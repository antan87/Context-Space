import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AIAssistant, SessionAssistant } from '../types.js';
import { HARNESS_SKILL_SOURCES } from '../utils/harness-skill-sources.js';
import {
  HARNESSES,
  HARNESS_IDS,
  SESSION_SOURCES,
  SKILL_FOLDER_ADAPTERS,
  defaultWorkspaceHarnesses,
  harnessPromptArgs,
  harnessSkillSources,
  harnessSummaries,
  isHarnessId,
  skillFolderOfAdapter,
  workspaceSkillFolders,
  type HarnessDefinition,
  type HarnessId,
  type WorkspaceSkillFolder,
} from './registry.js';

const entries = Object.entries(HARNESSES) as Array<[HarnessId, HarnessDefinition]>;

describe('every registry entry', () => {
  it.each(entries)('%s is complete', (id, harness) => {
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    for (const text of [harness.name, harness.setupName, harness.binary]) expect(text.trim()).not.toBe('');
    expect(harness.resumeArgs('session-1')).toContain('session-1');
    expect(Array.isArray(harness.continueArgs)).toBe(true);
    expect(typeof harness.history).toBe('boolean');
    expect(typeof harness.mcp).toBe('boolean');
    expect(typeof harness.defaultForNewWorkspaces).toBe('boolean');
    if (harness.promptArgs) expect(harness.promptArgs('hello')).toContain('hello');
    if (harness.terminalBinaries) expect(harness.terminalBinaries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s names real skill folders', (_id, harness) => {
    expect(Object.keys(SKILL_FOLDER_ADAPTERS)).toContain(harness.skills.workspaceFolder);
    for (const root of harness.skills.globalRoots) expect(root.startsWith('~/') || path.isAbsolute(root)).toBe(true);
    if (harness.skills.maxDepth !== undefined) expect(harness.skills.maxDepth).toBeGreaterThan(0);
  });

  it.each(entries)('%s names its own instruction file only if it needs one', (_id, harness) => {
    if (harness.instructions === null) return;
    expect(harness.instructions.outputFile.trim()).not.toBe('');
    expect(path.isAbsolute(harness.instructions.outputFile)).toBe(false);
    // AGENTS.md is the canonical file every tool can read; a tool's own file is something else.
    expect(harness.instructions.outputFile).not.toBe('AGENTS.md');
  });

  it('has unique names, so the app never shows two tools alike', () => {
    expect(new Set(entries.map(([, harness]) => harness.name)).size).toBe(entries.length);
    expect(new Set(entries.map(([, harness]) => harness.setupName)).size).toBe(entries.length);
  });
});

describe('derived values', () => {
  it('lists the skill folders the materializer writes: exactly .agents/skills and .claude/skills', () => {
    expect(workspaceSkillFolders()).toEqual(['.agents/skills', '.claude/skills']);
  });

  it('keeps the persisted lock adapter ids', () => {
    expect(SKILL_FOLDER_ADAPTERS).toEqual({ '.agents/skills': 'agent-skill-v1', '.claude/skills': 'claude-skill-v1' });
    expect(skillFolderOfAdapter('agent-skill-v1')).toBe('.agents/skills');
    expect(skillFolderOfAdapter('claude-skill-v1')).toBe('.claude/skills');
    // Legacy adapters are not folders any harness reads now.
    expect(skillFolderOfAdapter('codex-skill-v1')).toBeUndefined();
  });

  it('reads Claude Code from .claude/skills and the other tools from .agents/skills', () => {
    const folder = (id: HarnessId) => HARNESSES[id].skills.workspaceFolder;
    expect(folder('claude')).toBe('.claude/skills');
    for (const id of ['antigravity', 'codex', 'copilot', 'cursor', 'pi'] as const) expect(folder(id)).toBe('.agents/skills');
  });

  it('asks only Claude Code, Copilot and Cursor for their own instruction file', () => {
    const own = entries.filter(([, harness]) => harness.instructions).map(([id]) => id);
    expect(own).toEqual(['claude', 'copilot', 'cursor']);
    expect(HARNESSES.claude.instructions.outputFile).toBe('CLAUDE.md');
    expect(HARNESSES.copilot.instructions.outputFile).toBe('.github/copilot-instructions.md');
  });

  it('starts new workspaces with Claude Code, Antigravity and Codex', () => {
    // Sorted by id, which is the order the list has always had: the first is the tool a workspace resumes with.
    expect(defaultWorkspaceHarnesses()).toEqual(['antigravity', 'claude', 'codex']);
  });

  it('lists saved-session sources for the harnesses with history, then the workspace', () => {
    expect(SESSION_SOURCES).toEqual([...HARNESS_IDS.filter((id) => HARNESSES[id].history), 'workspace']);
    expect(SESSION_SOURCES).not.toContain('cursor');
  });

  it('starts a session with a first message only for tools that can', () => {
    expect(harnessPromptArgs('pi', 'hi')).toEqual(['--', 'hi']);
    expect(harnessPromptArgs('copilot', 'hi')).toBeNull();
  });

  it('summarises each harness for the GUI without any launch details', () => {
    const summaries = harnessSummaries();
    expect(summaries.map((summary) => summary.id)).toEqual([...HARNESS_IDS]);
    expect(JSON.parse(JSON.stringify(summaries))).toEqual(summaries);
    expect(summaries.find((summary) => summary.id === 'claude')).toEqual({
      id: 'claude',
      name: 'Claude Code',
      workspaceSkillFolder: '.claude/skills',
      globalSkillRoots: ['~/.claude/skills'],
      history: true,
      instructionsFile: 'CLAUDE.md',
    });
    expect(summaries.find((summary) => summary.id === 'pi')).toMatchObject({ instructionsFile: null });
  });
});

describe('Pi', () => {
  it('is a full assistant', () => {
    expect(isHarnessId('pi')).toBe(true);
    expect(HARNESS_IDS).toContain('pi');
    // Both compile only while 'pi' is an AIAssistant and SessionAssistant is the same type.
    const assistant: AIAssistant = 'pi';
    const session: SessionAssistant = assistant;
    expect(session).toBe('pi');
    expect(HARNESSES.pi.mcp).toBe(true);
  });

  it('shows the skills it loads everywhere as built in, from its own folder and the shared agent skills folder', () => {
    expect(HARNESS_SKILL_SOURCES.pi.roots).toEqual(['~/.pi/agent/skills', '~/.agents/skills']);
  });

  it('is the only harness that owns ~/.agents/skills', () => {
    const owners = entries.filter(([, harness]) => harness.skills.globalRoots.includes('~/.agents/skills')).map(([id]) => id);
    expect(owners).toEqual(['pi']);
  });
});

describe('Antigravity', () => {
  it('loads skills from config/skills as well as its built-in and plugin folders', () => {
    expect(HARNESS_SKILL_SOURCES.antigravity.roots).toEqual([
      '~/.gemini/antigravity/builtin/skills',
      '~/.gemini/antigravity-cli/builtin/skills',
      '~/.gemini/config/skills',
      '~/.gemini/config/plugins',
    ]);
  });
});

describe('a harness added to the registry', () => {
  // Built here with the derive helpers; the real registry is never changed.
  const acme: HarnessDefinition = {
    name: 'Acme Agent',
    setupName: 'Acme',
    binary: 'acme',
    resumeArgs: (id) => ['--session', id],
    continueArgs: ['--last'],
    history: false,
    skills: { workspaceFolder: '.claude/skills', globalRoots: ['~/.acme/skills'], maxDepth: 2 },
    instructions: { outputFile: 'ACME.md' },
    mcp: false,
    defaultForNewWorkspaces: true,
  };
  const withAcme = { ...HARNESSES, acme };

  it('gets its global skill folders, with its depth limit', () => {
    expect(harnessSkillSources(withAcme).acme).toEqual({ roots: ['~/.acme/skills'], maxDepth: 2 });
    expect(harnessSkillSources(withAcme).claude).toEqual({ roots: ['~/.claude/skills'] });
    expect(Object.keys(harnessSkillSources(withAcme))).toEqual([...HARNESS_IDS, 'acme']);
  });

  it('is summarised for the GUI, last', () => {
    expect(harnessSummaries(withAcme).at(-1)).toEqual({
      id: 'acme',
      name: 'Acme Agent',
      workspaceSkillFolder: '.claude/skills',
      globalSkillRoots: ['~/.acme/skills'],
      history: false,
      instructionsFile: 'ACME.md',
    });
  });

  it('joins the new-workspace defaults', () => {
    expect(defaultWorkspaceHarnesses(withAcme)).toContain('acme');
    expect(defaultWorkspaceHarnesses()).not.toContain('acme');
  });

  it('adds a skill folder only when no other harness reads it already', () => {
    expect(workspaceSkillFolders(withAcme)).toEqual(workspaceSkillFolders());
    const elsewhere = { ...HARNESSES, acme: { ...acme, skills: { ...acme.skills, workspaceFolder: '.acme/skills' as WorkspaceSkillFolder } } };
    expect(workspaceSkillFolders(elsewhere)).toEqual(['.acme/skills', '.agents/skills', '.claude/skills']);
  });

  it('leaves the real registry alone', () => {
    expect(isHarnessId('acme')).toBe(false);
    expect(workspaceSkillFolders()).toEqual(['.agents/skills', '.claude/skills']);
  });
});
