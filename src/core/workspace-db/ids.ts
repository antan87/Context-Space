/**
 * @module core/workspace-db/ids
 * Ids: a kind letter and five base-32 characters (`s7k2q`). Random, checked against every table and `ids_used`, and
 * never reused, so an id that was once removed can never point at something else.
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Base 32 without i, l, o, u, so an id is easy to read aloud and hard to misread. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export type IdKind = 'checkpoint' | 'step' | 'decision' | 'heading' | 'prose' | 'card';

export const KIND_LETTER: Record<IdKind, string> = {
  checkpoint: 'c',
  step: 's',
  decision: 'd',
  heading: 'h',
  prose: 'p',
  card: 'k',
};

/** What an id of ours looks like. */
export const ID_PATTERN = /^[a-z][0-9a-hjkmnp-tv-z]{5}$/;

/**
 * A fresh id. `taken` holds the ids already handed out inside the current transaction (not yet in `ids_used`).
 * The caller records it with {@link markUsed} when it inserts the row.
 */
export function newId(db: DatabaseSync, kind: IdKind, taken: Set<string> = new Set()): string {
  const letter = KIND_LETTER[kind];
  const used = db.prepare('SELECT 1 FROM ids_used WHERE id = ?');
  const inBlocks = db.prepare('SELECT 1 FROM blocks WHERE id = ?');
  const inCards = db.prepare('SELECT 1 FROM cards WHERE id = ? OR legacy_id = ?');
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const bytes = randomBytes(5);
    let id = letter;
    for (const byte of bytes) id += ALPHABET[byte & 31];
    if (taken.has(id) || used.get(id) || inBlocks.get(id) || inCards.get(id, id)) continue;
    taken.add(id);
    return id;
  }
  throw new Error('Could not find a free id after 1000 tries.');
}

export function markUsed(db: DatabaseSync, id: string): void {
  db.prepare('INSERT OR IGNORE INTO ids_used(id) VALUES (?)').run(id);
}
