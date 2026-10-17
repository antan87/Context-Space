/**
 * @module generators/base
 * Builds the small markdown context every AI assistant generator starts from:
 * the task, the repos and how they relate, how to verify each one, and pointers
 * to everything else.
 */

import type { WorkspaceContext } from '../types.js';
import { findInterRepoDependencies } from '../analyzers/detect-deps.js';
import { isInPlace } from '../utils/feature.js';
import { getConventionalTestCommands } from '../utils/test-command.js';
import { renderFreshnessBanner } from '../core/generation-lock.js';
import { PRIMARY_KNOWLEDGE_FILE, PRIMARY_PLAN_FILE, CLI_NAME } from '../core/constants.js';
import { resolveActiveDomainRules } from '../core/domain-packs.js';
import { renderPlanFileInstructions } from '../core/plan-file-text.js';
import { renderLessonsSection } from './lessons.js';

/** How a repo relates to its siblings in this workspace. */
export interface RepoRelations {
  /** Workspace repos this one depends on. */
  dependsOn: string[];
  /** Workspace repos that depend on this one. */
  consumedBy: string[];
  /** The branch this repo is on. */
  branch?: string;
}

/**
 * Works out how each repo relates to its siblings.
 *
 * The data was already being computed — `findInterRepoDependencies` has existed
 * and been exported all along — it simply never reached the assistant-facing
 * context, which is the one place it matters most.
 */
function computeRepoRelations(ctx: WorkspaceContext): Map<string, RepoRelations> {
  const relations = new Map<string, RepoRelations>();
  const { repos, analysis, feature } = ctx;
  if (!analysis) return relations;

  const repoNames = new Map<string, string>();
  for (const repo of repos) repoNames.set(repo.path, repo.name);

  const dependsOn = findInterRepoDependencies(analysis, repoNames);

  // Invert it, so each repo can also state who would break if it changed.
  const consumedBy = new Map<string, string[]>();
  for (const [consumer, providers] of dependsOn) {
    for (const provider of providers) {
      consumedBy.set(provider, [...(consumedBy.get(provider) ?? []), consumer]);
    }
  }

  for (const repo of repos) {
    relations.set(repo.name, {
      dependsOn: dependsOn.get(repo.name) ?? [],
      consumedBy: consumedBy.get(repo.name) ?? [],
      branch: feature.repoBranches?.[repo.name] ?? repo.defaultBranch,
    });
  }

  return relations;
}

/**
 * Orders repos so anything depended upon comes before its consumers. Falls back
 * to the given order for anything a cycle makes unorderable, rather than
 * dropping it.
 *
 * Keyed on the repo objects, not their names. Two repos can share a basename —
 * `/org1/api` and `/org2/api` in an in-place workspace — and keying the visited
 * set by name collapsed them, so one was silently missing from the caller's
 * output. Dependencies are still resolved by name, which is all a manifest
 * gives, so an ambiguous name visits every repo bearing it.
 */
function orderReposByDependency<T extends { name: string }>(
  repos: T[],
  relations: Map<string, RepoRelations>,
): T[] {
  const placed = new Set<T>();
  const ordered: T[] = [];

  const byName = new Map<string, T[]>();
  for (const repo of repos) {
    const sameName = byName.get(repo.name);
    if (sameName) sameName.push(repo);
    else byName.set(repo.name, [repo]);
  }

  const visit = (repo: T, seen: Set<T>): void => {
    if (placed.has(repo) || seen.has(repo)) return;
    seen.add(repo);
    for (const dependency of relations.get(repo.name)?.dependsOn ?? []) {
      for (const target of byName.get(dependency) ?? []) visit(target, seen);
    }
    if (!placed.has(repo)) {
      placed.add(repo);
      ordered.push(repo);
    }
  };

  for (const repo of repos) visit(repo, new Set());
  // Every repo is placed by the loop above; this only guarantees the caller
  // never receives fewer rows than it passed in.
  for (const repo of repos) if (!placed.has(repo)) ordered.push(repo);

  return ordered;
}

/**
 * Builds the workspace context an assistant loads at session start.
 *
 * Kept deliberately small. It carries only what an assistant cannot cheaply
 * work out for itself, and links to the rest:
 *
 *  - what to build
 *  - where each repo is, and how the repos relate to each other
 *  - how to verify each repo
 *  - the one structural rule that is not inferable (worktree isolation)
 *  - the titles of the recorded knowledge entries, so a session starts knowing what
 *    was learned (`generators/lessons`; `core/agents-lessons` keeps them current)
 *
 * Everything else is a pointer. Per-repo language, framework, build tool, port
 * and purpose used to be listed here; two independent agents evaluating a
 * generated workspace used none of it — they needed code-level facts instead,
 * like a module's exports — while that same block is where a wrong claim
 * appeared ("Build tools: none detected" for a repo whose package.json has
 * "build": "tsc"). Anything derivable from a manifest is better read from the
 * manifest, where it cannot go stale.
 */
export async function buildContextContent(ctx: WorkspaceContext): Promise<string> {
  const { feature, repos, analysis } = ctx;
  const inPlace = isInPlace(feature);

  const relations = analysis && analysis.size > 0
    ? computeRepoRelations(ctx)
    : new Map<string, RepoRelations>();
  const ordered = orderReposByDependency(repos, relations);

  // One row per repo: where it is, how to check it, and who it is tied to.
  const rows = ordered.map((repo) => {
    const a = analysis?.get(repo.path);
    const rel = relations.get(repo.name);
    const verifyCommands = a ? getConventionalTestCommands(a) : [];
    const verify = verifyCommands.length > 0
      ? verifyCommands.map((cmd) => '`' + cmd + '`').join(', ')
      : '—';

    // In-place repos can each sit on a different branch, which is worth stating.
    // Repos dynamically isolated into dedicated worktrees show their worktree path.
    // In worktree mode they are all on the feature branch named just below, so
    // repeating it per row would be noise.
    const isIsolated = inPlace && Boolean(feature.isolatedRepos?.[repo.name] ?? feature.isolatedRepos?.[repo.path]);
    const isolated = feature.isolatedRepos?.[repo.name] ?? feature.isolatedRepos?.[repo.path];
    const branch = rel?.branch ?? (isolated ? isolated.branchName : undefined);
    const location = inPlace
      ? (isIsolated
          ? `\`${isolated!.worktreePath}\` *(on ${branch ?? 'feature branch'} [isolated worktree])*`
          : `\`${repo.path}\`${branch ? ` (on ${branch})` : ''} *(read-only reference)*`)
      : `\`${repo.name}\``;

    const ties: string[] = [];
    if (rel?.dependsOn.length) ties.push(`needs ${rel.dependsOn.map((n) => '`' + n + '`').join(', ')}`);
    if (rel?.consumedBy.length) ties.push(`used by ${rel.consumedBy.map((n) => '`' + n + '`').join(', ')}`);

    return `| \`${repo.name}\` | ${location} | ${verify} | ${ties.join('; ') || '—'} |`;
  });

  // The earliest repo something actually builds on — and it names what. The
  // previous test was "does any repo anywhere have a dependency", which pointed
  // at `ordered[0]` regardless: a workspace of [alpha (independent), lib, web]
  // where only web needs lib produced "Start with `alpha` — the others build on
  // it" directly above alpha's own row showing no ties at all. Since `ordered` is
  // already dependency-ordered, the first entry with consumers is the real
  // starting point, and if nothing has consumers there is no order to give.
  const startsWith = ordered.find((repo) => (relations.get(repo.name)?.consumedBy.length ?? 0) > 0);
  const consumers = startsWith ? relations.get(startsWith.name)!.consumedBy : [];
  const startHint = startsWith
    ? `\n\nStart with \`${startsWith.name}\` — ${consumers.map((n) => '`' + n + '`').join(', ')} ${consumers.length === 1 ? 'builds' : 'build'} on it.`
    : '';

  // Only the rule an assistant cannot infer. Which directory to run a command
  // in, and how git works, are not worth the tokens.
  const hasIsolated = inPlace && Boolean(feature.isolatedRepos && Object.keys(feature.isolatedRepos).length > 0);
  const structureRule = inPlace
    ? (hasIsolated
        ? '**RULE**: Repos marked `[isolated worktree]` MUST be edited inside their dedicated worktree path. Unisolated repos are in READ-ONLY reference mode: before modifying files in any unisolated repository, you MUST prepare it for editing with the `isolate_repo` MCP tool (or `ctxspace isolate <repo>`, or "Prepare for editing" in the app). Commit, finish and revert refuse to change a reference repo.'
        : '**RULE**: These repositories are in READ-ONLY reference mode on host branches. Before making ANY file modifications, you MUST prepare the repo for editing with the `isolate_repo` MCP tool (or `ctxspace isolate <repo>`, or "Prepare for editing" in the app) to create a dedicated feature worktree. Commit, finish and revert refuse to change a reference repo.')
    : `Each repo above is a separate git worktree on \`${feature.branchName}\`. **Do not edit the original repositories elsewhere on disk** — that is a different checkout and changes there are not part of this feature.`;

  // Repos that already ship their own assistant instructions; those override
  // anything here for that repo, so it is worth naming them. Walked via `repos`
  // rather than the analysis map, so an analysis entry for a repo that is not in
  // this workspace cannot put a name in the list — the same scoping the plan's
  // contract table needed.
  const existing = ordered
    .map((repo) => analysis?.get(repo.path))
    .filter((a): a is NonNullable<typeof a> => !!a && a.existingAIConfigs.length > 0)
    .map((a) => `\`${a.name}\` (${a.existingAIConfigs.map((c) => c.relativePath).join(', ')})`);

  const teamwork = feature.teamworkInstructions
    ? `\n## How to work together\n\n${feature.teamworkInstructions}\n`
    : '';

  const ownInstructions = existing.length > 0
    ? `- These repos carry their own assistant instructions, which take precedence inside them: ${existing.join(', ')}\n`
    : '';

  // Commands the person who created this workspace typed in by hand. Exactly the
  // kind of thing an assistant cannot derive: a mock/seed step, a non-standard
  // start command, a test command that differs from the convention. The API still
  // accepts and persists these, and for a while nothing read them — deleting the
  // only reader as "dead code" silently dropped them from every generated file.
  const custom: string[] = [];
  if (feature.resumption?.testCommand) custom.push(`- Verify with \`${feature.resumption.testCommand}\` — this overrides the per-repo commands above.`);
  if (feature.resumption?.mockCommand) custom.push(`- Set up dependencies first with \`${feature.resumption.mockCommand}\`.`);
  if (feature.resumption?.startCommand) custom.push(`- Start the services with \`${feature.resumption.startCommand}\`.`);
  const customCommands = custom.length > 0
    ? `\n## Commands recorded for this workspace\n\nThese were entered by hand and are not derivable from any manifest.\n\n${custom.join('\n')}\n`
    : '';

  // Enterprise organization conventions and domain subsystem rules
  let enterpriseSection = '';
  if (feature.organizationId || (feature.domainPacks && feature.domainPacks.length > 0)) {
    const { organization, domainPacks } = resolveActiveDomainRules(feature.organizationId, feature.domainPacks);
    const parts: string[] = [];

    if (organization) {
      const orgLines = [
        `## Organization Conventions (${organization.name})`,
        '',
        organization.commitMessagePattern ? `- **Commit Convention**: Commit messages must follow regex \`${organization.commitMessagePattern}\` (e.g. \`${organization.commitExample ?? ''}\`).` : '',
        organization.prTemplate ? `- **PR Template**: \`${organization.prTemplate}\`` : '',
        ...organization.rules.map((r) => `- ${r}`),
      ].filter(Boolean);
      parts.push(orgLines.join('\n'));
    }

    if (domainPacks.length > 0) {
      const domainSections = domainPacks.map((pack) => {
        const pLines = [
          `### ${pack.name}`,
          pack.description,
          '',
          ...(pack.rules ?? []).map((r) => `- ${r}`),
          pack.verifyCommand ? `- **Domain Verification**: \`${pack.verifyCommand}\`` : '',
        ].filter(Boolean);
        return pLines.join('\n');
      });
      parts.push(`## Active Domain Rules (${domainPacks.map((d) => d.name).join(', ')})\n\n${domainSections.join('\n\n')}`);
    }

    if (parts.length > 0) {
      enterpriseSection = `\n\n${parts.join('\n\n')}`;
    }
  }

  // A table header over no rows, followed by "Each repo above is a separate git
  // worktree", describes nothing. `create` should never produce this, but the
  // writer had no guard, so say the true thing instead.
  const reposSection = rows.length > 0
    ? `## Repos

| Repo | ${inPlace ? 'Path' : 'Directory'} | Verify | Cross-repo |
|---|---|---|---|
${rows.join('\n')}

${structureRule}${startHint}`
    : `This workspace has no repositories yet — add one with \`ctxspace add-repo\`.`;

  const freshness = ctx.generation ? `${renderFreshnessBanner(ctx.generation)}\n\n` : '';

  // The description is optional at creation; an empty one leaves no blank paragraph.
  const summary = feature.description?.trim() ? `${feature.description}\n\n` : '';

  return `${freshness}# ${feature.id}

${summary}${reposSection}

${renderPlanFileInstructions()}

${renderLessonsSection(ctx.lessons ?? [])}## Where to look

If \`ctxspace\` is not on PATH, use \`./.contextspace/bin/ctxspace\` (bash) or \`.\\.contextspace\\bin\\ctxspace.cmd\` (PowerShell) with the same arguments. Trust workspace MCP configs in your assistant.

- \`${PRIMARY_KNOWLEDGE_FILE}\` — decisions and gotchas, one per \`###\` heading. Search it, not the whole file, with \`${CLI_NAME} knowledge search <words>\` (MCP \`search_knowledge\` also works). Add a rule and its reason, if they cannot be recovered from the code or git history, with \`${CLI_NAME} knowledge add -t decision|gotcha --title "..." -m "..."\`.
- \`contextspace-work.json\` — assignment and sources. Read live guidance with \`ctxspace flow --assignment\` or MCP \`get_work_context\`.
- \`.agents/skills/\` — enabled playbooks; Claude copies: \`.claude/skills/\`.
- Need the user's answer or approval? Run \`${CLI_NAME} ask "<question>" --option "<answer>" ...\` (or MCP \`request_user_input\`) so this chat is flagged, then ask in the chat and end your turn.
- Show your work: MCP \`show_in_reader\`, \`annotate_document\` and \`suggest_next\` put it beside the user's chat. They only show things. No MCP: say it in the chat.
${ownInstructions}${customCommands}${teamwork}${enterpriseSection}`;
}
