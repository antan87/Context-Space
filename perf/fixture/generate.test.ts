import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateFixture, removeFixture } from './generate.mjs';

// Small enough to build twice well within the test timeout on Windows runners.
const TINY = {
  repos: [{ files: 60 }],
  workspaces: 2,
  reposPerWorkspace: 1,
  dirtyWorktrees: 1,
  untrackedInSource: 5,
  codex: { rollouts: 4, totalMB: 0.2, maxMB: 0.1, matching: 2 },
  claude: { transcripts: 2, totalMB: 0.1, maxMB: 0.06, workspaces: 1 },
};

describe('perf fixture generator', () => {
  const roots: string[] = [];
  const outDir = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-perf-fixture-'));
    roots.push(dir);
    return path.join(dir, 'fx');
  };

  afterEach(async () => {
    for (const dir of roots.splice(0)) {
      await removeFixture(path.join(dir, 'fx'));
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reproduces the same tree and commits for the same tier and seed', async () => {
    // Same-length output paths keep embedded absolute paths the same size.
    const [a, b] = [await outDir(), await outDir()];
    const first = await generateFixture({ tier: 'S', spec: TINY, seed: 7, out: a });
    const second = await generateFixture({ tier: 'S', spec: TINY, seed: 7, out: b });

    expect(second.treeDigest).toBe(first.treeDigest);
    expect(second.repos).toEqual(first.repos);
    expect(first.workspaces).toBe(2);
    expect(first.codex.bytes).toBeGreaterThan(150 * 1024);
  }, 90_000);

  it('changes the data when the seed changes', async () => {
    const first = await generateFixture({ tier: 'S', spec: TINY, seed: 1, out: await outDir() });
    const second = await generateFixture({ tier: 'S', spec: TINY, seed: 2, out: await outDir() });

    expect(second.treeDigest).not.toBe(first.treeDigest);
  }, 90_000);

  it('writes a config that points the app at the fixture only', async () => {
    const out = await outDir();
    const manifest = await generateFixture({ tier: 'S', spec: TINY, out });
    const config = JSON.parse(await fs.readFile(path.join(manifest.home, '.contextspace', 'config.json'), 'utf8'));

    expect(config.workspacesDir.startsWith(manifest.home)).toBe(true);
    expect(config.devDir.startsWith(manifest.home)).toBe(true);
    const workspaceManifest = JSON.parse(
      await fs.readFile(path.join(config.workspacesDir, 'perf-ws-000', 'contextspace.json'), 'utf8'),
    );
    expect(workspaceManifest.repos.every((repo: string) => repo.startsWith(manifest.home))).toBe(true);
  });

  it('refuses to write into a non-empty directory', async () => {
    const out = await outDir();
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'keep.txt'), 'user data');

    await expect(generateFixture({ tier: 'S', spec: TINY, out })).rejects.toThrow(/not empty/);
    expect(await fs.readFile(path.join(out, 'keep.txt'), 'utf8')).toBe('user data');
  });

  it('injects the missing-path fault and removes an unreadable fixture cleanly', async () => {
    const out = await outDir();
    const manifest = await generateFixture({ tier: 'S', spec: TINY, out, faults: true });

    expect(manifest.faults).toContain('missing-repo');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      expect(manifest.faults).toContain('unreadable-worktree');
      await expect(fs.readdir(manifest.unreadablePaths[0])).rejects.toThrow();
    }

    await removeFixture(out);
    await expect(fs.stat(out)).rejects.toThrow();
  });
});
