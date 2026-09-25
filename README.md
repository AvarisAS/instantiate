# instantiate

See what's actually in your codebase: dead code, duplicates, contradictions,
unfinished work and inconsistent conventions, ranked into a worklist.

Runs locally. No account, no upload, no API key.

## Install

```bash
npm i -D @avarisas/instantiate      # or: pnpm add -D, yarn add -D
```

Requires Node 22+. Or run it once without installing:
`npx @avarisas/instantiate scan`.

## Use

```bash
npx instantiate scan                        # ranked findings in the terminal
npx instantiate report --out report.html    # self-contained HTML code browser
npx instantiate serve                       # live UI, rebuilds on save
```

Point it at another folder with `--root <path>`. Without `--out`, `report`
writes to `<root>/.instantiate/report.html`; add `.instantiate/report.html` to
your `.gitignore`, or pass `--out`. `scan` writes nothing.

Supports **TypeScript, JavaScript, Python, Go and Swift**, in one graph.

## What it finds

| Finding | Example |
| --- | --- |
| **Dead code** | Functions, classes and whole files nothing reaches |
| **Duplicates** | `formatDuration`, `prettyTime` and `humanizeMs` doing the same job |
| **Contradictions** | One env var defaulting to `3000` here and `8080` there |
| **Unfinished work** | State nothing ever sets; bodies that only say `not implemented` |
| **Drift** | The same job done several ways, e.g. async/await vs promise chains |

Each finding says what to do about it. Low-confidence findings are shown as
questions and never count towards the headline numbers.

## The report

`instantiate report` writes one HTML file: a file tree shaded by findings, each
file's symbols, and the source with the lines to act on highlighted. Click
through call sites, go back and forward, and see which files connect to the one
you're reading. File paths link to your git remote.

## CI

The check fails when the numbers **grow**, not on what's already there.

```bash
npx instantiate budget    # record today's numbers → .instantiate/budget.json
npx instantiate check     # in CI: fail if any number went up
```

## Coding agents

An MCP server lets agents check before writing a new helper:

```jsonc
// .mcp.json
{ "mcpServers": { "instantiate": { "command": "npx", "args": ["instantiate", "mcp"] } } }
```

Tools: `check_before_writing`, `find_symbol`, `blast_radius`, `list_concepts`,
`list_findings`, `get_intent`.

## Commands

| Command | Does |
| --- | --- |
| `scan` | All findings, ranked |
| `dead` · `dupes` · `conflicts` · `drift` · `unfinished` | One kind |
| `report` · `serve` | HTML file · live UI |
| `budget` · `check` | Record the baseline · enforce it |
| `why <symbol>` | Where it's declared, called and what it reaches |
| `trend --days 90` | The numbers over git history |
| `concepts` | What the codebase is made of |
| `dismiss <id> "<why>"` | Hide a finding, with a reason |
| `intent` | Record why a symbol exists and what it's not for |
| `mcp` | Run as an MCP server |

Add `--json` to any command, `--coverage <file>` to count what ran as used.

## Configuration

Entrypoints and public API are detected from `package.json`, `go.mod`,
`Package.swift` and common conventions. Override only what's wrong:

```yaml
# .instantiate.yml
entrypoints: [src/index.ts, src/workers/*.ts]
publicApi: [packages/sdk/src/index.ts]   # exports here are never "dead"
exclude: [generated/**]
```

Framework rules (NestJS, Django, Flask, Next.js and more) turn on
automatically. To mark a one-off as fine:

```ts
// instantiate-ignore dead: loaded by path from the deploy script
function boot() {}
```

## Website

A landing page and [popular libraries, scanned](https://instantiate.avaris.no/libraries.html),
each with its full report. Built by `scripts/build-site.ts` from `site/libraries.json`
and deployed by `.github/workflows/pages.yml`. Build it locally with
`npx tsx scripts/build-site.ts --out _site`.

## Docs

- [Configuration](docs/configuration.md): config file, framework rules, ignoring findings
- [Dynamic code](docs/dynamic-code.md): what static analysis can't see, and coverage/traces
- [Languages](docs/languages.md): how each language is read, and adding one
- [Accuracy](docs/accuracy.md): how it's validated, and known limits

## Licence

MIT
