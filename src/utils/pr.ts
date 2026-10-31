/**
 * @module utils/pr
 * Pull-request and commit helpers: detect the GitHub CLI, parse a git remote URL
 * into its host/owner/repo, and construct a "create PR / MR" compare URL or
 * commit URL for the common forges. Pure functions (`parseRemoteUrl`,
 * `buildCompareUrl`, `buildCommitUrl`) are unit-tested; `detectGh`/`createPrWithGh`
 * shell out to `gh`.
 */

import { execa } from 'execa';

/** Recognized forge kinds. */
export type ForgeKind = 'github' | 'gitlab' | 'azure' | 'bitbucket' | 'unknown';

/** A parsed git remote. */
export interface ParsedRemote {
  host: string;
  /** Owner / org / group (may include GitLab subgroups). */
  owner: string;
  repo: string;
  kind: ForgeKind;
  /** Azure DevOps project (only set for `kind === 'azure'`). */
  project?: string;
}

/** Availability + auth state of the GitHub CLI. */
export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
}

/** Determines the forge kind from a hostname. */
function forgeKind(host: string): ForgeKind {
  const h = host.toLowerCase().trim();
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github';
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com')) return 'gitlab';
  if (
    h === 'dev.azure.com' ||
    h.endsWith('.dev.azure.com') ||
    h === 'visualstudio.com' ||
    h.endsWith('.visualstudio.com') ||
    h.endsWith('.azure.com')
  ) {
    return 'azure';
  }
  if (h === 'bitbucket.org' || h.endsWith('.bitbucket.org')) return 'bitbucket';
  return 'unknown';
}

function stripGitSuffix(s: string): string {
  return s.replace(/\.git$/, '');
}

/**
 * Parses a git remote URL (https, ssh://, scp-style `git@host:path`, and Azure
 * DevOps variants) into structured parts, or `null` when it cannot be parsed.
 */
export function parseRemoteUrl(url: string): ParsedRemote | null {
  if (!url) return null;
  const raw = url.trim();

  // Azure DevOps SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  //              or:  {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
  const azureSsh = raw.match(/@(?:ssh\.dev\.azure\.com|[^:@]*vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+)/i);
  if (azureSsh) {
    return {
      host: 'dev.azure.com',
      owner: azureSsh[1],
      project: azureSsh[2],
      repo: stripGitSuffix(azureSsh[3]),
      kind: 'azure',
    };
  }

  // Normalize into a URL we can parse with the WHATWG URL class.
  let normalized = raw;
  const scp = raw.match(/^([^@]+)@([^:]+):(.+)$/); // git@host:owner/repo(.git)
  if (scp && !raw.includes('://')) {
    normalized = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  const host = parsed.hostname;
  const kind = forgeKind(host);
  const segments = parsed.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (segments.length < 2) return null;

  // Azure HTTPS: /{org}/{project}/_git/{repo}  (org may be a leading path segment)
  const gitIdx = segments.indexOf('_git');
  if (kind === 'azure' && gitIdx >= 1) {
    const repo = segments[gitIdx + 1];
    const project = segments[gitIdx - 1];
    // The org is whatever precedes the project (Azure hosts it at /{org}/...).
    const org = segments.slice(0, gitIdx - 1).join('/') || project;
    if (repo) {
      return { host: 'dev.azure.com', owner: org, project, repo: stripGitSuffix(repo), kind: 'azure' };
    }
  }

  // Generic: owner(/subgroups)/repo — repo is the last segment.
  const repo = stripGitSuffix(segments[segments.length - 1]);
  const owner = segments.slice(0, segments.length - 1).join('/');
  if (!owner || !repo) return null;

  return { host, owner, repo, kind };
}

/**
 * Builds a "create a PR/MR" URL for a base←head comparison, or `null` for an
 * unknown forge (the caller should then print the remote URL + branch instead).
 */
export function buildCompareUrl(remote: ParsedRemote, baseBranch: string, headBranch: string): string | null {
  const enc = encodeURIComponent;
  switch (remote.kind) {
    case 'github':
      // GitHub accepts raw slashes in the compare segment (feature/x is fine).
      return `https://${remote.host}/${remote.owner}/${remote.repo}/compare/${baseBranch}...${headBranch}?expand=1`;
    case 'gitlab':
      return (
        `https://${remote.host}/${remote.owner}/${remote.repo}/-/merge_requests/new` +
        `?merge_request%5Bsource_branch%5D=${enc(headBranch)}` +
        `&merge_request%5Btarget_branch%5D=${enc(baseBranch)}`
      );
    case 'azure':
      return (
        `https://dev.azure.com/${remote.owner}/${remote.project ?? ''}/_git/${remote.repo}/pullrequestcreate` +
        `?sourceRef=${enc(headBranch)}&targetRef=${enc(baseBranch)}`
      );
    case 'bitbucket':
      return `https://${remote.host}/${remote.owner}/${remote.repo}/pull-requests/new?source=${enc(headBranch)}&dest=${enc(baseBranch)}`;
    default:
      return null;
  }
}

function encodePathSegments(rawPath: string): string {
  return rawPath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * Builds a commit URL for a forge, or `null` for an unknown forge.
 * Path segments are encoded safely.
 */
export function buildCommitUrl(remote: ParsedRemote, sha: string): string | null {
  const enc = encodeURIComponent;
  const owner = encodePathSegments(remote.owner);
  const repo = enc(remote.repo);
  const encSha = enc(sha);

  switch (remote.kind) {
    case 'github':
      return `https://${remote.host}/${owner}/${repo}/commit/${encSha}`;
    case 'gitlab':
      return `https://${remote.host}/${owner}/${repo}/-/commit/${encSha}`;
    case 'azure': {
      const project = remote.project ? `${enc(remote.project)}/` : '';
      return `https://dev.azure.com/${owner}/${project}_git/${repo}/commit/${encSha}`;
    }
    case 'bitbucket':
      return `https://${remote.host}/${owner}/${repo}/commits/${encSha}`;
    default:
      return null;
  }
}

/** Detects whether the GitHub CLI is installed and authenticated. */
export async function detectGh(): Promise<GhStatus> {
  let installed = false;
  try {
    const v = await execa('gh', ['--version'], { reject: false });
    installed = v.exitCode === 0;
  } catch {
    installed = false;
  }
  if (!installed) return { installed: false, authenticated: false };

  let authenticated = false;
  try {
    const a = await execa('gh', ['auth', 'status'], { reject: false });
    authenticated = a.exitCode === 0;
  } catch {
    authenticated = false;
  }
  return { installed, authenticated };
}

/**
 * Creates a PR with the GitHub CLI. Never throws — returns `{ url }` on success
 * or `{ url: null, error }` so the caller can fall back to a compare URL.
 */
export async function createPrWithGh(
  repoPath: string,
  opts: { base: string; head: string; title: string; body: string },
): Promise<{ url: string | null; error?: string }> {
  try {
    const result = await execa(
      'gh',
      ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body', opts.body],
      { cwd: repoPath, reject: false },
    );
    if (result.exitCode === 0) {
      const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const url = lines.reverse().find((l) => l.startsWith('http')) ?? null;
      return { url };
    }
    return { url: null, error: (result.stderr || result.stdout || 'gh pr create failed').split('\n')[0] };
  } catch (error) {
    return { url: null, error: error instanceof Error ? error.message : String(error) };
  }
}
