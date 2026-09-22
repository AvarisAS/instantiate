import {
  buildHistory,
  readHistory,
  sparkline,
  summarise,
  isGitRepo,
  isShallow,
} from '../analysis/history.js';
import { bold, dim, cyan, green, red, yellow } from '../util/term.js';

/**
 * The trend screen. A rising line is the most motivating artefact this tool
 * produces, and a falling one is the only proof that the work paid off.
 */
export async function runTrend(root: string, days: number, points: number, json: boolean): Promise<number> {
  if (!isGitRepo(root)) {
    console.error(`\n${yellow('!')} Not a git repository, so there is no history to walk.\n`);
    return 1;
  }

  if (isShallow(root)) {
    console.error(
      `\n${yellow('!')} This is a shallow clone, so there is only one commit to measure.\n` +
        `  Run ${cyan('git fetch --unshallow')} first — a trend drawn through one point is a straight line that means nothing.\n`,
    );
    return 1;
  }

  const cached = readHistory(root);
  if (!json) {
    console.log(
      `\n${dim(`walking ${points} points across ${days} days` + (cached.length ? ` (${cached.length} already cached)` : ''))}`,
    );
  }

  const series = await buildHistory(root, {
    days,
    points,
    onProgress: (done, total, sha) => {
      if (!json) process.stderr.write(`\r${dim(`  ${done}/${total}  ${sha.slice(0, 8)}`)}   `);
    },
  });
  if (!json) process.stderr.write('\r' + ' '.repeat(40) + '\r');

  if (series.length === 0) {
    console.error(`\n${yellow('!')} No commits found in that window. Try a larger --days.\n`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(series, null, 2));
    return 0;
  }

  console.log(
    `\n${bold(`${series.length} points`)} ${dim(`· ${series[0].date} → ${series[series.length - 1].date}`)}\n`,
  );

  for (const trend of summarise(series)) {
    const worse = trend.growthIsBad ? trend.delta > 0 : trend.delta < 0;
    const colour = trend.delta === 0 ? dim : worse ? red : green;
    const sign = trend.delta > 0 ? '+' : '';
    const change = trend.delta === 0 ? 'no change' : `${sign}${round(trend.delta)}`;

    console.log(
      `  ${trend.label.padEnd(18)} ${cyan(sparkline(trend.values))}  ` +
        `${String(round(trend.first)).padStart(7)} → ${String(round(trend.last)).padStart(7)}  ${colour(change)}`,
    );
  }

  const dead = summarise(series).find((t) => t.label === 'dead lines');
  console.log('');
  if (dead && dead.delta > 0) {
    console.log(
      `  ${red('↑')} Dead code grew by ${round(dead.delta)} lines over this window. ` +
        dim(`Run ${cyan('instantiate dead')} to see what.`),
    );
  } else if (dead && dead.delta < 0) {
    console.log(`  ${green('↓')} Dead code fell by ${round(-dead.delta)} lines. ${dim('Keep going.')}`);
  }
  console.log(dim(`\n  Cached in .instantiate/history.json — commit it to keep the line going.\n`));
  return 0;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
