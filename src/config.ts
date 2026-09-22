import { existsSync, readFileSync } from 'node:fs';
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
    '**/generated/**',
    '**/__generated__/**',
    '**/*.pb.ts',
  ],
  // Measured, not guessed: genuine re-implementations of one idea land at 0.81
  // and above, while the nearest unrelated pair sits below 0.50. The cut-off
  // goes in that gap, nearer the noise floor, because calibration raises it per
  // project and nothing can rescue a finding that was never generated.
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
  const pkgPath = join(root, 'package.json');

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      // A published package's exports ARE the contract: never dead by definition.
      for (const field of ['main', 'module', 'browser'] as const) {
        if (typeof pkg[field] === 'string') publicApi.push(sourceOf(pkg[field]));
      }
      if (pkg.exports) collectExports(pkg.exports, publicApi);
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
        for (const b of bins) if (typeof b === 'string') entrypoints.push(sourceOf(b));
      }
      // A private package has no consumers, so its entry is a true entrypoint.
      if (pkg.private && typeof pkg.main === 'string') entrypoints.push(sourceOf(pkg.main));
    } catch {
      // Malformed package.json is not fatal; fall through to conventions.
    }
  }

  for (const guess of [
    'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx',
    'src/cli.ts', 'src/server.ts', 'src/app.ts',
    'index.ts', 'main.ts', 'app/page.tsx', 'src/app/page.tsx',
  ]) {
    if (existsSync(join(root, guess))) entrypoints.push(guess);
  }

  // Framework conventions: files the framework calls, that nothing in-repo imports.
  for (const dir of ['app', 'src/app', 'pages', 'src/pages']) {
    if (existsSync(join(root, dir))) entrypoints.push(`${dir}/**/{page,layout,route,loading,error,middleware}.{ts,tsx,js,jsx}`);
  }
  if (existsSync(join(root, 'test')) || existsSync(join(root, 'tests'))) {
    entrypoints.push('{test,tests}/**/*.{test,spec}.{ts,tsx,js,jsx}');
  }
  entrypoints.push('**/*.{test,spec}.{ts,tsx,js,jsx}');

  return { entrypoints: unique(entrypoints), publicApi: unique(publicApi) };
}

/** Map a built artefact path back to its likely source, since we index source. */
function sourceOf(p: string): string {
  return p
    .replace(/^\.\//, '')
    .replace(/^(dist|build|lib|out)\//, 'src/')
    .replace(/\.(js|mjs|cjs)$/, '.ts');
}

function collectExports(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(sourceOf(node));
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) collectExports(value, out);
  }
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
