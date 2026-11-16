import { describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { readCommit, CommitTooLargeError } from './commit-detail.js';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../utils/multi-git.js', () => ({ getWorkspaceRepoPaths: async () => [{ name: 'repo', path: '/unused' }] }));

describe('commit detail subprocess lifetime', () => {
  it('waits for the other diff child before rejecting, then permits a normal retry', async () => {
    const sha = 'a'.repeat(40);
    let finishSibling!: () => void;
    let startedSibling = false;
    let fail = true;
    vi.mocked(execa).mockImplementation((_command, args) => {
      const argv = args as string[];
      if (argv[0] === 'rev-parse') return Promise.resolve({ stdout: sha }) as ReturnType<typeof execa>;
      if (argv[0] === 'log') return Promise.resolve({ stdout: `${[sha, 'aaaaaaa', 'Author', '2026-05-01T10:00:00Z', 'Subject', '', 'b'.repeat(40)].join('\0')}` }) as ReturnType<typeof execa>;
      if (fail && argv.includes('--numstat')) return Promise.reject({ isMaxBuffer: true }) as ReturnType<typeof execa>;
      if (fail && argv.includes('--name-status')) {
        startedSibling = true;
        return new Promise(resolve => { finishSibling = () => resolve({ stdout: '' }); }) as ReturnType<typeof execa>;
      }
      return Promise.resolve({ stdout: '' }) as ReturnType<typeof execa>;
    });
    let settled = false;
    const reading = readCommit('/unused', 'repo', sha).finally(() => { settled = true; });
    const rejection = expect(reading).rejects.toBeInstanceOf(CommitTooLargeError);
    await vi.waitFor(() => expect(startedSibling).toBe(true));
    expect(settled).toBe(false);
    finishSibling();
    await rejection;
    fail = false;
    expect((await readCommit('/unused', 'repo', sha)).files).toEqual([]);
  });
});
