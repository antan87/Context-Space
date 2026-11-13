/**
 * Knowledge on the Board: the words of its index entry, which entry a search or a news line points at, and whether a
 * file is the knowledge file. Pure, so it is tested without the screen.
 */

import { KNOWLEDGE_FILE, LEGACY_KNOWLEDGE_FILE } from '../../brand.js';
import { readableTitle, type KnowledgeEntry } from './knowledgeEntries.js';

const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** What names an entry: its day and its title in plain words. The same entry has the same key after the file is read again. */
export function entryKey(entry: Pick<KnowledgeEntry, 'date' | 'title'>): string {
  return `${entry.date ?? ''}|${normal(readableTitle(entry.title))}`;
}

/** "24 entries", "1 entry"; "No entries yet" when there are none. */
export function knowledgeCountText(total: number): string {
  return total === 0 ? 'No entries yet' : `${total} ${total === 1 ? 'entry' : 'entries'}`;
}

/** "3 new" when something is new since the person looked; nothing otherwise. */
export function knowledgeNewText(fresh: number): string {
  return fresh > 0 ? `${fresh} new` : '';
}

export interface KnowledgeNavItem {
  key: string;
  title: string;
  /** "Decision · 2026-11-13" */
  subtitle: string;
}

const KIND: Record<KnowledgeEntry['kind'], string> = { decision: 'Decision', gotcha: 'Gotcha', assumption: 'Assumption', question: 'Question', note: 'Note' };

/** The entries whose title has the words searched for, in the order the file reader shows them (newest first). Nothing without a search. */
export function knowledgeNavItems(entries: readonly KnowledgeEntry[], query: string): KnowledgeNavItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return entries
    .filter((entry) => [readableTitle(entry.title), entry.title].some((title) => title.toLowerCase().includes(needle)))
    .map((entry) => ({ key: entryKey(entry), title: readableTitle(entry.title), subtitle: [KIND[entry.kind], entry.date].filter(Boolean).join(' · ') }));
}

/**
 * The entry a news line is about, as its key, or null when it cannot name one (the entry is gone, or the file has not been read
 * yet): the line then opens Knowledge at the top. The news names an entry by its day and title.
 */
export function newsEntryKey(entries: readonly KnowledgeEntry[], news: { title: string; date: string | null }): string | null {
  const wanted = normal(news.title);
  const found = entries.find((entry) => (entry.date ?? null) === (news.date ?? null) && (normal(readableTitle(entry.title)) === wanted || normal(entry.title) === wanted));
  return found ? entryKey(found) : null;
}

/** Whether a file the Board is asked to open is the workspace's knowledge file (in the workspace folder, not a repository's). */
export function isKnowledgeFile(path: string, workspacePath?: string): boolean {
  const clean = path.replace(/\\/g, '/');
  const slash = clean.lastIndexOf('/');
  const name = clean.slice(slash + 1);
  if (name !== KNOWLEDGE_FILE && name !== LEGACY_KNOWLEDGE_FILE) return false;
  if (slash < 0) return true;
  const folder = clean.slice(0, slash).replace(/\/+$/, '');
  return Boolean(workspacePath) && folder === workspacePath!.replace(/\\/g, '/').replace(/\/+$/, '');
}
