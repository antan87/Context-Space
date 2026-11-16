import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { readQuestions } from '../core/questions.js';

const skillFile = path.resolve(__dirname, '..', '..', 'resources', 'skills', 'contextspace-explain', 'SKILL.md');

describe('the explain skill\'s words', () => {
  let root: string;
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explain-skill-'))); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('has an example answer that really matches when its code is in the file it names', async () => {
    const text = (await fs.readFile(skillFile, 'utf8')).replace(/\r\n/g, '\n');
    const example = /````markdown\n([\s\S]*?)\n````/.exec(text)![1]!;
    const fence = /```ts (\S+):(\d+)-(\d+)\n([\s\S]*?)\n```/.exec(example)!;
    const [, where, start, end, code] = fence as unknown as [string, string, string, string, string];
    const [repo, ...rest] = where.split('/');
    // The file holds the copied lines at exactly the range the fence names
    const lines = Array.from({ length: Number(start) - 1 }, (_, i) => `// filler ${i + 1}`).concat(code.split('\n'));
    expect(lines.length).toBe(Number(end));
    await fs.mkdir(path.join(root, repo!, path.dirname(rest.join('/'))), { recursive: true });
    await fs.writeFile(path.join(root, repo!, ...rest), `${lines.join('\n')}\n`);
    await fs.mkdir(path.join(root, 'explain'));
    await fs.writeFile(path.join(root, 'explain', 'example.md'), example);
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ repos: [path.join(root, repo!)], mode: 'in-place' }));
    const [answer] = await readQuestions(root);
    const cards = answer!.parts.flatMap((part) => part.cards).filter((card) => card.kind === 'code');
    expect(cards.map((card) => (card.kind === 'code' ? card.check.status : ''))).toEqual(['matches']);
    expect(answer!.area).toBe('checkpoint:the-board-shows-the-work');
  });

  it('names the statuses as the command prints them, and the fallback command', async () => {
    const text = (await fs.readFile(skillFile, 'utf8')).replace(/\r\n/g, '\n');
    for (const status of ['changed', 'moved', 'gone', 'not-in-workspace', 'unreadable']) expect(text).toContain(`\`${status}\``);
    expect(text).toContain('./.contextspace/bin/ctxspace');
    expect(text.split('\n').length).toBeLessThan(120);
  });
});
