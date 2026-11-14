import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

import { ArchivedWorkspaceError } from './archive-guard.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { BOARD_LIMITS, BoardChangeError, BoardWorkspaceError, changeBoard, readBoard } from './board.js';
import {
  CommitNoteAmbiguousError,
  CommitNoteInputError,
  CommitNoteNotFoundError,
  addCommitNote,
  listCommitNotes,
  queryCommitNotes,
} from './commit-notes.js';

let tempDir: string;
let workspaceDir: string;

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
};

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execa('git', args, { cwd, env: { ...process.env, ...gitEnv, ...env } });
}

async function initRepo(repoPath: string): Promise<string[]> {
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, ['init', '-b', 'main']);
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'first\n');
  await git(repoPath, ['add', 'a.txt']);
  await git(repoPath, ['commit', '-m', 'First commit']);
  const c1 = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

  await fs.writeFile(path.join(repoPath, 'b.txt'), 'second\n');
  await git(repoPath, ['add', 'b.txt']);
  await git(repoPath, ['commit', '-m', 'Second commit'], {
    GIT_AUTHOR_DATE: '2026-10-01T11:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-01T11:00:00Z',
  });
  const c2 = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
  return [c1, c2];
}

async function writeWorkspaceManifest(repos: string[], extra: Record<string, unknown> = {}) {
  await fs.writeFile(
    path.join(workspaceDir, 'contextspace.json'),
    JSON.stringify({
      id: 'cn1-test',
      name: 'cn1-test',
      branchName: 'main',
      repos,
      assistants: [],
      workspacePath: workspaceDir,
      ...extra,
    }),
  );
}

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'commit-notes-test-')));
  workspaceDir = path.join(tempDir, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('commit notes core', () => {
  it('resolves HEAD, HEAD~1, 7-char hash, and full hash, storing card and note link atomically', async () => {
    const repoPath = path.join(workspaceDir, 'App');
    const [c1, c2] = await initRepo(repoPath);
    await writeWorkspaceManifest(['App']);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
    const r1 = await addCommitNote(workspaceDir, {
      commit: c1.slice(0, 7),
      text: '\n\n  Merge conflict in boardRows.ts\nKept both imports and deduplicated props.',
      by: 'claude',
    });

    vi.setSystemTime(new Date('2026-10-10T10:05:00.000Z'));
    const r2 = await addCommitNote(workspaceDir, {
      commit: 'HEAD',
      text: 'Long body text\nwith details.',
      title: 'Explicit title',
      by: 'user',
    });

    vi.setSystemTime(new Date('2026-10-10T10:10:00.000Z'));
    const r3 = await addCommitNote(workspaceDir, {
      commit: c2,
      text: `${'x'.repeat(250)}\nsecond line`,
    });

    expect(r1.note).toMatchObject({
      repo: 'App',
      sha: c1,
      shortSha: c1.slice(0, 7),
      title: 'Merge conflict in boardRows.ts',
      body: 'Merge conflict in boardRows.ts\nKept both imports and deduplicated props.',
      by: 'claude',
    });
    expect(r2.note.by).toBe('ai');
    expect(r2.note.title).toBe('Explicit title');
    expect(r2.note.sha).toBe(c2);
    expect(r3.note.title.length).toBe(BOARD_LIMITS.title);

    const board = await readBoard(workspaceDir);
    expect(board.cards).toHaveLength(3);
    expect(board.links).toHaveLength(3);
    for (const created of [r1, r2, r3]) {
      const card = board.cards.find((entry) => entry.id === created.note.id);
      const link = board.links.find((entry) => entry.from === created.note.id);
      expect(card).toMatchObject({ kind: 'note', about: created.commitNodeId });
      expect(card?.area).toBeUndefined();
      expect(link).toEqual({
        id: expect.any(String),
        from: created.note.id,
        to: created.commitNodeId,
        label: 'note',
        by: created.note.by,
        at: created.note.at,
      });
    }

    const listedAll = await listCommitNotes(workspaceDir);
    expect(listedAll.map((n) => n.id)).toEqual([r3.note.id, r2.note.id, r1.note.id]);

    const listedHeadPrev = await listCommitNotes(workspaceDir, { commit: 'HEAD~1' });
    expect(listedHeadPrev.map((n) => n.id)).toEqual([r1.note.id]);
  });

  it('resolves commits only reachable on remote-tracking refs (refs/remotes/origin/...)', async () => {
    const bareRemote = path.join(tempDir, 'remote.git');
    await git(tempDir, ['init', '--bare', bareRemote]);
    const peerRepo = path.join(tempDir, 'peer');
    await initRepo(peerRepo);
    await git(peerRepo, ['remote', 'add', 'origin', bareRemote]);
    await git(peerRepo, ['push', '-u', 'origin', 'main']);

    const localRepo = path.join(workspaceDir, 'NexusFlow');
    await git(tempDir, ['clone', bareRemote, localRepo]);

    // Peer pushes an extra branch that local does NOT check out, then local fetches only.
    await git(peerRepo, ['checkout', '-b', 'peer-work']);
    await fs.writeFile(path.join(peerRepo, 'peer.txt'), 'incoming\n');
    await git(peerRepo, ['add', 'peer.txt']);
    await git(peerRepo, ['commit', '-m', 'Incoming peer change'], {
      GIT_AUTHOR_DATE: '2026-10-02T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-02T12:00:00Z',
    });
    const remoteSha = (await git(peerRepo, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(peerRepo, ['push', '-u', 'origin', 'peer-work']);
    await git(localRepo, ['fetch', 'origin']);

    await writeWorkspaceManifest(['NexusFlow']);

    const byHash = await addCommitNote(workspaceDir, {
      commit: remoteSha.slice(0, 7),
      text: 'Peer force-pushed migration note',
      by: 'codex',
    });
    const byTrackingRef = await addCommitNote(workspaceDir, {
      commit: 'origin/peer-work',
      text: 'Second note via tracking ref',
      by: 'codex',
    });

    expect(byHash.note.sha).toBe(remoteSha);
    expect(byTrackingRef.note.sha).toBe(remoteSha);

    const fetched = await listCommitNotes(workspaceDir, { commit: remoteSha.slice(0, 7) });
    expect(fetched).toHaveLength(2);
    expect(fetched.map((n) => n.sha)).toEqual([remoteSha, remoteSha]);
  });

  it('errors on ambiguous commits without --repo and succeeds with --repo', async () => {
    const repoA = path.join(workspaceDir, 'RepoA');
    const repoB = path.join(workspaceDir, 'RepoB');
    const [, c2A] = await initRepo(repoA);
    const [, c2B] = await initRepo(repoB);
    expect(c2A).toBe(c2B);

    await writeWorkspaceManifest(['RepoA', 'RepoB']);

    await expect(
      addCommitNote(workspaceDir, { commit: 'HEAD', text: 'Which repo?' }),
    ).rejects.toBeInstanceOf(CommitNoteAmbiguousError);

    await expect(
      addCommitNote(workspaceDir, { commit: c2A.slice(0, 7), text: 'Still ambiguous hash' }),
    ).rejects.toThrow(/multiple repositories.*RepoA, RepoB.*--repo/i);

    const addedB = await addCommitNote(workspaceDir, {
      commit: c2B.slice(0, 7),
      repo: 'RepoB',
      text: 'Pinned to RepoB',
      by: 'gemini',
    });
    expect(addedB.note.repo).toBe('RepoB');
    expect(addedB.note.sha).toBe(c2B);

    await expect(listCommitNotes(workspaceDir, { commit: 'HEAD' })).rejects.toBeInstanceOf(CommitNoteAmbiguousError);
    const listB = await listCommitNotes(workspaceDir, { commit: c2B.slice(0, 7), repo: 'repob' });
    expect(listB.map((n) => n.id)).toEqual([addedB.note.id]);
  });

  it('rejects bad inputs, missing commits, short hashes <7, and unknown repos', async () => {
    const repoPath = path.join(workspaceDir, 'App');
    await initRepo(repoPath);
    await writeWorkspaceManifest(['App']);

    await expect(addCommitNote(workspaceDir, { commit: 'abc123', text: 'Too short' })).rejects.toBeInstanceOf(CommitNoteInputError);
    await expect(addCommitNote(workspaceDir, { commit: '-bad', text: 'Flag injection' })).rejects.toBeInstanceOf(CommitNoteInputError);
    await expect(addCommitNote(workspaceDir, { commit: 'HEAD~1..HEAD', text: 'Range disallowed' })).rejects.toBeInstanceOf(CommitNoteInputError);
    await expect(addCommitNote(workspaceDir, { commit: 'HEAD', text: '   \n  ' })).rejects.toBeInstanceOf(CommitNoteInputError);
    await expect(addCommitNote(workspaceDir, { commit: 'HEAD', text: 'Hi', title: '  ' })).rejects.toBeInstanceOf(CommitNoteInputError);
    await expect(addCommitNote(workspaceDir, { commit: 'HEAD', text: 'Hi', repo: 'Nope' })).rejects.toBeInstanceOf(CommitNoteInputError);
    await expect(addCommitNote(workspaceDir, { commit: 'deadbeef1234', text: 'Missing' })).rejects.toBeInstanceOf(CommitNoteNotFoundError);
    await expect(addCommitNote(path.join(tempDir, 'nonexistent'), { commit: 'HEAD', text: 'Hi' })).rejects.toBeInstanceOf(BoardWorkspaceError);
  });

  it('writes atomically: leaves no partial card when changeBoard rejects link limit', async () => {
    const repoPath = path.join(workspaceDir, 'App');
    const [c1] = await initRepo(repoPath);
    await writeWorkspaceManifest(['App']);

    const { board: initial } = await changeBoard(workspaceDir, [{ op: 'add_card', kind: 'note', title: 'Anchor' }], { by: 'ai' });
    const anchorId = initial.cards[0]!.id;
    const fillerLinks = Array.from({ length: BOARD_LIMITS.links }, (_, i) => ({
      op: 'link' as const,
      from: anchorId,
      to: `commit:App:${i.toString(16).padStart(7, '0')}`,
    }));
    // Batch filler links under MAX_CHANGES_PER_REQUEST (50).
    for (let i = 0; i < fillerLinks.length; i += 50) {
      await changeBoard(workspaceDir, fillerLinks.slice(i, i + 50), { by: 'ai' });
    }

    await expect(
      addCommitNote(workspaceDir, { commit: c1, text: 'Should roll back card + link' }),
    ).rejects.toBeInstanceOf(BoardChangeError);

    const after = await readBoard(workspaceDir);
    expect(after.cards).toHaveLength(1);
    expect(after.links).toHaveLength(BOARD_LIMITS.links);
  });

  it('keeps notes readable after a commit is rebased away and pruned from git', async () => {
    const repoPath = path.join(workspaceDir, 'App');
    const [c1, c2] = await initRepo(repoPath);
    await writeWorkspaceManifest(['App']);

    const added = await addCommitNote(workspaceDir, {
      commit: c2,
      text: 'Conflict decision on doomed commit\nWhy we kept this choice.',
      by: 'claude',
    });

    // Drop c2 (reset to c1) and prune git objects completely so c2 disappears from git.
    await git(repoPath, ['reset', '--hard', c1]);
    await git(repoPath, ['reflog', 'expire', '--expire=now', '--all']);
    await git(repoPath, ['gc', '--prune=now']);

    const checkGone = await git(repoPath, ['rev-parse', '--verify', '-q', `${c2}^{commit}`]).catch((err) => err);
    expect(checkGone.exitCode).not.toBe(0);

    const all = await listCommitNotes(workspaceDir);
    expect(all.map((n) => n.id)).toEqual([added.note.id]);
    expect(all[0]).toMatchObject({
      sha: c2,
      shortSha: c2.slice(0, 7),
      title: 'Conflict decision on doomed commit',
      body: 'Conflict decision on doomed commit\nWhy we kept this choice.',
    });

    const byShortSha = await listCommitNotes(workspaceDir, { commit: c2.slice(0, 7) });
    expect(byShortSha.map((n) => n.id)).toEqual([added.note.id]);

    const viaQuery = await queryCommitNotes(workspaceDir, { repo: 'App', sha: c2.slice(0, 7) });
    expect(viaQuery.map((n) => n.id)).toEqual([added.note.id]);
    expect(await queryCommitNotes(workspaceDir, { repo: 'App', sha: '0000000' })).toEqual([]);
  });

  it('refuses writes on archived workspaces while keeping reads working', async () => {
    const repoPath = path.join(workspaceDir, 'App');
    const [c1] = await initRepo(repoPath);
    await writeWorkspaceManifest(['App']);

    await addCommitNote(workspaceDir, { commit: c1, text: 'Before archive' });
    await writeWorkspaceManifest(['App'], { archivedAt: '2026-10-15T10:00:00.000Z' });

    await expect(addCommitNote(workspaceDir, { commit: c1, text: 'During archive' })).rejects.toBeInstanceOf(ArchivedWorkspaceError);
    expect(await listCommitNotes(workspaceDir)).toHaveLength(1);
  });

  it('prefers the repository containing cwd for HEAD and shared refs, while still asking for --repo outside repos', async () => {
    const appDir = path.join(workspaceDir, 'App');
    const appCopyDir = path.join(workspaceDir, 'App Copy');
    const otherDir = path.join(workspaceDir, 'Other');
    const [, appHead] = await initRepo(appDir);
    await initRepo(appCopyDir);
    await fs.mkdir(otherDir, { recursive: true });
    await git(otherDir, ['init', '-b', 'main']);
    await fs.writeFile(path.join(otherDir, 'other.txt'), 'other\n');
    await git(otherDir, ['add', 'other.txt']);
    await git(otherDir, ['commit', '-m', 'Other only commit'], {
      GIT_AUTHOR_DATE: '2026-10-03T10:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-03T10:00:00Z',
    });
    const otherHead = (await git(otherDir, ['rev-parse', 'HEAD'])).stdout.trim();
    const appNested = path.join(appDir, 'packages', 'core');
    await fs.mkdir(appNested, { recursive: true });

    await writeWorkspaceManifest(['App', 'App Copy', 'Other']);

    // Inside App (and nested subdirectory): HEAD resolves unambiguously to App.
    const cwdSpy = vi.spyOn(process, 'cwd');
    cwdSpy.mockReturnValue(appDir);
    const onApp = await addCommitNote(workspaceDir, { commit: 'HEAD', text: 'Note from App dir' });
    expect(onApp.note.repo).toBe('App');
    expect(onApp.note.sha).toBe(appHead);

    cwdSpy.mockReturnValue(appNested);
    const listedFromNested = await listCommitNotes(workspaceDir, { commit: 'HEAD' });
    expect(listedFromNested.map((n) => n.id)).toEqual([onApp.note.id]);

    // Inside App, a commit that exists only in Other still resolves to Other.
    const onOtherFromApp = await addCommitNote(workspaceDir, { commit: otherHead.slice(0, 7), text: 'Unique to Other' });
    expect(onOtherFromApp.note.repo).toBe('Other');
    expect(onOtherFromApp.note.sha).toBe(otherHead);

    // At workspace root (outside all repos): HEAD still asks for --repo.
    cwdSpy.mockReturnValue(workspaceDir);
    await expect(addCommitNote(workspaceDir, { commit: 'HEAD', text: 'Ambiguous at root' })).rejects.toBeInstanceOf(CommitNoteAmbiguousError);

    // Inside Other, a hash shared by App and App Copy (neither contains cwd) still asks for --repo.
    cwdSpy.mockReturnValue(otherDir);
    await expect(addCommitNote(workspaceDir, { commit: appHead.slice(0, 7), text: 'Ambiguous in App and App Copy' })).rejects.toThrow(/--repo/);
  });

  it('reports an intra-repo ambiguous short hash as "ambiguous, give more characters" rather than "not found"', async () => {
    const repoPath = path.join(workspaceDir, 'App');
    await fs.mkdir(repoPath, { recursive: true });
    await git(repoPath, ['init', '-b', 'main']);
    const emptyTree = (await git(repoPath, ['hash-object', '-t', 'tree', '/dev/null'])).stdout.trim();

    // Find two distinct commit objects sharing the same 7-char SHA-1 prefix in memory (~24 ms).
    const seenPrefixes = new Map<string, string>();
    let firstRaw = '';
    let secondRaw = '';
    let sharedPrefix = '';
    for (let i = 0; i < 200_000; i++) {
      const body = `tree ${emptyTree}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\ncommit-${i}\n`;
      const sha = createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex');
      const prefix = sha.slice(0, 7);
      const prev = seenPrefixes.get(prefix);
      if (prev) {
        firstRaw = prev;
        secondRaw = body;
        sharedPrefix = prefix;
        break;
      }
      seenPrefixes.set(prefix, body);
    }
    expect(sharedPrefix).toHaveLength(7);

    const sha1 = (await execa('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repoPath, input: firstRaw })).stdout.trim();
    const sha2 = (await execa('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repoPath, input: secondRaw })).stdout.trim();
    await git(repoPath, ['update-ref', 'refs/heads/main', sha1]);
    await git(repoPath, ['update-ref', 'refs/heads/alt', sha2]);
    await writeWorkspaceManifest(['App']);

    await expect(addCommitNote(workspaceDir, { commit: sharedPrefix, repo: 'App', text: 'Ambiguous prefix' }))
      .rejects.toThrow(/ambiguous, give more characters/i);
    await expect(addCommitNote(workspaceDir, { commit: sharedPrefix, text: 'Ambiguous prefix' }))
      .rejects.toBeInstanceOf(CommitNoteAmbiguousError);
    await expect(listCommitNotes(workspaceDir, { commit: sharedPrefix }))
      .rejects.toThrow(/ambiguous, give more characters/i);

    // Giving enough characters disambiguates cleanly.
    const unambiguous = await addCommitNote(workspaceDir, { commit: sha2.slice(0, 9), repo: 'App', text: 'Exact match' });
    expect(unambiguous.note.sha).toBe(sha2);
  });
});
