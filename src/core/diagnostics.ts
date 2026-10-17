import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getCurrentVersion } from '../utils/update-check.js';
import { loadFeatureConfig } from './workspace.js';
import { getActiveStorageProvider, isBuiltInLocalStorageProvider } from './adapters/registry.js';
import { workspaceFileExists } from './storage.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';
import { PRIMARY_KNOWLEDGE_FILE } from './constants.js';
import { PLAN_FILE } from './plan-file.js';
import { assertNoLinkedPathComponents, assertFileHandleMatchesPath, readFileHandleAtMost } from '../resources/fs-safety.js';
import { DIAGNOSTIC_EXCLUSIONS } from './data-inventory.js';

export const DIAGNOSTIC_SECTIONS = ['runtime', 'workspace', 'checks'] as const;
const sectionSchema = z.enum(DIAGNOSTIC_SECTIONS);
const count = z.number().int().min(0).max(10000);
const checkSchema = z.object({
  id: z.enum(['repository-directory', 'knowledge-file', 'plan-file', 'assignment-file']),
  target: z.string().regex(/^(workspace-1|repository-[1-9][0-9]{0,3})$/),
  status: z.enum(['present', 'missing', 'unavailable', 'not-checked']),
}).strict();
const sectionsSchema = z.object({
  runtime: z.object({
    productVersion: z.tuple([count, count, count]), nodeMajor: count,
    platform: z.enum(['linux', 'win32', 'darwin', 'other']),
    architecture: z.enum(['x64', 'arm64', 'ia32', 'arm', 'other']),
  }).strict().optional(),
  workspace: z.object({ alias: z.literal('workspace-1'), mode: z.enum(['in-place', 'worktree']),
    repositoryCount: count, projectLinked: z.boolean(), storage: z.enum(['local', 'plugin']),
  }).strict().optional(),
  checks: z.array(checkSchema).max(10003).optional(),
}).strict();
export const diagnosticReportSchema = z.object({
  schemaVersion: z.literal(1), purpose: z.literal('support-status-only'),
  sections: sectionsSchema,
  omittedSections: z.array(sectionSchema).max(3),
  excludedData: z.array(z.enum(DIAGNOSTIC_EXCLUSIONS)).length(DIAGNOSTIC_EXCLUSIONS.length),
}).strict().superRefine((report, ctx) => {
  const omitted = DIAGNOSTIC_SECTIONS.filter(key => report.sections[key] === undefined);
  if (JSON.stringify(omitted) !== JSON.stringify(report.omittedSections)
      || JSON.stringify(report.excludedData) !== JSON.stringify(DIAGNOSTIC_EXCLUSIONS)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid diagnostic manifest.' });
  }
});
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;
export type DiagnosticSection = typeof DIAGNOSTIC_SECTIONS[number];
export interface DiagnosticPreview { report: DiagnosticReport; digest: string; content: string }
export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

/** Fixed error messages: neither raw exceptions nor input values cross this boundary. */
export class DiagnosticError extends Error {}

export function previewDiagnostics(input: unknown, omit: unknown = []): DiagnosticPreview {
  const parsed = diagnosticReportSchema.safeParse(input);
  const omissions = z.array(sectionSchema).max(3).safeParse(omit);
  if (!parsed.success || !omissions.success) throw new DiagnosticError('Invalid diagnostic report or section selection.');
  const report = parsed.data;
  for (const section of omissions.data) delete report.sections[section];
  report.omittedSections = DIAGNOSTIC_SECTIONS.filter(key => report.sections[key] === undefined);
  const content = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(content) > MAX_DIAGNOSTIC_BYTES) throw new DiagnosticError('Diagnostic report exceeds the size limit.');
  return { report, content, digest: createHash('sha256').update(content).digest('hex') };
}

export function reviewedDiagnostics(input: unknown, digest: unknown): DiagnosticPreview {
  const preview = previewDiagnostics(input);
  if (typeof digest !== 'string' || digest !== preview.digest) {
    throw new DiagnosticError('The report changed. Review the current preview before exporting.');
  }
  return preview;
}

/** No doctor analysis, subprocesses, content scans, transcript reads or network calls. */
export async function collectDiagnostics(workspacePath?: string): Promise<DiagnosticPreview> {
  const version = getCurrentVersion().match(/^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+]|$)/);
  const report: DiagnosticReport = {
    schemaVersion: 1, purpose: 'support-status-only',
    sections: { runtime: {
      productVersion: version ? [Number(version[1]), Number(version[2]), Number(version[3])] : [0, 0, 0],
      nodeMajor: Number(process.versions.node.split('.')[0]),
      platform: ['linux', 'win32', 'darwin'].includes(process.platform) ? process.platform as 'linux' | 'win32' | 'darwin' : 'other',
      architecture: ['x64', 'arm64', 'ia32', 'arm'].includes(process.arch) ? process.arch as 'x64' | 'arm64' | 'ia32' | 'arm' : 'other',
    } }, omittedSections: ['workspace', 'checks'], excludedData: [...DIAGNOSTIC_EXCLUSIONS],
  };
  if (workspacePath) {
    try {
      const feature = await loadFeatureConfig(workspacePath);
      if (!feature || !Array.isArray(feature.repos) || feature.repos.length > 9999
          || feature.repos.some(repo => typeof repo !== 'string')) throw new Error();
      const local = isBuiltInLocalStorageProvider(getActiveStorageProvider());
      report.sections.workspace = { alias: 'workspace-1', mode: feature.mode === 'in-place' ? 'in-place' : 'worktree',
        repositoryCount: feature.repos.length, projectLinked: Boolean(feature.projectId), storage: local ? 'local' : 'plugin' };
      const checks: z.infer<typeof checkSchema>[] = [];
      for (const [index, repo] of feature.repos.entries()) {
        let status: z.infer<typeof checkSchema>['status'] = 'unavailable';
        try { status = (await fs.stat(resolveFeatureRepoPath(feature, workspacePath, repo))).isDirectory() ? 'present' : 'missing'; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') status = 'missing'; }
        checks.push({ id: 'repository-directory', target: `repository-${index + 1}`, status });
      }
      for (const [id, filename] of [
        ['knowledge-file', PRIMARY_KNOWLEDGE_FILE], ['plan-file', PLAN_FILE], ['assignment-file', 'contextspace-work.json'],
      ] as const) {
        let status: z.infer<typeof checkSchema>['status'] = 'not-checked';
        // A third-party adapter may be remote: report the omission rather than calling it.
        if (local) {
          try { status = await workspaceFileExists(workspacePath, feature.id, filename) ? 'present' : 'missing'; }
          catch { status = 'unavailable'; }
        }
        checks.push({ id, target: 'workspace-1', status });
      }
      report.sections.checks = checks;
      report.omittedSections = [];
    } catch { throw new DiagnosticError('Could not read workspace metadata. Check the workspace and try again.'); }
  }
  return previewDiagnostics(report);
}

/** Publish a complete file exclusively: never truncate or replace an existing file. */
export async function saveDiagnosticFile(destination: string, content: string): Promise<void> {
  const target = path.resolve(destination);
  const temporary = path.join(path.dirname(target), `.contextspace-diagnostics-${randomUUID()}.tmp`);
  try {
    await assertNoLinkedPathComponents(path.parse(target).root, target);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await assertNoLinkedPathComponents(path.parse(target).root, target);
    // link fails if destination exists; complete bytes become visible together.
    await fs.link(temporary, target);
  } catch { throw new DiagnosticError('Could not save diagnostics. Choose a new file in an existing writable folder without linked paths.'); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function readDiagnosticCandidate(filename: string): Promise<DiagnosticReport> {
  try {
    const target = path.resolve(filename);
    await assertNoLinkedPathComponents(path.parse(target).root, target);
    const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      await assertFileHandleMatchesPath(handle, target);
      const bytes = await readFileHandleAtMost(handle, MAX_DIAGNOSTIC_BYTES + 1);
      if (bytes.length > MAX_DIAGNOSTIC_BYTES) throw new Error();
      return previewDiagnostics(JSON.parse(bytes.toString('utf8'))).report;
    } finally { await handle.close(); }
  } catch { throw new DiagnosticError('Could not read a valid diagnostic candidate.'); }
}
