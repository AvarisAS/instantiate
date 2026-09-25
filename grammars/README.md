# Grammars

Compiled tree-sitter grammars, loaded by `web-tree-sitter` at scan time.
They are vendored so that installing instantiate never runs a native build.

| File | Source | Version | Licence |
|---|---|---|---|
| `tree-sitter-python.wasm` | npm `tree-sitter-python` (shipped prebuilt) | 0.25.0 | MIT |
| `tree-sitter-go.wasm` | npm `tree-sitter-go` (shipped prebuilt) | 0.25.0 | MIT |
| `tree-sitter-swift.wasm` | npm `tree-sitter-swift`, built with `tree-sitter-cli` 0.27.0 | 0.7.1 | MIT |

A grammar must be built for a tree-sitter ABI that the installed
`web-tree-sitter` accepts (13 to 15 for 0.27). The older `tree-sitter-wasms`
bundle is built for an earlier format, which is why this project stayed on
`web-tree-sitter` 0.24 until these replaced it.

Rebuild or update with `scripts/build-grammars.sh`.
