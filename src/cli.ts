#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scan, loadDismissals, saveDismissals, applyDismissals } from './api.js';
import { describeConfig } from './config.js';
import { renderSummary, renderFindings } from './report/terminal.js';
import { readBudget, writeBudget, checkBudget } from './analysis/budget.js';
import { bold, dim, cyan, green, red, yellow } from './util/term.js';
import type { Finding } from './types.js';

const HELP = `
${bold('instantiate')} — see what is actually in your codebase

  ${bold('scan')}                 index and report everything, ranked
  ${bold('dead')}                 code nothing reaches
  ${bold('dupes')}                symbols that do the same job
  ${bold('drift')}                conventions done more than one way
  ${bold('conflicts')}            one fact with two different answers
  ${bold('concepts')}             what this codebase is made of
  ${bold('trend')} [--days n]     how the numbers moved over git history
  ${bold('why')} <symbol>         where a symbol is declared, called and used
  ${bold('report')} [--out f]     write a standalone HTML report
  ${bold('serve')} [--port n]     live UI on localhost
  ${bold('budget')}               record the current numbers as the baseline
  ${bold('check')}                fail if the numbers grew past the baseline
  ${bold('intent')} <cmd>         draft, confirm and read intent records
  ${bold('mcp')}                  run as an MCP server for coding agents
  ${bold('config')}               show the resolved configuration

  ${dim('--root <dir>     project root (default: cwd)')}
  ${dim('--limit <n>      findings to show (default: the noise budget, 20)')}
  ${dim('--days <n>       history window for trend (default: 90)')}
  ${dim('--points <n>     samples across that window (default: 10)')}
  ${dim('--json           machine-readable output')}
  ${dim('--all            ignore dismissals')}
`;

interface Args {
  command: string;
  positional: string[];
  root: string;
  limit?: number;
  json: boolean;
  all: boolean;
  out?: string;
  port: number;
  days: number;
  points: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'scan',
    positional: [],
    root: process.cwd(),
    json: false,
    all: false,
    port: 4321,
    days: 90,
    points: 10,
  };

  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') args.root = resolve(argv[++i] ?? '.');
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--days') args.days = Number(argv[++i]);
    else if (arg === '--points') args.points = Number(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
    else rest.push(arg);
  }

  if (args.command !== 'help' && rest.length > 0) args.command = rest.shift()!;
  args.positional = rest;
  return args;
}

function visible(findings: Finding[], args: Args): Finding[] {
  return args.all ? findings : applyDismissals(findings, loadDismissals(args.root));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    console.log(HELP);
    return 0;
  }

  if (args.command === 'mcp') {
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer(args.root);
    return 0;
  }

  if (args.command === 'trend') {
    const { runTrend } = await import('./report/trend.js');
    return await runTrend(args.root, args.days, args.points, args.json);
  }

  if (args.command === 'config') {
    const { loadConfig } = await import('./config.js');
    console.log(describeConfig(loadConfig(args.root)));
    return 0;
  }

  const result = await scan({ root: args.root });
  const all = visible(result.findings, args);
  const limit = args.limit ?? result.config.maxFindings;

  switch (args.command) {
    case 'scan': {
      if (args.json) {
        console.log(JSON.stringify({ stats: result.stats, findings: all, warnings: result.warnings }, null, 2));
        return 0;
      }
      console.log(renderSummary(result.stats, result.warnings));
      console.log(renderFindings(all, limit));
      console.log(dim(`  ${cyan('instantiate report')} writes a shareable HTML version of this.\n`));
      return 0;
    }

    case 'dead':
    case 'dupes':
    case 'drift':
    case 'conflicts': {
      const kind =
        args.command === 'dupes'
          ? 'duplicate'
          : args.command === 'conflicts'
            ? 'contradiction'
            : args.command;
      const subset = all.filter((f) => f.kind === kind);
      if (args.json) {
        console.log(JSON.stringify(subset, null, 2));
        return 0;
      }
      console.log(renderFindings(subset, limit));
      return 0;
    }

    case 'concepts': {
      if (args.json) {
        console.log(JSON.stringify(result.concepts, null, 2));
        return 0;
      }
      console.log(`\n${bold(`${result.concepts.length} concepts`)}\n`);
      for (const concept of result.concepts) {
        const couples = concept.couples.slice(0, 3).map((c) => result.concepts[c.to]?.name).filter(Boolean);
        console.log(`  ${bold(concept.name.padEnd(28))} ${String(concept.loc).padStart(6)} lines  ${dim(concept.description)}`);
        if (couples.length > 0) console.log(`  ${' '.repeat(28)} ${dim(`→ ${couples.join(', ')}`)}`);
      }
      console.log('');
      return 0;
    }

    case 'why': {
      const query = args.positional[0];
      if (!query) {
        console.error('Usage: instantiate why <symbol name>');
        return 1;
      }
      const { renderWhy } = await import('./report/why.js');
      console.log(renderWhy(result.graph, query, args.root));
      return 0;
    }

    case 'report': {
      const { renderHtmlReport } = await import('./report/html.js');
      const html = renderHtmlReport(result, all);
      const out = args.out ?? join(args.root, '.instantiate', 'report.html');
      mkdirSync(join(args.root, '.instantiate'), { recursive: true });
      writeFileSync(out, html);
      console.log(`\n${green('✓')} ${out} ${dim(`(${(html.length / 1024).toFixed(0)} KB, self-contained)`)}\n`);
      return 0;
    }

    case 'serve': {
      const { serve } = await import('./report/serve.js');
      await serve(args.root, args.port);
      return 0;
    }

    case 'budget': {
      const budget = writeBudget(args.root, result.stats);
      console.log(`\n${green('✓')} baseline recorded — dead ${budget.dead}, duplicate ${budget.duplicate}, drift ${budget.drift}`);
      console.log(dim('  CI now fails only if these grow. Commit .instantiate/budget.json.\n'));
      return 0;
    }

    case 'check': {
      const budget = readBudget(args.root);
      if (!budget) {
        console.error(`\n${yellow('!')} No baseline. Run ${cyan('instantiate budget')} first.\n`);
        return 1;
      }
      const check = checkBudget(budget, result.stats);
      console.log('');
      console.log(check.lines.join('\n'));
      console.log('');
      if (!check.ok) {
        console.error(`${red('✗')} This change adds to the mess. Run ${cyan('instantiate scan')} to see what.\n`);
        return 1;
      }
      console.log(`${green('✓')} within budget\n`);
      return 0;
    }

    case 'dismiss': {
      const id = args.positional[0];
      if (!id) {
        console.error('Usage: instantiate dismiss <finding id>');
        return 1;
      }
      const store = loadDismissals(args.root);
      store.dismissed.push(id);
      saveDismissals(args.root, store);
      console.log(`${green('✓')} dismissed — it will stay hidden across runs`);
      return 0;
    }

    case 'intent': {
      const { runIntentCommand } = await import('./intent/command.js');
      return runIntentCommand(args.positional, result, args.root);
    }

    default:
      console.error(`Unknown command: ${args.command}`);
      console.log(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    // Never process.exit() here: on a pipe, stdout is buffered and exiting
    // discards whatever has not flushed, which silently truncated large
    // --json output midway through.
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\n${red('✗')} ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.DEBUG) console.error(error);
    process.exitCode = 1;
  });
