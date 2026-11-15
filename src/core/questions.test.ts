import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_ANSWER_BYTES, MAX_CHECKED_FILE_BYTES, parseAnswer, parseArea, parseWhere, readQuestions, summarizeAnswers, type QuestionCard } from './questions.js';

describe('parseAnswer', () => {
  it('reads the question, the short answer and the parts in order', () => {
    const answer = parseAnswer([
      '# How do we enforce security?', '', 'Every request is checked.', 'A second line.', '',
      '## Sign-in', 'Text one.', '', 'Text two.', '', '```ts src/a.ts:1-2', 'a', 'b', '```', '', 'After the code.',
      '## Pictures', '![What you see](../board-pictures/x.png)', '', '```mermaid', 'graph TD', 'A-->B', '```',
    ].join('\n'), 'security.md');
    expect(answer.question).toBe('How do we enforce security?');
    expect(answer.summary).toBe('Every request is checked.');
    expect(answer.parts.map((part) => [part.title, part.heading, part.cards.map((card) => card.kind)])).toEqual([
      ['In short', null, ['text']],
      ['Sign-in', 'Sign-in', ['text', 'code', 'text']],
      ['Pictures', 'Pictures', ['picture', 'diagram']],
    ]);
    // Consecutive text, with its blank line, is one card
    expect(answer.parts[1]!.cards[0]).toEqual({ kind: 'text', text: 'Text one.\n\nText two.' });
    expect(answer.parts[2]!.cards[1]).toEqual({ kind: 'diagram', source: 'graph TD\nA-->B' });
  });

  it('makes the question from the file name when there is no # line, and has no In short without a short answer', () => {
    const answer = parseAnswer('## Only a part\nhello', 'how-do-we-ship_it.md');
    expect(answer.question).toBe('How do we ship it');
    expect(answer.summary).toBe('');
    expect(answer.parts.map((part) => part.title)).toEqual(['Only a part']);
  });

  it('skips a front matter block and handles CRLF', () => {
    const answer = parseAnswer('---\r\nowner: ai\r\n---\r\n# Q?\r\n\r\nShort.\r\n\r\n## P\r\n```ts a.ts:3\r\nx\r\n```\r\n', 'q.md');
    expect(answer.question).toBe('Q?');
    expect(answer.summary).toBe('Short.');
    expect(answer.parts[1]!.cards).toEqual([{ kind: 'code', language: 'ts', info: 'a.ts:3', copy: 'x' }]);
  });

  it('keeps a fence that contains other backticks, and headings inside fences', () => {
    const answer = parseAnswer(['# Q', '## P', '````md a.md:1-4', '```ts', '# not a question', '## not a part', '```', '````', 'after'].join('\n'), 'q.md');
    expect(answer.parts.map((part) => part.title)).toEqual(['P']);
    expect(answer.parts[0]!.cards).toEqual([
      { kind: 'code', language: 'md', info: 'a.md:1-4', copy: '```ts\n# not a question\n## not a part\n```' },
      { kind: 'text', text: 'after' },
    ]);
  });

  it('keeps tables, quotes and ### headings as text, and a fence that never closes runs to the end', () => {
    const answer = parseAnswer('# Q\n## P\n### Sub\n> quote\n| a | b |\n\n```ts x.ts:1\nunclosed', 'q.md');
    expect(answer.parts[0]!.cards).toEqual([
      { kind: 'text', text: '### Sub\n> quote\n| a | b |' },
      { kind: 'code', language: 'ts', info: 'x.ts:1', copy: 'unclosed' },
    ]);
  });
});

describe('the Area an answer is about', () => {
  const front = (...lines: string[]) => ['---', ...lines, '---', '# Q?', '', 'Short.'].join('\n');

  it('reads a checkpoint or the plan from the front matter, quoted or not, and still skips the front matter', () => {
    expect(parseArea(front('area: checkpoint:the-board-is-powerful'))).toBe('checkpoint:the-board-is-powerful');
    expect(parseArea(front('owner: ai', 'area: "plan:own"'))).toBe('plan:own');
    expect(parseArea(front("area: 'checkpoint:a_b-1'"))).toBe('checkpoint:a_b-1');
    expect(parseAnswer(front('area: plan:own'), 'q.md')).toMatchObject({ question: 'Q?', summary: 'Short.', area: 'plan:own' });
  });

  it('has none when it is missing or malformed, and never reads a line of the body as front matter', () => {
    for (const value of ['', 'checkpoint:', 'checkpoint:has space', 'plan:other', 'document:abc', 'checkpoint:../x', 'Plan:own', '[plan:own]']) {
      expect(parseArea(front(`area: ${value}`)), value).toBeNull();
    }
    expect(parseArea('# Q?\n\narea: plan:own')).toBeNull();
    expect(parseArea('---\narea: plan:own\n# never closed')).toBeNull();
    expect(parseArea(front('owner: ai'))).toBeNull();
    expect(parseAnswer('# Q', 'q.md').area).toBeNull();
  });

  it('reads a long run of spaces in an area line in linear time', () => {
    const started = Date.now();
    for (const tail of [' '.repeat(40_000), ` plan:own${' '.repeat(40_000)}x`, `${' '.repeat(40_000)}plan:own${' '.repeat(40_000)}`]) {
      parseArea(front(`area:${tail}`));
    }
    expect(parseArea(front(`area:${' '.repeat(40_000)}plan:own${' '.repeat(40_000)}`))).toBe('plan:own');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('accepts what a plan key can be: letters and digits of any language, as `ctxspace explain --areas` offers them', () => {
    for (const key of ['användare-kan-logga-in', 'café-menu-shows-prices', '日本語-計画', 'phase-2']) {
      expect(parseArea(front(`area: checkpoint:${key}`)), key).toBe(`checkpoint:${key}`);
      expect(parseArea(front(`area: "checkpoint:${key}"`)), key).toBe(`checkpoint:${key}`);
    }
    expect(parseArea('---\r\narea: "checkpoint:användare-kan-logga-in"\r\n---\r\n# Q')).toBe('checkpoint:användare-kan-logga-in');
    expect(parseArea(front('area: checkpoint:-leading'))).toBeNull();
    expect(parseArea(front('area: checkpoint:has space'))).toBeNull();
  });
});

describe('parseWhere', () => {
  it('reads a range, a single line, and nothing else', () => {
    expect(parseWhere('NexusFlow/src/a.ts:12-40')).toEqual({ where: 'NexusFlow/src/a.ts', start: 12, end: 40 });
    expect(parseWhere('docs/a.md:7')).toEqual({ where: 'docs/a.md', start: 7, end: 7 });
    expect(parseWhere('')).toBeNull();
    expect(parseWhere('just words')).toBeNull();
    expect(parseWhere('a.ts:0-3')).toBeNull();
    expect(parseWhere('a.ts:9-3')).toBeNull();
  });
});

describe('readQuestions', () => {
  let root: string;
  let outside: string;
  const put = async (name: string, content: string | Buffer, base = root) => {
    await fs.mkdir(path.dirname(path.join(base, name)), { recursive: true });
    await fs.writeFile(path.join(base, name), content);
  };
  const answer = (...blocks: string[]) => ['# Q?', '', 'Short.', '', '## P', ...blocks].join('\n');
  const codeCards = async (file = 'explain/q.md'): Promise<Extract<QuestionCard, { kind: 'code' }>[]> => {
    const found = (await readQuestions(root)).find((entry) => entry.path === file)!;
    return found.parts.flatMap((part) => part.cards).filter((card): card is Extract<QuestionCard, { kind: 'code' }> => card.kind === 'code');
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'questions-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'questions-out-')));
    await put('Repo/src/a.ts', 'one\ntwo\nthree\nfour\n');
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ repos: [path.join(root, 'Repo')], mode: 'in-place' }));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('gives [] with no explain folder and ignores other files and subfolders', async () => {
    expect(await readQuestions(root)).toEqual([]);
    await put('explain/notes.txt', 'x'); await put('explain/sub/deep.md', '# Deep'); await put('explain/ok.md', '# Ok');
    expect((await readQuestions(root)).map((entry) => entry.path)).toEqual(['explain/ok.md']);
  });

  it('says matches for the same lines, also with trailing spaces and CRLF differences', async () => {
    await put('Repo/win.ts', 'a  \r\nb\r\n');
    await put('explain/q.md', answer('```ts Repo/src/a.ts:2-3', 'two  ', 'three', '```', '```ts Repo/win.ts:1-2', 'a', 'b', '```'));
    expect((await codeCards()).map((card) => card.check.status)).toEqual(['matches', 'matches']);
  });

  it('follows a copy that moved within the same file, to the nearest place', async () => {
    await put('explain/q.md', answer('```ts Repo/src/a.ts:1-2', 'two', 'three', '```'));
    const [card] = await codeCards();
    expect(card!.check).toEqual({ status: 'moved', start: 2, end: 3 });
    expect(card).toMatchObject({ repo: 'Repo', file: 'src/a.ts', start: 1, end: 2 });
    expect(card!.repoPath).toBe(path.join(root, 'Repo'));
  });

  it('says changed with the lines now, and a longer or shorter range is a change too', async () => {
    await put('explain/q.md', answer('```ts Repo/src/a.ts:2-3', 'two', 'THREE', '```', '```ts Repo/src/a.ts:90-91', 'zzz', '```'));
    const [changed, beyond] = await codeCards();
    expect(changed!.check).toEqual({ status: 'changed', current: 'two\nthree' });
    expect(beyond!.check).toEqual({ status: 'changed', current: '' });
  });

  it('says gone for a missing file in a repository, and not-in-workspace for an unknown first segment', async () => {
    await put('docs/here.md', 'hello\n');
    await put('explain/q.md', answer(
      '```ts Repo/src/missing.ts:1-1', 'x', '```',
      '```ts Other/src/a.ts:1-1', 'x', '```',
      '```md docs/here.md:1-1', 'hello', '```',
      '```md docs/absent.md:1-1', 'hello', '```',
    ));
    expect((await codeCards()).map((card) => card.check.status)).toEqual(['gone', 'not-in-workspace', 'matches', 'not-in-workspace']);
  });

  it('has no check for a code fence without a place, and shows a diagram as text', async () => {
    await put('explain/q.md', answer('```bash', 'npm test', '```'));
    const [card] = await codeCards();
    expect(card).toMatchObject({ language: 'bash', copy: 'npm test', check: { status: 'none' } });
    expect(card!.where).toBeUndefined();
  });

  it('refuses a path that escapes by .. or by a link, and a file that is too large', async () => {
    await put('secret.txt', 'top secret\n', outside);
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'Repo', 'link.txt'));
    await fs.symlink(outside, path.join(root, 'Repo', 'linkdir'));
    await put('Repo/big.txt', Buffer.alloc(MAX_CHECKED_FILE_BYTES + 10, 97));
    await put('Repo/bin.dat', Buffer.from([1, 0, 2, 0]));
    await put('explain/q.md', answer(
      '```txt Repo/../../secret.txt:1-1', 'top secret', '```',
      '```txt Repo/link.txt:1-1', 'top secret', '```',
      '```txt Repo/linkdir/secret.txt:1-1', 'top secret', '```',
      '```txt Repo/big.txt:1-1', 'a', '```',
      '```txt Repo/bin.dat:1-1', 'a', '```',
      `\`\`\`txt ${path.join(outside, 'secret.txt')}:1-1`, 'top secret', '```',
    ));
    const cards = await codeCards();
    expect(cards.map((card) => card.check.status)).toEqual(['not-in-workspace', 'not-in-workspace', 'not-in-workspace', 'unreadable', 'unreadable', 'not-in-workspace']);
    // What the answer holds is its own copy; nothing of the refused files is read into the reply
    expect(cards.every((card) => card.check.current === undefined)).toBe(true);
  });

  it('is fresh on every read: a changed code file gives a new check, a rewritten answer a new parse', async () => {
    await put('explain/q.md', answer('```ts Repo/src/a.ts:1-1', 'one', '```'));
    expect((await codeCards())[0]!.check.status).toBe('matches');
    await put('Repo/src/a.ts', 'uno\ntwo\n');
    expect((await codeCards())[0]!.check.status).toBe('changed');
    await put('explain/q.md', '# Rewritten\n\nNew short.');
    expect(await readQuestions(root)).toMatchObject([{ question: 'Rewritten', summary: 'New short.' }]);
  });

  it('shows a picture only when it is a picture inside the workspace, named from the answer file', async () => {
    await put('board-pictures/x.png', 'png');
    await put('Repo/shot.png', 'png');
    await fs.symlink(path.join(root, 'board-pictures', 'x.png'), path.join(root, 'board-pictures', 'link.png'));
    await put('explain/q.md', answer('![ok](../board-pictures/x.png)', '', '![gone](../board-pictures/nope.png)', '', '![up](../../x.png)', '', '![web](https://example.com/a.png)', '', '![link](../board-pictures/link.png)', '', '![repo](../Repo/shot.png)', '', '![not a picture](../Repo/src/a.ts)'));
    const found = (await readQuestions(root))[0]!;
    const pictures = found.parts.flatMap((part) => part.cards).filter((card) => card.kind === 'picture');
    expect(pictures.map((card) => (card as { src: string | null }).src)).toEqual(['board-pictures/x.png', null, null, null, null, null, null]);
    expect(pictures[0]).toMatchObject({ alt: 'ok', path: '../board-pictures/x.png' });
  });

  it('orders newest file first and keeps at most 200 answers, each at most 1 MB', async () => {
    for (let i = 0; i < 205; i += 1) {
      await put(`explain/a${String(i).padStart(3, '0')}.md`, `# Q${i}`);
      const at = new Date(2026, 0, 1, 0, 0, i);
      await fs.utimes(path.join(root, 'explain', `a${String(i).padStart(3, '0')}.md`), at, at);
    }
    await put('explain/huge.md', Buffer.alloc(MAX_ANSWER_BYTES + 1, 97));
    const answers = await readQuestions(root);
    expect(answers).toHaveLength(200);
    expect(answers[0]!.question).toBe('Q204');
    expect(answers.some((entry) => entry.path === 'explain/huge.md')).toBe(false);
  });

  it('checks a code block inside a list item against the file, without the fence\'s indentation', async () => {
    await put('Repo/a.ts', 'line 1\nline 2\n');
    await put('explain/q.md', ['# Q?', '', '## P', '1. The first step:', '   ```ts Repo/a.ts:1-2', '   line 1', '     line 2 deeper', '   ```'].join('\n'));
    // Only the fence's own indentation goes; deeper indentation stays
    expect((await codeCards())[0]!.copy).toBe('line 1\n  line 2 deeper');
    await put('explain/q.md', ['# Q?', '', '## P', '1. The first step:', '   ```ts Repo/a.ts:1-2', '   line 1', '   line 2', '   ```'].join('\n'));
    expect((await codeCards())[0]!.check.status).toBe('matches');
  });

  it('does not count a trailing blank line inside a fence as a line of the copy', async () => {
    await put('Repo/a.ts', 'one\ntwo\nthree\n');
    await put('explain/q.md', ['# Q?', '', '## P', '```ts Repo/a.ts:1-2', 'one', 'two', '', '```'].join('\n'));
    const [card] = await codeCards();
    expect(card!.copy).toBe('one\ntwo');
    expect(card!.check.status).toBe('matches');
  });

  it('matches a range that really ends on blank lines in the file', async () => {
    await put('Repo/b.ts', 'one\ntwo\nthree\n\n\nfour\n');
    await put('explain/q.md', answer(
      '```ts Repo/b.ts:2-4', 'two', 'three', '', '```',
      '```ts Repo/b.ts:2-5', 'two', 'three', '```',
      '```ts Repo/b.ts:2-6', 'two', 'three', '```',
      '```ts Repo/b.ts:4-5', '', '```',
    ));
    const [oneBlank, twoBlanks, intoCode, onlyBlank] = await codeCards();
    expect(oneBlank!.check.status).toBe('matches');
    expect(twoBlanks!.check.status).toBe('matches');
    // The range goes on to a line with code that the copy does not have
    expect(intoCode!.check.status).toBe('changed');
    // A copy of nothing but blank lines is never Matches
    expect(onlyBlank!.check.status).toBe('changed');
  });

  it('says Matches only when the range exists and the copy has exactly its lines', async () => {
    await put('Repo/short.ts', 'one\ntwo\nthree\n');
    await put('Repo/ten.ts', Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n'));
    await put('explain/q.md', answer(
      '```ts Repo/short.ts:2-40', 'two', 'three', '```',
      '```ts Repo/ten.ts:50-60', '```',
      '```ts Repo/ten.ts:3-8', 'l3', 'l4', '```',
      '```ts Repo/ten.ts:1-99999999', 'l1', '```',
      '```ts Repo/ten.ts:5-6', 'l5', 'l6', '```',
      '```ts Repo/ten.ts:1-2', 'l7', 'l8', '```',
    ));
    const [pastEnd, empty, shorter, huge, ok, moved] = await codeCards();
    expect(pastEnd!.check).toEqual({ status: 'changed', current: 'two\nthree' });
    expect(empty!.check).toEqual({ status: 'changed', current: '' });
    // A copy of 2 lines for a range of 6 is a change, also where the lines are at the start of the range
    expect(shorter!.check.status).toBe('changed');
    expect(huge!.check.status).toBe('changed');
    expect(ok!.check.status).toBe('matches');
    // Moved is for the exact copy found elsewhere, with its own line count
    expect(moved!.check).toEqual({ status: 'moved', start: 7, end: 8 });
  });

  it('never reads a .git folder, in any case, for code or pictures', async () => {
    await put('Repo/.git/config', '[remote]\nurl = https://token@example.com/x\n');
    await put('.GIT/config', 'secret\n');
    await put('board-pictures/.git/p.png', 'png');
    await put('explain/q.md', answer(
      '```ini Repo/.git/config:1-2', 'wrong', '```',
      '```ini Repo/.Git/config:1-2', 'wrong', '```',
      '```ini .GIT/config:1-1', 'secret', '```',
      '![p](../board-pictures/.git/p.png)',
    ));
    const cards = await codeCards();
    expect(cards.map((card) => card.check)).toEqual([{ status: 'not-in-workspace' }, { status: 'not-in-workspace' }, { status: 'not-in-workspace' }]);
    const picture = (await readQuestions(root))[0]!.parts.flatMap((part) => part.cards).find((card) => card.kind === 'picture') as { src: string | null };
    expect(picture.src).toBeNull();
  });

  it('does not follow an explain folder that is a link', async () => {
    await fs.rm(path.join(root, 'explain'), { recursive: true, force: true });
    await put('leak.md', '# Leak', outside);
    await fs.symlink(outside, path.join(root, 'explain'));
    expect(await readQuestions(root)).toEqual([]);
  });

  it('never writes: the folder looks the same after a read', async () => {
    await put('explain/q.md', answer('```ts Repo/src/a.ts:1-1', 'one', '```'));
    const before = await fs.readdir(root, { recursive: true });
    await readQuestions(root);
    expect(await fs.readdir(root, { recursive: true })).toEqual(before);
  });
});

describe('answers with an area, and the short list of them', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'questions-area-')));
    await fs.mkdir(path.join(root, 'Repo/src'), { recursive: true });
    await fs.mkdir(path.join(root, 'explain'));
    await fs.writeFile(path.join(root, 'Repo/src/a.ts'), 'one\ntwo\nthree\nfour\n');
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ repos: [path.join(root, 'Repo')], mode: 'in-place' }));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('carries the area of each answer, and none for a file that names none or a bad one', async () => {
    await fs.writeFile(path.join(root, 'explain/a.md'), '---\narea: checkpoint:first-step\n---\n# A\n\nShort.');
    await fs.writeFile(path.join(root, 'explain/b.md'), '# B\n\nShort.');
    await fs.writeFile(path.join(root, 'explain/c.md'), '---\narea: nonsense\n---\n# C\n\nShort.');
    const found = Object.fromEntries((await readQuestions(root)).map((entry) => [entry.path, entry.area]));
    expect(found).toEqual({ 'explain/a.md': 'checkpoint:first-step', 'explain/b.md': undefined, 'explain/c.md': undefined });
  });

  it('lists the path, question, area, parts, code blocks and each copy that does not match', async () => {
    await fs.writeFile(path.join(root, 'explain/ok.md'), ['---', 'area: plan:own', '---', '# All good?', '', 'Yes.', '', '## One', '```ts Repo/src/a.ts:2-3', 'two', 'three', '```', '```text', 'plain', '```'].join('\n'));
    await fs.writeFile(path.join(root, 'explain/bad.md'), ['# Some wrong', '', 'Mostly.', '', '## Moved', '```ts Repo/src/a.ts:1-2', 'two', 'three', '```', '## Changed', '```ts Repo/src/a.ts:3-4', 'x', 'y', '```', '## Gone', '```ts Repo/nope.ts:1-1', 'z', '```'].join('\n'));
    const list = summarizeAnswers(await readQuestions(root));
    const ok = list.find((entry) => entry.path === 'explain/ok.md')!;
    const bad = list.find((entry) => entry.path === 'explain/bad.md')!;
    expect(ok).toEqual({ path: 'explain/ok.md', question: 'All good?', area: 'plan:own', parts: ['One'], codeBlocks: 2, notMatching: [] });
    expect(bad).toMatchObject({ question: 'Some wrong', area: null, parts: ['Moved', 'Changed', 'Gone'], codeBlocks: 3 });
    expect(bad.notMatching).toEqual([
      { where: 'Repo/src/a.ts:1-2', status: 'moved', start: 2, end: 3 },
      { where: 'Repo/src/a.ts:3-4', status: 'changed' },
      { where: 'Repo/nope.ts:1', status: 'gone' },
    ]);
  });

  it('is an empty list for no answers', () => {
    expect(summarizeAnswers([])).toEqual([]);
  });
});
