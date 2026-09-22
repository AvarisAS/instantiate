import type { ScanResult } from '../api.js';
import { IntentStore } from './store.js';
import { bold, dim, cyan, green, yellow } from '../util/term.js';
import type { CodeSymbol } from '../types.js';

const TEST_FILE =
  /(^|\/)(tests?|spec|__tests__|test-d|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/i;

const USAGE = `
${bold('instantiate intent')} — why each thing exists

  ${bold('list')}                    records on file
  ${bold('draft')} [--limit n]       draft records for the most-depended-on symbols
  ${bold('show')} <symbol>           read one record
  ${bold('set')} <symbol> <purpose> [--not-for <text>]
  ${bold('confirm')} <symbol>        mark a draft as human-checked
  ${bold('gaps')}                    load-bearing symbols with no record yet
`;

export interface IntentOptions {
  limit?: number;
}

export function runIntentCommand(
  argv: string[],
  result: ScanResult,
  root: string,
  options: IntentOptions = {},
): number {
  const store = new IntentStore(root);
  const [sub, ...rest] = argv;

  switch (sub) {
    case 'list': {
      const records = store.all();
      if (records.length === 0) {
        console.log(`\nNo intent records yet. ${cyan('instantiate intent draft')} proposes some.\n`);
        return 0;
      }
      console.log('');
      for (const record of records) {
        const badge = record.status === 'confirmed' ? green('✓') : yellow('draft');
        console.log(`  ${badge} ${bold(record.symbol)}`);
        console.log(`      ${record.purpose}`);
        if (record.notFor) console.log(`      ${dim(`not for: ${record.notFor}`)}`);
      }
      console.log('');
      return 0;
    }

    case 'show': {
      const record = store.get(rest[0]) ?? store.search(rest[0] ?? '', 1)[0];
      if (!record) {
        console.log(`\nNo record for ${bold(rest[0] ?? '')}.\n`);
        return 1;
      }
      console.log(`\n${bold(record.symbol)}\n  ${record.purpose}\n  ${dim(`not for: ${record.notFor || '(unstated)'}`)}\n  ${dim(record.status)}\n`);
      return 0;
    }

    case 'set': {
      const symbol = rest[0];
      const notForIndex = rest.indexOf('--not-for');
      const purpose = (notForIndex === -1 ? rest.slice(1) : rest.slice(1, notForIndex)).join(' ');
      const notFor = notForIndex === -1 ? '' : rest.slice(notForIndex + 1).join(' ');
      if (!symbol || !purpose) {
        console.error(USAGE);
        return 1;
      }
      // A record the human typed is confirmed by definition.
      store.set({ symbol, purpose, notFor, status: 'confirmed' });
      store.save();
      console.log(`${green('✓')} recorded`);
      return 0;
    }

    case 'confirm': {
      if (!store.confirm(rest[0])) {
        console.error(`No draft for ${rest[0]}`);
        return 1;
      }
      store.save();
      console.log(`${green('✓')} confirmed`);
      return 0;
    }

    case 'draft': {
      // `--limit` is stripped by the top-level parser before it reaches here,
      // so read the parsed value and fall back to scanning the raw arguments.
      const limitFlag = rest.indexOf('--limit');
      const limit = limitFlag === -1 ? (options.limit ?? 20) : Number(rest[limitFlag + 1]) || 20;
      const targets = loadBearing(result, limit).filter((s) => !store.get(s.symbol.id));

      for (const { symbol, callers } of targets) {
        // A draft states what the code plainly does. The value is in the human
        // correcting it, which takes ten seconds and is the whole point: an
        // uncorrected draft is just the guesswork we are trying to remove.
        store.set({
          symbol: symbol.id,
          purpose: `${symbol.name}: ${describeShape(symbol)}. Used by ${callers} caller${callers === 1 ? '' : 's'}.`,
          notFor: '',
          status: 'draft',
        });
      }
      store.save();
      console.log(`\n${green('✓')} drafted ${targets.length} record${targets.length === 1 ? '' : 's'}`);
      console.log(dim(`  Edit .instantiate/intent.json, then ${cyan('instantiate intent confirm <symbol>')}.`));
      console.log(dim('  A draft nobody confirms is worth nothing — that is the deal.\n'));
      return 0;
    }

    case 'gaps': {
      const gaps = loadBearing(result, 200).filter((s) => !store.get(s.symbol.id));
      console.log(`\n${bold(`${gaps.length} load-bearing symbols with no recorded intent`)}\n`);
      for (const { symbol, callers } of gaps.slice(0, options.limit ?? 25)) {
        console.log(`  ${bold(symbol.name.padEnd(30))} ${dim(`${symbol.file}:${symbol.line} · ${callers} callers`)}`);
      }
      console.log('');
      return 0;
    }

    default:
      console.log(USAGE);
      return sub ? 1 : 0;
  }
}

/**
 * Symbols where a wrong guess costs the most.
 *
 * Not simply the most-referenced: every file in a project mentions its core
 * types and its logging helper, and neither is where an agent's assumption goes
 * wrong. What matters is how much behaviour hangs off a thing — how many
 * callers, weighted by how much it actually does — so a two-line colour helper
 * with sixty callers ranks below a sixty-line function with ten.
 */
function loadBearing(result: ScanResult, limit: number): Array<{ symbol: CodeSymbol; callers: number }> {
  const callers = new Map<string, number>();
  for (const edge of result.graph.edges) {
    callers.set(edge.to, (callers.get(edge.to) ?? 0) + 1);
  }

  const weight = (symbol: CodeSymbol, count: number): number =>
    count * Math.log2(symbol.loc + 2);

  return [...result.graph.symbols.values()]
    .map((symbol) => ({ symbol, callers: callers.get(symbol.id) ?? 0 }))
    .filter(
      (s) =>
        s.callers > 0 &&
        s.symbol.kind !== 'module' &&
        // A one-liner carries no intent worth recording.
        s.symbol.loc >= 4 &&
        // A test helper has many callers and no intent anyone needs written
        // down; it crowded out the library's own public surface.
        !TEST_FILE.test(s.symbol.file),
    )
    .sort(
      (a, b) =>
        weight(b.symbol, b.callers) - weight(a.symbol, a.callers) ||
        a.symbol.id.localeCompare(b.symbol.id),
    )
    .slice(0, limit);
}

function describeShape(symbol: CodeSymbol): string {
  if (symbol.kind === 'function' || symbol.kind === 'method') {
    return `a ${symbol.loc}-line ${symbol.kind} with signature ${symbol.signature}`;
  }
  return `a ${symbol.kind} declared over ${symbol.loc} lines`;
}
