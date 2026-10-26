import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { saveAgent, getAllAgents } from '../resources/agents-catalog.js';
import { assertFileHandleMatchesPath, assertNoLinkedPathComponents, assertPathWithin, atomicWriteJson, readFileHandleAtMost } from '../resources/fs-safety.js';
import { getAllSkills, getNexusFlowHome, getUserSkillsDir, saveSkill } from '../utils/skills-catalog.js';
import { getCurrentVersion } from '../utils/update-check.js';
import { getWorkflowTemplates, saveWorkflowTemplate } from '../utils/workflows.js';
import {
  WORKROOM_MAX_FILE_BYTES,
  WORKROOM_SCHEMA_VERSION,
  WorkroomValidationError,
  type ImmutableResourceRefV1,
  type WorkroomResourceManifestV1,
  type WorkroomResourcePackageV1,
} from './contracts.js';
import { digestResourcePackage, makeResourceFile, parseResourceDefinition, validateResourcePackage } from './resource-package.js';

export interface LocalShareableResource {
  readonly kind: 'skill' | 'agent' | 'workflow';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly custom: boolean;
}

type SemverTuple = readonly [number, number, number];

function parseCoreVersion(value: string, label: string): SemverTuple {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new WorkroomValidationError(`${label} must be a semantic version with major.minor.patch.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: SemverTuple, right: SemverTuple): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}

function satisfiesNexusFlowRequirement(currentVersion: string, requirement: string): boolean {
  const current = parseCoreVersion(currentVersion, 'The running NexusFlow version');
  const tokens = requirement.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new WorkroomValidationError('Resource NexusFlow compatibility cannot be empty.');
  return tokens.every((token) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token);
    if (!match) {
      throw new WorkroomValidationError('Resource NexusFlow compatibility must use an exact version or space-separated >=, <=, >, <, or = comparisons.');
    }
    const comparison = compareVersions(current, parseCoreVersion(match[2]!, 'Resource NexusFlow compatibility'));
    switch (match[1] ?? '=') {
      case '>=': return comparison >= 0;
      case '<=': return comparison <= 0;
      case '>': return comparison > 0;
      case '<': return comparison < 0;
      default: return comparison === 0;
    }
  });
}

export function assertLocalResourceCompatibility(
  manifest: Pick<WorkroomResourceManifestV1, 'compatibility'>,
  platform: NodeJS.Platform = process.platform,
  nexusflowVersion = getCurrentVersion(),
): void {
  const compatibility = manifest.compatibility;
  if (!compatibility) return;
  if (compatibility.platforms && !compatibility.platforms.includes(platform as 'win32' | 'linux' | 'darwin')) {
    throw new WorkroomValidationError(`This resource does not support the local ${platform} platform.`);
  }
  if (compatibility.nexusflow && !satisfiesNexusFlowRequirement(nexusflowVersion, compatibility.nexusflow)) {
    throw new WorkroomValidationError(`This resource requires NexusFlow ${compatibility.nexusflow}; this instance is ${nexusflowVersion}.`);
  }
}

export async function listLocalShareableResources(): Promise<LocalShareableResource[]> {
  const [skills, agents, workflows] = await Promise.all([getAllSkills(), getAllAgents(), getWorkflowTemplates()]);
  return [
    ...skills.map((item) => ({ kind: 'skill' as const, id: item.id, name: item.title || item.name, description: item.description, custom: item.custom })),
    ...agents.map((item) => ({ kind: 'agent' as const, id: item.id, name: item.name, description: item.description, custom: item.custom })),
    ...workflows.map((item) => ({ kind: 'workflow' as const, id: item.id, name: item.name, description: item.description, custom: item.custom })),
  ];
}

async function assertSkillPackageFullySupported(
  skill: Awaited<ReturnType<typeof getAllSkills>>[number],
): Promise<void> {
  if (!skill.sourcePath) return;
  const sourceRoot = path.resolve(skill.sourcePath);
  const topLevel = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of topLevel) {
    if (entry.isSymbolicLink()) {
      throw new WorkroomValidationError(`Linked skill package entries are not shareable: ${entry.name}`);
    }
    if (entry.isFile()) {
      if (entry.name !== 'SKILL.md') {
        throw new WorkroomValidationError(`Workrooms cannot faithfully share the top-level skill file ${entry.name}.`);
      }
      continue;
    }
    if (!entry.isDirectory()) {
      throw new WorkroomValidationError(`Unsupported skill package entry: ${entry.name}`);
    }
    if (entry.name === 'assets' || entry.name === 'agents') {
      if ((await fs.readdir(path.join(sourceRoot, entry.name))).length > 0) {
        throw new WorkroomValidationError(`Workrooms do not yet support non-empty ${entry.name}/ skill trees. Export was stopped to avoid dropping files.`);
      }
      continue;
    }
    if (entry.name !== 'references' && entry.name !== 'scripts') {
      throw new WorkroomValidationError(`Unsupported top-level skill package directory: ${entry.name}`);
    }
    const entries = await fs.readdir(path.join(sourceRoot, entry.name), { withFileTypes: true });
    for (const support of entries) {
      if (support.isSymbolicLink() || !support.isFile()) {
        throw new WorkroomValidationError(`Workrooms support only flat regular UTF-8 files in ${entry.name}/; ${support.name} cannot be shared faithfully.`);
      }
    }
    const catalogNames = new Set((skill[entry.name] ?? []).map((file) => file.name));
    if (entries.some((support) => !catalogNames.has(support.name)) || catalogNames.size !== entries.length) {
      throw new WorkroomValidationError(`The loaded ${entry.name}/ catalog does not match the complete skill package. Export was stopped.`);
    }
  }
}

async function hydrateSkillSupportingFiles(
  skill: Awaited<ReturnType<typeof getAllSkills>>[number],
  directory: 'references' | 'scripts',
): Promise<{
  readonly definitionFiles: Array<{ name: string; relativePath: string; content: string; mode?: number }>;
  readonly packageFiles: WorkroomResourcePackageV1['files'];
}> {
  const definitionFiles: Array<{ name: string; relativePath: string; content: string }> = [];
  const packageFiles: WorkroomResourcePackageV1['files'][number][] = [];
  for (const file of skill[directory] ?? []) {
    if (!file.name || path.basename(file.name) !== file.name) {
      throw new WorkroomValidationError(`Invalid ${directory} file name: ${file.name || '(empty)'}`);
    }
    let content = file.content;
    let mode: number | undefined;
    if (skill.sourcePath) {
      const skillsRoot = path.resolve(getUserSkillsDir());
      const sourceRoot = path.resolve(skill.sourcePath);
      const sourcePath = path.resolve(sourceRoot, directory, file.name);
      if (!sourcePath.startsWith(`${sourceRoot}${path.sep}`)) throw new WorkroomValidationError('Skill supporting file escaped its source package.');
      const handle = await fs.open(sourcePath, 'r');
      try {
        let stats;
        try {
          await assertNoLinkedPathComponents(skillsRoot, sourcePath);
          const [matchingStats, skillsRootStats, canonicalRoot, canonicalSource] = await Promise.all([
            assertFileHandleMatchesPath(handle, sourcePath),
            fs.lstat(skillsRoot, { bigint: true }),
            fs.realpath(skillsRoot),
            fs.realpath(sourcePath),
          ]);
          assertPathWithin(canonicalRoot, canonicalSource);
          if (!skillsRootStats.isDirectory() || skillsRootStats.isSymbolicLink()) throw new Error('The skills root is linked or not a directory.');
          stats = matchingStats;
        } catch (error) {
          if (error instanceof WorkroomValidationError) throw error;
          throw new WorkroomValidationError(`Linked, replaced, or non-file skill support entry is not shareable: ${file.name}`);
        }
        if (stats.size > BigInt(WORKROOM_MAX_FILE_BYTES)) {
          throw new WorkroomValidationError(`Skill supporting file exceeds the ${WORKROOM_MAX_FILE_BYTES}-byte limit: ${file.name}`);
        }
        const bytes = await readFileHandleAtMost(handle, WORKROOM_MAX_FILE_BYTES + 1);
        if (bytes.length > WORKROOM_MAX_FILE_BYTES) {
          throw new WorkroomValidationError(`Skill supporting file exceeds the ${WORKROOM_MAX_FILE_BYTES}-byte limit: ${file.name}`);
        }
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new WorkroomValidationError(`Skill supporting files must be UTF-8 text: ${file.name}`);
        }
        mode = Number(stats.mode & 0o777n);
      } finally {
        await handle.close().catch(() => {});
      }
    }
    if (content === undefined) throw new WorkroomValidationError(`Skill supporting file content is unavailable: ${file.name}`);
    const relativePath = `${directory}/${file.name}`;
    definitionFiles.push({ name: file.name, relativePath, content, ...(mode === undefined ? {} : { mode }) });
    packageFiles.push(makeResourceFile(relativePath, content, mode));
  }
  return { definitionFiles, packageFiles };
}

function finalizePackage(
  manifest: Omit<WorkroomResourceManifestV1, 'digest'>,
  files: WorkroomResourcePackageV1['files'],
): WorkroomResourcePackageV1 {
  const draft: WorkroomResourcePackageV1 = { manifest: { ...manifest, digest: '0'.repeat(64) }, files };
  const pkg: WorkroomResourcePackageV1 = { manifest: { ...draft.manifest, digest: digestResourcePackage(draft) }, files };
  return validateResourcePackage(pkg);
}

export async function packageLocalResource(
  kind: 'skill' | 'agent' | 'workflow',
  id: string,
  version: string,
): Promise<WorkroomResourcePackageV1> {
  const common = {
    schemaVersion: WORKROOM_SCHEMA_VERSION,
    kind,
    id,
    version,
    ownerMemberId: 'pending-owner',
    maintainerMemberIds: [] as string[],
    createdAt: new Date().toISOString(),
    dependencies: [] as ImmutableResourceRefV1[],
  };
  if (kind === 'skill') {
    const skill = (await getAllSkills()).find((candidate) => candidate.id === id);
    if (!skill) throw new WorkroomValidationError('Local skill not found.');
    await assertSkillPackageFullySupported(skill);
    const [references, scripts] = await Promise.all([
      hydrateSkillSupportingFiles(skill, 'references'),
      hydrateSkillSupportingFiles(skill, 'scripts'),
    ]);
    const definition = {
      id: skill.id,
      name: skill.name,
      title: skill.title,
      category: skill.category,
      description: skill.description,
      tags: skill.tags,
      allowedTools: skill.allowedTools,
      parameters: skill.parameters,
      content: skill.content,
      references: references.definitionFiles.length > 0 ? references.definitionFiles : undefined,
      scripts: scripts.definitionFiles.length > 0 ? scripts.definitionFiles : undefined,
    };
    const files = [
      makeResourceFile('definition.json', JSON.stringify(definition, null, 2)),
      makeResourceFile('SKILL.md', skill.content),
      ...references.packageFiles,
      ...scripts.packageFiles,
    ];
    return finalizePackage(common, files);
  }
  if (kind === 'agent') {
    const agent = (await getAllAgents()).find((candidate) => candidate.id === id);
    if (!agent) throw new WorkroomValidationError('Local agent not found.');
    const definition = {
      id: agent.id,
      name: agent.name,
      category: agent.category,
      description: agent.description,
      model: agent.model,
      modelReasoningEffort: agent.modelReasoningEffort,
      sandboxMode: agent.sandboxMode,
      developerInstructions: agent.developerInstructions,
    };
    return finalizePackage(common, [makeResourceFile('definition.json', JSON.stringify(definition, null, 2))]);
  }
  const workflow = (await getWorkflowTemplates()).find((candidate) => candidate.id === id);
  if (!workflow) throw new WorkroomValidationError('Local workflow not found.');
  const definition = { id: workflow.id, name: workflow.name, description: workflow.description, content: workflow.content };
  return finalizePackage(common, [
    makeResourceFile('definition.json', JSON.stringify(definition, null, 2)),
    makeResourceFile('WORKFLOW.md', workflow.content),
    makeResourceFile('workflow.json', JSON.stringify({ schemaVersion: 1, id, version, steps: [] }, null, 2)),
  ]);
}

export async function cacheResourcePackage(roomId: string, pkgInput: unknown): Promise<string> {
  const pkg = validateResourcePackage(pkgInput);
  assertLocalResourceCompatibility(pkg.manifest);
  const cacheDir = path.join(getNexusFlowHome(), 'workrooms', 'cache', roomId, pkg.manifest.kind, pkg.manifest.id, pkg.manifest.version);
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const cachePath = path.join(cacheDir, `${pkg.manifest.digest}.json`);
  await atomicWriteJson(cachePath, pkg);
  return cachePath;
}

export async function readCachedPackage(roomId: string, digest: string): Promise<WorkroomResourcePackageV1> {
  const cacheRoot = path.join(getNexusFlowHome(), 'workrooms', 'cache', roomId);
  const candidates: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile() && entry.name === `${digest}.json`) candidates.push(entryPath);
    }
  }
  await walk(cacheRoot);
  if (candidates.length !== 1) throw new WorkroomValidationError('Downloaded resource package not found.');
  return validateResourcePackage(JSON.parse(await fs.readFile(candidates[0]!, 'utf8')));
}

export async function getLocalResourceDefinition(
  kind: 'skill' | 'agent' | 'workflow',
  id: string,
): Promise<Record<string, unknown> | undefined> {
  if (kind === 'skill') {
    const skill = (await getAllSkills()).find((candidate) => candidate.id === id);
    if (!skill) return undefined;
    await assertSkillPackageFullySupported(skill);
    const [references, scripts] = await Promise.all([
      hydrateSkillSupportingFiles(skill, 'references'),
      hydrateSkillSupportingFiles(skill, 'scripts'),
    ]);
    return {
      id: skill.id,
      name: skill.name,
      title: skill.title,
      category: skill.category,
      description: skill.description,
      tags: skill.tags,
      allowedTools: skill.allowedTools,
      parameters: skill.parameters,
      content: skill.content,
      references: references.definitionFiles.length > 0 ? references.definitionFiles : undefined,
      scripts: scripts.definitionFiles.length > 0 ? scripts.definitionFiles : undefined,
    };
  }
  if (kind === 'agent') {
    const agent = (await getAllAgents()).find((candidate) => candidate.id === id);
    return agent ? {
      id: agent.id,
      name: agent.name,
      category: agent.category,
      description: agent.description,
      model: agent.model,
      modelReasoningEffort: agent.modelReasoningEffort,
      sandboxMode: agent.sandboxMode,
      developerInstructions: agent.developerInstructions,
    } : undefined;
  }
  const workflow = (await getWorkflowTemplates()).find((candidate) => candidate.id === id);
  return workflow ? { id: workflow.id, name: workflow.name, description: workflow.description, content: workflow.content } : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function digestLocalResourceDefinition(definition: Record<string, unknown> | undefined): string {
  const framed = definition === undefined
    ? 'NEXUSFLOW-LOCAL-RESOURCE-MISSING-V1'
    : `NEXUSFLOW-LOCAL-RESOURCE-DEFINITION-V1\0${canonicalJson(definition)}`;
  return createHash('sha256').update(framed, 'utf8').digest('hex');
}

export async function applyCachedResource(
  roomId: string,
  digest: string,
  approvedDigest: string,
  approvedLocalDigest: string,
) {
  if (approvedDigest !== digest) throw new WorkroomValidationError('Resource approval is not bound to this package digest.');
  if (!/^[a-f0-9]{64}$/.test(approvedLocalDigest)) {
    throw new WorkroomValidationError('Resource approval is not bound to the reviewed local resource revision.');
  }
  const pkg = await readCachedPackage(roomId, digest);
  assertLocalResourceCompatibility(pkg.manifest);
  if (pkg.manifest.digest !== approvedDigest) throw new WorkroomValidationError('The cached resource changed after review. Download and review it again.');
  const definition = parseResourceDefinition(pkg) as Record<string, unknown>;
  const assertLocalRevisionUnchanged = async () => {
    const current = await getLocalResourceDefinition(pkg.manifest.kind, pkg.manifest.id);
    if (digestLocalResourceDefinition(current) !== approvedLocalDigest) {
      throw new WorkroomValidationError('The local resource changed after review. Download and review the package again.');
    }
  };
  switch (pkg.manifest.kind) {
    case 'skill':
      {
        const resource = await saveSkill({
        id: String(definition.id ?? pkg.manifest.id),
        name: String(definition.name ?? pkg.manifest.id),
        title: typeof definition.title === 'string' ? definition.title : undefined,
        category: String(definition.category ?? 'general'),
        description: String(definition.description ?? ''),
        tags: Array.isArray(definition.tags) ? (definition.tags as string[]) : [],
        allowedTools: Array.isArray(definition.allowedTools) ? (definition.allowedTools as string[]) : undefined,
        parameters: Array.isArray(definition.parameters) ? (definition.parameters as never) : undefined,
        content: String(definition.content ?? ''),
        references: Array.isArray(definition.references) ? (definition.references as never) : [],
        scripts: Array.isArray(definition.scripts) ? (definition.scripts as never) : [],
        }, {
          beforeCommit: assertLocalRevisionUnchanged,
          supportFileModes: Object.fromEntries(pkg.files
            .filter((file) => (file.path.startsWith('references/') || file.path.startsWith('scripts/')) && file.mode !== undefined)
            .map((file) => [file.path, file.mode!])),
        });
        return { kind: 'skill' as const, resource };
      }
    case 'agent':
      return { kind: 'agent' as const, resource: await saveAgent(definition, { beforeCommit: assertLocalRevisionUnchanged }) };
    case 'workflow':
      return { kind: 'workflow' as const, resource: await saveWorkflowTemplate(
        String(definition.name ?? pkg.manifest.id),
        String(definition.content ?? ''),
        undefined,
        { beforeCommit: assertLocalRevisionUnchanged, expectedId: pkg.manifest.id },
      ) };
  }
}
