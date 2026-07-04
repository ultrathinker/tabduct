#!/usr/bin/env node
// Thin wrapper: run the conformance suite against the Node reference host.
// The real logic lives in protocol/conformance/run.mjs (host-language-neutral,
// single source of truth) so this file and the conformance runner can't drift.
import { runConformance } from "../protocol/conformance/run.mjs";
runConformance().then((code) => process.exit(code));
