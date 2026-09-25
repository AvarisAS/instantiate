#!/usr/bin/env bash
# Rebuild the vendored grammars in grammars/.
#
# Python and Go publish prebuilt .wasm files in their npm packages; Swift does
# not, so it is compiled here. tree-sitter-cli downloads its own WASI toolchain
# on first use, so nothing needs installing beforehand.
set -euo pipefail

PYTHON=0.25.0
GO=0.25.0
SWIFT=0.7.1
CLI=0.27.0

out="$(cd "$(dirname "$0")/.." && pwd)/grammars"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm i --ignore-scripts --legacy-peer-deps \
  "tree-sitter-python@$PYTHON" "tree-sitter-go@$GO" "tree-sitter-swift@$SWIFT" >/dev/null

cp node_modules/tree-sitter-python/tree-sitter-python.wasm "$out/"
cp node_modules/tree-sitter-go/tree-sitter-go.wasm "$out/"
(cd node_modules/tree-sitter-swift && npx -y "tree-sitter-cli@$CLI" build --wasm -o "$out/tree-sitter-swift.wasm" .)

echo "grammars written to $out"
