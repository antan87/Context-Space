/** Durable, local margin notes. The lock covers read, recovery, cap and atomic replacement. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { acquireLock } from './locks.js';
import { assertNoLinkedPathComponents, atomicWriteFile } from '../resources/fs-safety.js';
import { assertWorkspaceActive } from './archive-guard.js';
import { loadFeatureConfig } from './workspace.js';

export const LINE_NOTES_CAP = 500;
const relative = z.string().min(1).max(4096).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(v => v === '..' || v === '.') && !/[\x00-\x1f]/.test(p));
const schema = z.object({
  id: z.string().min(1).max(100), path: relative, repo: z.string().min(1).max(200).optional(),
  line: z.number().int().min(1).max(10_000_000), endLine: z.number().int().min(1).max(10_000_000),
  text: z.string().min(1).max(500), tag: z.enum(['question', 'risk', 'todo']),
  harness: z.string().min(1).max(40), createdAt: z.iso.datetime(), doneAt: z.iso.datetime().optional(),
  anchor: z.string().max(4096), anchorCut: z.boolean(),
}).refine(n => n.endLine >= n.line);
export type LineNote = z.infer<typeof schema>;
export type NewLineNote = Omit<LineNote, 'id' | 'createdAt' | 'doneAt'>;
const storeSchema = z.object({ version: z.literal(1), notes: z.array(schema).max(LINE_NOTES_CAP) });
const fileOf = (root: string) => path.join(root, '.contextspace/line-notes.json');

export async function readLineNotes(root: string): Promise<LineNote[]> {
  const file = fileOf(root);
  await assertNoLinkedPathComponents(root, file);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  try { return storeSchema.parse(JSON.parse(text)).notes; }
  catch { throw new Error('The line notes file is damaged. The next save will keep it aside for recovery.'); }
}

async function change<T>(root: string, apply: (notes: LineNote[]) => T): Promise<T> {
  assertWorkspaceActive(await loadFeatureConfig(root), 'change line notes');
  const file = fileOf(root);
  const lock = `${file}.lock`;
  await assertNoLinkedPathComponents(root, file);
  await assertNoLinkedPathComponents(root, lock);
  const release = await acquireLock(lock, { staleMs: 30_000, timeoutMs: 10_000, timeoutMessage: 'Another writer is saving line notes. Retry.' });
  try {
    let notes: LineNote[];
    try { notes = await readLineNotes(root); }
    catch (e) {
      if (!(e instanceof Error) || !e.message.includes('file is damaged')) throw e;
      await fs.rename(file, `${file}.damaged-${Date.now()}-${randomUUID()}`);
      notes = [];
    }
    const result = apply(notes);
    // Existing workspaces predate this store: keep local notes (including recovery copies) ignored there too.
    const ignore = path.join(root, '.contextspace/.gitignore');
    await assertNoLinkedPathComponents(root, ignore);
    const ignored = await fs.readFile(ignore, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    if (!ignored.split(/\r?\n/).includes('line-notes.json*')) await atomicWriteFile(ignore, `${ignored}${ignored && !ignored.endsWith('\n') ? '\n' : ''}line-notes.json*\n`, () => assertNoLinkedPathComponents(root, ignore));
    await atomicWriteFile(file, JSON.stringify({ version: 1, notes }) + '\n', () => assertNoLinkedPathComponents(root, file));
    return result;
  } finally { await release(); }
}

export function addLineNote(root: string, input: NewLineNote): Promise<LineNote> {
  const note = schema.parse({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
  return change(root, notes => {
    const duplicate = notes.find(n => !n.doneAt && n.path === note.path && n.repo === note.repo && n.line === note.line && n.endLine === note.endLine && n.text === note.text && n.tag === note.tag && n.harness === note.harness && n.anchor === note.anchor && Date.parse(note.createdAt) - Date.parse(n.createdAt) < 60_000);
    if (duplicate) return duplicate;
    if (notes.length >= LINE_NOTES_CAP) {
      const finished = notes.map((n, i) => ({ n, i })).filter(v => v.n.doneAt).sort((a, b) => a.n.doneAt!.localeCompare(b.n.doneAt!))[0];
      if (!finished) throw new Error('The 500 open note limit is full. Mark a note Done first.');
      notes.splice(finished.i, 1);
    }
    notes.push(note); return note;
  });
}
export function finishLineNote(root: string, id: string): Promise<LineNote> {
  return change(root, notes => {
    const note = notes.find(n => n.id === id);
    if (!note) throw new Error('Note not found.');
    note.doneAt ??= new Date().toISOString(); return note;
  });
}

/** Preserve exact source lines, bounded even for a single very long line. */
export function lineAnchor(content: string, line: number, endLine: number): { anchor: string; anchorCut: boolean } {
  const lines = content.replace(/\r\n/g, '\n').split('\n').slice(line - 1, endLine);
  const first = lines.slice(0, 40).join('\n');
  return { anchor: first.slice(0, 4096), anchorCut: lines.length > 40 || first.length > 4096 };
}
