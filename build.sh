#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is required: https://rustwasm.github.io/wasm-pack/installer/"
  exit 1
fi

if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  echo "Adding wasm32-unknown-unknown target…"
  rustup target add wasm32-unknown-unknown
fi

echo "Building rustbar-scanner (release)…"
wasm-pack build scanner \
  --target web \
  --out-dir ../www/pkg \
  --release

echo ""
echo "Done. Local demo:"
echo "  cd www && python -m http.server 8080"
echo "  Or push to GitHub — Pages workflow deploys www/ over HTTPS."
