import * as path from 'node:path';

import { acquireLock, createMutationQueue } from '../core/locks.js';
import {
  resolveBrandHomeDir,
  RESOURCE_LOCKS_DIR,
  RESOURCE_ADMIN_LOCK_FILE,
} from '../core/constants.js';
import { getAllSkills } from '../utils/skills-catalog.js';
import { getAllAgents } from './agents-catalog.js';
import { previewResourceFiles } from './materializer.js';
import { resolveWorkspaceSkills } from './selection.js';
import type { AIAssistant } from '../types.js';

const runResourceAdministration = createMutationQueue();

export class ResourceSelectionError extends Error {
  public readonly missingSkills: string[];
  public readonly missingAgents: string[];

  constructor(missingSkills: string[], missingAgents: string[]) {
    const parts = [
      missingSkills.length ? `skills: ${missingSkills.join(', ')}` : '',
      missingAgents.length ? `agents: ${missingAgents.join(', ')}` : '',
    ].filter(Boolean);
    super(`Selected resources are not available (${parts.join('; ')}).`);
    this.name = 'ResourceSelectionError';
    this.missingSkills = missingSkills;
    this.missingAgents = missingAgents;
  }
}

export async function withResourceAdministrationLock<T>(operation: () => Promise<T>): Promise<T> {
  return runResourceAdministration(async () => {
    const release = await acquireLock(
      path.join(resolveBrandHomeDir(), RESOURCE_LOCKS_DIR, RESOURCE_ADMIN_LOCK_FILE),
      {
        staleMs: 60_000,
        timeoutMs: 15_000,
        timeoutMessage: 'Timed out waiting for resource administration.',
      },
    );
    try {
      return await operation();
    } finally {
      await release();
    }
  });
}

export async function validateResourceSelections(
  enabledSkills: string[],
  enabledAgents: string[],
  workspacePath?: string,
): Promise<void> {
  // Agents currently have only a global catalog; skills also have workspace sources.
  const [skills, agents] = await Promise.all([getAllSkills(workspacePath), getAllAgents()]);
  const skillIds = new Set(skills.map((skill) => skill.id));
  const agentIds = new Set(agents.map((agent) => agent.id));
  const missingSkills = [...new Set(enabledSkills)].filter((id) => !skillIds.has(id));
  const missingAgents = [...new Set(enabledAgents)].filter((id) => !agentIds.has(id));
  if (missingSkills.length || missingAgents.length) {
    throw new ResourceSelectionError(missingSkills, missingAgents);
  }
}

export interface ResourcePreviewItem {
  kind: 'skill' | 'agent';
  id: string;
  title: string;
  description: string;
  /** Workspace-relative files this resource adds. */
  files: string[];
}

/**
 * What creating a workspace with these selections would install, and where. Skills come from the single picks
 * and the subscribed categories, less the skills left out; a skill a harness ships is left out, since a workspace
 * never copies it.
 */
export async function previewResourceSelections(
  enabledSkills: string[],
  enabledAgents: string[],
  assistants: AIAssistant[],
  categories: string[] = [],
  disabledSkills: string[] = [],
): Promise<ResourcePreviewItem[]> {
  await validateResourceSelections(enabledSkills, enabledAgents);
  const [skills, agents] = await Promise.all([getAllSkills(), getAllAgents()]);
  const selectedSkills = resolveWorkspaceSkills({ enabledSkills, enabledCategories: categories, disabledSkills }, skills).skills;
  const selectedAgents = agents.filter((agent) => enabledAgents.includes(agent.id));
  const files = await previewResourceFiles(assistants, selectedSkills, selectedAgents);
  const filesOf = (kind: string, id: string) => files.filter((file) => file.kind === kind && file.resourceId === id).map((file) => file.path);
  return [
    ...selectedSkills.map((skill) => ({ kind: 'skill' as const, id: skill.id, title: skill.title || skill.name, description: skill.description, files: filesOf('skill', skill.id) })),
    ...selectedAgents.map((agent) => ({ kind: 'agent' as const, id: agent.id, title: agent.name, description: agent.description ?? '', files: filesOf('codex-agent', agent.id) })),
  ];
}
