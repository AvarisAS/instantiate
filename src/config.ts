import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';

export interface Config {
  root: string;
  /** Globs. Files reachable from these are alive. */
  entrypoints: string[];
  /** Library surface: exports here are never dead, they are the contract. */
  publicApi: string[];
  include: string[];
  exclude: string[];
  /** Non-code files scanned for imports, so what they use is not reported dead. */
  satellites: string[];
  /** Python sources, indexed by the tree-sitter backend rather than by tsc. */
  python: string[];
  /**
   * Look for duplicates inside test files.
   *
   * Off by default: a test suite repeats its scaffolding on purpose, each case
   * setting up the same shape and asserting something different. Measured
   * precision on real Python test suites was zero.
   */
  includeTests: boolean;
  /** Cosine cut-off for the duplicate clusters. Calibrated per project on first scan. */
  dupeThreshold: number;
  /** Minimum lines before a symbol is a duplicate candidate. Kills trivial-adapter noise. */
  dupeMinLoc: number;
  /** Findings shown in a report. The noise budget. */
  maxFindings: number;
  /** Target number of concept clusters on the map. */
  concepts: number;
}

const DEFAULTS: Omit<Config, 'root' | 'entrypoints' | 'publicApi'> = {
  include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.cts'],
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/*.d.ts',
    '**/*.min.js',
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/site-packages/**',
    '**/generated/**',
    '**/__generated__/**',
    '**/*.pb.ts',
  ],
  // Measured, not guessed: genuine re-implementations of one idea land at 0.81
  // and above, while the nearest unrelated pair sits below 0.50. The cut-off
  // goes in that gap, nearer the noise floor, because calibration raises it per
  // project and nothing can rescue a finding that was never generated.
  // Files that are not code but do import it: MDX docs, single-file components,
  // templates. They are never indexed, yet what they import is very much alive.
  satellites: ['**/*.{mdx,md,vue,svelte,astro,html}'],
  python: ['**/*.py'],
  includeTests: false,
  dupeThreshold: 0.72,
  dupeMinLoc: 4,
  maxFindings: 20,
  concepts: 30,
};

const CONFIG_NAMES = ['.instantiate.yml', '.instantiate.yaml', 'instantiate.yml'];

/**
 * Entrypoint autodetection. Dead-code findings are only as good as this set,
 * so when we detect nothing we say so loudly rather than declaring the repo dead.
 */
export function detectEntrypoints(root: string): { entrypoints: string[]; publicApi: string[] } {
  const entrypoints: string[] = [];
  const publicApi: string[] = [];

  readPackage(root, '.', entrypoints, publicApi);

  // A monorepo's root package.json describes the repository, not the code.
  // Without reading each workspace, every package's public surface looks
  // unreachable and the dead-code report becomes meaningless rather than empty.
  const workspaces = workspaceDirs(root);
  for (const dir of workspaces) {
    readPackage(root, dir, entrypoints, publicApi);
  }

  for (const guess of [
    'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx',
    'src/cli.ts', 'src/server.ts', 'src/app.ts',
    'index.ts', 'main.ts', 'app/page.tsx', 'src/app/page.tsx',
  ]) {
    if (existsSync(join(root, guess))) entrypoints.push(guess);
  }

  // Framework conventions: files the framework calls, that nothing in-repo
  // imports. Checked per workspace as well as at the root, since a monorepo
  // keeps its site in packages/docs rather than at the top level.
  for (const base of ['.', ...workspaces]) {
    const prefix = base === '.' ? '' : `${base}/`;
    for (const dir of ['app', 'src/app', 'pages', 'src/pages']) {
      if (existsSync(join(root, prefix + dir))) {
        entrypoints.push(`${prefix}${dir}/**/{page,layout,route,loading,error,not-found,middleware,template,default,sitemap,robots,opengraph-image,icon}.{ts,tsx,js,jsx,mts}`);
      }
    }
  }
  // Python: the files an interpreter is pointed at, plus the test conventions.
  entrypoints.push('**/{__main__,main,manage,app,wsgi,asgi,conftest,setup}.py');
  entrypoints.push('**/{test_*,*_test}.py');
  entrypoints.push('{test,tests}/**/*.py');

  entrypoints.push('{test,tests,spec,__tests__,test-d,type-tests,types-test}/**/*.{ts,tsx,js,jsx,mts,cts,py}');
  entrypoints.push('**/*.{test-d,typetest}.{ts,tsx}');
  entrypoints.push('**/*.{test,spec}.{ts,tsx,js,jsx}');

  // Scripts, benchmarks and examples are executed directly rather than imported.
  // They are unreachable by construction, so reporting them is pure noise.
  // Matched at any depth, since a monorepo keeps them in packages/bench and the
  // like rather than at the root.
  // Every language, not just the TypeScript ones: click's examples are Python,
  // and a glob listing only JS extensions made them unreachable by construction.
  entrypoints.push(`**/{${SCRIPT_DIRS.join(',')}}/**/*.{ts,tsx,js,jsx,mts,cts,py}`);

  // A package's `__init__.py` re-exports are its published surface, exactly as a
  // barrel is in TypeScript: absent callers inside the repo are the point.
  if (
    existsSync(join(root, 'pyproject.toml')) ||
    existsSync(join(root, 'setup.py')) ||
    existsSync(join(root, 'setup.cfg'))
  ) {
    publicApi.push('**/__init__.py');
  }

  // Vendored and generated code is somebody else's contract. Its unused exports
  // are real, and they are not this repository's problem to act on.
  publicApi.push('**/{vendor,vendored,third_party,third-party}/**/*.{ts,tsx,js,jsx,mts,cts}');

  return { entrypoints: unique(entrypoints), publicApi: unique(publicApi) };
}

/** Directories whose files are run, not imported. */
const SCRIPT_DIRS = [
  'scripts', 'script', 'bench', 'benchmark', 'benchmarks', 'perf', 'perf-measures',
  'examples', 'example', 'tools', 'build', 'e2e', 'fixtures', 'docs', 'doc',
];

/** Workspace package directories, from `workspaces` or the usual layout. */
function workspaceDirs(root: string): string[] {
  const dirs = new Set<string>();
  const patterns: string[] = [];

  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (Array.isArray(workspaces)) patterns.push(...workspaces.filter((w) => typeof w === 'string'));
  } catch {
    // No or malformed root package.json; fall back to the conventional layout.
  }
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) patterns.push('packages/*', 'apps/*');
  if (patterns.length === 0) patterns.push('packages/*', 'apps/*');

  for (const pattern of patterns) {
    // Only the single-level `dir/*` form is worth expanding; anything deeper is
    // rare enough that an explicit config entry is the better answer.
    const base = pattern.endsWith('/*') ? pattern.slice(0, -2) : undefined;
    if (!base) {
      if (existsSync(join(root, pattern, 'package.json'))) dirs.add(pattern);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(join(root, base));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = `${base}/${entry}`;
      if (existsSync(join(root, dir, 'package.json'))) dirs.add(dir);
    }
  }
  return [...dirs];
}

/** Read one package.json and add whatever entrypoints and public surface it declares. */
function readPackage(root: string, dir: string, entrypoints: string[], publicApi: string[]): void {
  const prefix = dir === '.' ? '' : `${dir}/`;
  const pkgPath = join(root, dir, 'package.json');
  const resolve = (p: string): string | undefined => sourceOf(root, prefix + p.replace(/^\.\//, ''));

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      // A published package's exports ARE the contract: never dead by definition.
      for (const field of ['main', 'module', 'browser'] as const) {
        if (typeof pkg[field] === 'string') push(publicApi, resolve(pkg[field]));
      }
      if (pkg.exports) collectExports(root, prefix, pkg.exports, publicApi);
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
        for (const b of bins) if (typeof b === 'string') push(entrypoints, resolve(b));
      }
      // A private package has no consumers, so its entry is a true entrypoint.
      if (pkg.private && typeof pkg.main === 'string') push(entrypoints, resolve(pkg.main));
    } catch {
      // Malformed package.json is not fatal; fall through to conventions.
    }
  }
}

/**
 * Map a published artefact path back to the source file we actually index.
 *
 * A package's `exports` point at build output, and the shape of that output
 * varies: `dist/index.js`, `dist/cjs/index.js`, `dist/types/index.d.ts`, or a
 * plain `source/index.js` that is already the source. Rewriting blindly to
 * `.ts` produced paths that exist in no repository, so every public export
 * looked unreachable and the whole dead-code report became noise.
 *
 * So: generate candidates, keep the first that exists on disk, and fall back to
 * the literal path only if nothing matches.
 */
function sourceOf(root: string, published: string): string | undefined {
  const clean = published.replace(/^\.\//, '');
  const roots = new Set<string>([clean]);

  // Build directory to source directory.
  const withoutBuildDir = clean.replace(/^(dist|build|lib|out|esm|cjs)\//, '');
  roots.add(withoutBuildDir);
  roots.add(`src/${withoutBuildDir}`);
  roots.add(`source/${withoutBuildDir}`);

  // Output layouts that nest by module format or by declarations.
  const withoutFormatDir = withoutBuildDir.replace(/^(cjs|esm|mjs|types|typings)\//, '');
  roots.add(`src/${withoutFormatDir}`);
  roots.add(`source/${withoutFormatDir}`);

  const candidates: string[] = [];
  for (const base of roots) {
    // A declaration file's implementation carries the same stem.
    const stem = base.replace(/\.d\.ts$/, '').replace(/\.(js|mjs|cjs|jsx)$/, '');
    if (base !== stem) {
      for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']) {
        candidates.push(stem + extension);
      }
      candidates.push(`${stem}/index.ts`, `${stem}/index.js`);
    }
    // The published path may already be the source, as it is for a package
    // that ships plain JavaScript.
    candidates.push(base);
  }

  for (const candidate of candidates) {
    if (!candidate || !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(candidate)) continue;
    if (existsSync(join(root, candidate))) return candidate;
  }
  return undefined;
}

function collectExports(root: string, prefix: string, node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    push(out, sourceOf(root, prefix + node.replace(/^\.\//, '')));
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectExports(root, prefix, value, out);
    }
  }
}

function push(out: string[], value: string | undefined): void {
  if (value) out.push(value);
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function loadConfig(root: string): Config {
  const detected = detectEntrypoints(root);
  let fileConfig: Partial<Config> = {};

  for (const name of CONFIG_NAMES) {
    const path = join(root, name);
    if (existsSync(path)) {
      fileConfig = (YAML.parse(readFileSync(path, 'utf8')) ?? {}) as Partial<Config>;
      break;
    }
  }

  return {
    ...DEFAULTS,
    entrypoints: detected.entrypoints,
    publicApi: detected.publicApi,
    ...fileConfig,
    // Explicit excludes add to the defaults rather than replacing them; dropping
    // node_modules from a hand-written list is a footgun nobody needs.
    exclude: [...DEFAULTS.exclude, ...(fileConfig.exclude ?? [])],
    root,
  };
}

export function describeConfig(config: Config): string {
  const lines = [
    `root         ${config.root}`,
    `entrypoints  ${config.entrypoints.length ? config.entrypoints.join(', ') : '(none detected)'}`,
    `public api   ${config.publicApi.length ? config.publicApi.join(', ') : '(none)'}`,
    `dupe cutoff  ${config.dupeThreshold}`,
  ];
  return lines.join('\n');
}

export function relPath(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}
