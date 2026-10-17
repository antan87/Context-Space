import { createHash } from 'node:crypto';

import { execa } from 'execa';

import { readWorkspaceKnowledge } from '../core/knowledge.js';
import { readWorkspaceFile } from '../core/storage.js';
import { PRIMARY_HANDOFF_FILE } from '../core/constants.js';
import { PLAN_FILE } from '../core/plan-file.js';
import { loadFeatureConfig, resolveRepoInfos } from '../core/workspace.js';
import type { Feature } from '../types.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';
import { slugify } from '../utils/slug.js';
import {
  WORKROOM_SCHEMA_VERSION,
  WORKROOM_MAX_DOCUMENT_BYTES,
  WorkroomValidationError,
  portableFeatureBundleSchema,
  type PortableFeatureBundleV1,
  type PortableRepoV1,
  type WorkroomDocumentName,
} from './contracts.js';

function removeCredentials(url: URL): URL {
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return url;
}

/** Stable Git identity without credentials, local paths, or provider coupling. */
export function normalizeGitRemote(raw: string, fallbackName: string): string {
  const value = raw.trim();
  if (!value) return `unconfigured://${slugify(fallbackName) || 'repository'}`;
  const opaqueIdentity = () => {
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
    return `unrecognized://${slugify(fallbackName) || 'repository'}/${digest}`;
  };
  if (/^(?:[A-Za-z]:|[\\/]{1,2}(?!\/)|file:)/i.test(value)) return opaqueIdentity();

  const scpMatch = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  const candidate = scpMatch && !value.includes('://')
    ? `https://${scpMatch[1]}/${scpMatch[2]}`
    : value.replace(/^git\+/, '');
  try {
    const parsed = removeCredentials(new URL(candidate));
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return opaqueIdentity();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return opaqueIdentity();
  }
}

async function gitOutput(repoPath: string, args: string[], fallback: string): Promise<string> {
  try {
    const result = await execa('git', args, { cwd: repoPath, reject: false });
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : fallback;
  } catch {
    return fallback;
  }
}

export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}

async function readOptionalText(workspacePath: string, featureId: string, filename: string): Promise<string> {
  try {
    const value = await readWorkspaceFile(workspacePath, featureId, filename);
    return limitPortableDocument(value);
  } catch {
    return '';
  }
}

function limitPortableDocument(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= WORKROOM_MAX_DOCUMENT_BYTES) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = WORKROOM_MAX_DOCUMENT_BYTES; end >= WORKROOM_MAX_DOCUMENT_BYTES - 3; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {}
  }
  throw new WorkroomValidationError('Portable document could not be truncated at a valid UTF-8 boundary.');
}

export function digestPortableWorkroomContext(
  bundle: PortableFeatureBundleV1,
  documents: Record<WorkroomDocumentName, string>,
): string {
  return createHash('sha256').update(JSON.stringify({
    bundle,
    documents: {
      plan: documents.plan,
      decisions: documents.decisions,
      handoff: documents.handoff,
    },
  }), 'utf8').digest('hex');
}

export function scanPortableContextWarnings(content: string): string[] {
  const warnings: string[] = [];
  if (/(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i.test(content)) {
    warnings.push('Possible credential or private key detected.');
  }
  if (/^(?:diff --git |index [a-f0-9]+\.\.[a-f0-9]+|@@ .+ @@)/m.test(content)) {
    warnings.push('Possible source diff detected.');
  }
  if (/(?:[A-Za-z]:\\(?:Users|home)\\|\/(?:home|Users)\/[^\s/]+\/)/.test(content)) {
    warnings.push('Possible absolute user path detected.');
  }
  if (/^(?:user|assistant|system|developer):\s/m.test(content)) {
    warnings.push('Possible AI/chat transcript detected.');
  }
  if (/(?:password|api[_-]?key|secret|token)\s*[:=]\s*[^\s]{8,}/i.test(content)) {
    warnings.push('Possible secret assignment detected.');
  }
  return warnings;
}

export interface PortableWorkroomPreview {
  readonly workspaceId: string;
  readonly bundle: PortableFeatureBundleV1;
  readonly bundleDigest: string;
  readonly bundleWarnings: string[];
  readonly documents: Record<WorkroomDocumentName, string>;
  readonly warnings: Record<WorkroomDocumentName, string[]>;
}

export async function buildPortableWorkroomPreview(workspacePath: string): Promise<PortableWorkroomPreview> {
  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) throw new WorkroomValidationError('Workspace manifest not found.');
  const repoInfos = await resolveRepoInfos(feature.repos);
  const repos: PortableRepoV1[] = [];
  for (let index = 0; index < repoInfos.length; index += 1) {
    const repo = repoInfos[index]!;
    const worktreePath = resolveFeatureRepoPath(feature, workspacePath, repo.path);
    const remote = await gitOutput(worktreePath, ['remote', 'get-url', 'origin'], '');
    const baseId = slugify(repo.name) || `repo-${index + 1}`;
    repos.push({
      id: repos.some((candidate) => candidate.id === baseId) ? `${baseId}-${index + 1}` : baseId,
      name: repo.name,
      remoteUrl: normalizeGitRemote(remote, repo.name),
      defaultBranch: repo.defaultBranch || 'main',
    });
  }

  const featureId = slugify(feature.id || feature.branchName) || `feature-${createHash('sha256').update(feature.branchName).digest('hex').slice(0, 10)}`;
  const projectId = slugify(feature.projectId || featureId) || featureId;
  const createdAt = feature.createdAt;
  const bundle = portableFeatureBundleSchema.parse({
    schemaVersion: WORKROOM_SCHEMA_VERSION,
    project: { id: projectId, name: feature.projectId || feature.branchName },
    feature: {
      id: featureId,
      goal: feature.description || feature.branchName,
      description: feature.description || '',
    },
    repos,
    pinnedResources: [],
    createdAt,
  });

  const [plan, decisions, handoff] = await Promise.all([
    readOptionalText(workspacePath, feature.id, PLAN_FILE),
    readWorkspaceKnowledge(workspacePath).then((value) => limitPortableDocument(value ?? '')).catch(() => ''),
    readOptionalText(workspacePath, feature.id, PRIMARY_HANDOFF_FILE),
  ]);
  return {
    workspaceId: feature.id,
    bundle,
    bundleDigest: createHash('sha256').update(JSON.stringify(bundle), 'utf8').digest('hex'),
    bundleWarnings: scanPortableContextWarnings(JSON.stringify(bundle)),
    documents: { plan, decisions, handoff },
    warnings: {
      plan: scanPortableContextWarnings(plan),
      decisions: scanPortableContextWarnings(decisions),
      handoff: scanPortableContextWarnings(handoff),
    },
  };
}

export async function buildPublishedHandoff(
  feature: Feature,
  workspacePath: string,
  actorId: string,
): Promise<{ readonly markdown: string; readonly repos: PortableRepoV1[] }> {
  const repoInfos = await resolveRepoInfos(feature.repos);
  const publishedAt = new Date().toISOString();
  const rows: string[] = [];
  const repos: PortableRepoV1[] = [];
  for (let index = 0; index < repoInfos.length; index += 1) {
    const repo = repoInfos[index]!;
    const worktreePath = resolveFeatureRepoPath(feature, workspacePath, repo.path);
    const [remote, branch, commit, porcelain, counts] = await Promise.all([
      gitOutput(worktreePath, ['remote', 'get-url', 'origin'], ''),
      gitOutput(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown'),
      gitOutput(worktreePath, ['rev-parse', 'HEAD'], 'unknown'),
      gitOutput(worktreePath, ['status', '--porcelain'], ''),
      gitOutput(worktreePath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], '0\t0'),
    ]);
    const [behindRaw, aheadRaw] = counts.split(/\s+/);
    const ahead = Number.parseInt(aheadRaw ?? '0', 10) || 0;
    const behind = Number.parseInt(behindRaw ?? '0', 10) || 0;
    const dirty = Boolean(porcelain);
    const id = slugify(repo.name) || `repo-${index + 1}`;
    repos.push({
      id,
      name: repo.name,
      remoteUrl: normalizeGitRemote(remote, repo.name),
      defaultBranch: repo.defaultBranch || 'main',
      handoff: { branch, commit, ahead, behind, dirty, publishedAt, publishedBy: actorId },
    });
    rows.push(`| ${escapeMarkdownTableCell(repo.name)} | ${escapeMarkdownTableCell(branch)} | ${commit.slice(0, 12)} | ${ahead} | ${behind} | ${dirty ? 'Dirty' : 'Clean'} |`);
  }
  const markdown = [
    `# Workroom handoff — ${feature.branchName}`,
    '',
    `Published ${publishedAt}. This snapshot intentionally contains no filenames, diffs, or source content.`,
    '',
    '| Repository | Branch | Commit | Ahead | Behind | State |',
    '|---|---|---:|---:|---:|---|',
    ...rows,
  ].join('\n');
  return { markdown, repos };
}
