# Accuracy

A tool like this is only as useful as its false-positive rate, so every
analysis is checked against real open-source code and every mistake found
becomes a regression test.

## Validated on

| Language | Repositories |
| --- | --- |
| TypeScript / JavaScript | hono, zod, ky, zustand, ofetch, chalk, execa, h3, consola, a NestJS app |
| Python | requests, click, a Django app, the Flask tutorial |
| Go | gorilla/mux, spf13/cobra, charmbracelet/glow |
| Swift | Rainbow, clean-architecture-swiftui, Gifski |

## Numbers

- **Duplicates:** precision 0.75, recall 0.86 on hand-labelled pairs.
  `npm run calibrate` re-runs it. Confidence bands descend as they should
  (0.80 / 0.67 / 0.17).
- **Framework rules:** dead-code findings on sample apps went from 60 → 2
  (NestJS), 13 → 0 (Django), 9 → 0 (Flask); the two left are real.
- **Unfinished work:** one finding across 14 repos, and it's real.

## Known limits

- **Dynamic code:** see [Dynamic code](dynamic-code.md).
- **Python, Go and Swift** resolve method calls by name, so some unused methods
  are missed.
- **Duplicates need shared vocabulary.** Identical logic with every name changed
  scores too low to report.
- **Parallel sets** (translations, adapters, drivers) are recognised by shape,
  not understood.
- **Contradictions are narrow on purpose:** env var defaults, declared
  constants, UTC vs local time.
- **It doesn't judge code quality.** That's a linter's job.
