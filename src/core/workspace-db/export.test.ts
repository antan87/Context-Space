import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { exportPlanMarkdown, importPlanText, parsePlanText, stripExport, bodyOf, listBlocks, getItem, exportDigest } from './index.js';
import { SAMPLE_PLAN, cleanTemp, openTest, seeded, tempWorkspace, apply, idOf } from './testing.js';

afterEach(cleanTemp);

describe('export round trip', () => {
  it('the sample plan exports byte for byte, ignoring the header and the id comments', async () => {
    const { db } = await seeded();
    const text = exportPlanMarkdown(db);
    expect(text.split('\n')[0]).toMatch(/^<!-- Written by ContextSpace from the workspace database\./);
    expect(stripExport(text)).toBe(SAMPLE_PLAN);
    expect(SAMPLE_PLAN.endsWith('\n')).toBe(false); // the fixture has no trailing newline
    expect(exportDigest(text)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a plan with CRLF line endings (a PLAN.md checked out on Windows) exports byte for byte with CRLF', async () => {
    const crlf = SAMPLE_PLAN.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    expect(crlf).toContain('\r\n');
    const { db } = await seeded(crlf);
    const text = exportPlanMarkdown(db);
    expect(stripExport(text)).toBe(crlf);
    // every line ends with CRLF, the header line too: no bare LF is left
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('the fixture covers what it claims to', async () => {
    const { db } = await seeded();
    const blocks = listBlocks(db);
    const kinds = new Set(blocks.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(['checkpoint', 'decision', 'heading', 'prose', 'step']);
    expect(blocks.some((b) => b.kind === 'prose' && b.text.includes('```bash'))).toBe(true); // fenced code stays prose
    expect(blocks.some((b) => b.kind === 'step' && b.parentId === null)).toBe(true); // a loose item
    expect(blocks.some((b) => b.kind === 'step' && b.parentId !== null && blocks.find((p) => p.id === b.parentId)?.kind === 'step')).toBe(true); // nested steps
    const decision = blocks.find((b) => b.kind === 'decision' && b.name === 'Which format first?')!;
    expect(getItem(db, decision.id)!.decision).toMatchObject({ suggested: ['CSV', 'JSON'], answer: 'CSV' });
    const writeFile = blocks.find((b) => b.name === 'Write the file')!;
    expect(writeFile.detail).toContain('```text'); // fenced code inside a detail stays in the detail
    expect(blocks.filter((b) => b.kind === 'prose').length).toBeGreaterThan(4); // prose between items has a place
  });

  it('each item and heading line ends with its id, prose has none, and the ids are the rows ids', async () => {
    const { db } = await seeded();
    const text = exportPlanMarkdown(db);
    const parsed = parsePlanText(text);
    const blocks = listBlocks(db);
    expect(parsed.blocks.filter((b) => b.kind !== 'prose').map((b) => b.id)).toEqual(blocks.filter((b) => b.kind !== 'prose').map((b) => b.id));
    expect(parsed.header).toMatchObject({ revision: 1 });
    expect(bodyOf(text).includes('<!-- Written by')).toBe(false);
  });

  it('an export read back keeps every id (what a hand-edit import will rely on)', async () => {
    const { db } = await seeded();
    const first = exportPlanMarkdown(db);
    const ws2 = tempWorkspace();
    const db2 = openTest(ws2);
    await importPlanText(db2, first, { by: 'import' });
    const shape = (d: typeof db) => {
      const all = listBlocks(d);
      return all.filter((b) => b.kind !== 'prose').map((b) => [b.id, b.kind, b.parentId]);
    };
    expect(shape(db2)).toEqual(shape(db)); // prose has no id in the file, so it gets a new one
    expect(stripExport(exportPlanMarkdown(db2))).toBe(SAMPLE_PLAN);
  });

  it('a duplicated id in the text is refused, and an import only fills an empty database', async () => {
    const ws = tempWorkspace();
    const db = openTest(ws);
    await expect(importPlanText(db, '- [ ] a <!-- s7k2qa -->\n- [ ] b <!-- s7k2qa -->\n', { by: 'import' })).rejects.toThrow(/same id/);
    await importPlanText(db, '- [ ] a\n', { by: 'import' });
    await expect(importPlanText(db, '- [ ] b\n', { by: 'import' })).rejects.toThrow(/not pristine/);
  });

  it('a change shows in the export with its header revision, and still round-trips what it did not touch', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    await apply(db, [{ op: 'tick', id }]);
    const text = exportPlanMarkdown(db);
    expect(text.split('\n')[0]).toContain('revision=2');
    expect(stripExport(text)).toBe(SAMPLE_PLAN.replace('- [ ] Write the file', '- [x] Write the file'));
  });

  it('empty and newline-only sources round-trip', async () => {
    for (const source of ['', '\n', 'just words', '# Title\n\n\n']) {
      const ws = tempWorkspace();
      const db = openTest(ws);
      await importPlanText(db, source, { by: 'import' });
      expect(stripExport(exportPlanMarkdown(db))).toBe(source);
    }
  });

  it('the committed sample file is what the test reads (guard against a trailing newline sneaking in)', () => {
    expect(readFileSync(new URL('./fixtures/sample-plan.md', import.meta.url), 'utf8')).toBe(SAMPLE_PLAN);
  });
});
