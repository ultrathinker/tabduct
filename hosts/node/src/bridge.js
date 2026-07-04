// Tabduct Node host — the bridge.
//
// Turns "call a tool" (MCP side) into an `invoke` message on the wire and
// resolves when the extension replies (correlated by `id`). Heart of the host.

import { randomUUID } from "node:crypto";
import { INVOKE_TIMEOUT_MS, ERR } from "./constants.js";

function wireError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export class Bridge {
  /** @param {import("./native-messaging.js").NativeMessaging} nm */
  constructor(nm) {
    this._nm = nm;
    this._pending = new Map(); // id -> { resolve, reject, timer }
  }

  /** Feed replies coming back from the extension. Returns true if consumed. */
  handleReply(msg) {
    if (!msg || typeof msg.replyTo !== "string") return false;
    const p = this._pending.get(msg.replyTo);
    if (!p) return true;
    clearTimeout(p.timer);
    this._pending.delete(msg.replyTo);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(wireError(msg.error?.code || ERR.INTERNAL, msg.error?.message || "tool failed"));
    return true;
  }

  /** Ask the extension to run a tool; resolves with its result. */
  invoke(tool, args = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(wireError(ERR.TIMEOUT, `Tool "${tool}" timed out after ${INVOKE_TIMEOUT_MS}ms`));
      }, INVOKE_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._nm.send({ type: "invoke", id, payload: { tool, args } });
      } catch (e) {
        // e.g. FRAME_TOO_LARGE or EPIPE after Chrome died — fail fast, don't wait for timeout.
        clearTimeout(timer);
        this._pending.delete(id);
        reject(wireError(e.code || ERR.INTERNAL, e.message));
      }
    });
  }

  /** Reject everything in flight (extension/Chrome went away). */
  rejectAll(reason) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(wireError(ERR.INTERNAL, reason));
    }
    this._pending.clear();
  }
}
