import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { askCard, askText, isAskLine, type AskCard } from './askText.js';

const hasBreak = (line: string) => Array.from(line).some((c) => c.charCodeAt(0) < 32 || c === '\u2028' || c === '\u2029');

describe('askText', () => {
  it('names a note by title and card id', () => {
    expect(askText({ kind: 'note', id: 'card-7', title: 'Export rules' })).toBe('About the board note "Export rules" (card card-7; board_read shows it): ');
  });
  it('falls back from a note title to the start of its text, then to the kind', () => {
    expect(askText({ kind: 'note', id: 'n1', title: '  ', text: 'First words of the body' })).toBe('About the board note "First words of the body" (card n1; board_read shows it): ');
    expect(askText({ kind: 'note', id: 'n1', title: ' ', text: '  ' })).toBe('About this board note (card n1; board_read shows it): ');
  });
  it('names a file or picture by its workspace path, so the CLI can open it', () => {
    expect(askText({ kind: 'file', id: 'f1', title: 'Login screen', path: 'board-pictures/login.png' })).toBe('About board-pictures/login.png (board card "Login screen", f1): ');
    expect(askText({ kind: 'file', id: 'f1', title: '', path: 'a/b.md' })).toBe('About a/b.md (board card f1): ');
  });
  it('names a reader view with no card by its path alone', () => {
    expect(askText({ kind: 'file', path: 'explain/x.md', title: 'explain/x.md' })).toBe('About explain/x.md: ');
    expect(askText({ kind: 'file', path: 'explain/x.md', title: 'How do we save?' })).toBe('About explain/x.md ("How do we save?"): ');
    expect(askText({ kind: 'file', path: '  ' })).toBe('About this file: ');
  });
  it('names a commit by short sha, subject and repository', () => {
    expect(askText({ kind: 'commit', sha: 'abcdef1234567', subject: 'fix: save drafts', repo: 'NexusFlow' })).toBe('About commit abcdef1 "fix: save drafts" in NexusFlow: ');
    expect(askText({ kind: 'commit', sha: 'abcdef1', subject: '' })).toBe('About commit abcdef1: ');
  });
  it('names a plan question without its marks, and the checkpoint', () => {
    expect(askText({ kind: 'question', question: 'Which **time zone** for `export`?', checkpoint: 'Reports' })).toBe("About the plan question \"Which time zone for 'export'?\" (Reports): ");
    expect(askText({ kind: 'question', question: '  ' })).toBe('About the plan question: ');
  });
  it('cuts a long title with an ellipsis, never a path', () => {
    const long = 'x'.repeat(300);
    const note = askText({ kind: 'note', id: 'n', title: long });
    expect(note).toContain(`"${'x'.repeat(79)}…"`);
    const path = `dir/${'p'.repeat(300)}.png`;
    expect(askText({ kind: 'file', path })).toBe(`About ${path}: `);
  });
  it('keeps quotes and backticks from breaking the line', () => {
    const line = askText({ kind: 'note', id: 'n', title: 'say "hi" and `ls`' });
    expect(line).toBe("About the board note \"say 'hi' and 'ls'\" (card n; board_read shows it): ");
  });
  const nasty = 'a\nb\rc\u2028d\u2029e\u0000f\u001bg\td';
  const cards: AskCard[] = [
    { kind: 'note', id: nasty, title: nasty, text: nasty },
    { kind: 'file', id: nasty, title: nasty, path: nasty },
    { kind: 'commit', sha: nasty, subject: nasty, repo: nasty },
    { kind: 'question', question: nasty, checkpoint: nasty },
  ];
  it.each(cards.map((card) => [card.kind, card] as const))('never puts a line break or control character in a %s line, so the CLI never sends early', (_kind, card) => {
    const line = askText(card);
    expect(hasBreak(line)).toBe(false);
    expect(line.endsWith(': ')).toBe(true);
  });
  it('wraps a line so the page types it as it is', () => {
    expect(isAskLine(askCard({ kind: 'note', id: 'n' }))).toBe(true);
    expect(isAskLine('Regarding x')).toBe(false);
  });
});

describe('the callers', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  it.each([
    ['cards/NoteCard.tsx', 2, "kind: 'note'"],
    ['cards/FileCard.tsx', 1, "kind: 'file'"],
    ['BoardNodes.tsx', 3, "kind: 'commit'"],
    ['BoardReader.tsx', 1, "kind: 'file'"],
  ])('%s builds its line with askCard (%i)', (file, count, kind) => {
    const source = read(file);
    expect(source.match(/askInCLI\??\.?\??\(askCard\(|onAskInCLI\(askCard\(/g)?.length).toBe(count);
    expect(source).toContain(kind);
  });
  it('BoardNodes asks about a decision and a commit with their own kinds', () => {
    const source = read('BoardNodes.tsx');
    expect(source.match(/kind: 'question'/g)?.length).toBe(2);
    expect(source).not.toMatch(/commitSummary|noteSummary/);
  });
  it('the page types an AskLine as it is, and still wraps a plain string', () => {
    const page = readFileSync(new URL('../../pages/WorkspacesPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('if (isAskLine(context)) return sendToSession(context.line);');
    expect(page).toContain('`Regarding ${context}: `');
  });
});
