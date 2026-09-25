# Configuration

Everything is autodetected. Add `.instantiate.yml` only to correct it.

## `.instantiate.yml`

```yaml
entrypoints:              # files that run; everything they reach is used
  - src/index.ts
  - src/workers/*.ts
publicApi:                # exports here are a contract, never "dead"
  - packages/sdk/src/index.ts
exclude:                  # added to the defaults (node_modules, dist, vendor…)
  - generated/**
includeTests: false       # look for duplicates inside tests too
dupeThreshold: 0.72       # raise if duplicates are noisy, lower to find more
maxFindings: 20           # how many findings a scan shows
plugins: []               # your own framework rules, below
```

For a library, `publicApi` matters most: without it every export looks unused.
Run `instantiate config` to see what was detected.

## Framework rules

Frameworks call code nothing in your repo names: controllers by decorator,
lifecycle hooks by name, commands by folder. Built-in rules cover NestJS,
Angular, TypeORM, React, Next.js, Django, Flask, FastAPI, Celery, pytest,
Click/Typer, Pydantic, SQLAlchemy and Swift/UIKit. Each turns on when the
project depends on it.

Add your own in the same shape:

```yaml
plugins:
  - name: job-runner
    decorators: [job]                 # @job, @scheduler.job
    names: [handle_*]                 # functions/methods called by name
    entrypoints: [jobs/**/*.py]       # files loaded by location
    symbols: ['src/legacy.ts#boot']   # exact symbols
    reason: The scheduler imports jobs/ and calls handle_* by name.
```

Anything a rule matches counts as used, along with everything it calls. Rules
only ever remove findings.

## Ignoring a finding

In code, above the declaration:

```ts
// instantiate-ignore dead: loaded by path from the deploy script
```

```py
# instantiate-ignore dead, unfinished: kept for the v2 exporter
```

- Kinds: `dead`, `duplicate`, `drift`, `conflict`, `unfinished`.
- A reason after `:` is required; without one the comment does nothing and is reported.
- Covers the next declaration only.
- Reported as stale once the finding is gone.
- The number of ignores is a budget line: `instantiate check` fails when it
  grows, until `instantiate budget` accepts it.

For code you can't edit, `instantiate dismiss <id> "<why>"` records the same
thing in `.instantiate/dismissed.json`.

## Budget

`instantiate budget` writes `.instantiate/budget.json`: dead lines, duplicated
lines, drift, contradictions, unfinished work and ignores. `instantiate check`
fails when any of them goes up. Only findings above 50% confidence count.

## Intent records

`.instantiate/intent.json` holds why a symbol exists and what it's not for.
Agents read it through the MCP server before reusing or adding code.

```bash
npx instantiate intent draft                  # propose records
npx instantiate intent gaps                   # what has none
npx instantiate intent set <symbol> "<purpose>" --not-for "<not for>"
npx instantiate intent confirm <symbol>
```

Commit it: it's the one input that isn't derived from the code.
