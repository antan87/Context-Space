import type { WorkspaceMode } from '../../types.js';

export function suggestedBranchName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `feature/${slug}` : '';
}

/** The branch a worktree workspace is created on: the one typed, else one derived from the name. */
export function resolveWorktreeBranch(branchName: string | undefined, workspaceName: string): string {
  return (branchName ?? '').trim() || suggestedBranchName(workspaceName);
}

/** What the strategy and skill suggestions read: the task if there is one, else the workspace name. */
export function taskTextForSuggestions(description: string, workspaceName: string): string {
  return description.trim() || workspaceName.trim();
}

const DERIVED_NAME_MAX = 48;
/** A full stop earlier than this is an abbreviation ("e.g."), not the end of the first sentence. */
const SENTENCE_MIN = 12;

/**
 * A workspace name taken from what the developer wants to do: the first
 * sentence of the description's first line, tidied, and cut at a word when it is
 * long. Empty when there is no description.
 */
export function deriveWorkspaceName(description: string): string {
  const line = (description.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '').replace(/\s+/g, ' ');
  const sentenceEnd = [...line.matchAll(/[.!?](?=\s|$)/g)].find((end) => end.index >= SENTENCE_MIN)?.index;
  const tidy = (sentenceEnd === undefined ? line : line.slice(0, sentenceEnd)).replace(/[.!?:;,\s]+$/, '');
  if (tidy.length <= DERIVED_NAME_MAX) return tidy;
  const cut = tidy.slice(0, DERIVED_NAME_MAX);
  const atWord = cut.lastIndexOf(' ');
  return (atWord > DERIVED_NAME_MAX / 2 ? cut.slice(0, atWord) : cut).replace(/[.!?:;,\s-]+$/, '');
}

/** The name the workspace is created with: the one typed, else one taken from the description. */
export function resolveWorkspaceName(workspaceName: string, description: string): string {
  return workspaceName.trim() || deriveWorkspaceName(description);
}

export type WorkspaceFormProblem = 'repository' | 'task' | 'branch';

/**
 * What stops a workspace from being created, first thing first, or null when
 * nothing does. A workspace needs at least one repository, and a name: typed, or
 * taken from the description. The description alone is enough: the backend
 * accepts an empty one, so it never gates creation when a name is typed. New
 * worktrees also need a branch, normally derived from the name.
 */
export function workspaceFormProblem(params: {
  workspaceName: string;
  description?: string;
  mode: WorkspaceMode;
  branchName?: string;
  selectedRepoCount: number;
}): WorkspaceFormProblem | null {
  if (params.selectedRepoCount <= 0) return 'repository';
  const name = resolveWorkspaceName(params.workspaceName, params.description ?? '');
  if (!name) return 'task';
  if (params.mode !== 'in-place' && !resolveWorktreeBranch(params.branchName, name)) return 'branch';
  return null;
}

export function isWorkspaceFormValid(params: {
  workspaceName: string;
  description?: string;
  mode: WorkspaceMode;
  branchName?: string;
  selectedRepoCount: number;
}): boolean {
  return workspaceFormProblem(params) === null;
}

/**
 * Runs once per finished creation job: makes the chosen harness the preferred
 * one for the new workspace, opens the CLI start-session dock and lands on the
 * workspace page. Returns the id that was acted on so the caller can ignore
 * repeat completions.
 *
 * `autoNavigate: false` is for re-opened job links, which only inspect a
 * finished job. They do nothing, and must not mark the workspace as handled: a
 * later creation of the same workspace in this page still has to open it.
 *
 * The harness is applied here, once the workspace exists, so a creation that
 * fails never leaves a preference behind for a workspace that was not made.
 */
export function handleWorkspaceCreationCompletion(params: {
  status: string;
  workspaceId?: string | null;
  lastOpenedWorkspaceId: string | null;
  autoNavigate?: boolean;
  startHarness?: string;
  onChooseHarness?: (workspaceId: string, harness: string) => void;
  onOpenCli: (workspaceId: string) => void;
  onNavigate: (path: string) => void;
}): string | null {
  if (params.status !== 'completed' || !params.workspaceId || params.lastOpenedWorkspaceId === params.workspaceId) {
    return params.lastOpenedWorkspaceId;
  }
  if (params.autoNavigate === false) return params.lastOpenedWorkspaceId;
  if (params.startHarness) params.onChooseHarness?.(params.workspaceId, params.startHarness);
  params.onOpenCli(params.workspaceId);
  params.onNavigate(`/workspaces/${encodeURIComponent(params.workspaceId)}`);
  return params.workspaceId;
}

/**
 * The harness a developer starts with always receives the workspace
 * instructions: choosing it must not depend on also ticking it under Advanced.
 */
export function withStartHarness(assistants: readonly string[], startHarness: string): string[] {
  return startHarness && !assistants.includes(startHarness) ? [...assistants, startHarness] : [...assistants];
}

/**
 * The harness shown as chosen is only ever the developer's own pick, and only
 * while it is installed. Nothing is chosen for them: not a default, and not the
 * tool they used last time.
 */
export function resolveStartHarness(params: { chosen: string; installed: readonly string[] }): string {
  return params.installed.includes(params.chosen) ? params.chosen : '';
}

/** "shop-api, shop-web +2": the first few names and how many more there are, for places with little room. */
export function summarizeNames(names: readonly string[], show = 2): string {
  const shown = names.slice(0, show).join(', ');
  const more = names.length - show;
  return more > 0 ? `${shown} +${more}` : shown;
}

const WORK_TYPE_LABELS: Record<string, string> = {
  bug: 'Bug fix',
  feature: 'Feature',
  performance: 'Performance',
  refactor: 'Refactor',
  rewrite: 'Rewrite',
};

/** The label for a work type value, as the Work type list shows it. */
export function workTypeLabel(workType: string): string {
  return WORK_TYPE_LABELS[workType] ?? workType;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The options under More options that are not at their default, as short phrases
 * for the closed disclosure, so a developer sees what is set without opening it.
 * Empty when everything is at its default.
 */
export function summarizeOptionChanges(options: {
  mode: WorkspaceMode;
  workType: string;
  /** How many repositories ride an existing branch (worktrees only). */
  existingBranches: number;
  autoUpdateBase: boolean;
  /** Categories of My library turned on. */
  categories?: number;
  skills: number;
  tags: number;
  /** Display name of the tool chosen to start with, or '' for none. */
  startHarness: string;
  /** Tools ticked to receive instructions besides the one started with. */
  extraAssistants: number;
  hasTeamworkInstructions: boolean;
  agents: number;
}): string[] {
  const phrases: string[] = [];
  if (options.mode === 'worktree') phrases.push('New worktrees');
  if (options.mode === 'worktree' && options.existingBranches > 0) phrases.push('Existing branches');
  if (options.workType !== 'feature') phrases.push(workTypeLabel(options.workType));
  if (options.autoUpdateBase) phrases.push('Fast-forward first');
  if (options.startHarness) phrases.push(`Starts with ${options.startHarness}`);
  if (options.categories) phrases.push(`${options.categories} ${options.categories === 1 ? 'category' : 'categories'}`);
  if (options.skills > 0) phrases.push(count(options.skills, 'skill'));
  if (options.tags > 0) phrases.push(count(options.tags, 'tag'));
  if (options.extraAssistants > 0) phrases.push(count(options.extraAssistants, 'more AI tool'));
  if (options.hasTeamworkInstructions) phrases.push('Teamwork notes');
  if (options.agents > 0) phrases.push(count(options.agents, 'agent'));
  return phrases;
}
