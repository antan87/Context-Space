import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PRIMARY_MANIFEST_FILE } from './constants.js';
import { watchLiveEvents, type LiveEvent } from './screen-events.js';
import { workspaceFilesSignature } from './workspace-files.js';

const POLL = 20;
const FILES_POLL = 40;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let base: string;
let workspace: string;
let repo: string;
let controller: AbortController;
let seen: LiveEvent[];
let running: Promise<void>;

async function writeManifest(repos: string[]) {
  await fs.writeFile(path.join(workspace, PRIMARY_MANIFEST_FILE), JSON.stringify({ id: 'demo', name: 'demo', repos, mode: 'in-place', createdAt: new Date().toISOString() }));
}
/** Starts the feed and waits until it has taken its first look, so what follows is a change. */
async function start() {
  controller = new AbortController();
  seen = [];
  running = (async () => {
    for await (const live of watchLiveEvents(workspace, { signal: controller.signal, pollMs: POLL, filesPollMs: FILES_POLL })) seen.push(live);
  })();
  await sleep(FILES_POLL * 3);
}
const ofType = (type: LiveEvent['type']) => seen.filter((e) => e.type === type);
/** Long enough for several polls of both kinds. */
const settle = () => sleep(FILES_POLL * 5);

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'live-repos-'));
  workspace = path.join(base, 'ws');
  repo = path.join(base, 'repo');
  await fs.mkdir(workspace);
  await fs.mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  await writeManifest([repo]);
});
afterEach(async () => {
  controller?.abort();
  await running?.catch(() => {});
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
});

describe('watchLiveEvents: commits and documents', () => {
  it('says nothing when it starts, and nothing for a write to an unrelated file', async () => {
    await start();
    await fs.writeFile(path.join(repo, 'scratch.txt'), 'untracked, not a commit');
    await fs.mkdir(path.join(workspace, '.contextspace'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.contextspace', 'noise.json'), '{}');
    await fs.mkdir(path.join(workspace, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'node_modules', 'x.js'), '1');
    await settle();
    expect(seen).toEqual([]);
  });

  it('yields commits when a commit lands in a repository of the workspace', async () => {
    await start();
    await fs.writeFile(path.join(repo, 'b.txt'), 'b');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second');
    await settle();
    expect(ofType('commits')).toHaveLength(1);
    expect(ofType('files')).toHaveLength(0);
  });

  it('yields one commits event for a branch switch, and sees a new branch', async () => {
    await start();
    git(repo, 'switch', '-q', '-c', 'feature');
    await settle();
    expect(ofType('commits')).toHaveLength(1);
    git(repo, 'switch', '-q', 'main');
    await settle();
    expect(ofType('commits')).toHaveLength(2);
  });

  it('sees a commit made in a linked worktree', async () => {
    const linked = path.join(base, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
    await writeManifest([linked]);
    await start();
    await fs.writeFile(path.join(linked, 'c.txt'), 'c');
    git(linked, 'add', '.');
    git(linked, 'commit', '-q', '-m', 'in the worktree');
    await settle();
    expect(ofType('commits')).toHaveLength(1);
  });

  it('sees a branch that was packed (packed-refs) being rewritten', async () => {
    await start();
    git(repo, 'pack-refs', '--all');
    await settle();
    expect(ofType('commits').length).toBeGreaterThanOrEqual(1);
  });

  it('gives a burst of commits within one poll one event', async () => {
    await start();
    for (let i = 0; i < 6; i += 1) {
      await fs.writeFile(path.join(repo, `burst${i}.txt`), String(i));
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', `burst ${i}`);
    }
    await settle();
    // The six commits take longer than a poll on a busy machine, so allow a few, but never one per commit with a long quiet after.
    const count = ofType('commits').length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThan(6);
    const after = count;
    await settle();
    expect(ofType('commits')).toHaveLength(after);
  });

  it('yields files for a new document, a changed one and a new folder, and never for repository files', async () => {
    await fs.writeFile(path.join(workspace, 'notes.md'), 'one');
    await start();
    await fs.writeFile(path.join(workspace, 'plan-doc.md'), 'new');
    await settle();
    expect(ofType('files')).toHaveLength(1);
    await sleep(20);
    await fs.writeFile(path.join(workspace, 'notes.md'), 'changed and longer');
    await settle();
    expect(ofType('files')).toHaveLength(2);
    await fs.mkdir(path.join(workspace, 'design'));
    await fs.writeFile(path.join(workspace, 'design', 'spec.md'), 'x');
    await settle();
    expect(ofType('files')).toHaveLength(3);
    // A file inside a repository is not a workspace file.
    await fs.writeFile(path.join(repo, 'inside.md'), 'x');
    await settle();
    expect(ofType('files')).toHaveLength(3);
    expect(ofType('commits')).toHaveLength(0);
  });

  it('gives several new documents written together one files event', async () => {
    await start();
    await Promise.all(Array.from({ length: 20 }, (_, i) => fs.writeFile(path.join(workspace, `doc${i}.md`), String(i))));
    await settle();
    expect(ofType('files')).toHaveLength(1);
  });
});

describe('workspaceFilesSignature', () => {
  it('differs for an added, changed or removed document and ignores hidden, ignored and repository files', async () => {
    await writeManifest([repo]);
    const sig = () => workspaceFilesSignature(workspace);
    const empty = await sig();
    await fs.mkdir(path.join(workspace, 'dist'));
    await fs.writeFile(path.join(workspace, 'dist', 'x.js'), '1');
    await fs.writeFile(path.join(workspace, '.hidden.md'), '1');
    expect(await sig()).toBe(empty);
    await fs.writeFile(path.join(workspace, 'a.md'), '1');
    const one = await sig();
    expect(one).not.toBe(empty);
    await fs.writeFile(path.join(workspace, 'a.md'), '22');
    const changed = await sig();
    expect(changed).not.toBe(one);
    await fs.rm(path.join(workspace, 'a.md'));
    expect(await sig()).toBe(empty);
  });
});
