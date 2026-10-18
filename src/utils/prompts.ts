/**
 * @module utils/prompts
 * Interactive CLI prompts for NexusFlow using @inquirer/prompts.
 */

import { input, checkbox, confirm, select, search, editor, Separator } from '@inquirer/prompts';
import chalk from 'chalk';

import type { AIAssistant, DetectedAI, DetectedEditor, RepoInfo, SkillItem } from '../types.js';
import { isValidBranchName, listBranches } from './git.js';
import { isValidProjectName } from '../core/new-repo.js';
import type { WorkflowTemplate } from './workflows.js';

/**
 * Prompts the user for a feature branch name.
 */
export async function promptBranchName(): Promise<string> {
  const branchName = await input({
    message: 'Feature branch name:',
    validate: (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return 'Branch name cannot be empty';
      if (/\s/.test(trimmed)) return 'Branch name cannot contain spaces';
      // Reject git-illegal names up front so worktree creation doesn't fail
      // deep inside createWorkspace after the workspace dir already exists.
      if (!isValidBranchName(trimmed)) return 'Not a valid git branch name';
      return true;
    },
  });
  return branchName.trim();
}

/**
 * Generic prompt for multi-line text input.
 * Offers short inline typing, multi-line editor (safe for pasting), or loading from file.
 *
 * @param entityName e.g., 'feature description', 'commit message'
 * @param emptyFallback Default text to return if left empty in editor mode
 */
export async function promptMultiLineInput(entityName: string, emptyFallback = ''): Promise<string> {
  const mode = await select({
    message: `How do you want to provide the ${entityName}?`,
    choices: [
      { name: `✍️  Type short ${entityName}`, value: 'short', description: `Type a single-line ${entityName} directly in the terminal` },
      { name: `📝 Write in editor`, value: 'editor', description: 'Opens your $EDITOR (safest for copy-pasting multi-line text)' },
      { name: `📂 Load from file`, value: 'file', description: 'Paste a path to a .md or .txt file' },
    ],
  });

  if (mode === 'short') {
    const text = await input({
      message: `${entityName.charAt(0).toUpperCase() + entityName.slice(1)}:`,
      validate: (value: string) => {
        if (!value.trim() && !emptyFallback) return `${entityName} cannot be empty`;
        return true;
      },
    });
    return text.trim() || emptyFallback;
  }

  if (mode === 'editor') {
    const text = await editor({
      message: `Write or paste your ${entityName} (save and close the editor when done):`,
      default: '',
      waitForUserInput: false,
    });
    if (!text.trim()) {
      console.log(chalk.yellow(`  ⚠ Empty ${entityName} provided.`));
      return emptyFallback;
    }
    return text.trim();
  }

  // File mode
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');

  const filePath = await input({
    message: `Path to ${entityName} file (.md or .txt):`,
    validate: (value) => {
      if (!value.trim()) return 'Path cannot be empty';
      if (!existsSync(value.trim())) return 'File not found';
      return true;
    },
  });

  const content = await readFile(filePath.trim(), 'utf-8');
  console.log(chalk.dim(`  Read ${entityName} from ${filePath.trim()}`));
  return content.trim() || emptyFallback;
}

/**
 * Prompts the user for a feature description.
 */
export async function promptDescription(): Promise<string> {
  return promptMultiLineInput('feature description', 'No description provided.');
}

/**
 * Prompts the user to select repos from a list of discovered repos.
 * Supports searching/filtering by term, viewing all, and incremental selection.
 */
export async function promptSelectRepos(repos: RepoInfo[]): Promise<RepoInfo[]> {
  if (repos.length === 0) {
    return [];
  }

  const selectedPaths = new Set<string>();

  // If there are only a few repos (e.g. <= 10), we can just show a checkbox prompt directly to save time
  if (repos.length <= 10) {
    const toggled = await checkbox({
      message: 'Select repositories to include in workspace:',
      choices: repos.map((repo) => ({
        name: `${repo.name} ${chalk.dim(`(${repo.path})`)}`,
        value: repo.path,
        checked: false,
      })),
    });
    return repos.filter((r) => toggled.includes(r.path));
  }

  // Otherwise, use a loop with the search prompt to make it extremely easy to filter and toggle selection
  while (true) {
    console.log(chalk.bold(`\n📁 Selected Repositories (${selectedPaths.size}/${repos.length}):`));
    if (selectedPaths.size === 0) {
      console.log(chalk.dim('  (None selected yet)'));
    } else {
      repos.forEach((r) => {
        if (selectedPaths.has(r.path)) {
          console.log(`  ${chalk.green('✓')} ${r.name} ${chalk.dim(`(${r.path})`)}`);
        }
      });
    }
    console.log();

    const result = await search({
      message: 'Search and select repositories (type to filter, select to toggle, choose Done to finish):',
      source: async (input) => {
        const query = (input || '').toLowerCase();
        const filtered = repos.filter(
          (r) =>
            r.name.toLowerCase().includes(query) ||
            r.path.toLowerCase().includes(query)
        );

        const choices = [
          {
            name: chalk.green(`✅ Done selecting (${selectedPaths.size} repo(s) selected)`),
            value: 'done',
          },
        ];

        if (selectedPaths.size > 0) {
          choices.push({
            name: chalk.yellow('🧹 Clear all selections'),
            value: 'clear',
          });
        }

        filtered.forEach((r) => {
          const isSelected = selectedPaths.has(r.path);
          choices.push({
            name: `${isSelected ? chalk.green('✓') : ' '} ${r.name} ${chalk.dim(`(${r.path})`)}`,
            value: r.path,
          });
        });

        return choices;
      },
    });

    if (result === 'done') {
      // An empty selection is allowed — the create flow can still scaffold a
      // brand-new project afterwards, and exits if nothing ends up selected.
      break;
    }

    if (result === 'clear') {
      selectedPaths.clear();
      continue;
    }

    // Toggle selected state
    if (selectedPaths.has(result)) {
      selectedPaths.delete(result);
    } else {
      selectedPaths.add(result);
    }
  }

  return repos.filter((r) => selectedPaths.has(r.path));
}

/**
 * Prompts for the name of a brand-new project to scaffold in `devDir`.
 */
export async function promptNewProjectName(devDir: string): Promise<string> {
  const name = await input({
    message: `New project name (created in ${devDir}):`,
    validate: (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return 'Project name cannot be empty';
      if (!isValidProjectName(trimmed)) return 'Not a valid directory name';
      return true;
    },
  });
  return name.trim();
}

/**
 * Optionally lets the user pick an existing branch per repo instead of
 * creating the feature branch.
 *
 * @param repos         - The repos selected for the workspace.
 * @param featureBranch - The feature branch that would be created by default.
 * @returns Map of repo name → existing branch, for overridden repos only.
 */
export async function promptRepoBranches(
  repos: RepoInfo[],
  featureBranch: string,
): Promise<Map<string, string>> {
  const overrides = new Map<string, string>();

  const useExisting = await confirm({
    message: 'Check out an existing branch for any repo (instead of creating the feature branch)?',
    default: false,
  });
  if (!useExisting) return overrides;

  for (const repo of repos) {
    const { local, remote } = await listBranches(repo.path);
    const branchNames = Array.from(new Set([...local, ...remote]));

    if (branchNames.length === 0) {
      console.log(chalk.dim(`  ${repo.name}: no branches found — will create "${featureBranch}".`));
      continue;
    }

    const picked = await select({
      message: `Branch for ${repo.name}:`,
      choices: [
        {
          name: `➕ Create new branch "${featureBranch}" (default)`,
          value: '',
        },
        ...branchNames.map((b) => ({
          name: local.includes(b) ? b : `${b} ${chalk.dim('(remote only)')}`,
          value: b,
        })),
      ],
    });

    if (picked) {
      overrides.set(repo.name, picked);
    }
  }

  return overrides;
}

/**
 * Prompts the user to select AI assistants to generate context for.
 */
export async function promptSelectAI(
  detected: DetectedAI[],
): Promise<AIAssistant[]> {
  const selected = await checkbox({
    message: 'Select AI assistant(s) to generate context for:',
    choices: detected.map((ai) => ({
      name: `${ai.displayName} ${ai.detected ? chalk.green('✓ detected') : chalk.dim('not found')}`,
      value: ai.name,
      checked: ai.detected,
    })),
    validate: (items) => {
      if (items.length === 0) return 'Please select at least one AI assistant';
      return true;
    },
  });

  return selected as AIAssistant[];
}

/**
 * Prompts the user to select an editor to open the workspace in.
 */
export async function promptSelectEditor(
  detected: DetectedEditor[],
): Promise<DetectedEditor | null> {
  const shouldOpen = await confirm({
    message: 'Open workspace in an editor?',
    default: true,
  });

  if (!shouldOpen) return null;

  const available = detected.filter((e) => e.detected);

  if (available.length === 0) {
    console.log(chalk.yellow('  No editors detected in PATH.'));
    return null;
  }

  const selectedCommand = await select({
    message: 'Select editor:',
    choices: available.map((editor) => ({
      name: editor.name,
      value: editor.command,
    })),
  });

  return available.find((e) => e.command === selectedCommand) ?? null;
}

/**
 * Prompts the user to select a teamwork collaboration strategy.
 * Shows a preview of the selected template before confirming.
 */
export async function promptSelectStrategy(
  templates: WorkflowTemplate[]
): Promise<string> {
  const choices = [
    { name: '✨ Auto-suggest using AI', value: 'auto', description: 'Picks one of the strategies below based on the task description and repo count' },
    { name: '✏️  Create new custom strategy', value: 'create_new', description: 'Write a new strategy or load from a file' },
    ...templates.map((t) => ({
      name: `${t.name}${t.custom ? ' (Custom)' : ''}`,
      value: t.id,
      description: t.description,
    })),
  ];

  while (true) {
    const selectedId = await select({
      message: 'Select a teamwork collaboration strategy:',
      choices,
    });

    // Both of these have their own step later, so there is nothing to preview.
    if (selectedId === 'auto' || selectedId === 'create_new') {
      return selectedId;
    }

    // Show preview for template-based strategies
    const template = templates.find((t) => t.id === selectedId);
    if (template) {
      console.log(chalk.bold(`\n📄 Preview: ${template.name}\n`));
      console.log(chalk.dim('─'.repeat(60)));
      console.log(template.content);
      console.log(chalk.dim('─'.repeat(60)));

      const confirmed = await confirm({
        message: 'Use this strategy?',
        default: true,
      });

      if (confirmed) {
        return selectedId;
      }
      // Loop back to selection if not confirmed
      console.log();
    } else {
      return selectedId;
    }
  }
}

/**
 * Prompts the user for a new strategy name and content.
 * Offers two input modes: open $EDITOR for multi-line authoring, or load from a file.
 */
export async function promptNewStrategy(): Promise<{ name: string; content: string }> {
  const name = await input({
    message: 'New Strategy Name:',
    validate: (value) => value.trim().length > 0 || 'Name cannot be empty',
  });

  const mode = await select({
    message: 'How do you want to provide the strategy content?',
    choices: [
      { name: '📝 Write in editor', value: 'editor', description: 'Opens your $EDITOR for multi-line content' },
      { name: '📂 Load from file', value: 'file', description: 'Paste a path to a .md or .txt file' },
    ],
  });

  let content: string;

  if (mode === 'file') {
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');

    const filePath = await input({
      message: 'Path to strategy file (.md or .txt):',
      validate: (value) => {
        if (!value.trim()) return 'Path cannot be empty';
        if (!existsSync(value.trim())) return 'File not found';
        return true;
      },
    });

    content = await readFile(filePath.trim(), 'utf-8');
    console.log(chalk.dim(`  Read strategy from ${filePath.trim()}`));
  } else {
    content = await editor({
      message: 'Write your strategy content (save and close the editor when done):',
      default: `# ${name.trim()}\n\nDescribe your teamwork cooperation guidelines here.\n\n## Guidelines\n\n- \n`,
      waitForUserInput: false,
    });
  }

  if (!content.trim()) {
    content = `# ${name.trim()}\n\nCustom strategy template.`;
  }

  return { name: name.trim(), content: content.trim() };
}

/**
 * Prompts the user to select Agent Skills to deploy to the workspace.
 * Skills are grouped into ContextSpace catalog skills and Global harness skills.
 */
export async function promptSelectSkills(skills: SkillItem[]): Promise<string[]> {
  if (skills.length === 0) return [];

  const catalogSkills = skills.filter((s) => !s.source);
  const harnessSkills = skills.filter((s) => Boolean(s.source));

  const choices: Array<{ name: string; value: string; checked?: boolean } | Separator> = [];

  if (catalogSkills.length > 0) {
    choices.push(new Separator(chalk.bold('--- ContextSpace Catalog Skills ---')));
    for (const s of catalogSkills) {
      const desc = s.description ? ` ${chalk.dim(`(${s.description.slice(0, 60)}...)`)}` : '';
      choices.push({
        name: `${s.title || s.name}${desc}`,
        value: s.id,
        checked: false,
      });
    }
  }

  if (harnessSkills.length > 0) {
    choices.push(new Separator(chalk.bold('--- Global Harness Skills ---')));
    for (const s of harnessSkills) {
      const sourceLabel = s.source?.label || s.source?.harness || 'Global';
      const desc = s.description ? ` ${chalk.dim(`(${s.description.slice(0, 60)}...)`)}` : '';
      choices.push({
        name: `${s.title || s.name} ${chalk.cyan(`[${sourceLabel}]`)}${desc}`,
        value: s.id,
        checked: false,
      });
    }
  }

  const selected = await checkbox({
    message: 'Select Agent Skills to deploy to this workspace (optional):',
    choices,
  });
  return selected;
}
