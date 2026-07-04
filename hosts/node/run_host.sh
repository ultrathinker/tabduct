#!/usr/bin/env bash
# Tabduct native host launcher (macOS/Linux). Chrome invokes this via the
# native-messaging manifest. stdout carries protocol frames only.
# `register` writes node_path.txt (absolute node) for Chrome's minimal-env spawn.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="node"
[ -f "$DIR/node_path.txt" ] && NODE="$(cat "$DIR/node_path.txt")"
exec "$NODE" "$DIR/src/index.js"
