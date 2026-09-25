# Languages

TypeScript and JavaScript are read with the TypeScript compiler. Python, Go and
Swift use tree-sitter. All five feed the same graph, so every finding works
across languages.

Without a type checker, `obj.method()` in Python, Go and Swift matches every
method of that name. This errs towards "used": a missed finding is cheaper than
a false "dead".

## TypeScript / JavaScript

Entrypoints and public API come from `package.json` (`main`, `exports`, `bin`),
workspaces, and framework conventions such as Next.js routes. Handled:
barrels and `export *`, namespace imports, `#private` members, subpath
imports, `import()`/`require()`, path aliases from every tsconfig, `declare
module` augmentations, imports inside `.mdx`/`.vue`/`.svelte`, and scripts that
nothing imports.

## Python

Entrypoints: files with `if __name__ == "__main__"`, `manage.py`, `wsgi.py`,
`conftest.py`, tests. `__init__.py` is public API in a package. Handles
relative imports, virtual dispatch through base classes, `super()`, and
decorators.

## Go

- A package is its directory; files in it see each other without imports.
- Imports resolve through every `go.mod` in the repo.
- `func main` in `package main` is an entrypoint; `_test.go` files are too.
- `init()` runs when a package loads, including via `import _ "…"`.
- `x_unix.go` and `x_windows.go` both define `x`; both count.
- A used type keeps its exported methods, since any interface may call them.
- Exported names outside `internal/` are public API.

## Swift

- All files in a target share one namespace.
- `@main`, `main.swift`, `Package.swift` and test targets are entrypoints.
- `override`, `@objc`, `@IBAction`, `@IBOutlet` and operators always count as used.
- App Intents, widgets and previews are discovered by the system, so they count as used.
- Conforming to a standard protocol keeps what it requires (`description`,
  `hash(into:)`, `body`…). Subclassing a framework class such as
  `UIViewController` keeps every non-private member.
- `public` and `open` symbols are public API.
- A class named in a storyboard, xib or plist may be loaded by name.

## Adding a language

1. Add its grammar to `grammars/` (see `scripts/build-grammars.sh`).
2. Add `src/index/<lang>.ts` exporting a `Backend`: declare symbols, resolve
   imports, connect references. `python.ts` and `go.ts` are the examples.
3. Register it in `src/index/backends.ts`, and add its file globs and
   entrypoint conventions in `src/config.ts`.
4. Add a fixture with known dead code and false-positive traps, then check it
   on two or three real repos.
