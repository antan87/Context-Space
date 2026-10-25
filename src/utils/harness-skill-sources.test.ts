import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import fse from 'fs-extra';

import { CLI_HARNESSES } from './cli-harnesses.js';
import { HARNESS_SKILL_SOURCES, findHarnessSkillDirs, type HarnessSkillSource } from './harness-skill-sources.js';

describe('HARNESS_SKILL_SOURCES', () => {
  it('has exactly one entry per CLI harness, so a new harness has to say where its skills live', () => {
    expect(Object.keys(HARNESS_SKILL_SOURCES).sort()).toEqual(Object.keys(CLI_HARNESSES).sort());
  });

  it('only names folders under the home directory or absolute paths', () => {
    for (const source of Object.values(HARNESS_SKILL_SOURCES)) {
      for (const root of source.roots) expect(root.startsWith('~/') || path.isAbsolute(root)).toBe(true);
    }
  });

  it('covers the folders each harness really uses for global skills', () => {
    expect(HARNESS_SKILL_SOURCES.claude.roots).toContain('~/.claude/skills');
    expect(HARNESS_SKILL_SOURCES.codex.roots).toContain('~/.codex/skills');
    expect(HARNESS_SKILL_SOURCES.antigravity.roots).toContain('~/.gemini/antigravity/builtin/skills');
    expect(HARNESS_SKILL_SOURCES.antigravity.roots).toContain('~/.gemini/config/skills');
    expect(HARNESS_SKILL_SOURCES.pi.roots).toEqual(['~/.pi/agent/skills', '~/.agents/skills']);
  });

  it('reads the folders from the registry, in registry order', () => {
    expect(Object.keys(HARNESS_SKILL_SOURCES)).toEqual(Object.keys(CLI_HARNESSES));
    for (const [id, harness] of Object.entries(CLI_HARNESSES)) {
      expect(HARNESS_SKILL_SOURCES[id as keyof typeof CLI_HARNESSES].roots).toEqual(harness.skills.globalRoots);
    }
  });
});

describe('findHarnessSkillDirs', () => {
  let home: string;

  beforeEach(async () => {
    // realpath: tmpdir is itself a symlink on macOS, and the finder reports resolved roots.
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skill-sources-')));
  });

  afterEach(async () => {
    await fse.remove(home);
  });

  async function skill(...segments: string[]): Promise<string> {
    const dir = path.join(home, ...segments);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
    return dir;
  }
  const dirs = async (sources: Record<string, HarnessSkillSource>) =>
    (await findHarnessSkillDirs(home, sources)).map((found) => path.relative(home, found.skillDir));

  it('finds flat, nested and dot-folder layouts', async () => {
    await skill('.h', 'skills', 'flat');
    await skill('.h', 'skills', 'synced', 'bucket', 'nested');
    await skill('.h', 'skills', '.system', 'bundled');

    expect(await dirs({ h: { roots: ['~/.h/skills'] } })).toEqual([
      path.join('.h', 'skills', '.system', 'bundled'),
      path.join('.h', 'skills', 'flat'),
      path.join('.h', 'skills', 'synced', 'bucket', 'nested'),
    ]);
  });

  it('does not search inside a skill, and ignores folders without SKILL.md at the depth limit', async () => {
    await skill('.h', 'skills', 'outer');
    await skill('.h', 'skills', 'outer', 'references', 'inner');
    await skill('.h', 'skills', 'a', 'b', 'c', 'too-deep');

    expect(await dirs({ h: { roots: ['~/.h/skills'] } })).toEqual([path.join('.h', 'skills', 'outer')]);
  });

  it('honours a per-harness maxDepth', async () => {
    await skill('.h', 'skills', 'a', 'b', 'c', 'deep');

    expect(await dirs({ h: { roots: ['~/.h/skills'], maxDepth: 4 } })).toEqual([path.join('.h', 'skills', 'a', 'b', 'c', 'deep')]);
    expect(await dirs({ h: { roots: ['~/.h/skills'], maxDepth: 2 } })).toEqual([]);
  });

  it('skips roots that are missing or not folders, and absolute roots work', async () => {
    await fs.writeFile(path.join(home, 'a-file'), 'not a folder');
    await skill('elsewhere', 'abs');

    expect(await dirs({
      h: { roots: ['~/missing', '~/a-file', path.join(home, 'elsewhere')] },
    })).toEqual([path.join('elsewhere', 'abs')]);
  });

  it('skips node_modules and .git', async () => {
    await skill('.h', 'skills', 'node_modules', 'dep');
    await skill('.h', 'skills', '.git', 'hook');
    await skill('.h', 'skills', 'real');

    expect(await dirs({ h: { roots: ['~/.h/skills'] } })).toEqual([path.join('.h', 'skills', 'real')]);
  });

  it('does not follow a symlinked folder inside a root', async () => {
    await skill('outside', 'secret');
    await skill('.h', 'skills', 'real');
    await fs.symlink(path.join(home, 'outside'), path.join(home, '.h', 'skills', 'linked'), 'dir');

    expect(await dirs({ h: { roots: ['~/.h/skills'] } })).toEqual([path.join('.h', 'skills', 'real')]);
  });

  it('accepts a root that is itself a symlink, as dotfile managers create, and reports its real path', async () => {
    await skill('dotfiles', 'skills', 'managed');
    await fs.mkdir(path.join(home, '.h'));
    await fs.symlink(path.join(home, 'dotfiles', 'skills'), path.join(home, '.h', 'skills'), 'dir');

    const [found] = await findHarnessSkillDirs(home, { h: { roots: ['~/.h/skills'] } });

    expect(found.root).toBe(path.join(home, 'dotfiles', 'skills'));
    expect(found.skillDir).toBe(path.join(home, 'dotfiles', 'skills', 'managed'));
  });

  it('lists harnesses in registration order and searches a shared root once', async () => {
    await skill('.shared', 'both');
    await skill('.b', 'only-b');
    await skill('.a', 'only-a');

    const found = await findHarnessSkillDirs(home, {
      second: { roots: ['~/.b', '~/.shared'] },
      first: { roots: ['~/.a', '~/.shared'] },
    });

    expect(found.map((f) => `${f.harness}:${path.basename(f.skillDir)}`)).toEqual([
      'second:only-b',
      'second:both',
      'first:only-a',
    ]);
  });

  it('labels known harnesses by display name and unknown ones by id', async () => {
    await skill('.c', 'one');
    await skill('.x', 'two');

    const found = await findHarnessSkillDirs(home, { claude: { roots: ['~/.c'] }, brand_new: { roots: ['~/.x'] } });

    expect(found.map((f) => f.label)).toEqual([CLI_HARNESSES.claude.name, 'brand_new']);
  });

  it('finds what Pi loads from its own folder and the shared ~/.agents/skills, and what Antigravity loads from config/skills', async () => {
    await skill('.pi', 'agent', 'skills', 'pi-own');
    await skill('.agents', 'skills', 'shared');
    await skill('.gemini', 'config', 'skills', 'agy-config');

    const found = await findHarnessSkillDirs(home);

    expect(found.map((f) => `${f.harness}:${path.basename(f.skillDir)}`)).toEqual(['antigravity:agy-config', 'pi:pi-own', 'pi:shared']);
    expect(found.find((f) => f.harness === 'pi')?.label).toBe('Pi');
  });

  it('returns nothing for a harness with no roots', async () => {
    expect(await findHarnessSkillDirs(home, { h: { roots: [] } })).toEqual([]);
  });
});
