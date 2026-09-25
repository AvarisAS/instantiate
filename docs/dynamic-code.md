# Dynamic code

A static graph can't see code called by a computed name. This is what
instantiate does about it.

## Followed automatically

| Pattern | Resolves to |
| --- | --- |
| `this[verb]()` with `verb: 'get' \| 'post'` | exactly those methods |
| `` import(`./locales/${lang}`) `` | every file the prefix can complete to |
| `getattr(obj, "name")` (Python) | methods called `name` |
| `import_module(f"app.plugins.{x}")` | every module under `app.plugins` |
| `v.MethodByName("Save")` (Go) | methods called `Save` |
| Framework decorators and hooks | see [Configuration](configuration.md#framework-rules) |

## Reported as a question, not as dead

If a symbol's name appears in a string, or in a config file (YAML, JSON, TOML,
plist, storyboard…), it's shown as **may be loaded by name**. The same goes for
code reached only through such a symbol. These don't count towards the headline
numbers or the budget.

## Listed, so you know where analysis stops

`handlers[kind]()`, `require(variable)`, `getattr(obj, name)`, `eval` and
similar are listed by file and line in the scan output. Settle them with a
framework rule, an ignore comment, or a real run.

## Coverage and traces

Anything that actually ran counts as used:

```bash
npx vitest --coverage
npx instantiate scan --coverage coverage/coverage-final.json
```

Understood: Istanbul (Vitest, Jest, nyc, c8), `coverage.py` (`coverage json`),
and raw V8 traces. `--coverage` can be given more than once.

A production trace catches paths no test tried:

```bash
NODE_V8_COVERAGE=traces/ node server.js     # run for a while
npx instantiate scan --coverage traces/
```

Raw traces work for plain JavaScript. For TypeScript, convert first:
`npx c8 report --temp-directory traces --reporter=json`.

Code in a covered file that never ran is reported at 97% confidence instead of
the usual 70%.
