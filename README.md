# instantiate

See what is actually in your codebase.

LLMs write more code than anyone reads. The result is not usually broken — it is
redundant, inconsistent, and too large to hold in a head. Three functions format
a duration. Four modules handle errors four ways. A thousand lines are reachable
from nothing at all, and nobody can tell which thousand.

`instantiate` builds a graph of your code and turns it into a ranked worklist:
what to delete, what to merge, what convention to settle on. The pictures are
there to justify a finding, not to be admired.

```bash
npx instantiate scan       # index and report, ranked
npx instantiate report     # one self-contained HTML file
npx instantiate serve      # live UI, rebuilds on save
```

No account, no upload, no API key. Everything runs locally.

## What it finds

Indexes **TypeScript, JavaScript and Python** into one graph — a polyglot repo is
one codebase, and a per-language report hides the thing worth seeing.

**Dead code** — reachability from your entrypoints. Deleting is the highest-value
and lowest-risk action in a codebase nobody understands, so it comes first. A
file where nothing is reachable is reported once, since that is one decision.

**Semantic duplicates** — not copy-paste. `formatDuration`, `prettyTime` and
`humanizeMs`, written weeks apart by sessions that could not find each other.
Matched on structure *and* vocabulary, so same-shape-different-domain does not
trigger and different-shape-same-job does.

**Contradictions** — one fact with two answers. The same environment variable
defaulting to two values, one named timeout that is 3 seconds here and 30 there,
dates read as UTC in one module and local time in another. Each site is
defensible alone, which is why review never catches it.

**Convention drift** — error handling done four ways because four sessions each
guessed. Invisible in any single file, obvious in aggregate.

**Trends** — the same numbers walked back through git history. A single scan
saying 4% dead is a fact nobody acts on; the same number rising for six weeks is
an argument, and a falling one is the reason to keep going.

**File connections** — for any file, what reaches into it and what it reaches,
counted by distinct symbol pairs. That is the question people ask before they
ask about a function: is this change contained, or does it touch half the
codebase.

**A trail through the codebase.** Following a call site into another file, and
another, is how anybody reads unfamiliar code — and how you lose your place.
Every move is recorded: back and forward, alt and an arrow key, and a trail
showing the path taken where each step goes back to it.

**The report is a code browser.** Three panes: a file tree where each row is
shaded by what is wrong inside it, that file's symbols with a filter, and the
whole source with the lines to act on shaded in place and the remedy stated
above them. Click a call site to jump to it. The treemap is tucked behind a
toggle, which is all an overview is for.

## What it does for coding agents

Reporting duplicates after they are written is hygiene. Preventing them is the
point. Register the MCP server and an agent can ask the graph before it writes:

```jsonc
// .mcp.json
{ "mcpServers": { "instantiate": { "command": "npx", "args": ["instantiate", "mcp"] } } }
```

| Tool | Use |
| --- | --- |
| `check_before_writing` | "Does anything already do this?" — before adding a helper |
| `find_symbol` | Declaration, callers, callees — instead of grepping |
| `blast_radius` | What breaks if I change this |
| `list_concepts` | Orient in an unfamiliar area |
| `list_findings` | The established convention, before picking a different one |
| `get_intent` | Why this exists, and what it is explicitly not for |

## CI: a ratchet, not a gate

A repo with 4,100 dead lines today is not one anyone will clean up before
adopting a tool. So the check fails on an **increase**, never an absolute.

```bash
npx instantiate budget   # record today's numbers, commit .instantiate/budget.json
npx instantiate check    # fails only if they grew
```

```yaml
- run: npx instantiate check
```

Only findings above 50% confidence count towards the budget. A low-confidence
finding is worth showing as a question; it is not worth failing a build over.

## The intent layer

The half that code cannot express: *why* a thing exists and what it is **not**
for. Without it, every agent reaching for a helper guesses, and the guess becomes
next week's fact.

```bash
npx instantiate intent draft     # propose records for load-bearing symbols
npx instantiate intent gaps      # what nothing explains yet
npx instantiate intent set <symbol> "<purpose>" --not-for "<what it is not>"
npx instantiate intent confirm <symbol>
```

Records live in `.instantiate/intent.json`. **Commit them** — they are the human
contribution, reviewable in a PR, and the only input here that is not derived
from the code. A draft nobody confirms is worth nothing; that is the deal.

## Configuration

Autodetected from `package.json` and conventions. Override only what is wrong:

```yaml
# .instantiate.yml
entrypoints:
  - src/index.ts
  - src/workers/*.ts
publicApi:
  - packages/sdk/src/index.ts   # exports here are the contract, never "dead"
exclude:
  - generated/**
dupeThreshold: 0.72             # raise if duplicates are noisy, lower to find more
maxFindings: 20                 # the noise budget
```

`publicApi` is the line that matters for libraries. Without it every export looks
unreachable, the dead-code report is noise, and the tool gets uninstalled in
minute two.

## Commands

| | |
| --- | --- |
| `scan` | Everything, ranked |
| `dead` / `dupes` / `conflicts` / `drift` | One kind at a time |
| `dismiss <id> <why>` | Hide a finding permanently, with a recorded reason |
| `trend --days 90` | How the numbers moved over git history |
| `concepts` | What this codebase is made of |
| `why <symbol>` | Declared where, called from where, reaches what |
| `report` / `serve` | HTML file / live UI |
| `budget` / `check` | Record the baseline / enforce it |
| `intent` | Draft, confirm and read intent records |
| `mcp` | Run as an MCP server |

Add `--json` to anything.

## What it understands

Validated against real repositories — hono, zod, ky, zustand, ofetch, chalk and
requests — because a tool like this is only as good as its false-positive rate.
Two rounds of adversarial checking put dead-code precision at 0% before these
were fixed. Each is a pattern that produced a wrong answer on real code and is
now covered by a regression test:

- code at module scope, which has no enclosing function
- barrels — `export { x } from`, and `export *`, which names nothing
- `import * as tags` followed by `tags[key]`, which no graph can trace
- `this.#private()` calls
- Node subpath imports (`#supports-color`), across every condition
- `await import()` and `require()`
- imports written in `.mdx`, `.vue`, `.svelte` and other files that are never
  themselves indexed
- monorepo workspaces, and framework route conventions inside them
- scripts, benchmarks and examples, which are run rather than imported
- vendored code, whose unused exports are somebody else's contract
- constructors, which `new Foo()` never names, and abstract members, which have
  no body to record
- overrides, since a call through a base method runs the subclass's version
- `declare module` augmentations, which merge into a type declared elsewhere
- path aliases (`@/components/x`) from whichever tsconfig governs the file
- modules that run code at load and that nothing imports, which are scripts

Duplicate detection knows the difference between redundancy and design:

- test suites, which repeat their scaffolding on purpose — opt in with
  `--include-tests`
- designed sets differing in one word: `help_option` beside `version_option`
- one name implemented as a method by several classes, which is polymorphism

- a closure and the function whose text contains it
- stubs, which all resemble each other and implement nothing
- pairs of wildly different size, where neither could replace the other
- named doors onto one function — `head`, `options`, `delete`
- one name per class, which is polymorphism
- directories that mirror each other, learned from shared symbol names: two
  published API surfaces over one idea are a design, not a repetition
- translations, adapters and drivers — one name implemented once per file

## Honest limits

- **TypeScript, JavaScript and Python.** Other languages need their own indexer.
- **Python resolution is weaker than TypeScript's.** There is no type checker, so
  `obj.method()` resolves by name across every class that defines it. That
  over-approximates on purpose: a false "alive" costs one missed finding, a false
  "dead" costs trust in all of them.
- **A static graph cannot see dynamic dispatch.** String-keyed containers, routes
  built at runtime, `require(variable)`. Names that appear in string literals are
  downgraded rather than reported confidently, but a graph will still be wrong
  where a codebase is most confusing. Low confidence means *question*, not fact.

  The answer to that is not more static analysis — it is a test run. Pass a
  coverage report and anything the tests executed counts as reached, however it
  was reached:

  ```bash
  npx vitest --coverage           # or: coverage run -m pytest && coverage json
  npx instantiate scan --coverage coverage/coverage-final.json
  ```

  Istanbul (nyc, c8, Vitest, Jest) and `coverage.py` are both understood. What
  is left is unreachable *and* untested, which is a stronger finding than
  either alone — such findings are reported at 97% rather than the usual 70%.
- **Parallel sets are demoted, not understood.** Sixty translations are
  recognised as structure rather than redundancy by their shape — one name per
  file — not because the tool knows what a translation is.
- **Duplicates need shared vocabulary.** Two functions with identical structure
  and every noun renamed score too low to report, because nothing short of
  semantic embeddings separates that from a coincidental shape match.
- **Duplicate precision is 0.75 against hand-labelled pairs**, with recall 0.86
  — measured, not asserted: `npm run calibrate` re-runs it. The confidence score
  is calibrated so the bands descend (0.80 above 0.70, 0.67 in the middle, 0.17
  below), which is what makes ranking worth reading. It is a similarity
  detector, not a semantic one, and two functions that share a parameter list
  while doing different work can still slip through.
- **Contradictions are narrow on purpose.** An environment variable with two
  fallbacks, a declared constant with two values, UTC against local time. A
  `maxAge` of 600 in one feature and 3600 in another is two settings, not a
  disagreement, and reporting it would make the whole category untrustworthy.
- **It does not judge whether code is good.** That is out of reach, and attempting
  it would make this a linter with worse ergonomics.
- **Intent records are only as true as the human who confirmed them.**

## Licence

MIT
