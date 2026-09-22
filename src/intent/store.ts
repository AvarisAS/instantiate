import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntentRecord } from '../types.js';

/**
 * Per-symbol intent records: why a thing exists and what it is not for.
 *
 * This is the half that code cannot express and humans rarely write down, which
 * is why an agent reaching for a helper guesses instead of reusing. Records live
 * beside the graph rather than in the source, and they are meant to be committed
 * and reviewed: they are the human contribution, not a derived artefact.
 */
export class IntentStore {
  private readonly path: string;
  private records = new Map<string, IntentRecord>();

  constructor(private readonly root: string) {
    this.path = join(root, '.instantiate', 'intent.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as IntentRecord[];
      for (const record of raw) this.records.set(record.symbol, record);
    } catch {
      // A corrupt store must not stop a scan; it is an overlay, not the source.
    }
  }

  save(): void {
    mkdirSync(join(this.root, '.instantiate'), { recursive: true });
    const sorted = [...this.records.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    // Stable ordering keeps the diff readable, since this file is reviewed in PRs.
    writeFileSync(this.path, `${JSON.stringify(sorted, null, 2)}\n`);
  }

  get(symbol: string): IntentRecord | undefined {
    return this.records.get(symbol);
  }

  set(record: Omit<IntentRecord, 'updatedAt'>): IntentRecord {
    const full: IntentRecord = { ...record, updatedAt: Date.now() };
    this.records.set(record.symbol, full);
    return full;
  }

  confirm(symbol: string): IntentRecord | undefined {
    const record = this.records.get(symbol);
    if (!record) return undefined;
    record.status = 'confirmed';
    record.updatedAt = Date.now();
    return record;
  }

  all(): IntentRecord[] {
    return [...this.records.values()];
  }

  /**
   * Which symbols already claim a concept. This is what an agent should consult
   * before writing a new helper, and the only reliable way to stop the fourth
   * `formatDuration` being born.
   */
  search(query: string, limit = 5): IntentRecord[] {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    if (words.length === 0) return [];
    return this.all()
      .map((record) => {
        const haystack = `${record.symbol} ${record.purpose} ${record.notFor}`.toLowerCase();
        const hits = words.filter((w) => haystack.includes(w)).length;
        // A confirmed record outranks a draft at equal relevance: it is trusted.
        return { record, score: hits + (record.status === 'confirmed' ? 0.5 : 0) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.record);
  }
}
