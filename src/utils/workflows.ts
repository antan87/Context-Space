import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveResourcePath } from './resources.js';
import { slugify } from './slug.js';
import { getErrorCode } from './errors.js';
import { acquireLock, createMutationQueue } from '../core/locks.js';
import { atomicWriteFile } from '../resources/fs-safety.js';
import {
  resolveBrandHomeDir,
  RESOURCE_LOCKS_DIR,
  RESOURCE_CATALOG_LOCK_FILE,
  RESOURCE_WORKFLOWS_DIR,
} from '../core/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runCatalogMutation = createMutationQueue();

async function withCatalogLock<T>(operation: () => Promise<T>): Promise<T> {
  return runCatalogMutation(async () => {
    const release = await acquireLock(path.join(resolveBrandHomeDir(), RESOURCE_LOCKS_DIR, RESOURCE_CATALOG_LOCK_FILE), {
      staleMs: 60_000,
      timeoutMs: 10_000,
      timeoutMessage: 'Timed out waiting for the resource catalog lock.',
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  });
}

function getUserWorkflowsDir(): string {
  return path.join(resolveBrandHomeDir(), RESOURCE_WORKFLOWS_DIR);
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
  custom: boolean;
}

function parseMarkdownTemplate(id: string, content: string): Omit<WorkflowTemplate, 'id' | 'custom'> {
  const lines = content.split('\n');
  let name = id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  let description = '';

  // Extract name from the first H1 header (# Name)
  for (const line of lines) {
    if (line.startsWith('# ')) {
      name = line.substring(2).trim();
      break;
    }
  }

  // Extract description from the first non-empty text paragraph below the H1 header
  let foundHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      foundHeader = true;
      continue;
    }
    if (foundHeader && trimmed.length > 0 && !trimmed.startsWith('#') && !trimmed.startsWith('>')) {
      description = trimmed;
      // Truncate to first sentence or 120 chars
      const sentenceEnd = description.indexOf('.');
      if (sentenceEnd !== -1) {
        description = description.substring(0, sentenceEnd + 1);
      }
      if (description.length > 120) {
        description = description.substring(0, 117) + '...';
      }
      break;
    }
  }

  // Fallbacks for built-in templates if none extracted
  if (!description) {
    if (id === 'plan-implement-review') {
      description = 'Plan, implement, and review one cohesive change using the current assignment and milestone plan.';
    } else if (id === 'research-verify') {
      description = 'Investigate uncertainty and return evidence within the current assignment stage and stopping point.';
    } else if (id === 'solo-developer') {
      description = 'Direct coding and verification by the primary agent without subagent delegation overhead.';
    } else if (id === 'epic-multi-slice') {
      description = 'Decompose large epics or multi-PR modules into independently reviewable vertical slices with persistent contracts.';
    } else {
      description = 'Custom user-defined teamwork strategy.';
    }
  }

  return { name, description, content };
}

async function loadTemplatesFromDir(dirPath: string, custom: boolean): Promise<WorkflowTemplate[]> {
  const templates: WorkflowTemplate[] = [];
  try {
    const files = await fs.readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const id = path.basename(file, '.md');
      const content = await fs.readFile(path.join(dirPath, file), 'utf-8');
      const parsed = parseMarkdownTemplate(id, content);
      templates.push({
        id,
        custom,
        ...parsed,
      });
    }
  } catch (error) {
    // Only log if directory exists (ignoring non-existent custom folder log spam)
    if (getErrorCode(error) !== 'ENOENT') {
      console.error(`Failed to read templates from ${dirPath}:`, error);
    }
  }
  return templates;
}

export async function getWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  // `resources/` is copied into dist at build time, so its position relative to
  // this module differs between a built run and a source-tree run; a single
  // hard-coded relative path silently finds nothing in one of them.
  const builtInDir = await resolveResourcePath(__dirname, 'workflows');
  const userDir = getUserWorkflowsDir();

  // Ensure user custom workflows directory exists so they can find it easily
  try {
    await fs.mkdir(userDir, { recursive: true });
  } catch {}

  const [builtInTemplates, userTemplates] = await Promise.all([
    builtInDir ? loadTemplatesFromDir(builtInDir, false) : Promise.resolve([]),
    loadTemplatesFromDir(userDir, true)
  ]);

  // Merge templates (user custom templates override built-in if they share the same ID)
  const templateMap = new Map<string, WorkflowTemplate>();
  
  for (const t of builtInTemplates) {
    templateMap.set(t.id, t);
  }
  for (const t of userTemplates) {
    templateMap.set(t.id, t);
  }

  return Array.from(templateMap.values());
}

export async function saveWorkflowTemplate(
  name: string,
  content: string,
  originalId?: string,
  options: { readonly beforeCommit?: () => Promise<void>; readonly expectedId?: string } = {},
): Promise<WorkflowTemplate> {
  const userDir = getUserWorkflowsDir();
  await fs.mkdir(userDir, { recursive: true });

  // Extract name from the first H1 header (# Name) in content if present
  let parsedName = name;
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('# ')) {
      parsedName = line.trim().substring(2).trim();
      break;
    }
  }

  const id = slugify(parsedName);

  if (!id) {
    throw new Error('Invalid template name');
  }
  if (options.expectedId !== undefined && id !== options.expectedId) {
    throw new Error('Workflow Markdown heading does not match the reviewed resource ID.');
  }

  // Ensure content starts with "# <Name>" header so it parses correctly next time
  let fileContent = content.trim();
  if (!fileContent.startsWith('# ')) {
    fileContent = `# ${parsedName}\n\n${fileContent}`;
  }

  await withCatalogLock(async () => {
    const filePath = path.join(userDir, `${id}.md`);
    await atomicWriteFile(filePath, fileContent, options.beforeCommit);

    // If we are editing an existing custom template and the ID changed, delete the old file
    if (originalId && originalId !== id) {
      const oldPath = path.join(userDir, `${originalId}.md`);
      try {
        await fs.unlink(oldPath);
      } catch {}
    }
  });

  const parsed = parseMarkdownTemplate(id, fileContent);
  return {
    id,
    custom: true,
    ...parsed,
  };
}

export async function deleteWorkflowTemplate(id: string): Promise<void> {
  if (!id || slugify(id) !== id || path.basename(id) !== id) throw new Error('Invalid workflow template ID.');
  const userDir = getUserWorkflowsDir();
  const filePath = path.join(userDir, `${id}.md`);

  await withCatalogLock(async () => {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
    }
  });
}
