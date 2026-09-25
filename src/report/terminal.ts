import type { Finding, Stats } from '../types.js';
import { bold, dim, cyan, green, severityColour, bar, plural } from '../util/term.js';

/**
 * Headline numbers count only findings above the confidence floor, because they
 * drive the CI budget. The list below them shows everything, so the two can
 * legitimately disagree — which reads as a contradiction unless it is said out
 * loud.
 */
export function renderSummary(stats: Stats, warnings: string[], shown = 0): string {
  const lines: string[] = [''];
  lines.push(
    `${bold('scanned')} ${plural(stats.files, 'file')}, ${plural(stats.symbols, 'symbol')}, ${plural(stats.edges, 'edge')} ` +
      dim(`(${stats.indexMs}ms index, ${stats.analyseMs}ms analyse)`),
  );
  lines.push('');

  const rows: Array<[string, number, string]> = [
    ['dead', stats.deadLoc, `${stats.deadLoc} lines nothing reaches`],
    ['duplicate', stats.duplicateLoc, `${stats.duplicateLoc} lines of redundant re-implementation`],
    ['drift', stats.driftCount, `${plural(stats.driftCount, 'convention')} done more than one way`],
    ['conflict', stats.contradictionCount, `${plural(stats.contradictionCount, 'value')} stated two different ways`],
    ['unfinished', stats.unfinishedCount, `${plural(stats.unfinishedCount, 'thing')} started and never finished`],
  ];

  for (const [label, value, description] of rows) {
    const share =
      label === 'drift' || label === 'conflict' || label === 'unfinished'
        ? Math.min(value / 5, 1)
        : value / Math.max(stats.loc, 1);
    lines.push(`  ${label.padEnd(10)} ${bar(share, 16)} ${description}`);
  }

  if (stats.loc > 0) {
    const clean = 1 - (stats.deadLoc + stats.duplicateLoc) / stats.loc;
    lines.push('');
    lines.push(`  ${bold('load-bearing')}  ${(clean * 100).toFixed(1)}% of ${stats.loc} lines`);
  }

  const counted =
    stats.deadLoc + stats.duplicateLoc + stats.driftCount + stats.contradictionCount + stats.unfinishedCount;
  if (shown > 0 && counted === 0) {
    lines.push('');
    lines.push(
      `  ${dim('Everything below is under 50% confidence, so none of it counts towards these numbers or the CI budget.')}`,
    );
  }

  for (const warning of warnings) {
    lines.push('');
    lines.push(`  ${bold('!')} ${warning}`);
  }

  return lines.join('\n');
}

/** What each analysis looked for, so an empty result is a result and not a shrug. */
const LOOKED_FOR: Record<string, string> = {
  dead: 'Every symbol is reachable from an entrypoint.',
  'orphan-file': 'No file is unreachable in its entirety.',
  duplicate: 'No two implementations of one idea were found.',
  contradiction:
    'Checked for one environment variable with two fallbacks, one declared ' +
    'constant with different values across files, and dates read as UTC in one ' +
    'place and local time in another. None of those disagree here.',
  drift: 'Error handling, asynchrony, logging, exports and validation are each done one way.',
};

export function renderFindings(findings: Finding[], limit: number, kind?: string): string {
  if (findings.length === 0) {
    const detail = kind ? LOOKED_FOR[kind] : undefined;
    return `\n${green('Nothing to do.')} ${detail ?? 'No findings above the confidence cut-off.'}\n`;
  }

  const shown = findings.slice(0, limit);
  const lines = ['', bold(`${shown.length} of ${findings.length} findings`), ''];

  shown.forEach((finding, i) => {
    const colour = severityColour(finding.severity);
    const rank = dim(String(i + 1).padStart(2));
    lines.push(`${rank} ${colour(finding.severity.padEnd(6))} ${bold(finding.title)}`);
    const unit =
      finding.kind === 'contradiction'
        ? plural(finding.loc, 'site')
        : finding.kind === 'unfinished' && finding.id.endsWith('@unset')
          ? plural(finding.loc, 'frozen branch', 'frozen branches')
          : `${finding.loc} lines`;
    lines.push(`   ${cyan(`${finding.file}:${finding.line}`)} ${dim(`· ${unit} · ${Math.round(finding.score * 100)}% confidence`)}`);
    lines.push(`   ${dim(finding.detail)}`);
    lines.push('');
  });

  if (findings.length > shown.length) {
    lines.push(
      dim(`   ${findings.length - shown.length} more below the noise budget. Raise it with --limit, or open the report.`),
    );
    lines.push('');
  }

  return lines.join('\n');
}
