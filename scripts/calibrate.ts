/**
 * Duplicate-detection calibration, against hand-labelled pairs.
 *
 * Tuning a similarity model on intuition is how it ends up anti-predictive:
 * before this existed the highest-confidence band was *less* accurate than the
 * middle one, and the most actionable finding in a whole run sat at 0.42,
 * beneath seven false positives.
 *
 * Every pair in labelled-pairs.json was judged by reading both bodies in full.
 * The repositories are not vendored — clone them first; pairs whose repository
 * is absent are skipped and reported.
 *
 *     npm run calibrate
 *
 * Read the bands, not only the rate. A change that raises the raw number while
 * flattening the bands has made the tool worse, because ranking is what a user
 * actually sees.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { scan } from '../src/api.js';

interface LabelledPair {
  repo: string;
  a: string;
  b: string;
  want: 'TRUE' | 'FALSE';
}

const here = dirname(fileURLToPath(import.meta.url));
const all = JSON.parse(readFileSync(join(here, 'labelled-pairs.json'), 'utf8')) as LabelledPair[];

const labelled = all.filter((pair) => existsSync(pair.repo));
const missing = [...new Set(all.filter((pair) => !existsSync(pair.repo)).map((p) => p.repo))];
if (missing.length > 0) {
  console.log(`skipping repositories not cloned: ${missing.join(', ')}\n`);
}
if (labelled.length === 0) {
  console.log('None of the labelled repositories are present. Clone them and try again.');
  process.exit(0);
}

/** Highest score any cluster gave to each pair of names, per repository. */
const scored = new Map<string, Map<string, number>>();
for (const repo of [...new Set(labelled.map((p) => p.repo))]) {
  const result = await scan({ root: repo, config: loadConfig(repo) });
  const pairs = new Map<string, number>();
  for (const finding of result.findings.filter((f) => f.kind === 'duplicate')) {
    const names = finding.symbols.map((s) => s.split('#')[1].split('.').pop()!);
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        const key = `${names[i]}|${names[j]}`;
        pairs.set(key, Math.max(pairs.get(key) ?? 0, finding.score));
      }
    }
  }
  scored.set(repo, pairs);
}

const scoreOf = (pair: LabelledPair): number | undefined => {
  const pairs = scored.get(pair.repo)!;
  return pairs.get(`${pair.a}|${pair.b}`) ?? pairs.get(`${pair.b}|${pair.a}`);
};

/** What a user sees: anything below the confidence floor is not acted on. */
const FLOOR = 0.5;

let truePositives = 0;
let falseNegatives = 0;
let falsePositives = 0;
let trueNegatives = 0;

for (const pair of labelled) {
  const score = scoreOf(pair);
  const shown = score !== undefined && score >= FLOOR;
  const correct = pair.want === 'TRUE' ? shown : !shown;
  if (pair.want === 'TRUE') correct ? truePositives++ : falseNegatives++;
  else correct ? trueNegatives++ : falsePositives++;

  console.log(
    `${correct ? ' ok ' : 'MISS'} ${pair.want.padEnd(5)} ` +
      `${(score === undefined ? 'absent' : score.toFixed(2)).padStart(6)}  ${pair.a} ~ ${pair.b}`,
  );
}

const precision = truePositives / (truePositives + falsePositives || 1);
const recall = truePositives / (truePositives + falseNegatives || 1);
console.log(
  `\nTP ${truePositives}  FN ${falseNegatives}  FP ${falsePositives}  TN ${trueNegatives}` +
    `   → precision ${precision.toFixed(2)}  recall ${recall.toFixed(2)}`,
);

console.log('\ncalibration — each band should be more accurate than the one below it:');
for (const [label, low, high] of [
  ['>=0.70', 0.7, 1.01],
  ['0.50-0.69', 0.5, 0.7],
  ['<0.50', 0, 0.5],
] as const) {
  const band = labelled.filter((pair) => {
    const score = scoreOf(pair);
    return score !== undefined && score >= low && score < high;
  });
  const good = band.filter((pair) => pair.want === 'TRUE').length;
  console.log(
    `  ${label.padEnd(10)} n=${String(band.length).padStart(2)}  true=${good}  ` +
      `false=${band.length - good}  precision=${band.length ? (good / band.length).toFixed(2) : '—'}`,
  );
}
