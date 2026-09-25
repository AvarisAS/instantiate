import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeGraph, Finding, FindingKind } from '../types.js';

/**
 * `// instantiate-ignore dead: loaded by the legacy shell` — a judgement kept
 * beside the code it is about.
 *
 * A dismissal keyed by finding id stops matching the moment a symbol is
 * renamed or moved, and lives in a file nobody opens in review. A comment
 * travels with the declaration and shows up in the diff that adds it.
 *
 * The rules keep it from becoming a dumping ground:
 *   - a reason is required; without one the comment does nothing and is reported
 *   - it names the kinds it hides, so a real duplicate on the same function still shows
 *   - it covers the next declaration only, never a file or a block
 *   - one that no longer hides anything is reported, so it gets deleted
 *   - the number in force is a CI budget line, so it can only grow on purpose
 */
export interface Ignore {
  file: string;
  /** Where the comment is. */
  line: number;
  /** The lines it covers: the declaration, and its decorators. */
  targets: number[];
  kinds: FindingKind[];
  reason: string;
  /** Hid at least one finding this run. */
  used: boolean;
}

export interface IgnoreResult {
  findings: Finding[];
  /** Comments that hid something. */
  applied: Ignore[];
  /** Well-formed comments that hid nothing: the finding went away. */
  stale: Ignore[];
  /** Comments missing a reason or naming no known kind. They hide nothing. */
  malformed: Ignore[];
}

/** The comment must open where it stands: `\`// instantiate-ignore\`` quoted in prose is not one. */
const DIRECTIVE = /(?:^|\s)(?:\/\/|#|\/\*|<!--)\s*instantiate-ignore\b(.*)$/;

const KINDS: Record<string, FindingKind[]> = {
  dead: ['dead', 'orphan-file'],
  duplicate: ['duplicate'],
  dupes: ['duplicate'],
  drift: ['drift'],
  conflict: ['contradiction'],
  conflicts: ['contradiction'],
  contradiction: ['contradiction'],
  unfinished: ['unfinished'],
};

export function applyIgnores(findings: Finding[], graph: CodeGraph): IgnoreResult {
  const files = new Set([...graph.files.keys(), ...findings.map((f) => f.file)]);
  const all: Ignore[] = [];
  const malformed: Ignore[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(graph.root, file), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('instantiate-ignore')) continue;
    for (const ignore of parse(file, text)) {
      if (ignore.kinds.length === 0 || !ignore.reason) malformed.push(ignore);
      else all.push(ignore);
    }
  }

  const covering = (kind: FindingKind, file: string, line: number): Ignore | undefined =>
    all.find((i) => i.file === file && i.kinds.includes(kind) && i.targets.includes(line));
  const lineOf = (id: string): number | undefined => graph.symbols.get(id)?.line;

  const kept: Finding[] = [];
  for (const finding of findings) {
    const result = filter(finding, covering, lineOf);
    if (result) kept.push(result);
  }

  return {
    findings: kept,
    applied: all.filter((i) => i.used),
    stale: all.filter((i) => !i.used),
    malformed,
  };
}

function parse(file: string, text: string): Ignore[] {
  const lines = text.split('\n');
  const out: Ignore[] = [];
  lines.forEach((raw, index) => {
    const match = DIRECTIVE.exec(raw);
    if (!match) return;
    const body = match[1].replace(/\s*(\*\/|-->)\s*$/, '');
    const colon = body.indexOf(':');
    const names = (colon === -1 ? body : body.slice(0, colon)).split(/[\s,]+/).filter(Boolean);
    const reason = colon === -1 ? '' : body.slice(colon + 1).trim();
    const kinds = [...new Set(names.flatMap((n) => KINDS[n.toLowerCase()] ?? []))];
    // Unknown words are a typo, not a wish to hide everything.
    const valid = names.length > 0 && names.every((n) => KINDS[n.toLowerCase()]);

    const before = raw.slice(0, match.index).trim();
    const targets = before ? [index + 1] : following(lines, index);
    out.push({ file, line: index + 1, targets, kinds: valid ? kinds : [], reason, used: false });
  });
  return out;
}

/**
 * The next declaration: its decorators and the line they sit on. Blank lines
 * and further comments between are skipped, so an ignore can sit above a
 * docblock.
 */
function following(lines: string[], index: number): number[] {
  const targets: number[] = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^(\/\/|#|\/\*|\*)/.test(line)) {
      if (targets.length) break;
      continue;
    }
    targets.push(i + 1);
    if (!line.startsWith('@')) break;
  }
  return targets;
}

/** The finding with the ignored parts taken out, or nothing when nothing is left. */
function filter(
  finding: Finding,
  covering: (kind: FindingKind, file: string, line: number) => Ignore | undefined,
  lineOf: (id: string) => number | undefined,
): Finding | undefined {
  const hit = (file: string, line: number | undefined): boolean => {
    if (line === undefined) return false;
    const ignore = covering(finding.kind, file, line);
    if (ignore) ignore.used = true;
    return !!ignore;
  };

  switch (finding.kind) {
    case 'orphan-file': {
      // Vouching for one symbol in the file vouches for the file: it is loaded.
      const symbols = (finding.evidence?.symbols ?? []) as Array<{ line: number }>;
      return symbols.some((s) => hit(finding.file, s.line)) ? undefined : finding;
    }

    case 'duplicate': {
      // One copy may be deliberate; the others are still copies of each other.
      const members = (finding.evidence?.members ?? []) as Array<{ id: string; file: string; line: number; loc: number }>;
      const remaining = members.filter((m) => !hit(m.file, m.line));
      if (remaining.length === members.length) return finding;
      if (remaining.length < 2) return undefined;
      const loc = remaining
        .map((m) => m.loc)
        .sort((a, b) => a - b)
        .slice(1)
        .reduce((sum, n) => sum + n, 0);
      return {
        ...finding,
        id: `duplicate:${remaining.map((m) => m.id).join('|')}`,
        file: remaining[0].file,
        line: remaining[0].line,
        symbols: remaining.map((m) => m.id),
        loc,
        evidence: { ...finding.evidence, members: remaining },
      };
    }

    case 'drift': {
      const deviants = (finding.evidence?.deviants ?? []) as Array<{ file: string; line: number }>;
      const remaining = deviants.filter((d) => !hit(d.file, d.line));
      if (remaining.length === deviants.length) return finding;
      if (remaining.length === 0) return undefined;
      return { ...finding, evidence: { ...finding.evidence, deviants: remaining } };
    }

    case 'contradiction': {
      const variants = (finding.evidence?.variants ?? []) as Array<{ file: string; line: number; value: string }>;
      const remaining = variants.filter((v) => !hit(v.file, v.line));
      if (remaining.length === variants.length) return finding;
      // With one value left there is nothing to disagree about.
      if (new Set(remaining.map((v) => v.value)).size < 2) return undefined;
      return { ...finding, evidence: { ...finding.evidence, variants: remaining } };
    }

    default: {
      const lines = [finding.line, ...finding.symbols.map(lineOf)];
      return lines.some((line) => hit(finding.file, line)) ? undefined : finding;
    }
  }
}
