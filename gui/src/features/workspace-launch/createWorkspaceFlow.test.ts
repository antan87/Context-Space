import { describe, expect, it, vi } from 'vitest';
import {
  deriveWorkspaceName,
  resolveWorkspaceName,
  workspaceFormProblem,
  summarizeOptionChanges,
  workTypeLabel,
  suggestedBranchName,
  isWorkspaceFormValid,
  handleWorkspaceCreationCompletion,
  withStartHarness,
  resolveStartHarness,
  resolveWorktreeBranch,
  summarizeNames,
  taskTextForSuggestions,
} from './createWorkspaceFlow.js';

describe('suggestedBranchName', () => {
  it('converts human titles into clean feature branch slugs', () => {
    expect(suggestedBranchName('Fast Workspace Creation')).toBe('feature/fast-workspace-creation');
    expect(suggestedBranchName('Fix Issue #42 (urgent!)')).toBe('feature/fix-issue-42-urgent');
  });

  it('handles edge cases such as leading/trailing separators and empty inputs', () => {
    expect(suggestedBranchName('---my--feature---')).toBe('feature/my-feature');
    expect(suggestedBranchName('')).toBe('');
    expect(suggestedBranchName('   ')).toBe('');
    expect(suggestedBranchName('$$$###')).toBe('');
  });
});

describe('isWorkspaceFormValid', () => {
  it('allows in-place workspace creation with only name and selected repos (description is optional)', () => {
    const valid = isWorkspaceFormValid({
      workspaceName: 'Rapid Setup',
      mode: 'in-place',
      selectedRepoCount: 1,
    });
    expect(valid).toBe(true);
  });

  it('allows worktree workspace creation when workspaceName can generate a branch name', () => {
    const valid = isWorkspaceFormValid({
      workspaceName: 'New Worktree',
      mode: 'worktree',
      selectedRepoCount: 2,
    });
    expect(valid).toBe(true);
  });

  it('allows worktree workspace creation with an explicit custom branch name', () => {
    const valid = isWorkspaceFormValid({
      workspaceName: 'Custom Branch Work',
      mode: 'worktree',
      branchName: 'custom/feat-branch',
      selectedRepoCount: 1,
    });
    expect(valid).toBe(true);
  });

  it('rejects creation when workspace name is empty or only whitespace', () => {
    expect(
      isWorkspaceFormValid({
        workspaceName: '',
        mode: 'in-place',
        selectedRepoCount: 1,
      }),
    ).toBe(false);

    expect(
      isWorkspaceFormValid({
        workspaceName: '   ',
        mode: 'worktree',
        selectedRepoCount: 1,
      }),
    ).toBe(false);
  });

  it('rejects creation when no repositories are selected', () => {
    expect(
      isWorkspaceFormValid({
        workspaceName: 'Valid Name',
        mode: 'in-place',
        selectedRepoCount: 0,
      }),
    ).toBe(false);

    expect(
      isWorkspaceFormValid({
        workspaceName: 'Valid Name',
        mode: 'worktree',
        selectedRepoCount: 0,
      }),
    ).toBe(false);
  });

  it('rejects worktree creation if workspace name cannot produce a branch and no branch name is provided', () => {
    expect(
      isWorkspaceFormValid({
        workspaceName: '###',
        mode: 'worktree',
        selectedRepoCount: 1,
      }),
    ).toBe(false);
  });
});

describe('deriveWorkspaceName', () => {
  it('takes the first line of the description, tidied', () => {
    expect(deriveWorkspaceName('Cache invoice lookups.')).toBe('Cache invoice lookups');
    expect(deriveWorkspaceName('  Fix   the\ttotals!  \nThen check the tax rounding.')).toBe('Fix the totals');
    expect(deriveWorkspaceName('\n\n  Skip the blank lines first')).toBe('Skip the blank lines first');
  });

  it('stops at the end of the first sentence, but not at an abbreviation', () => {
    expect(deriveWorkspaceName('Cache invoice lookups. Then measure the totals.')).toBe('Cache invoice lookups');
    expect(deriveWorkspaceName('Speed up the invoice list! It is slow')).toBe('Speed up the invoice list');
    expect(deriveWorkspaceName('Use e.g. Redis for the cache. Measure first')).toBe('Use e.g. Redis for the cache');
    expect(deriveWorkspaceName('Upgrade to v2.0 of the billing API')).toBe('Upgrade to v2.0 of the billing API');
  });

  it('is empty without a description', () => {
    expect(deriveWorkspaceName('')).toBe('');
    expect(deriveWorkspaceName('  \n \n')).toBe('');
  });

  it('cuts a long line at a word, never mid-word, and leaves no trailing punctuation', () => {
    const name = deriveWorkspaceName('Simplify workspace setup and clarify the navigation, then speed up the plan');
    expect(name).toBe('Simplify workspace setup and clarify the');
    expect(name.length).toBeLessThanOrEqual(48);
    expect(deriveWorkspaceName('Rework the invoice list so that totals, taxes, and discounts load, fast')).toBe(
      'Rework the invoice list so that totals, taxes',
    );
  });

  it('cuts a long unbroken string at the limit', () => {
    expect(deriveWorkspaceName('x'.repeat(80))).toBe('x'.repeat(48));
  });
});

describe('resolveWorkspaceName', () => {
  it('keeps a typed name, trimmed', () => {
    expect(resolveWorkspaceName('  Invoice speed-up ', 'Something else')).toBe('Invoice speed-up');
  });

  it('falls back to the description when the name is empty or blank', () => {
    expect(resolveWorkspaceName('', 'Cache invoice lookups')).toBe('Cache invoice lookups');
    expect(resolveWorkspaceName('   ', 'Cache invoice lookups')).toBe('Cache invoice lookups');
    expect(resolveWorkspaceName('', '')).toBe('');
  });
});

describe('workspaceFormProblem', () => {
  const base = { workspaceName: '', description: '', mode: 'in-place' as const, selectedRepoCount: 1 };

  it('asks for a repository first', () => {
    expect(workspaceFormProblem({ ...base, workspaceName: 'Named', selectedRepoCount: 0 })).toBe('repository');
    expect(workspaceFormProblem({ ...base, selectedRepoCount: 0 })).toBe('repository');
  });

  it('needs a name or a description, and either one is enough', () => {
    expect(workspaceFormProblem(base)).toBe('task');
    expect(workspaceFormProblem({ ...base, workspaceName: '   ', description: '  ' })).toBe('task');
    expect(workspaceFormProblem({ ...base, workspaceName: 'Named' })).toBeNull();
    expect(workspaceFormProblem({ ...base, description: 'Fix invoice rounding' })).toBeNull();
  });

  it('derives the worktree branch from the description when there is no name', () => {
    expect(workspaceFormProblem({ ...base, mode: 'worktree', description: 'Fix invoice rounding' })).toBeNull();
  });

  it('reports a worktree that cannot get a branch, unless one is typed', () => {
    expect(workspaceFormProblem({ ...base, mode: 'worktree', description: '###' })).toBe('branch');
    expect(workspaceFormProblem({ ...base, mode: 'worktree', description: '###', branchName: 'fix/x' })).toBeNull();
    expect(workspaceFormProblem({ ...base, mode: 'in-place', description: '###' })).toBeNull();
  });

  it('agrees with isWorkspaceFormValid', () => {
    expect(isWorkspaceFormValid({ ...base, description: 'Fix invoice rounding' })).toBe(true);
    expect(isWorkspaceFormValid(base)).toBe(false);
  });
});

describe('summarizeOptionChanges', () => {
  const defaults = {
    mode: 'in-place' as const,
    workType: 'feature',
    existingBranches: 0,
    autoUpdateBase: false,
    skills: 0,
    tags: 0,
    startHarness: '',
    extraAssistants: 0,
    hasTeamworkInstructions: false,
    agents: 0,
  };

  it('is empty when every option is at its default', () => {
    expect(summarizeOptionChanges(defaults)).toEqual([]);
  });

  it('names each option that was changed, in the order the options appear', () => {
    expect(
      summarizeOptionChanges({
        ...defaults,
        mode: 'worktree',
        existingBranches: 1,
        workType: 'bug',
        autoUpdateBase: true,
        startHarness: 'Codex',
        skills: 2,
        tags: 1,
        extraAssistants: 3,
        hasTeamworkInstructions: true,
        agents: 1,
      }),
    ).toEqual([
      'New worktrees',
      'Existing branches',
      'Bug fix',
      'Fast-forward first',
      'Starts with Codex',
      '2 skills',
      '1 tag',
      '3 more AI tools',
      'Teamwork notes',
      '1 agent',
    ]);
  });

  it('ignores existing branches when no worktrees are created', () => {
    expect(summarizeOptionChanges({ ...defaults, existingBranches: 2 })).toEqual([]);
  });

  it('labels work types the way the list does', () => {
    expect(workTypeLabel('performance')).toBe('Performance');
    expect(workTypeLabel('unknown')).toBe('unknown');
  });
});

describe('handleWorkspaceCreationCompletion', () => {
  it('triggers immediate CLI session opening and navigates directly to workspace on completed status', () => {
    const onOpenCli = vi.fn();
    const onNavigate = vi.fn();

    const result = handleWorkspaceCreationCompletion({
      status: 'completed',
      workspaceId: 'feat/fast-ws',
      lastOpenedWorkspaceId: null,
      onOpenCli,
      onNavigate,
    });

    expect(result).toBe('feat/fast-ws');
    expect(onOpenCli).toHaveBeenCalledTimes(1);
    expect(onOpenCli).toHaveBeenCalledWith('feat/fast-ws');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('/workspaces/feat%2Ffast-ws');
  });

  it('does not navigate or open CLI while status is still running', () => {
    const onOpenCli = vi.fn();
    const onNavigate = vi.fn();

    const result = handleWorkspaceCreationCompletion({
      status: 'running',
      workspaceId: 'feat/fast-ws',
      lastOpenedWorkspaceId: null,
      onOpenCli,
      onNavigate,
    });

    expect(result).toBeNull();
    expect(onOpenCli).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('does not navigate or open CLI if status is failed', () => {
    const onOpenCli = vi.fn();
    const onNavigate = vi.fn();

    const result = handleWorkspaceCreationCompletion({
      status: 'failed',
      workspaceId: 'feat/fast-ws',
      lastOpenedWorkspaceId: null,
      onOpenCli,
      onNavigate,
    });

    expect(result).toBeNull();
    expect(onOpenCli).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('does not re-navigate or duplicate CLI opening if already opened for this workspaceId', () => {
    const onOpenCli = vi.fn();
    const onNavigate = vi.fn();

    const result = handleWorkspaceCreationCompletion({
      status: 'completed',
      workspaceId: 'feat/fast-ws',
      lastOpenedWorkspaceId: 'feat/fast-ws',
      onOpenCli,
      onNavigate,
    });

    expect(result).toBe('feat/fast-ws');
    expect(onOpenCli).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('does not navigate or open CLI when autoNavigate is false (replayed job inspection)', () => {
    const onOpenCli = vi.fn();
    const onNavigate = vi.fn();

    const result = handleWorkspaceCreationCompletion({
      status: 'completed',
      workspaceId: 'feat/fast-ws',
      lastOpenedWorkspaceId: null,
      autoNavigate: false,
      onOpenCli,
      onNavigate,
    });

    // Inspecting a finished job acts on nothing, so nothing is marked as handled.
    expect(result).toBeNull();
    expect(onOpenCli).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('still opens a workspace that was only inspected earlier in the same page', () => {
    const onOpenCli = vi.fn();
    const onNavigate = vi.fn();
    const inspected = handleWorkspaceCreationCompletion({
      status: 'completed', workspaceId: 'feat/fast-ws', lastOpenedWorkspaceId: null, autoNavigate: false, onOpenCli, onNavigate,
    });
    const created = handleWorkspaceCreationCompletion({
      status: 'completed', workspaceId: 'feat/fast-ws', lastOpenedWorkspaceId: inspected, onOpenCli, onNavigate,
    });
    expect(created).toBe('feat/fast-ws');
    expect(onNavigate).toHaveBeenCalledWith('/workspaces/feat%2Ffast-ws');
  });

  it('makes the chosen harness the preferred one before opening the dock, once the workspace exists', () => {
    const calls: string[] = [];
    handleWorkspaceCreationCompletion({
      status: 'completed',
      workspaceId: 'fast-ws',
      lastOpenedWorkspaceId: null,
      startHarness: 'codex',
      onChooseHarness: (id, harness) => calls.push(`choose ${id} ${harness}`),
      onOpenCli: (id) => calls.push(`open ${id}`),
      onNavigate: (path) => calls.push(`go ${path}`),
    });
    expect(calls).toEqual(['choose fast-ws codex', 'open fast-ws', 'go /workspaces/fast-ws']);
  });

  it('chooses no harness when none was picked, when the job failed, or when only inspecting', () => {
    const onChooseHarness = vi.fn();
    const base = { workspaceId: 'fast-ws', lastOpenedWorkspaceId: null, onChooseHarness, onOpenCli: vi.fn(), onNavigate: vi.fn() };
    handleWorkspaceCreationCompletion({ ...base, status: 'completed', startHarness: '' });
    handleWorkspaceCreationCompletion({ ...base, status: 'failed', startHarness: 'codex' });
    handleWorkspaceCreationCompletion({ ...base, status: 'running', startHarness: 'codex' });
    handleWorkspaceCreationCompletion({ ...base, status: 'completed', startHarness: 'codex', autoNavigate: false });
    expect(onChooseHarness).not.toHaveBeenCalled();
  });
});

describe('resolveWorktreeBranch', () => {
  it('uses the branch that was typed, trimmed', () => {
    expect(resolveWorktreeBranch('  custom/branch ', 'Anything')).toBe('custom/branch');
  });

  it('derives one from the workspace name when none was typed', () => {
    expect(resolveWorktreeBranch('', 'Fast Workspace')).toBe('feature/fast-workspace');
    expect(resolveWorktreeBranch(undefined, 'Fast Workspace')).toBe('feature/fast-workspace');
    expect(resolveWorktreeBranch('   ', 'Fast Workspace')).toBe('feature/fast-workspace');
  });

  it('is empty when neither gives a usable branch', () => {
    expect(resolveWorktreeBranch('', '###')).toBe('');
  });
});

describe('taskTextForSuggestions', () => {
  it('prefers the task description', () => {
    expect(taskTextForSuggestions(' Fix invoice rounding ', 'Invoices')).toBe('Fix invoice rounding');
  });

  it('falls back to the workspace name when there is no description', () => {
    expect(taskTextForSuggestions('', ' Invoices ')).toBe('Invoices');
    expect(taskTextForSuggestions('   ', 'Invoices')).toBe('Invoices');
  });

  it('is empty when there is neither', () => {
    expect(taskTextForSuggestions('', '  ')).toBe('');
  });
});

describe('withStartHarness', () => {
  it('adds the harness to start with so it always receives the workspace instructions', () => {
    expect(withStartHarness([], 'claude')).toEqual(['claude']);
    expect(withStartHarness(['codex'], 'claude')).toEqual(['codex', 'claude']);
  });

  it('does not duplicate a harness that is already selected, nor add anything when none is chosen', () => {
    expect(withStartHarness(['claude', 'codex'], 'claude')).toEqual(['claude', 'codex']);
    expect(withStartHarness(['codex'], '')).toEqual(['codex']);
  });

  it('returns a new array rather than the caller\'s state', () => {
    const selected = ['codex'];
    expect(withStartHarness(selected, '')).not.toBe(selected);
  });
});

describe('resolveStartHarness', () => {
  const installed = ['claude', 'codex'];

  it('shows the harness the developer picked', () => {
    expect(resolveStartHarness({ chosen: 'codex', installed })).toBe('codex');
  });

  it('chooses nothing until the developer picks, however many tools are installed', () => {
    expect(resolveStartHarness({ chosen: '', installed })).toBe('');
    expect(resolveStartHarness({ chosen: '', installed: ['claude'] })).toBe('');
  });

  it('drops a pick that is not installed', () => {
    expect(resolveStartHarness({ chosen: 'cursor', installed })).toBe('');
    expect(resolveStartHarness({ chosen: 'claude', installed: [] })).toBe('');
  });
});

describe('summarizeNames', () => {
  it('lists every name when they fit', () => {
    expect(summarizeNames([])).toBe('');
    expect(summarizeNames(['shop-api'])).toBe('shop-api');
    expect(summarizeNames(['shop-api', 'shop-web'])).toBe('shop-api, shop-web');
  });

  it('shows the first few and says how many more', () => {
    expect(summarizeNames(['a', 'b', 'c'])).toBe('a, b +1');
    expect(summarizeNames(['a', 'b', 'c', 'd', 'e'])).toBe('a, b +3');
  });

  it('can show more names when there is room', () => {
    expect(summarizeNames(['a', 'b', 'c', 'd'], 3)).toBe('a, b, c +1');
  });
});
