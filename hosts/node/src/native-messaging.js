// Tabduct Node host — Chrome Native Messaging transport (PROTOCOL.md §1).
//
// Frames: [uint32 LE length][UTF-8 JSON]. Read from stdin, write to stdout.
// - A bad length (<=0) or non-JSON body is a genuine desync → FATAL exit.
// - An oversize frame (> MAX_FRAME_BYTES) is NOT a desync (the length is valid):
//   we skip exactly that many bytes and keep the stream alive; the corresponding
//   invoke reply is lost and times out. Killing the host on a big screenshot
//   would be worse than dropping one reply.
// Buffering uses a chunk list (O(n) amortized), not repeated Buffer.concat.

import { MAX_FRAME_BYTES, OUT_FRAME_MAX_BYTES } from "./constants.js";

export class NativeMessaging {
  constructor() {
    this._chunks = [];
    this._buffered = 0;
    this._need = -1;
    this._skip = 0; // bytes of an oversize frame still to discard
    this._ended = false;
    this._onMessage = () => {};
    this._onEnd = () => {};
  }

  onMessage(fn) { this._onMessage = fn; }
  onEnd(fn) { this._onEnd = fn; }

  start() {
    process.stdin.on("readable", () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) this._push(chunk);
    });
    const end = () => this._end();
    process.stdin.on("end", end);
    process.stdin.on("error", end);
    process.stdout.on("error", end); // Chrome died mid-write → clean shutdown, not uncaught crash
  }

  _end() { if (this._ended) return; this._ended = true; this._onEnd(); }

  _push(chunk) {
    if (this._skip > 0) {
      if (chunk.length <= this._skip) { this._skip -= chunk.length; return; }
      chunk = chunk.subarray(this._skip); this._skip = 0;
    }
    this._chunks.push(chunk);
    this._buffered += chunk.length;
    this._drain();
  }

  _take(n) {
    if (this._chunks.length && this._chunks[0].length === n) {
      const b = this._chunks.shift(); this._buffered -= n; return b;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this._chunks[0];
      const take = Math.min(c.length, n - off);
      c.copy(out, off, 0, take);
      off += take;
      if (take === c.length) this._chunks.shift();
      else this._chunks[0] = c.subarray(take);
    }
    this._buffered -= n;
    return out;
  }

  _fatal(reason) { process.stderr.write(`[tabduct] fatal framing error: ${reason}\n`); process.exit(1); }

  _drain() {
    for (;;) {
      if (this._need === -1) {
        if (this._buffered < 4) return;
        this._need = this._take(4).readUInt32LE(0);
        if (this._need <= 0) { this._fatal(`bad length header: ${this._need}`); return; }
        if (this._need > MAX_FRAME_BYTES) {
          process.stderr.write(`[tabduct] dropping oversize frame: ${this._need}B (cap ${MAX_FRAME_BYTES})\n`);
          const avail = Math.min(this._need, this._buffered);
          if (avail > 0) this._take(avail);
          this._skip = this._need - avail;
          this._need = -1;
          if (this._skip > 0) return;
          continue;
        }
      }
      if (this._buffered < this._need) return;
      const body = this._take(this._need);
      this._need = -1;
      let msg;
      try { msg = JSON.parse(body.toString("utf8")); }
      catch (e) { this._fatal(`non-JSON frame: ${e.message}`); return; }
      this._onMessage(msg);
    }
  }

  /** host->extension is hard-capped at 1 MB by Chrome; refuse oversize instead of severing. */
  send(msg) {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    if (body.length > OUT_FRAME_MAX_BYTES) {
      const e = new Error(`outbound frame ${body.length}B exceeds 1 MB cap`);
      e.code = "FRAME_TOO_LARGE";
      throw e;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
  }
}
