import { HarnessIcon, harnessName } from '../components/icons/HarnessIcon.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ResourcePreview } from '../features/workspace-launch/ResourcePreview.js';
import { Check, CircleAlert, FolderGit2, GitBranch, Sparkles, Zap, Boxes, Bot, RefreshCw, Tag } from 'lucide-react';

import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Textarea } from '../components/ui/textarea.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Spinner } from '../components/ui/spinner.js';
import { StatusBadge } from '../components/ui/status-badge.js';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from '../components/ui/dialog.js';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { RepoChecklist } from '../components/RepoChecklist.js';
import { cn } from '../lib/utils.js';
import { repoName } from '../lib/status.js';
import { apiFetch } from '../lib/api/client.js';
import {
  useAiDetect,
  useCreateWorkspace,
  useDomainPacks,
  useCreateDomainPack,
  useProjects,
  useRepoBranches,
  useRepos,
  useWorkflowTemplates,
  useSkills,
  useAgents,
  useReposFreshness,
  usePullRepos,
  type CreateWorkspacePayload,
} from '../lib/api/queries.js';
import { ScaffoldRepoInline } from '../components/ScaffoldRepoInline.js';
import { useCreationStream, type CreationStep } from '../lib/api/useCreationStream.js';
import type { RepoInfo, RepoFreshness, WorkspaceMode, WorkGuidance } from '../types.js';
import { WorkspaceLauncher } from '../features/workspace-launch/WorkspaceLauncher.js';
import { floatingChatStore } from '../features/chat/floatingChatStore.js';
import {
  deriveWorkspaceName,
  handleWorkspaceCreationCompletion,
  resolveStartHarness,
  resolveWorkspaceName,
  resolveWorktreeBranch,
  suggestedBranchName,
  summarizeNames,
  summarizeOptionChanges,
  taskTextForSuggestions,
  withStartHarness,
  workspaceFormProblem,
} from '../features/workspace-launch/createWorkspaceFlow.js';
import { HarnessPicker } from '../features/workspace-launch/HarnessPicker.js';
import { MoreOptions, OptionGroup } from '../features/workspace-launch/MoreOptions.js';
import { SelectedRepos } from '../features/workspace-launch/SelectedRepos.js';

/** Sentinel select value for ad-hoc repo picking. */
const AD_HOC = '__ad-hoc__';

const isVsCode = new URLSearchParams(window.location.search).get('env') === 'vscode';

/** The card the form's main steps sit in: the same as the cards on the Overview. */
const FORM_CARD = 'rounded-xl border border-border bg-card px-4 py-3 shadow-xs';

const MODE_OPTIONS: Array<{ value: WorkspaceMode; icon: typeof Zap; title: string; body: string }> = [
  {
    value: 'in-place',
    icon: Zap,
    title: 'Reference checkouts',
    body: 'Read your checkouts as they are; nothing changes them. Prepare a repository for editing to give it its own branch and worktree in this workspace.',
  },
  {
    value: 'worktree',
    icon: GitBranch,
    title: 'New worktrees',
    body: 'Create a branch and editable worktree for each repository now.',
  },
];

/**
 * One per-repo existing-branch override input, with the repo's real branches
 * offered as datalist suggestions (fetched lazily once the section opens —
 * the server still enforces existence, this just prevents typos up front).
 */
function BranchOverrideRow({
  repo,
  value,
  onChange,
  enabled,
}: {
  repo: RepoInfo;
  value: string;
  onChange: (v: string) => void;
  enabled: boolean;
}) {
  const branches = useRepoBranches(repo.path, enabled);
  const options = useMemo(
    () => [...new Set([...(branches.data?.local ?? []), ...(branches.data?.remote ?? [])])],
    [branches.data],
  );
  const listId = `branches-${repo.path.replace(/[^a-zA-Z0-9]/g, '-')}`;
  return (
    <label className="flex items-center gap-2">
      <span className="w-40 shrink-0 truncate text-xs">{repo.name}</span>
      <Input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="existing branch (must exist)"
        className="h-7 font-mono text-xs"
      />
      <datalist id={listId}>
        {options.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
    </label>
  );
}

function StepRow({ step }: { step: CreationStep }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full border',
          step.status === 'completed' && 'border-success bg-success/15 text-success-foreground',
          step.status === 'running' && 'border-primary text-primary',
          step.status === 'failed' && 'border-destructive bg-destructive/15 text-destructive-foreground',
          step.status === 'pending' && 'border-border text-muted-foreground',
        )}
      >
        {step.status === 'completed' ? (
          <Check className="size-3" />
        ) : step.status === 'running' ? (
          <Spinner className="size-3" />
        ) : step.status === 'failed' ? (
          <CircleAlert className="size-3" />
        ) : null}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{step.name}</p>
        <p className="truncate text-xs text-muted-foreground">{step.message}</p>
      </div>
    </li>
  );
}

export function StartWorkPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const projects = useProjects();
  const repos = useRepos();
  const aiDetect = useAiDetect();
  const templates = useWorkflowTemplates();
  const skillsQuery = useSkills();
  const agentsQuery = useAgents();
  const domainPacksQuery = useDomainPacks();
  const createWorkspace = useCreateWorkspace();
  const { progress, start, reset } = useCreationStream();
  const creationJobId = searchParams.get('job');
  const openedWorkspace = useRef<string | null>(null);
  // True once this page instance has submitted a workspace itself. A ?job= link
  // opened without submitting (and not from chat) only inspects a past job.
  const [submittedHere, setSubmittedHere] = useState(false);
  const isDirectReplay = Boolean(creationJobId) && !submittedHere && searchParams.get('from') !== 'chat';

  const [projectId, setProjectId] = useState<string>(searchParams.get('project') ?? AD_HOC);
  const [workType, setWorkType] = useState<WorkGuidance['workType']>('feature');
  const [mode, setMode] = useState<WorkspaceMode>('in-place');
  const [branchName, setBranchName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // Setup hands over the repositories picked for the first task as ?repo=…
  const [adHocPaths, setAdHocPaths] = useState<string[]>(() => searchParams.getAll('repo'));
  // Everything beyond the repositories and the task lives under More options, closed until asked for.
  const [moreOpen, setMoreOpen] = useState(false);
  // Repositories already chosen by the link (a saved project, or Setup's first task): start on the task instead.
  const [startsWithRepos] = useState(() => Boolean(searchParams.get('project')) || searchParams.getAll('repo').length > 0);
  const [assistants, setAssistants] = useState<string[]>([]);
  // Empty until the developer picks a harness: nothing is ever preselected.
  const [chosenHarness, setChosenHarness] = useState('');
  const startHarness = resolveStartHarness({
    chosen: chosenHarness,
    installed: (aiDetect.data ?? []).filter((item) => item.detected).map((item) => item.name),
  });
  const instructionTargets = withStartHarness(assistants, startHarness);

  useEffect(() => {
    openedWorkspace.current = handleWorkspaceCreationCompletion({
      status: progress.status,
      workspaceId: progress.workspaceId,
      lastOpenedWorkspaceId: openedWorkspace.current,
      autoNavigate: !isDirectReplay,
      startHarness,
      onChooseHarness: (id, harness) => floatingChatStore.setHarness(id, harness),
      onOpenCli: (id) => floatingChatStore.openCli(id),
      onNavigate: (url) => navigate(url),
    });
  }, [progress.status, progress.workspaceId, navigate, isDirectReplay, startHarness]);
  const [enabledSkills, setEnabledSkills] = useState<string[]>([]);
  const [enabledAgents, setEnabledAgents] = useState<string[]>([]);
  const [strategyId, setStrategyId] = useState<string>('');
  /** Editable teamwork instructions; prefilled by strategy pick or AI suggestion. */
  const [customInstructions, setCustomInstructions] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestedDifficulty, setSuggestedDifficulty] = useState<string | null>(null);

  /** Optional per-repo existing branch (keyed by repo PATH — names can repeat). */
  const [branchOverrides, setBranchOverrides] = useState<Record<string, string>>({});
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Enter in the name field was pressed while something was missing: say what, instead of doing nothing.
  const [asked, setAsked] = useState(false);
  // The branch field sits under More options: when it is what stops Create, open it, focus it and explain.
  const [branchError, setBranchError] = useState<string | null>(null);
  const [focusBranch, setFocusBranch] = useState(0);
  const branchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusBranch > 0) branchInputRef.current?.focus();
  }, [focusBranch]);

  // Tag creation modal state
  const [showCreateTagModal, setShowCreateTagModal] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagId, setNewTagId] = useState('');
  const [newTagDescription, setNewTagDescription] = useState('');
  const [newTagType, setNewTagType] = useState<'vertical' | 'trait'>('vertical');
  const [newTagVerifyCmd, setNewTagVerifyCmd] = useState('');
  const [savingNewTag, setSavingNewTag] = useState(false);

  const createDomainPackMutation = useCreateDomainPack();

  const handleCreateNewTag = async () => {
    if (!newTagName.trim() || !newTagId.trim()) return;
    setSavingNewTag(true);
    try {
      const id = newTagId.trim().toLowerCase();
      await createDomainPackMutation.mutateAsync({
        id,
        name: newTagName.trim(),
        description: newTagDescription.trim() || newTagName.trim(),
        categoryType: newTagType,
        verifyCommand: newTagVerifyCmd.trim() || undefined,
        tags: [id, ...newTagName.trim().toLowerCase().split(/\s+/).filter(Boolean)],
      });
      setSelectedTags((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setShowCreateTagModal(false);
      setNewTagName('');
      setNewTagId('');
      setNewTagDescription('');
      setNewTagVerifyCmd('');
    } catch {
      // Handled
    } finally {
      setSavingNewTag(false);
    }
  };

  /** Keyword-based auto-suggestions from what the developer types in description */
  const suggestedMatches = useMemo(() => {
    const task = taskTextForSuggestions(description, workspaceName);
    if (task.length < 3) return [];
    const text = task.toLowerCase();
    const suggestions: Array<{ id: string; title: string; type: 'tag' | 'skill' }> = [];

    // Match tags
    for (const pack of domainPacksQuery.data ?? []) {
      if (selectedTags.includes(pack.id)) continue;
      const terms = [pack.id, pack.name, ...(pack.tags ?? [])];
      if (terms.some((term) => term && text.includes(term.toLowerCase()))) {
        suggestions.push({ id: pack.id, title: `#${pack.id}`, type: 'tag' });
      }
    }

    // Match skills
    for (const skill of skillsQuery.data ?? []) {
      if (enabledSkills.includes(skill.id)) continue;
      const terms = [skill.id, skill.name, skill.title, ...(skill.tags ?? [])];
      if (terms.some((term) => term && term.length > 2 && text.includes(term.toLowerCase()))) {
        suggestions.push({ id: skill.id, title: skill.title || skill.name, type: 'skill' });
      }
    }

    return suggestions.slice(0, 6);
  }, [description, workspaceName, domainPacksQuery.data, skillsQuery.data, selectedTags, enabledSkills]);

  useEffect(() => {
    if (creationJobId) {
      start(creationJobId);
    } else {
      reset();
    }
  }, [creationJobId, reset, start]);

  const returnToForm = () => {
    reset();
    setSubmittedHere(false);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete('job');
      return next;
    }, { replace: true });
  };

  const startOver = () => {
    setSubmittedHere(false);
    const url = new URL(window.location.href);
    url.hash = '#/new';
    window.location.replace(url.toString());
  };

  const retryObservation = () => {
    if (creationJobId) start(creationJobId);
  };

  const selectedProject = useMemo(
    () => (projects.data ?? []).find((p) => p.id === projectId) ?? null,
    [projects.data, projectId],
  );

  const selectedRepos: RepoInfo[] = useMemo(() => {
    if (selectedProject) {
      return selectedProject.repos.map((r) => ({
        name: repoName(r.path),
        path: r.path,
        defaultBranch: r.defaultBranch,
      }));
    }
    return (repos.data ?? []).filter((r) => adHocPaths.includes(r.path));
  }, [selectedProject, repos.data, adHocPaths]);

  // The quick path uses source checkouts, so updating repositories requires an explicit opt-in.
  const [autoUpdateBase, setAutoUpdateBase] = useState(false);
  const [pullWarning, setPullWarning] = useState<string | null>(null);
  const pullRepos = usePullRepos();

  const reposToCheck = useMemo(() => {
    return selectedRepos.map((r) => ({
      path: r.path,
      branch: branchOverrides[r.path] || r.defaultBranch,
    }));
  }, [selectedRepos, branchOverrides]);

  const freshnessQuery = useReposFreshness(reposToCheck, reposToCheck.length > 0);

  const freshnessMap: Record<string, RepoFreshness> = useMemo(() => {
    const map: Record<string, RepoFreshness> = {};
    for (const item of freshnessQuery.data ?? []) {
      map[item.repoPath] = item;
    }
    return map;
  }, [freshnessQuery.data]);

  const behindRepos = useMemo(() => {
    return (freshnessQuery.data ?? []).filter((f) => f.status === 'behind');
  }, [freshnessQuery.data]);

  const pullAllBehind = async () => {
    setPullWarning(null);
    try {
      const res = await pullRepos.mutateAsync({
        repos: behindRepos.map((r) => ({ path: r.repoPath, branch: r.branch })),
      });
      const dirtyFails = res.results.filter((r) => r.status === 'dirty' || r.status === 'diverged');
      if (dirtyFails.length > 0) {
        setPullWarning(
          `Could not update ${dirtyFails.length} repo(s): ${dirtyFails.map((d) => `${d.repoName} (${d.message})`).join('; ')}`,
        );
      }
    } catch (err) {
      setPullWarning(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePullSingle = async (repoPath: string, branch: string) => {
    setPullWarning(null);
    try {
      const res = await pullRepos.mutateAsync({ path: repoPath, branch });
      const fail = res.results.find((r) => !r.success);
      if (fail) {
        setPullWarning(`Could not update ${fail.repoName}: ${fail.message}`);
      }
    } catch (err) {
      setPullWarning(err instanceof Error ? err.message : String(err));
    }
  };

  const inPlace = mode === 'in-place';
  // The name is optional: left empty, the workspace is named from what the developer wants to do.
  const effectiveName = resolveWorkspaceName(workspaceName, description);
  const derivedName = workspaceName.trim() ? '' : deriveWorkspaceName(description);
  const worktreeBranch = resolveWorktreeBranch(branchName, effectiveName);
  const problem = workspaceFormProblem({
    workspaceName,
    description,
    mode,
    branchName,
    selectedRepoCount: selectedRepos.length,
  });
  // A missing branch is explained when Create is pressed (it lives under More options); the rest keep Create off.
  const canAttempt = problem === null || problem === 'branch';
  const shownBranchError = problem === 'branch' ? branchError : null;
  useEffect(() => {
    if (problem === null) setAsked(false);
  }, [problem]);

  const optionChanges = summarizeOptionChanges({
    mode,
    workType,
    existingBranches: selectedRepos.filter((repo) => branchOverrides[repo.path]?.trim()).length,
    autoUpdateBase,
    skills: enabledSkills.length,
    tags: selectedTags.length,
    startHarness: startHarness ? harnessName(startHarness) : '',
    extraAssistants: instructionTargets.length - (startHarness ? 1 : 0),
    hasTeamworkInstructions: customInstructions.trim().length > 0,
    agents: enabledAgents.length,
  });

  const applyStrategy = (id: string) => {
    setStrategyId(id);
    setSuggestedDifficulty(null);
    const template = (templates.data ?? []).find((t) => t.id === id);
    setCustomInstructions(template?.content ?? '');
  };

  const suggestStrategy = async () => {
    const task = taskTextForSuggestions(description, workspaceName);
    if (!task) {
      setSubmitError('Name the workspace or describe the task first — the suggestion is based on it.');
      return;
    }
    setSubmitError(null);
    setSuggesting(true);
    try {
      const data = await apiFetch<{
        success: boolean;
        difficulty: string;
        suggestedWorkflowId: string;
        customInstructions: string;
      }>('/api/workspace/suggest-workflow', {
        method: 'POST',
        body: JSON.stringify({ description: task, repos: selectedRepos }),
      });
      setStrategyId(data.suggestedWorkflowId);
      setCustomInstructions(data.customInstructions);
      setSuggestedDifficulty(data.difficulty);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSuggesting(false);
    }
  };

  const submittingRef = useRef(false);

  const submit = async () => {
    if (submittingRef.current || createWorkspace.isPending) return;
    if (problem === 'branch') {
      setBranchError('The new worktrees need a branch name. Type one here.');
      setMoreOpen(true);
      setFocusBranch((count) => count + 1);
      return;
    }
    if (problem) return;
    submittingRef.current = true;
    setSubmittedHere(true);
    setSubmitError(null);
    const payload: CreateWorkspacePayload = {
      workType,
      mode,
      projectId: selectedProject?.id,
      name: effectiveName,
      ...(!inPlace ? { branchName: worktreeBranch } : {}),
      description: description.trim(),
      repos: selectedRepos.map((repo) => ({
        ...repo,
        existingBranch:
          !inPlace && branchOverrides[repo.path]?.trim() ? branchOverrides[repo.path].trim() : undefined,
      })),
      assistants: instructionTargets,
      enabledSkills: enabledSkills.length > 0 ? enabledSkills : undefined,
      enabledAgents: enabledAgents.length > 0 ? enabledAgents : undefined,
      domainPacks: selectedTags.length > 0 ? selectedTags : undefined,
      teamworkInstructions: customInstructions.trim() || undefined,
      autoUpdateBase,
    };
    try {
      const { jobId } = await createWorkspace.mutateAsync(payload);
      start(jobId);
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.set('job', jobId);
        return next;
      }, { replace: true });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      submittingRef.current = false;
    }
  };

  // ── Creation progress / result panel ─────────────────────────────────────
  const displayedProgress = progress.status === 'idle' && creationJobId
    ? { status: 'running' as const, steps: [] }
    : progress;

  if (displayedProgress.status !== 'idle') {
    const failedStep = displayedProgress.steps.find((s) => s.status === 'failed');
    // A creation started here navigates to the workspace as soon as it completes,
    // so skip the "ready" actions rather than flashing them for a frame.
    const openingWorkspace = displayedProgress.status === 'completed' && !isDirectReplay;
    return (
      <div className="mx-auto max-w-xl animate-fade-in">
        <h1 className="text-xl font-semibold">
          {displayedProgress.status === 'running'
            ? 'Setting up your workspace…'
            : displayedProgress.status === 'completed'
              ? (openingWorkspace ? 'Opening your workspace…' : 'Workspace ready')
              : displayedProgress.status === 'failed'
                ? 'Workspace creation failed'
                : 'Unable to reconnect to workspace setup'}
        </h1>
        <ul
          aria-live="polite"
          aria-relevant="additions text"
          className="mt-6 divide-y divide-border rounded-xl border border-border bg-card px-4"
        >
          {displayedProgress.steps.length > 0 ? (
            displayedProgress.steps.map((step) => <StepRow key={step.id} step={step} />)
          ) : (
            <li className="flex items-center gap-3 py-3.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Spinner className="size-3" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">Connecting to workspace setup…</p>
                <p className="text-xs text-muted-foreground">Waiting for creation progress…</p>
              </div>
            </li>
          )}
        </ul>
        {(displayedProgress.status === 'failed' || displayedProgress.status === 'unavailable') && (
          <p className="mt-4 text-sm text-destructive-foreground">
            {failedStep?.message ?? displayedProgress.error ?? 'Something went wrong.'}
          </p>
        )}
        {displayedProgress.status === 'completed' && displayedProgress.workspacePath && (
          <p className="mt-4 truncate font-mono text-xs text-muted-foreground">{displayedProgress.workspacePath}</p>
        )}
        {submitError && <p className="mt-2 text-sm text-destructive-foreground">{submitError}</p>}
        <div data-testid="workspace-ready-actions" className="mt-6 flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
          {displayedProgress.status === 'completed' && displayedProgress.workspaceId && !openingWorkspace && (
            <>
              <Button
                className="w-full min-w-0 whitespace-normal sm:w-auto"
                onClick={() => {
                  floatingChatStore.openCli(displayedProgress.workspaceId!);
                  navigate(`/workspaces/${encodeURIComponent(displayedProgress.workspaceId!)}`);
                }}
              >
                Open workspace
              </Button>
              {displayedProgress.workspacePath && (
                <WorkspaceLauncher
                  workspaceId={displayedProgress.workspaceId}
                  workspacePath={displayedProgress.workspacePath}
                  isVsCode={isVsCode}
                  className="w-full min-w-0 whitespace-normal sm:w-auto"
                />
              )}
            </>
          )}
          {displayedProgress.status === 'failed' && (
            <div className="flex flex-wrap gap-2">
              <Button variant="default" onClick={returnToForm}>
                Back to form (edit & retry)
              </Button>
              <Button variant="outline" onClick={startOver}>
                Start over (clear form)
              </Button>
            </div>
          )}
          {displayedProgress.status === 'unavailable' && (
            <div className="flex flex-wrap gap-2">
              <Button variant="default" onClick={retryObservation}>
                Try reconnecting
              </Button>
              <Button variant="outline" onClick={returnToForm}>
                Back to form
              </Button>
            </div>
          )}
          {displayedProgress.status === 'running' && (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">This can take a moment for large repositories.</p>
              <Button variant="outline" size="sm" onClick={returnToForm}>
                Return to form
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── The form ─────────────────────────────────────────────────────────────
  return (
    // A column as tall as the window, so the Create bar sits at the bottom edge even when the form is short.
    <div className="flex min-h-full animate-fade-in flex-col">
      <div className="mx-auto w-full max-w-xl flex-1">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">New workspace</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose your repositories and say what you want to do.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {/* 1. Repositories */}
        <section aria-labelledby="new-workspace-repos" className={FORM_CARD}>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h2 id="new-workspace-repos" className="text-sm font-semibold">Repositories</h2>
            {(projects.data ?? []).length > 0 && (
              <Select value={projectId} onValueChange={(v) => typeof v === 'string' && setProjectId(v)}>
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Saved project">
                  <SelectValue>
                    {selectedProject ? selectedProject.name : 'Choose repositories manually'}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {(projects.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={AD_HOC}>Choose repositories manually</SelectItem>
                </SelectPopup>
              </Select>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Pick the repositories this work touches.</p>
          {selectedProject ? (
            <ul className="mt-2 flex flex-col gap-0.5">
              {selectedProject.repos.map((r) => (
                <li key={r.path} className="truncate font-mono text-xs text-muted-foreground">
                  {r.path}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2.5">
              <RepoChecklist
                repos={repos.data ?? []}
                selectedPaths={adHocPaths}
                onToggle={(repo) =>
                  setAdHocPaths((prev) =>
                    prev.includes(repo.path) ? prev.filter((p) => p !== repo.path) : [...prev, repo.path],
                  )
                }
                loading={repos.isLoading}
                freshnessMap={freshnessMap}
                autoFocusFilter={!startsWithRepos}
              />
              <SelectedRepos repos={selectedRepos} onRemove={(repo) => setAdHocPaths((prev) => prev.filter((path) => path !== repo.path))} />
              <ScaffoldRepoInline onCreated={(repo) => setAdHocPaths((prev) => [...prev, repo.path])} />
            </div>
          )}
        </section>

        {/* 2. The task, and an optional name for it */}
        <div className={cn(FORM_CARD, 'flex flex-col gap-4 py-4')}>
          <div>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">What do you want to do?</span>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Simplify workspace setup and clarify the navigation."
                rows={3}
                autoFocus={startsWithRepos}
                aria-describedby="new-workspace-task-help"
              />
            </label>
            <p id="new-workspace-task-help" className="mt-1.5 text-xs text-muted-foreground">
              A sentence or two is enough. Your AI tools read it as the goal.
            </p>
          </div>
          <div>
            <label className="block">
              <span className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-semibold">Workspace name</span>
                <span className="text-xs font-normal text-muted-foreground">optional</span>
              </span>
              <Input
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder={derivedName || 'e.g. Simpler workspace setup'}
                aria-describedby="new-workspace-name-help"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && !createWorkspace.isPending) {
                    e.preventDefault();
                    if (problem === null || problem === 'branch') submit();
                    else setAsked(true);
                  }
                }}
              />
            </label>
            <p id="new-workspace-name-help" className="mt-1.5 text-xs text-muted-foreground">
              {workspaceName.trim()
                ? 'Shown in your workspace list.'
                : derivedName
                  ? <>Leave empty to call it <span className="font-medium text-foreground">{derivedName}</span>.</>
                  : 'Leave empty to name it from what you want to do.'}
            </p>
          </div>
        </div>

        {/* 3. Everything else, with its default already chosen */}
        <MoreOptions open={moreOpen} onOpenChange={setMoreOpen} changes={optionChanges}>
          {suggestedMatches.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 bg-primary/5 px-4 py-3 text-xs">
              <span className="flex items-center gap-1 text-[11px] font-medium text-primary">
                <Sparkles className="size-3" /> Suggested for this task:
              </span>
              {suggestedMatches.map((item) => (
                <button
                  key={`${item.type}-${item.id}`}
                  type="button"
                  onClick={() => {
                    if (item.type === 'tag') {
                      setSelectedTags((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
                    } else {
                      setEnabledSkills((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-card px-2 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:bg-primary/10"
                >
                  <span>+{item.title}</span>
                  <Badge variant="outline" className="px-0.5 py-0 text-[8px] uppercase">
                    {item.type}
                  </Badge>
                </button>
              ))}
            </div>
          )}

          <div className="px-4 py-4">
            <HarnessPicker harnesses={aiDetect.data ?? []} value={startHarness} onChange={setChosenHarness} loading={aiDetect.isLoading} />
          </div>

          <OptionGroup title="Code location" hint="Where your AI tools make their changes.">
            <div className="flex flex-col gap-4">
              <div role="radiogroup" aria-label="Work mode" className="grid gap-3 sm:grid-cols-2" onKeyDown={(e) => {
                if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
                  e.preventDefault();
                  const next = mode === 'in-place' ? 'worktree' : 'in-place';
                  setMode(next);
                  document.getElementById(`mode-${next}`)?.focus();
                }
              }}>
                {MODE_OPTIONS.map((option) => (
                  <button key={option.value} id={`mode-${option.value}`} type="button" role="radio"
                    aria-checked={mode === option.value} tabIndex={mode === option.value ? 0 : -1}
                    onClick={() => setMode(option.value)}
                    className={cn('cursor-pointer rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      mode === option.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border bg-card hover:border-foreground/20')}>
                    <option.icon className={cn('size-4', mode === option.value ? 'text-primary' : 'text-muted-foreground')} />
                    <p className="mt-2 text-sm font-semibold">{option.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{option.body}</p>
                  </button>
                ))}
              </div>
              {!inPlace && <div className="space-y-3">
                <div>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">Feature branch</span>
                    <Input ref={branchInputRef} value={branchName}
                      onChange={(e) => setBranchName(e.target.value)}
                      aria-invalid={shownBranchError ? true : undefined}
                      aria-describedby={shownBranchError ? 'new-workspace-branch-error new-workspace-branch-help' : 'new-workspace-branch-help'}
                      placeholder={suggestedBranchName(effectiveName) || 'feature/my-work'} className="font-mono" />
                  </label>
                  <span id="new-workspace-branch-help" className="mt-1 block text-xs text-muted-foreground">Leave blank to use {suggestedBranchName(effectiveName) || 'a branch based on the workspace name'}.</span>
                  {shownBranchError && <p id="new-workspace-branch-error" role="alert" className="mt-1 text-xs text-destructive">{shownBranchError}</p>}
                </div>
                {selectedRepos.length > 0 && <details className="rounded-lg border border-border px-3 py-2"
                  onToggle={(e) => setOverridesOpen((e.target as HTMLDetailsElement).open)}>
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Create worktrees from existing branches</summary>
                  <div className="mt-2 flex flex-col gap-2">{selectedRepos.map((repo) => (
                    <BranchOverrideRow key={repo.path} repo={repo} enabled={overridesOpen}
                      value={branchOverrides[repo.path] ?? ''}
                      onChange={(value) => setBranchOverrides((prev) => ({ ...prev, [repo.path]: value }))} />
                  ))}</div>
                </details>}
              </div>}
            </div>
          </OptionGroup>

          <OptionGroup title="Work type" hint="Tells your AI tools what kind of work this is.">
            <select aria-label="Work type" className="block h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
              value={workType} onChange={(event) => setWorkType(event.target.value as WorkGuidance['workType'])}>
              <option value="bug">Bug fix</option><option value="feature">Feature</option><option value="performance">Performance</option><option value="refactor">Refactor</option><option value="rewrite">Rewrite</option>
            </select>
          </OptionGroup>

          <OptionGroup title="Repository updates" hint="Optional: start from the latest code.">
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <Checkbox checked={autoUpdateBase} onCheckedChange={(checked) => setAutoUpdateBase(Boolean(checked))}
                aria-label="Fast-forward clean repository branches before creating workspace" />
              Fast-forward your clean {inPlace ? 'checkouts' : 'base branches'} from their remotes before creating the workspace (this changes your own checkouts)
            </label>

          {selectedRepos.length > 0 && (
            <div className="mt-3 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <GitBranch className="size-3.5" />
                  Base repository sync ({selectedRepos.length})
                </span>
                <div className="flex items-center gap-2">
                  {behindRepos.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs px-2"
                      onClick={pullAllBehind}
                      disabled={pullRepos.isPending}
                    >
                      {pullRepos.isPending ? <Spinner className="size-3 mr-1" /> : <RefreshCw className="size-3 mr-1" />}
                      Pull {behindRepos.length} stale {behindRepos.length === 1 ? 'repo' : 'repos'}
                    </Button>
                  )}
                </div>
              </div>
              <ul className="mt-2 divide-y divide-border text-xs">
                {selectedRepos.map((repo) => {
                  const freshness = freshnessMap[repo.path];
                  const isBehind = freshness?.status === 'behind';
                  return (
                    <li key={repo.path} className="flex items-center justify-between py-1.5">
                      <div className="min-w-0 flex-1 truncate pr-2">
                        <span className="font-medium">{repo.name}</span>
                        <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                          ({branchOverrides[repo.path] || repo.defaultBranch})
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {freshnessQuery.isLoading ? (
                          <span className="text-muted-foreground text-[11px]">Checking…</span>
                        ) : freshness ? (
                          <StatusBadge
                            tone={
                              freshness.status === 'up-to-date'
                                ? 'success'
                                : freshness.status === 'behind'
                                  ? 'warning'
                                  : freshness.status === 'diverged'
                                    ? 'danger'
                                    : freshness.status === 'ahead'
                                      ? 'info'
                                      : 'neutral'
                            }
                            title={freshness.message}
                          >
                            {freshness.status === 'behind'
                              ? `↓ ${freshness.behind} behind ${freshness.trackingBranch}`
                              : freshness.status === 'up-to-date'
                                ? 'Up to date'
                                : freshness.status === 'diverged'
                                  ? 'Diverged'
                                  : freshness.status === 'ahead'
                                    ? `↑ ${freshness.ahead} ahead`
                                    : 'Local'}
                          </StatusBadge>
                        ) : null}
                        {isBehind && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 px-1.5 text-[11px] text-warning-foreground hover:text-amber-600"
                            onClick={() =>
                              handlePullSingle(
                                repo.path,
                                branchOverrides[repo.path] || repo.defaultBranch,
                              )
                            }
                            disabled={pullRepos.isPending}
                          >
                            Pull
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {pullWarning && (
                <p className="mt-2 text-xs text-warning-foreground">{pullWarning}</p>
              )}
            </div>
          )}
          </OptionGroup>

          <OptionGroup
            aria-label="Skills"
            icon={<Boxes className="size-4 text-primary" />}
            title={<>
              Skills
              {enabledSkills.length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">({enabledSkills.length} selected)</span>
              )}
            </>}
            hint="Guides your AI tools can follow. None are needed."
            action={
              <div className="flex shrink-0 items-center gap-2">
                {(skillsQuery.data ?? []).length > 0 && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      const all = (skillsQuery.data ?? []).map((s) => s.id);
                      setEnabledSkills(enabledSkills.length === all.length ? [] : all);
                    }}
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {enabledSkills.length === (skillsQuery.data ?? []).length && (skillsQuery.data ?? []).length > 0
                      ? 'Deselect All'
                      : 'Select All'}
                  </Button>
                )}
                <Link
                  to="/skills"
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Skill Library →
                </Link>
              </div>
            }
          >
            {skillsQuery.isLoading ? (
              <div className="flex items-center justify-center p-3 gap-2 text-xs text-muted-foreground rounded-lg border border-border">
                <Spinner className="size-3" />
                Loading skills...
              </div>
            ) : (skillsQuery.data ?? []).length === 0 ? (
              <div className="p-3 border border-dashed border-border rounded-lg bg-card/20 text-center">
                <p className="text-xs text-muted-foreground">
                  No skills yet. Add them in the{' '}
                  <Link to="/skills" className="text-primary underline">
                    Skill Library
                  </Link>.
                </p>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {(skillsQuery.data ?? []).map((skill) => {
                  const isChecked = enabledSkills.includes(skill.id);
                  return (
                    <label
                      key={skill.id}
                      className={cn(
                        'flex items-center justify-between gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors select-none text-left',
                        isChecked
                          ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/40 text-foreground'
                          : 'border-border bg-card hover:border-foreground/20 text-muted-foreground',
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() =>
                            setEnabledSkills((prev) =>
                              prev.includes(skill.id) ? prev.filter((id) => id !== skill.id) : [...prev, skill.id],
                            )
                          }
                          aria-label={`Select ${skill.title || skill.name}`}
                        />
                        <div className="min-w-0">
                          <p className="font-mono text-xs font-medium truncate text-foreground">
                            {skill.title || skill.name}
                          </p>
                          {skill.description && (
                            <p className="text-[11px] text-muted-foreground line-clamp-1">
                              {skill.description}
                            </p>
                          )}
                        </div>
                      </div>
                      {skill.category && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0 capitalize">
                          {skill.category}
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </OptionGroup>

          <OptionGroup
            icon={<Tag className="size-4 text-primary" />}
            title={<>
              Category & Domain Tags
              {selectedTags.length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">({selectedTags.length} attached)</span>
              )}
            </>}
            hint="Tags attach curated skill bundles & standards"
            action={
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setShowCreateTagModal(true)}
                className="h-6 shrink-0 gap-1 border-primary/40 px-2 text-xs text-primary hover:bg-primary/10"
              >
                <Tag className="size-3" />
                + New Tag
              </Button>
            }
          >
          <div className="space-y-2">
            {domainPacksQuery.isLoading ? (
              <div className="flex items-center justify-center p-4 gap-2 text-xs text-muted-foreground rounded-lg border border-border">
                <Spinner className="size-3" />
                Loading category tags...
              </div>
            ) : (domainPacksQuery.data ?? []).length === 0 ? (
              <div className="p-3.5 border border-border rounded-xl bg-card/40 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-foreground">No domain tags defined yet</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Tags are optional bundles that package skills, rules, and test commands for a domain. You can create a tag now, or select skills directly above.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setShowCreateTagModal(true)}
                    className="text-xs gap-1.5 h-7 shrink-0 text-primary border-primary/40 hover:bg-primary/10"
                  >
                    <Tag className="size-3 text-primary" />
                    + Create Tag
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {(domainPacksQuery.data ?? []).map((pack) => {
                  const isChecked = selectedTags.includes(pack.id);
                  const skillCount = pack.skills?.length ?? 0;
                  const ruleCount = pack.rules?.length ?? 0;
                  return (
                    <div
                      key={pack.id}
                      onClick={() =>
                        setSelectedTags((prev) =>
                          prev.includes(pack.id) ? prev.filter((id) => id !== pack.id) : [...prev, pack.id],
                        )
                      }
                      className={cn(
                        'flex flex-col justify-between p-3 rounded-xl border cursor-pointer transition-colors text-left outline-none select-none',
                        isChecked
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                          : 'border-border bg-card hover:border-foreground/20',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={isChecked}
                            onCheckedChange={() =>
                              setSelectedTags((prev) =>
                                prev.includes(pack.id) ? prev.filter((id) => id !== pack.id) : [...prev, pack.id],
                              )
                            }
                            aria-label={`Attach ${pack.name}`}
                          />
                          <span className="font-medium text-xs font-mono">#{pack.id}</span>
                        </div>
                        {pack.categoryType && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0 capitalize">
                            {pack.categoryType === 'trait' ? 'trait' : 'domain'}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2">{pack.description || pack.name}</p>
                      {(skillCount > 0 || ruleCount > 0) && (
                        <div className="mt-2 pt-2 border-t border-border/50 flex flex-wrap gap-1 items-center text-[10px]">
                          {skillCount > 0 && (
                            <span className="text-primary font-mono flex items-center gap-1">
                              <Boxes className="size-2.5" />
                              {pack.skills!.join(', ')}
                            </span>
                          )}
                          {ruleCount > 0 && (
                            <span className="text-muted-foreground ml-auto font-mono">
                              {ruleCount} rule{ruleCount === 1 ? '' : 's'}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </OptionGroup>

          <OptionGroup
            aria-label="AI harnesses"
            title="AI harnesses"
            hint="Choose which tools receive workspace instructions. The tool you start with is always included. This does not start a session."
          >
            <div className="flex flex-wrap gap-3">
              {(aiDetect.data ?? []).map((assistant) => (
                <label
                  key={assistant.name}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm',
                    !assistant.detected && 'opacity-50',
                  )}
                >
                  <Checkbox
                    checked={instructionTargets.includes(assistant.name)}
                    disabled={assistant.name === startHarness}
                    onCheckedChange={() =>
                      setAssistants((prev) =>
                        prev.includes(assistant.name)
                          ? prev.filter((a) => a !== assistant.name)
                          : [...prev, assistant.name],
                      )
                    }
                  />
                  <HarnessIcon harness={assistant.name} />{assistant.displayName}{!assistant.detected && <span className="text-xs text-muted-foreground">Not installed</span>}
                </label>
              ))}
            </div>
          </OptionGroup>

          <OptionGroup
            title="Teamwork strategy"
            hint="How several AI agents share the work."
            action={
              <Button size="xs" variant="outline" onClick={suggestStrategy} disabled={suggesting} className="shrink-0">
                {suggesting ? <Spinner /> : <Sparkles />}
                Suggest with AI
              </Button>
            }
          >
            <Select value={strategyId} onValueChange={(v) => typeof v === 'string' && applyStrategy(v)}>
              <SelectTrigger className="w-full" aria-label="Teamwork strategy">
                <SelectValue>
                  {(templates.data ?? []).find((t) => t.id === strategyId)?.name ?? 'None'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="">None</SelectItem>
                {(templates.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {suggestedDifficulty && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                AI classified this task as <span className="font-medium">{suggestedDifficulty}</span> difficulty.
              </p>
            )}
            <Textarea
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              placeholder="Cooperation instructions for the agent team (editable — prefilled by the strategy pick or AI suggestion)."
              rows={4}
              className="mt-2 font-mono text-xs"
            />
          </OptionGroup>

          {(agentsQuery.data ?? []).length > 0 && (
            <OptionGroup
              icon={<Bot className="size-4 text-purple-400" />}
              title={`Codex Native Agents (${enabledAgents.length} selected)`}
            >
              <div className="flex flex-wrap gap-2">
                {(agentsQuery.data ?? []).map((agent) => {
                  const isChecked = enabledAgents.includes(agent.id);
                  return (
                    <label
                      key={agent.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs',
                        isChecked ? 'border-purple-500/60 bg-purple-500/5 text-foreground' : 'text-muted-foreground hover:bg-muted/50'
                      )}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() =>
                          setEnabledAgents((prev) =>
                            prev.includes(agent.id) ? prev.filter((id) => id !== agent.id) : [...prev, agent.id]
                          )
                        }
                      />
                      <span className="font-mono">{agent.name}</span>
                    </label>
                  );
                })}
              </div>
            </OptionGroup>
          )}

          <div className="px-4 py-4">
            <ResourcePreview skills={enabledSkills} agents={enabledAgents} assistants={instructionTargets} tagCount={selectedTags.length} />
          </div>
        </MoreOptions>

        {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
        {asked && problem === 'repository' && <p role="alert" className="text-sm text-destructive">Choose a repository first, then create the workspace.</p>}
        {asked && problem === 'task' && <p role="alert" className="text-sm text-destructive">Say what you want to do, or give the workspace a name.</p>}

      </div>
      </div>

      {/* Pinned so Create stays in reach however long the skills list is, as a bar across the whole page with its
          contents lined up with the form. It sits flush with the bottom of the window: <main> in App.tsx pads its
          content by 12/20/24px and a sticky element respects that padding, so the bar reaches out by the same amount
          (the negative offsets and margins) instead of leaving a strip of page showing under or beside it. Its own
          padding is the same above and below the button, so the button sits in the middle of the bar. */}
      <div
        data-testid="create-footer"
        className="sticky -bottom-3 z-10 -mx-3 mt-5 -mb-3 border-t border-border bg-background px-3 py-3 shadow-[0_-6px_10px_-8px_rgb(0_0_0/0.14)] sm:-bottom-5 sm:-mx-5 sm:-mb-5 sm:px-5 lg:-bottom-6 lg:-mx-6 lg:-mb-6 lg:px-6"
      >
        <div className="mx-auto flex max-w-xl items-center justify-between gap-4">
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={selectedRepos.map((repo) => repo.name).join(', ')}>
            <FolderGit2 className="size-3.5 shrink-0" />
            {selectedRepos.length === 0 ? (
              'No repository selected'
            ) : (
              <>
                <span className="shrink-0 font-medium text-foreground">{selectedRepos.length} repositor{selectedRepos.length === 1 ? 'y' : 'ies'}</span>
                <span className="truncate">· {summarizeNames(selectedRepos.map((repo) => repo.name))}</span>
              </>
            )}
          </p>
          <Button onClick={submit} disabled={!canAttempt || createWorkspace.isPending}>
            {createWorkspace.isPending ? <Spinner /> : null}
            Create workspace
          </Button>
        </div>
      </div>

      {/* MODAL: CREATE NEW CATEGORY / TRAIT */}
      <Dialog open={showCreateTagModal} onOpenChange={setShowCreateTagModal}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag size={16} className="text-primary" />
              <span>Create Category Tag</span>
            </DialogTitle>
            <DialogDescription>
              Tags bundle reusable skills, rules, and test verification commands for a domain.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Tag Name</label>
              <Input
                value={newTagName}
                onChange={(e) => {
                  setNewTagName(e.target.value);
                  if (!newTagId || newTagId === newTagName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)) {
                    setNewTagId(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30));
                  }
                }}
                placeholder="e.g. Invoicing & Billing"
                size="sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Tag ID / Slug</label>
              <Input
                value={newTagId}
                onChange={(e) => setNewTagId(e.target.value)}
                placeholder="e.g. billing"
                size="sm"
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Type</label>
              <select
                value={newTagType}
                onChange={(e) => setNewTagType(e.target.value as 'vertical' | 'trait')}
                className="w-full h-7.5 px-2 text-xs rounded-md border border-border bg-background text-foreground"
              >
                <option value="vertical">Vertical Subsystem</option>
                <option value="trait">Horizontal Trait</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Description (optional)</label>
              <Input
                value={newTagDescription}
                onChange={(e) => setNewTagDescription(e.target.value)}
                placeholder="What this domain covers..."
                size="sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Verification Command (optional)</label>
              <Input
                value={newTagVerifyCmd}
                onChange={(e) => setNewTagVerifyCmd(e.target.value)}
                placeholder="e.g. npm test -- billing"
                size="sm"
                className="font-mono"
              />
            </div>
          </DialogPanel>
          <DialogFooter className="flex items-center justify-end gap-2 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowCreateTagModal(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!newTagName.trim() || !newTagId.trim() || savingNewTag}
              onClick={() => void handleCreateNewTag()}
            >
              {savingNewTag ? 'Creating...' : 'Create & Attach Tag'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
