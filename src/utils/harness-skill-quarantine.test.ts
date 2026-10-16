import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import fse from 'fs-extra';

import { getAllSkills } from './skills-catalog.js';
import {
  listQuarantinedHarnessSkills,
  quarantineHarnessSkill,
  restoreHarnessSkill,
} from './harness-skill-quarantine.js';

describe('harness skill quarantine', () => {
  let home: string;
  let quarantineDir: string;
  const options = () => ({ homeDir: home, quarantineDir });

  beforeEach(async () => {
    // realpath: the finder reports symlink-resolved roots, and tmpdir is a symlink on macOS.
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'harness-quarantine-home-')));
    quarantineDir = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'harness-quarantine-q-'))), 'q');
  });

  afterEach(async () => {
    await fse.remove(home);
    await fse.remove(path.dirname(quarantineDir));
  });

  async function writeSkill(relativeDir: string, body = '# Body'): Promise<string> {
    const dir = path.join(home, relativeDir);
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: test\n---\n${body}\n`);
    await fs.writeFile(path.join(dir, 'references', 'notes.md'), 'kept');
    return dir;
  }

  it('moves the skill out of the harness folder, keeps its files, and leaves a manifest', async () => {
    const original = await writeSkill('.claude/skills/pdf');

    const entry = await quarantineHarnessSkill('pdf', { ...options(), now: new Date('2026-10-16T10:00:00Z') });

    expect(await fse.pathExists(original)).toBe(false);
    expect(entry).toMatchObject({ id: 'pdf', harness: 'claude', originalPath: original });
    expect(await fs.readFile(path.join(entry.entryDir, 'skill', 'references', 'notes.md'), 'utf8')).toBe('kept');
    expect(await listQuarantinedHarnessSkills(options())).toEqual([expect.objectContaining({ id: 'pdf', originalPath: original })]);
  });

  it('makes the skill disappear from the list, since the catalog reads the harness folder', async () => {
    await writeSkill('.claude/skills/pdf');
    await quarantineHarnessSkill('pdf', options());

    const skills = await getAllSkills(undefined, undefined, { harnessHomeDir: home });

    expect(skills.some((s) => s.id === 'pdf')).toBe(false);
  });

  it('restores the skill to its original place and removes the quarantine entry', async () => {
    const original = await writeSkill('.codex/skills/.system/imagegen');
    await quarantineHarnessSkill('imagegen', options());

    await restoreHarnessSkill('imagegen', options());

    expect(await fs.readFile(path.join(original, 'SKILL.md'), 'utf8')).toContain('# Body');
    expect(await listQuarantinedHarnessSkills(options())).toEqual([]);
  });

  it('refuses to restore over a skill that now sits at the original path', async () => {
    await writeSkill('.claude/skills/pdf', '# Old');
    await quarantineHarnessSkill('pdf', options());
    await writeSkill('.claude/skills/pdf', '# New');

    await expect(restoreHarnessSkill('pdf', options())).rejects.toThrow(/already exists/);

    expect(await fs.readFile(path.join(home, '.claude/skills/pdf/SKILL.md'), 'utf8')).toContain('# New');
    expect(await listQuarantinedHarnessSkills(options())).toHaveLength(1);
  });

  it('refuses a skill that is not in any harness folder', async () => {
    await expect(quarantineHarnessSkill('nope', options())).rejects.toThrow(/No harness skill named "nope"/);
  });

  it('refuses a symlinked skill folder and leaves the target alone', async () => {
    const target = await writeSkill('outside/elsewhere');
    await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true });
    await fs.symlink(target, path.join(home, '.claude/skills/linked'), 'dir');

    // A symlinked folder is never found by the finder, so it reads as not found rather than being moved.
    await expect(quarantineHarnessSkill('linked', options())).rejects.toThrow(/No harness skill named/);
    expect(await fse.pathExists(path.join(target, 'SKILL.md'))).toBe(true);
  });

  it('keeps two quarantines of the same id apart', async () => {
    await writeSkill('.claude/skills/pdf');
    await quarantineHarnessSkill('pdf', { ...options(), now: new Date('2026-10-16T10:00:00Z') });
    await writeSkill('.claude/skills/pdf');
    await quarantineHarnessSkill('pdf', { ...options(), now: new Date('2026-10-16T11:00:00Z') });

    const entries = await listQuarantinedHarnessSkills(options());

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.entryDir)).size).toBe(2);
    expect(entries[0].quarantinedAt > entries[1].quarantinedAt).toBe(true);
  });

  it('skips a quarantine entry whose manifest is unreadable', async () => {
    await fs.mkdir(path.join(quarantineDir, 'claude', 'broken'), { recursive: true });
    await fs.writeFile(path.join(quarantineDir, 'claude', 'broken', 'entry.json'), '{not json');

    expect(await listQuarantinedHarnessSkills(options())).toEqual([]);
  });
});
