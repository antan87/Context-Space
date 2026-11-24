import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';
import { execa } from 'execa';

import {
  addWorkspaceRemote,
  commitWorkspaceArtifacts,
  commitExactWorkspaceArtifacts,
  ensureWorkspaceGitRepository,
  getWorkspaceRemote,
  pullWorkspaceArtifacts,
  pushWorkspaceArtifacts,
  redactRemoteUrl,
} from './workspace-git.js';
import { migrateWorkspace } from './plan-migrate.js';
import { dbPollToken } from './screen-events.js';
import { closeAppDb, readAppDb, restoreBackupForApp } from './workspace-db-app.js';
import { runDbWrite } from './workspace-db-write.js';
import { getRevision } from './workspace-db/index.js';

describe('workspace artifact git', () => {
  let workspacePath: string;
  let remotePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-artifacts-'));
    remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-artifacts-remote-'));
    await execa('git', ['init', '--bare'], { cwd: remotePath });
    await ensureWorkspaceGitRepository(workspacePath);
  });

  afterEach(async () => {
    await fse.remove(workspacePath);
    await fse.remove(remotePath);
  });

  it('commits only the explicitly owned path', async () => {
    await fs.writeFile(path.join(workspacePath, 'nexusflow-knowledge.md'), '# Knowledge\n');
    await fs.writeFile(path.join(workspacePath, 'unrelated.txt'), 'mine\n');
    const result = await commitExactWorkspaceArtifacts(workspacePath, 'remember', ['nexusflow-knowledge.md']);
    expect(result.committed).toBe(true);
    const tracked = await execa('git', ['ls-files'], { cwd: workspacePath });
    expect(tracked.stdout).toContain('nexusflow-knowledge.md');
    expect(tracked.stdout).not.toContain('unrelated.txt');
  });

  it('leaves unrelated pre-staged files out of automatic refresh commits', async () => {
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), '# Context\n');
    await fs.writeFile(path.join(workspacePath, 'unrelated.txt'), 'mine\n');
    await execa('git', ['add', 'unrelated.txt'], { cwd: workspacePath });

    await commitWorkspaceArtifacts(workspacePath, 'refresh');

    const committed = await execa('git', ['show', '--name-only', '--format='], { cwd: workspacePath });
    expect(committed.stdout).toContain('AGENTS.md');
    expect(committed.stdout).not.toContain('unrelated.txt');
    const staged = await execa('git', ['diff', '--cached', '--name-only'], { cwd: workspacePath });
    expect(staged.stdout).toContain('unrelated.txt');
  });

  it('commits the board with the other workspace artifacts, and leaves its change log and lock out', async () => {
    await fs.mkdir(path.join(workspacePath, '.contextspace'), { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'contextspace-board.json'), '{"version":1,"revision":1,"cards":[],"links":[],"positions":{}}\n');
    await fs.writeFile(path.join(workspacePath, '.contextspace', 'board-changes.jsonl'), '{}\n');
    await fs.writeFile(path.join(workspacePath, '.contextspace', 'board.lock'), '{}\n');
    expect((await commitWorkspaceArtifacts(workspacePath, 'refresh')).committed).toBe(true);
    const tracked = (await execa('git', ['ls-files'], { cwd: workspacePath })).stdout.split('\n');
    expect(tracked).toContain('contextspace-board.json');
    expect(tracked).not.toContain('.contextspace/board-changes.jsonl');
    expect(tracked).not.toContain('.contextspace/board.lock');

    await fs.writeFile(path.join(workspacePath, 'contextspace-board.json'), '{"version":1,"revision":2,"cards":[],"links":[],"positions":{}}\n');
    expect((await commitWorkspaceArtifacts(workspacePath, 'refresh again')).committed).toBe(true);
  });

  it('pushes history and refuses to pull over dirty workspace artifacts', async () => {
    await fs.writeFile(path.join(workspacePath, 'nexusflow-knowledge.md'), '# Knowledge\n');
    await commitExactWorkspaceArtifacts(workspacePath, 'remember', ['nexusflow-knowledge.md']);
    await addWorkspaceRemote(workspacePath, remotePath);
    await pushWorkspaceArtifacts(workspacePath);
    const refs = await execa('git', ['show-ref'], { cwd: remotePath });
    expect(refs.stdout).toContain('refs/heads/');

    await fs.appendFile(path.join(workspacePath, 'nexusflow-knowledge.md'), 'dirty\n');
    await expect(pullWorkspaceArtifacts(workspacePath)).rejects.toThrow(/uncommitted changes/);
  });

  it('commits the exact checked export bytes when Git would normalize a CRLF plan', async () => {
    const root = workspacePath;
    await execa('git', ['config', 'core.autocrlf', 'true'], { cwd: root });
    await fs.writeFile(path.join(root, '.gitignore'), '/.contextspace/state.json\n/.contextspace/*.lock\n');
    const planPath = path.join(root, 'PLAN.md');
    await fs.writeFile(planPath, '# Plan\r\n\r\n- [ ] Draft proof\r\n');
    try {
      await migrateWorkspace(root, { by: 'user', findOlderWriters: async () => [], backup: false });
      await commitWorkspaceArtifacts(root, 'Publish exact export bytes');
      const plan = await fs.readFile(planPath, 'utf8');
      const committed = await execa('git', ['cat-file', 'blob', 'HEAD:PLAN.md'], { cwd: root, stripFinalNewline: false });
      expect(plan).toContain('\r\n');
      expect(committed.stdout).toBe(plan);
      expect((await execa('git', ['status', '--porcelain'], { cwd: root })).stdout).toBe('');
    } finally {
      await closeAppDb(root);
    }
  });

  it('publishes several database changes per commit and takes successive clean Git pulls', async () => {
    const root = workspacePath;
    const dot = '.contextspace';
    const data = 'contextspace-data.json';
    const git = async (cwd: string, ...args: string[]) => (await execa('git', args, { cwd })).stdout;
    await fs.writeFile(path.join(root, '.gitignore'), '/.contextspace/state.json\n/.contextspace/*.lock\n');
    await fs.writeFile(path.join(root, 'PLAN.md'), '# Plan\n\n## Steps\n\n- [ ] First\n- [ ] Second\n- [ ] Third\n');
    await migrateWorkspace(root, { by: 'user', findOlderWriters: async () => [], backup: false });
    await dbPollToken(root);
    expect((await commitWorkspaceArtifacts(root, 'Publish the moved workspace')).committed).toBe(true);
    expect(await git(root, 'ls-files', data)).toBe(data);
    await addWorkspaceRemote(root, remotePath);
    await git(root, 'push', 'origin', 'HEAD:main');

    const recipient = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-pull-'));
    const current = (cwd: string) => readAppDb(cwd, (view) => ({
      ...getRevision(view),
      steps: view.sqlite.prepare("SELECT id, rev, done FROM blocks WHERE kind = 'step' ORDER BY ord").all() as Array<{ id: string; rev: number; done: number }>,
    }));
    const tick = async (cwd: string, index: number, done: boolean) => {
      const { steps, dbId, revision } = await current(cwd);
      const result = await runDbWrite(cwd, { type: 'batch', ops: [{ op: done ? 'tick' : 'untick', id: steps[index]!.id, rev: steps[index]!.rev }], options: { by: 'user', dbId, ifRevision: revision } });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    };
    const committed = async (cwd: string, file: string) => git(cwd, 'show', `HEAD:${file}`);
    try {
      await git(recipient, 'clone', '-b', 'main', remotePath, '.');
      await fs.cp(path.join(root, dot), path.join(recipient, dot), { recursive: true });
      const base = JSON.parse(await committed(root, data));
      const initial = await current(recipient);
      await tick(root, 0, true);
      await tick(root, 1, true);
      expect(JSON.parse(await fs.readFile(path.join(root, data), 'utf8')).base).toEqual({
        db_id: base.db_id, revision: base.revision, digest: base.digest,
      });
      await commitWorkspaceArtifacts(root, 'Publish two changes together');
      await git(root, 'push', 'origin', 'HEAD:main');
      await pullWorkspaceArtifacts(recipient);
      expect((await current(recipient)).steps.map((step) => step.done)).toEqual([1, 1, 0]);
      expect((await current(recipient)).revision).toBe(initial.revision + 1);
      expect(await git(recipient, 'status', '--porcelain')).toBe('');

      await tick(root, 2, true);
      await commitWorkspaceArtifacts(root, 'Publish the next change');
      await git(root, 'push', 'origin', 'HEAD:main');
      // An ordinary Git pull reaches the same reconciliation through the app poll.
      await git(recipient, 'pull', '--rebase', 'origin', 'main');
      await dbPollToken(recipient);
      expect((await current(recipient)).steps.map((step) => step.done)).toEqual([1, 1, 1]);
      expect((await current(recipient)).revision).toBe(initial.revision + 2);
      expect(await git(recipient, 'status', '--porcelain')).toBe('');
      expect((await runDbWrite(recipient, { type: 'draft-list' })).drafts).toEqual([]);
      const archived = await fs.readdir(path.join(recipient, dot, 'drafts'));
      expect(archived.length).toBeGreaterThan(0);
      const localFiles = await git(recipient, 'ls-files', '--', `${dot}/drafts`, `${dot}/.export-*`);
      expect(localFiles).toBe('');

      const head = await git(recipient, 'rev-parse', 'HEAD');
      const stray = `${dot}/workspace.db-shadow`;
      await fs.writeFile(path.join(root, stray), 'must stay local');
      await git(root, 'add', '-f', '--', stray);
      await git(root, 'commit', '-m', 'Invalid remote database artifact', '--', stray);
      await git(root, 'push', 'origin', 'HEAD:main');
      await expect(pullWorkspaceArtifacts(recipient)).rejects.toThrow(/contains local database files/);
      expect(await git(recipient, 'rev-parse', 'HEAD')).toBe(head);
      await expect(fs.access(path.join(recipient, stray))).rejects.toMatchObject({ code: 'ENOENT' });

      // The sender's greater revision is provenance, while local writes use the recipient's revision.
      await tick(recipient, 0, false);
      expect(await fs.readFile(path.join(recipient, 'PLAN.md'), 'utf8')).toContain('- [ ] First');
      await fs.writeFile(path.join(recipient, 'unrelated.txt'), 'Keep this dirty file');
      await expect(pullWorkspaceArtifacts(recipient)).rejects.toThrow(/uncommitted changes/);
      await fs.unlink(path.join(recipient, 'unrelated.txt'));
      await fs.appendFile(path.join(recipient, 'PLAN.md'), '\nA hand edit.\n');
      await fs.writeFile(path.join(recipient, 'AGENTS.md'), '# Workspace\n');
      expect((await commitWorkspaceArtifacts(recipient, 'Refresh the generated context')).committed).toBe(true);
      expect(await git(recipient, 'show', '--name-only', '--format=')).toBe('AGENTS.md');
      expect(await committed(recipient, 'PLAN.md')).not.toContain('A hand edit.');
    } finally {
      await closeAppDb(root);
      await closeAppDb(recipient);
      await fs.rm(recipient, { recursive: true, force: true });
    }
  });

  it('takes skipped Git publications and records a divergent snapshot without rewriting the local branch', async () => {
    const source = workspacePath;
    const git = async (cwd: string, ...args: string[]) => (await execa('git', args, { cwd })).stdout;
    const write = (cwd: string, file: string, text: string) => fs.writeFile(path.join(cwd, file), text);
    const read = (cwd: string, file: string) => fs.readFile(path.join(cwd, file), 'utf8');
    const state = (cwd: string) => readAppDb(cwd, (db) => ({
      ...getRevision(db),
      rows: db.sqlite.prepare("SELECT id, rev, done FROM blocks WHERE kind = 'step' ORDER BY ord").all() as Array<{ id: string; rev: number; done: number }>,
    }));
    const done = async (cwd: string) => (await state(cwd)).rows.map((step) => step.done);
    const tick = async (cwd: string, index: number) => {
      const { rows, revision, dbId } = await state(cwd);
      const { id, rev } = rows[index]!;
      const result = await runDbWrite(cwd, { type: 'batch', ops: [{ op: 'tick', id, rev }], options: { by: 'user', ifRevision: revision, dbId } });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    };
    const recipients: string[] = [];
    try {
      await write(source, '.gitignore', '/.contextspace/state.json\n/.contextspace/*.lock\n');
      await write(source, 'PLAN.md', '# Plan\n\n## Steps\n\n- [ ] First\n- [ ] Second\n- [ ] Local only\n');
      await migrateWorkspace(source, { by: 'user', findOlderWriters: async () => [], backup: false });
      await commitWorkspaceArtifacts(source, 'Base');
      await addWorkspaceRemote(source, remotePath);
      await git(source, 'push', 'origin', 'HEAD:main');
      const clone = async (autocrlf: boolean) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-pull-'));
        recipients.push(root);
        await git(root, 'clone', '-c', `core.autocrlf=${autocrlf}`, '-b', 'main', remotePath, '.');
        await fs.cp(path.join(source, '.contextspace'), path.join(root, '.contextspace'), {
          recursive: true, filter: (file) => path.basename(file) !== '.gitignore',
        });
        return root;
      };
      const clean = await clone(false);
      const direct = await clone(true);
      const dirty = await clone(false);
      const committed = await clone(false);
      const newlineEdit = await clone(false);
      const expectNoDrafts = async (cwd: string) => expect((await runDbWrite(cwd, { type: 'draft-list' })).drafts).toEqual([]);
      expect(await read(direct, 'PLAN.md')).toContain('\r\n');
      await dbPollToken(direct);
      await expectNoDrafts(direct);
      expect(await git(direct, 'status', '--porcelain')).toBe('');
      await write(newlineEdit, 'PLAN.md', (await read(newlineEdit, 'PLAN.md')).replace(/\r?\n/g, '\r\n'));
      const newlineDrafts = (await runDbWrite(newlineEdit, { type: 'draft-list' })).drafts;
      expect(newlineDrafts.map((draft) => draft.file)).toEqual(['PLAN.md']);

      for (const cwd of [dirty, committed]) await tick(cwd, 2);
      const backup = path.join(remotePath, 'before-git-draft.db');
      await closeAppDb(dirty);
      await fs.copyFile(path.join(dirty, '.contextspace', 'workspace.db'), backup);
      await commitWorkspaceArtifacts(committed, 'Local-only plan commit');
      for (const [index, message] of ['First remote change', 'Second remote change'].entries()) {
        await tick(source, index);
        await commitWorkspaceArtifacts(source, message);
      }
      await git(source, 'push', 'origin', 'HEAD:main');

      expect(await pullWorkspaceArtifacts(clean)).toEqual({ status: 'pulled' });
      await git(direct, 'pull', '--rebase', 'origin', 'main');
      await dbPollToken(direct);
      for (const cwd of [clean, direct]) {
        expect(await done(cwd)).toEqual([1, 1, 0]);
        expect(await git(cwd, 'status', '--porcelain')).toBe('');
        await expectNoDrafts(cwd);
      }
      for (const cwd of [dirty, committed]) {
        const before = await Promise.all([git(cwd, 'rev-parse', 'HEAD'), git(cwd, 'status', '--porcelain'), read(cwd, 'PLAN.md'), read(cwd, 'contextspace-data.json')]);
        const result = await pullWorkspaceArtifacts(cwd);
        expect(result).toMatchObject({ status: 'draft', pending: true });
        if (result.status !== 'draft') throw new Error('Expected a pending Git draft.');
        expect(await Promise.all([git(cwd, 'rev-parse', 'HEAD'), git(cwd, 'status', '--porcelain'), read(cwd, 'PLAN.md'), read(cwd, 'contextspace-data.json')])).toEqual(before);
        expect(await done(cwd)).toEqual([0, 0, 1]);
        const { drafts } = await runDbWrite(cwd, { type: 'draft-list' });
        expect(drafts).toEqual([expect.objectContaining({ digest: result.digest, file: 'contextspace-data.json' })]);
        if (cwd === dirty) {
          await restoreBackupForApp(cwd, backup);
          expect(await done(cwd)).toEqual([0, 0, 1]);
          expect((await runDbWrite(cwd, { type: 'draft-list' })).drafts).toEqual(drafts);
        }
        const preview = await runDbWrite(cwd, { type: 'draft-preview', digest: result.digest });
        expect(preview.baseKnown).toBe(true);
        expect(preview.changes).toHaveLength(2);
        expect(preview.changes.every((change) => !change.conflict)).toBe(true);
        expect(await runDbWrite(cwd, { type: 'draft-import', digest: result.digest, token: preview.token, by: 'tester' })).toMatchObject({ ok: true });
        expect(await done(cwd)).toEqual([1, 1, 1]);
      }
    } finally {
      for (const cwd of [source, ...recipients]) await closeAppDb(cwd);
      for (const cwd of recipients) await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('workspace remote status', () => {
  let workspacePath: string;
  let remotePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-remote-status-'));
    remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-remote-status-bare-'));
    await execa('git', ['init', '--bare'], { cwd: remotePath });
  });

  afterEach(async () => {
    await fse.remove(workspacePath);
    await fse.remove(remotePath);
  });

  it('has no remote in a folder that is not its own git repository', async () => {
    expect(await getWorkspaceRemote(workspacePath)).toEqual({ state: 'none' });
  });

  it('has no remote in a fresh artifact repository', async () => {
    await ensureWorkspaceGitRepository(workspacePath);
    expect(await getWorkspaceRemote(workspacePath)).toEqual({ state: 'none' });
  });

  it('reports the remote once it is added, and reading it pushes nothing', async () => {
    await ensureWorkspaceGitRepository(workspacePath);
    await addWorkspaceRemote(workspacePath, remotePath);

    expect(await getWorkspaceRemote(workspacePath)).toEqual({ state: 'configured', name: 'origin', url: remotePath });
    const refs = await execa('git', ['for-each-ref'], { cwd: remotePath });
    expect(refs.stdout).toBe('');
  });

  it('prefers origin, and otherwise names the one remote it has', async () => {
    await ensureWorkspaceGitRepository(workspacePath);
    await execa('git', ['remote', 'add', 'backup', remotePath], { cwd: workspacePath });
    expect(await getWorkspaceRemote(workspacePath)).toMatchObject({ state: 'configured', name: 'backup' });

    await execa('git', ['remote', 'add', 'origin', remotePath], { cwd: workspacePath });
    expect(await getWorkspaceRemote(workspacePath)).toMatchObject({ state: 'configured', name: 'origin' });
  });

  it('does not credit a workspace with the remote of a git repository it only sits inside', async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-remote-status-outer-'));
    try {
      await execa('git', ['init'], { cwd: outer });
      await execa('git', ['remote', 'add', 'origin', remotePath], { cwd: outer });
      const inner = path.join(outer, 'workspace');
      await fs.mkdir(inner);

      expect(await getWorkspaceRemote(inner)).toEqual({ state: 'none' });
    } finally {
      await fse.remove(outer);
    }
  });

  it('never shows a credential embedded in the remote URL', async () => {
    await ensureWorkspaceGitRepository(workspacePath);
    await execa('git', ['remote', 'add', 'origin', 'https://someone:ghp_secrettoken@example.com/team/notes.git'], { cwd: workspacePath });

    const remote = await getWorkspaceRemote(workspacePath);

    expect(remote).toEqual({ state: 'configured', name: 'origin', url: 'https://***@example.com/team/notes.git' });
    expect(JSON.stringify(remote)).not.toContain('ghp_secrettoken');
  });

  it('redacts only embedded credentials and leaves ordinary URLs alone', () => {
    expect(redactRemoteUrl('https://user:token@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(redactRemoteUrl('ssh://git@host.example/a/b.git')).toBe('ssh://***@host.example/a/b.git');
    expect(redactRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(redactRemoteUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(redactRemoteUrl('/srv/git/notes.git')).toBe('/srv/git/notes.git');
  });
});
