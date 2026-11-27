import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { DETAILED_COMMIT_FORMAT, parseDetailedCommitLog, parsePlanStepTrailers } from './commit-log-format.js';

describe('parsePlanStepTrailers', () => {
  it('reads one trailer in the last paragraph', () => {
    expect(parsePlanStepTrailers('Why it matters.\n\nPlan-Step: s7b273\n')).toEqual(['s7b273']);
  });

  it('reads several trailers and drops duplicates, keeping the order', () => {
    expect(parsePlanStepTrailers('Body\n\nPlan-Step: s7b273\nCo-Authored-By: A <a@b.c>\nPlan-Step: c4ynjc\nPlan-Step: s7b273')).toEqual(['s7b273', 'c4ynjc']);
  });

  it('does not care about the case of the key, but the id is lowercase', () => {
    expect(parsePlanStepTrailers('Body\n\nplan-step: s7b273\nPLAN-STEP:   c4ynjc  ')).toEqual(['s7b273', 'c4ynjc']);
    expect(parsePlanStepTrailers('Body\n\nPlan-Step: S7B273')).toEqual([]);
  });

  it('ignores a Plan-Step line that is not in the last paragraph', () => {
    expect(parsePlanStepTrailers('Plan-Step: s7b273\n\nMore words after it.')).toEqual([]);
    expect(parsePlanStepTrailers('Intro\nPlan-Step: s7b273\n\nSigned-off-by: A <a@b.c>')).toEqual([]);
  });

  it('ignores a bad id or extra words on the line', () => {
    expect(parsePlanStepTrailers('B\n\nPlan-Step: x7b273')).toEqual([]);
    expect(parsePlanStepTrailers('B\n\nPlan-Step: s7b27')).toEqual([]);
    expect(parsePlanStepTrailers('B\n\nPlan-Step: s7b2733')).toEqual([]);
    expect(parsePlanStepTrailers('B\n\nPlan-Step: s7b273 and more')).toEqual([]);
    expect(parsePlanStepTrailers('B\n\nPlan-Step:')).toEqual([]);
  });

  it('reads CRLF bodies', () => {
    expect(parsePlanStepTrailers('Body\r\n\r\nPlan-Step: s7b273\r\nPlan-Step: d12345\r\n')).toEqual(['s7b273', 'd12345']);
  });

  it('keeps at most 5 ids', () => {
    const ids = ['s11111', 's22222', 's33333', 's44444', 's55555', 's66666'];
    expect(parsePlanStepTrailers(`B\n\n${ids.map((id) => `Plan-Step: ${id}`).join('\n')}`)).toEqual(ids.slice(0, 5));
  });

  it('stays fast on a 1 MB body', () => {
    const big = `${'word '.repeat(200_000)}\n\n${'Plan-Step:  '.repeat(20_000)}\n\nPlan-Step: s7b273`;
    const started = Date.now();
    expect(parsePlanStepTrailers(big)).toEqual(['s7b273']);
    expect(parsePlanStepTrailers(`${'Plan-Step: s7b273 \n'.repeat(50_000)}`)).toEqual(['s7b273']);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('parseDetailedCommitLog steps', () => {
  const entry = (sha: string, body: string) => `\x00${sha}${'0'.repeat(33)}\x1f${sha}\x1f\x1fAnna\x1f2026-06-17T12:00:00Z\x1fSubject\x1f${body}\x00S: 1 file changed, 1 insertion(+)`;

  it('passes the ids through, and leaves the field out when there are none', () => {
    const commits = parseDetailedCommitLog(`${entry('a1b2c3d', 'Why.\n\nPlan-Step: s7b273\n')}${entry('b1b2c3d', 'Why.\n')}`);
    expect(commits[0]!.steps).toEqual(['s7b273']);
    expect('steps' in commits[1]!).toBe(false);
  });

  it('does not show the trailer as the first line of the description', () => {
    expect(parseDetailedCommitLog(entry('a1b2c3d', 'Plan-Step: s7b273\n'))[0]!.firstBodyLine).toBeUndefined();
    expect(parseDetailedCommitLog(entry('a1b2c3d', 'Real words.\n\nPlan-Step: s7b273\n'))[0]!.firstBodyLine).toBe('Real words.');
  });
});

describe('a commit made in a scratch repository', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('shows its Plan-Step trailer in the log reader', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db4a-trailer-'));
    const env = { GIT_AUTHOR_NAME: 'Anna', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'Anna', GIT_COMMITTER_EMAIL: 'a@example.com' };
    await execa('git', ['init', '-q'], { cwd: dir, env });
    await fs.writeFile(path.join(dir, 'a.txt'), 'a');
    await execa('git', ['add', '.'], { cwd: dir, env });
    await execa('git', ['commit', '-q', '-m', 'feat: add a', '-m', 'Because.', '-m', 'Plan-Step: s7b273\nPlan-Step: c4ynjc'], { cwd: dir, env });
    await fs.writeFile(path.join(dir, 'b.txt'), 'b');
    await execa('git', ['add', '.'], { cwd: dir, env });
    await execa('git', ['commit', '-q', '-m', 'feat: add b'], { cwd: dir, env });
    const { stdout } = await execa('git', ['log', '--shortstat', DETAILED_COMMIT_FORMAT], { cwd: dir, env });
    const [b, a] = parseDetailedCommitLog(stdout);
    expect(a!.subject).toBe('feat: add a');
    expect(a!.steps).toEqual(['s7b273', 'c4ynjc']);
    expect(a!.firstBodyLine).toBe('Because.');
    expect(b!.steps).toBeUndefined();
  });
});
