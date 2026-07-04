#!/usr/bin/env node
// Generate a stable identity for the Tabduct extension.
//
// Chrome derives an unpacked extension's id from the manifest's `key` field.
// Pinning it keeps the native-messaging manifest's allowed_origins valid across
// reloads/machines. This script:
//   1. generates an RSA keypair,
//   2. writes the private key to extension/key.pem (gitignored),
//   3. injects the base64 public key (SPKI DER) as manifest "key".
// The extension id is DERIVED from manifest.key by the host's register step
// (single source of truth — no separate id file to drift).
//
// Run once. To mint a new identity: delete extension/key.pem, then re-run.

import { generateKeyPairSync, createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../extension");
const MANIFEST = resolve(EXT, "manifest.json");
const PEM = resolve(EXT, "key.pem");

if (existsSync(PEM)) {
  console.error("extension/key.pem already exists — refusing to overwrite an existing identity.");
  console.error("Delete it first if you really want a new one.");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const keyB64 = publicKey.toString("base64");
const hex = createHash("sha256").update(publicKey).digest("hex").slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
delete manifest.__note_key;
delete manifest.key; // avoid clobbering the new key with a stale one on re-run

// Rebuild with `key` right after `description` for readability.
const rebuilt = {};
for (const [k, v] of Object.entries(manifest)) {
  rebuilt[k] = v;
  if (k === "description") rebuilt.key = keyB64;
}
if (!rebuilt.key) rebuilt.key = keyB64;

writeFileSync(PEM, privateKey, "utf8");
writeFileSync(MANIFEST, JSON.stringify(rebuilt, null, 2) + "\n", "utf8");

console.error("Tabduct identity created:");
console.error("  extension id : " + id);
console.error("  private key  : extension/key.pem  (secret, gitignored)");
console.error("  manifest.key : injected");
console.error("Next: run the host's `register` (it derives the id from manifest.key).");
