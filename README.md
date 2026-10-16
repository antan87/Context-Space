<p align="center">
  <h1 align="center">🌌 ContextSpace</h1>
  <p align="center">
    <strong>Deterministic Multi-Repo Context Engine for Autonomous AI Assistants</strong>
  </p>
  <p align="center">
    Group repositories · Generate AI context · Resume LLM sessions · Orchestrate services
  </p>
</p>

---

ContextSpace combines multiple Git repositories into a single feature workspace and generates the deterministic context files that your AI coding assistant needs to understand all of them at once. It can create isolated **git worktrees** on clean feature branches, or work in-place directly in your source repositories when you want to manage branches yourself.

> **New to ContextSpace?** Jump to the [Getting Started Guide](GETTING_STARTED.md) for a hands-on walkthrough.

For storage, sharing, deletion and local support reports, see the
[data and privacy guide](docs/data-and-privacy.md), Settings → Data and privacy,
or `ctxspace data`.

## ✨ Features

- **Multi-repo workspaces** — group any set of local Git repos in isolated worktrees or in-place source repositories
- **Project registry** — save named, persistent repo groups in `~/.contextspace/projects.json` and reuse them from the CLI or API
- **Dynamic lifecycle flow selection** — choose tailored development flow presets (`quick` for single-step bug fixes, `feature` for standard feature branches, and `epic` for multi-milestone initiatives) with milestone dependency gating and live fleet tracking
- **The full feature loop** — `create` opens a workspace, `finish` closes it: commit + push every repo, open PRs (or print compare links), promote learnings, and optionally clean up
- **Knowledge that accumulates durably** — titled, scoped decisions and gotchas are auto-committed to the workspace artifact repository, then reusable entries can be promoted into per-repo memory
- **Mechanical verification gates** — sequential test runners (`ctxspace verify`) enforce clean git commits, test-suite passing criteria, and cryptographic proof anchoring before advancing lifecycle milestones or completing features
- **Generic enterprise domain packs & categories** — model enterprise taxonomies through Root Organization Conventions (commit patterns, PR templates, compliance rules), Subsystem Verticals (domain-specific rules and verification gates), and Horizontal Traits (cross-cutting architectural invariants), persisted safely in `domain-catalog.json` with concurrency locks and full GUI administration
- **Open agentskills.io standard alignment** — portable agent skills deploy canonically to `.agents/skills/` with YAML frontmatter, execution playbooks, and auxiliary runbooks/scripts; streamlined projections for Claude Code (`.claude/skills/`) and native Codex custom agent personas (`.codex/agents/*.toml`)
- **Start Work GUI improvements** — launch workspaces from the GUI with instant skill selection, in-page tag and category creation, and visual flow pipeline configuration
- **Provenance-checked AI context** — `contextspace.lock` records repo fingerprints and generated-view hashes; `ctxspace refresh --check` and `doctor` expose stale or modified context loudly
- **Single-source AI context generation** — `AGENTS.md` is canonical; stamped Claude, Copilot, Cursor, and skill views are generated artifacts
- **Drive it from your assistant** — an MCP server exposes the whole loop (status, diff, commit, sync, refresh, doctor, knowledge, finish) so your AI can run it without leaving the session
- **Smart codebase analysis** — detects tech stacks, ports, API endpoints, dependencies, and existing AI configs across all projects
- **Resource Library** — create and administer reusable Agent Skill folders and Codex-native custom agents, then assign them to workspaces
- **Owned Resource Deployment** — installs portable skills to native discovery folders and Codex agents to `.codex/agents/`, refusing unmanaged collisions and preserving locally modified files
- **Teamwork Strategy Workflows** — predefine coordination flows and subagent behaviors (e.g. plan-implement-review) and inspect them with local AI coding assistant harnesses
- **Session history & resumption** — browse past conversation transcripts from Antigravity, Claude Code, OpenAI Codex, and GitHub Copilot, then resume where you left off
- **Incremental, token-efficient refresh** — an analysis cache fingerprints each repo (HEAD + dirty files), so `refresh`/`sync` only re-analyze repos that changed and unchanged maps stay byte-identical (keeping your AI assistant's prompt cache warm)
- **Scheduled workspace jobs** — recurring `sync`/`refresh` per workspace (e.g. every 2h) that run while the dashboard server is up, so context files stay fresh without manual runs
- **Service orchestration** — start, stop, and tail logs for all services in a workspace with a single command
- **Interactive Web Dashboard** — rich dark-themed GUI for managing workspaces, viewing sessions, and streaming logs
- **CLI-first** — every action available from the terminal via the `ctxspace` command (aliases: `contextspace`, `cs`, `nexusflow`)

## 📦 Installation

### Prerequisites

| Requirement | Version | Platform Notes |
|:---|:---|:---|
| [Node.js](https://nodejs.org) | 22.13 or later | Needed for source setup or CLI development; **not required by packaged desktop installers** |
| [Git](https://git-scm.com) | 2.20 or later | Required for worktree and multi-git operations |
| npm | Bundled with Node.js | Standard package manager (for source development) |
| `xdg-utils` | Recommended | Linux only (for auto-opening the web dashboard) |

### Desktop installers & standalone binaries (recommended)

Download the first-class Windows NSIS installer, Linux AppImage standalone binary, or VS Code extension from the
[ContextSpace GitHub Releases](https://github.com/antan87/Context-Space/releases). Each
release includes `latest.yml`/`latest-linux.yml` update metadata and a required
SHA-256 sidecar. The desktop app is the primary distribution and includes the
full GUI plus optional, user-controlled native updates.

- **Windows:** Run `ContextSpaceSetup.exe` to install and launch ContextSpace Desktop.
- **Linux:** Download `ContextSpace-<version>.AppImage` (standalone portable executable), make it executable (`chmod +x ContextSpace-*.AppImage`), and run it directly (`./ContextSpace-*.AppImage`), or place it under `~/.local/share/contextspace/ContextSpace.AppImage`.
- **VS Code Extension:** Download `ContextSpace.vsix` and install with `code --install-extension ContextSpace.vsix`.
- **Application Menu (Linux):** Open Activities / App Grid (press `Super` / Windows key), search for **ContextSpace**, and launch.
- **Terminal (Linux):** Run `gtk-launch contextspace` or execute `~/.local/share/contextspace/ContextSpace.AppImage`.
- **CLI Shortcut:** Run `ctxspace desktop` anytime.

### npm package (deprecated)

> [!WARNING]
> The `@mrpatronz/nexusflow` npm package is deprecated in favor of [ContextSpace GitHub Releases](https://github.com/antan87/Context-Space/releases). ContextSpace is distributed solely through GitHub Releases (desktop installers, standalone binaries, and installable VSIX). Do not install via `npm install -g @mrpatronz/nexusflow`.

### Install from source (CLI, GUI, desktop, and extension development)

```bash
git clone https://github.com/antan87/Context-Space.git
cd Context-Space

# Install root dependencies, then GUI/desktop/extension dependencies
npm install
npm run setup              # includes the Electron runtime for source desktop start

# Build everything
npm run build

# Link the CLI globally
npm link
```

After linking, the `ctxspace` (and aliases `contextspace`, `cs`, `nexusflow`) commands are available system-wide.

## 🚀 Quick Start

### Desktop (recommended)

On Windows or Linux, download the latest NSIS installer/AppImage from
[GitHub Releases](https://github.com/antan87/Context-Space/releases) and launch the
app. No Node.js or npm installation is needed.

### CLI and browser dashboard

```bash
# 1 — Initialize config (optional, defaults work out of the box)
ctxspace init

# 2 — Create a feature workspace
ctxspace create

# 3 — Or use the GUI: packaged desktop app or the fully functional browser dashboard
ctxspace dashboard
```

The `create` wizard walks you through:

1. **Choose a repo source** — start from a registered project or scan/pick ad-hoc repos
2. **Choose a work mode** — isolated worktrees or in-place source repositories
3. **Name the branch or workspace** — branch name for worktrees, workspace name for in-place
4. **Describe what you're building** — plain text or a path to a `.md` file
5. **Choose AI assistant(s)** — auto-detects what's installed
6. **Done!** — workspace created with AI context files, plus git worktrees in isolated mode

## 📚 Projects

A project is a named, persistent group of source repositories stored centrally in `~/.contextspace/projects.json` (with automatic fallback to `~/.nexusflow/projects.json`). Project ids are slugified from the name, so `Acme Billing` becomes `acme-billing`. Use either the `project` command group or its `proj` alias:

| Command | Description |
|:---|:---|
| `ctxspace project add -n, --name <name> -r, --repos <paths...> [-d, --description <text>]` | Register a project; omit `--repos` to use the interactive repo picker |
| `ctxspace project list` | List registered projects (alias: `ls`) |
| `ctxspace project show [id]` | Show a registered project |
| `ctxspace project remove [id] [-y, --yes]` | Remove a project from the registry (alias: `rm`) |

Removing a project only edits the registry — it never deletes repositories or workspaces on disk. The HTTP API exposes the same registry through `GET /api/projects`, `POST /api/projects`, `PUT /api/projects/:id`, and `DELETE /api/projects/:id`.

## 🧭 Work Modes

`ctxspace create` offers registered projects first (ad-hoc repo scanning is still available), then asks how the workspace should work:

| Mode | What it does |
|:---|:---|
| **Isolated worktrees** | The classic flow: ContextSpace creates a feature branch and git worktree per repo inside the workspace directory. |
| **In-place (reference checkouts)** | Your source repositories are attached as read-only references: ContextSpace reads them where they are and never changes them. No branches or worktrees are created up front; you provide a workspace name, and the workspace directory only holds `contextspace.json` plus generated AI context files. |

To change a reference repository, **prepare it for editing** (`ctxspace isolate <repo>`, the MCP `isolate_repo` tool, or the + action in the app). That creates an editable worktree on its own branch inside the workspace, and leaves your checkout — its branch, files and local base branch — exactly as it was. A path or branch collision is reported before anything is created (`--dry-run` shows the plan). Commit, finish, push and revert refuse to change a reference repository on every surface. `ctxspace sync` never mutates source-repo branches; creating a workspace fast-forwards your checkouts only when you explicitly ask. Deleting an in-place workspace never touches the source repositories, `ctxspace list` tags it with `[in-place]`, and agent sessions for single-repo in-place workspaces run in the repo root.

For API callers, `POST /api/workspace` accepts optional `mode` (`worktree` default, or `in-place`), `name` (required for in-place), and `projectId`. Existing workspace manifests without a `mode` field are treated as `worktree` mode.

## 📂 What Gets Generated

In isolated worktree mode:

```
~/dev/workspaces/feature/user-auth/
├── CLAUDE.md                         # Context for Claude Code
├── AGENTS.md                         # Canonical context for Antigravity, Codex & agents
├── .agents/
│   └── skills/                       # Canonical skills for Antigravity, Codex, Cursor, Copilot (SKILL.md + assets)
├── .claude/
│   └── skills/                       # Skills for Claude Code (SKILL.md + assets)
├── .codex/
│   └── agents/                       # Custom agent personas for OpenAI Codex (.toml)
├── .github/
│   └── copilot-instructions.md       # Context for GitHub Copilot
├── .cursor/
│   └── rules/                        # Context & rules for Cursor (.mdc)
├── contextspace.json                 # Feature config (branch, repos, etc.)
├── contextspace-knowledge.md         # Persistent workspace memory (decisions & gotchas)
├── contextspace-plan.md              # AI dependency build & merge plan
├── my-api/                           # ← Git worktree on feature branch
└── my-frontend/                      # ← Git worktree on feature branch
```

In-place workspaces keep the manifest, skills, and generated AI context files in the workspace directory while the code stays in the source repositories.

ContextSpace adheres strictly to the open **[agentskills.io](https://agentskills.io)** standard:
- `.agents/skills/` is the canonical open directory for portable agent skills (`SKILL.md` frontmatter + execution playbook, `references/`, `scripts/`).
- `.claude/skills/` is maintained as a dedicated projection exclusively for Claude Code.
- `.codex/agents/*.toml` houses native custom agent personas for OpenAI Codex.
- Redundant mirror folders (`.codex/skills/`, `.cursor/skills/`) are retired in favor of universal discovery via `.agents/skills/`.

Open this folder in your editor → your AI assistant picks up the context and skills → it understands *all* your repos.

## 🖥️ Commands

| Command | Description |
|:---|:---|
| `ctxspace create` | Interactive wizard to create a new worktree or in-place workspace |
| `ctxspace quick` | Fast-track instant workspace creation tailored for quick bug fixes |
| `ctxspace list` | List workspaces, tagging in-place ones with `[in-place]`; archived ones are hidden unless you pass `--archived` or `--all` (alias: `ls`) |
| `ctxspace open` | Re-open a workspace in your editor |
| `ctxspace init` | Configure ContextSpace settings |
| `ctxspace project` | Manage registered repo groups: `add`, `list`/`ls`, `show`, `remove`/`rm` (alias: `proj`) |
| `ctxspace add-repo` | Add a repository to an existing workspace (alias: `add`) |
| `ctxspace archive` | Complete a workspace: remove its worktrees and merged branches it created, keep its record (`--park`, `--keep-branches`, `--delete-remote-branches`, `--dry-run`, `--json`) |
| `ctxspace unarchive` | Restore an archived workspace as active; its repositories stay read-only references until prepared for editing |
| `ctxspace remove` | Delete a workspace and its record, force-removing its git worktrees (alias: `rm`); `archive` keeps the record |
| `ctxspace start` | Start the services a workspace's `Procfile.dev`/`Procfile` declares; offers guessed services only after asking, and reports why any did not start |
| `ctxspace stop` | Stop all running services |
| `ctxspace status` | Show live repo SHA/branch/dirty/push state, generated-context freshness, and service status |
| `ctxspace plan` | Read the plan (Goal, Needs you, Milestones, Other open work, Done and dropped, What changed) and change it one item at a time: `add`, `start`, `done`, `answer`, `block`, `later`, `drop`, `reopen`, `edit`, `log`, `check`; `--json` on all. The AI's closes of the user's items and of milestones become proposals the user accepts |
| `ctxspace flow` | Visualize active lifecycle steps, milestone gates, and multi-branch sister fleet (`--step`, `--action`, `--assignment`) |
| `ctxspace verify` | Execute mechanical verification gates and record cryptographic proof in workspace state (`--repo`, `--tag`, `--filter`, `--timeout`, `--allow-dirty`) |
| `ctxspace progress` | Derive implementation progress from live branch, push, and available PR state |
| `ctxspace logs` | Tail aggregated logs from all services |
| `ctxspace ui` | Start the dashboard server — the backend the desktop app embeds (`--port`, `--open`, `--strict-port`) |
| `ctxspace dashboard` | Open the dashboard in your browser (alias: `dash`) |
| `ctxspace tui` | Open the interactive terminal (TUI) dashboard |
| `ctxspace diff` | View changes across all sub-repositories, including unpushed commits (`--repo` to filter) |
| `ctxspace commit` | Commit and push changes across all modified repositories (`--repo`, `--no-push`, `--dry-run`) |
| `ctxspace sync` | Rebase worktree-mode repositories and reconcile generated views; in-place workspaces skip repo mutation but still reconcile stale context |
| `ctxspace finish` | Close out a feature: check verification evidence, commit & push editable repos, open PRs / print compare links, promote learnings, then optionally archive or delete the workspace (`-m`, `--no-pr`, `--no-knowledge`, `--archive`, `--park`, `--cleanup`, `--dry-run`, `--override-verification <reason>`) |
| `ctxspace isolate` | Prepare a read-only reference repository for editing in its own worktree and branch (`[repo] [branch]`, `--base`, `--dry-run`) |
| `ctxspace strategy` | Manage teamwork strategy workflows (`list`, `create`, `edit`, `delete`, `show`) |
| `ctxspace migrate` | Migrate legacy `.nexusflow` workspaces to `.contextspace` |
| `ctxspace tag` | Manage enterprise categories, vertical subsystems, and cross-cutting traits (`list`, `add`, `remove`, `show`) (alias: `category`) |
| `ctxspace skill` | Manage portable agent skills from CLI (`list`, `create`, `show`, `delete`) |
| `ctxspace knowledge` | Capture titled decisions/gotchas/assumptions/questions with optional `--scope` and `--evidence`; `show`, `promote` into per-repo base knowledge |
| `ctxspace refresh`| Regenerate plan and AI context files; use `--check` for a non-regenerating CI/pre-commit freshness gate |
| `ctxspace remote` | Add, push, or pull the workspace artifact repository remote without touching child repo remotes |
| `ctxspace handoff` | Generate a compact handoff bundle (`contextspace-handoff.md`) for session resumption |
| `ctxspace schedule` | Manage recurring workspace jobs: `add`, `list`, `remove`, `enable`, `disable`, `run` |
| `ctxspace doctor` | Run health checks and diagnostics to verify workspace integrity |
| `ctxspace config` | View and update configuration: `show`, `get <key>`, `set <key> <value>` |
| `ctxspace adapter` | Manage storage adapters: `list`, `use`, `info`, `init` |
| `ctxspace mcp` | Manage the MCP server for AI assistants: `run`, `setup` |
| `ctxspace desktop` | Launch the Electron desktop app from a source checkout (requires a built CLI and `desktop/` deps installed) |
| `ctxspace desktop install` | Download and checksum-verify the matching Windows NSIS/Linux AppImage release, then install it locally |

## 🤖 Supported AI Assistants

ContextSpace auto-detects which assistants are available on your machine and generates the right context files and skills for each:

| Assistant | Config File & Skills Target | How It's Detected |
|:---|:---|:---|
| **Google Antigravity** | `AGENTS.md` & `.agents/skills/` | `antigravity` in PATH |
| **Claude Code** | `CLAUDE.md` & `.claude/skills/` | `claude` in PATH |
| **OpenAI Codex** | `AGENTS.md`, `.agents/skills/` & `.codex/agents/` | `codex` in PATH |
| **GitHub Copilot** | `.github/copilot-instructions.md` & `.agents/skills/` | Always available |
| **Cursor** | `.cursor/rules/contextspace.mdc` & `.agents/skills/` | `cursor` in PATH |


## 🔁 The Feature Loop: create → work → learn → finish

ContextSpace is built around a single loop:

1. **`ctxspace create`** — open a worktree or in-place workspace with AI context files generated. Along the way you can **scaffold a brand-new project** (a fresh local git repo in your dev directory) and, per repo, **check out an existing branch** — local or remote — instead of creating the feature branch.
2. **Work** — your AI assistant edits code across repos. As it goes, it records learnings:
   ```bash
   ctxspace knowledge add -t decision --title "worktree isolation" -m "Chose worktrees over submodules for isolation"
   ctxspace knowledge add -t gotcha --title "windows ebusy" --scope "path:src/core/workspace.ts" -m "fs.rm needs maxRetries on Windows (EBUSY)"
   ctxspace progress
   ```
   Entries land under searchable dated slug headings in `contextspace-knowledge.md`. Identical retries are idempotent. If the storage write succeeds but Git auto-commit fails, ContextSpace reports "recorded but not committed" instead of inviting a duplicate retry. Git auto-commit applies to local workspace storage; custom adapters retain their own durability contract. The 300-character body cap remains enforced; implementation progress is never authored and is derived live instead.
3. **`ctxspace finish`** — close it out:
   - Shows a preflight status table (branch, dirty files, unpushed commits) per repo, and the verification evidence for each editable repo.
   - Refuses to finish while verification is missing, failed, timed out or stale for the current content — the same decision in the CLI, the app and MCP. Verify again, or pass `--override-verification "<reason>"`; the reason is recorded and returned. `--yes` never bypasses it.
   - Commits any remaining changes and pushes every editable branch; repos on the wrong branch or in a detached HEAD are skipped, and read-only reference repos are never touched.
   - Records each repo's outcome as it goes. Git effects are not atomic across repos: if a push fails, running `finish` again resumes — committed repos are pushed, not committed again.
   - Opens a PR per repo with the GitHub CLI when it's installed and authenticated; otherwise prints a ready-to-click **compare URL** for GitHub, GitLab, Azure DevOps, or Bitbucket.
   - Offers to **promote** reusable learnings into each repo's persistent base knowledge. Base knowledge lives in your ContextSpace home under `base/<repository>/`, keyed by the repository's origin URL, so every workspace with that repository shares it and it survives deleting or archiving the workspace. Older per-workspace copies are merged in once and kept.
   - With `--archive`, **archives** the workspace (see below). With `--cleanup`, deletes the workspace and its record once everything is confirmed pushed (never while you're `cd`'d inside it, and never touching source repositories for in-place workspaces).

   ```bash
   ctxspace finish --dry-run        # preview what would happen
   ctxspace finish -m "Ship feature" --archive
   ```
4. **`ctxspace archive`** — give back the worktrees, keep the record:
   - Every editable repository must be clean and its branch merged into the default branch: an ancestor of the fetched default branch, or merged through a pull request whose head is exactly that commit (via `gh`). Pushed but unmerged work needs `--park`, which keeps its branch. Dirty, unpushed or never-pushed work blocks the archive and nothing is removed.
   - Worktrees are removed without force. Merged branches the workspace created are deleted locally, only while they still point at the merged commit; branches it did not create, parked branches and branches checked out elsewhere are kept, and `--keep-branches` keeps them all. `--delete-remote-branches` also deletes them on `origin`, unless someone pushed to them since. Your own checkouts are never changed.
   - Milestones and verification results, planning notes, knowledge, the assignment and source documents stay in the workspace folder, readable in the app and the CLI. Each repository's final commit is recorded. Starting sessions or services, committing, syncing, verifying and finishing are refused until you `ctxspace unarchive` it.
   - Each run is journaled: if it stops part-way, running it again resumes. `--dry-run` shows every worktree, branch and file that would be removed or kept.

## 🌊 Dynamic Lifecycle Flows & Milestone Radar

ContextSpace provides dynamic development lifecycles (`flowType`), allowing developers and autonomous agents to right-size milestone pipelines, dependency gating, and multi-branch coordination:

| Flow Preset | Best For | Default Pipeline |
|:---|:---|:---|
| **`quick`** | Bug fixes, single-repo patches, typo fixes | Reproduce failure → Implement fix → Mechanical verify & commit |
| **`feature`** | Standard features, enhancements, new APIs | Foundation / Prereqs → Core feature slice → Integration, docs & verify → Finish |
| **`epic`** | Complex multi-repo initiatives, modular migrations | Architecture & Contracts → Milestone Slices (with dependency graph) → Cross-repo integration → Comprehensive release gate |

Select a flow preset during workspace creation (`ctxspace create` or `ctxspace quick`), or choose it directly in the Start Work GUI.

### Inspecting Flow & Advancing Milestones

Use `ctxspace flow` to inspect your active milestone pipeline, the current active deliverable, and live status:

```bash
# View active lifecycle pipeline and sister branch fleet in the terminal
ctxspace flow

# Output structured JSON for automation or scripting
ctxspace flow --json

# Read live AI assignment, source documents, and stage guidance
ctxspace flow --assignment
ctxspace flow --assignment --json

# Transition milestones through the state machine (start -> verify -> complete)
ctxspace flow --step milestone-1 --action start
ctxspace flow --step milestone-1 --action complete
```

### Sister Branch Fleet & Collaborator Radar

When coordinating across multiple repositories and developers, `ctxspace flow` surfaces the **Sister Branch Fleet**:
- **Non-destructive remote inspection**: Safely queries `refs/remotes/origin/*` across all repositories in the workspace without mutating local working trees.
- **Collision & Desync Detection**: Highlights ahead/behind commit deltas, unpushed local changes, and remote branch tracking state.
- **Collaborator Visibility**: Reports recent commit authors, commit messages, and relative commit timestamps across repositories so agents and developers avoid stomping on active teammate work.

## 🧪 Mechanical Verification Gates

To prevent advancing unverified code, broken builds, or uncommitted modifications, ContextSpace provides automated **Mechanical Verification Gates** via `ctxspace verify`.

```bash
# Execute verification commands across all repositories
ctxspace verify

# Target a specific repository or test tag
ctxspace verify --repo my-api
ctxspace verify --tag backend

# Specify a custom verification command or timeout
ctxspace verify --command "npm test" --timeout 120

# Run in CI or pre-commit scripts (exits with code 1 on failure or timeout)
ctxspace verify --json
```

A milestone gate (`ctxspace flow --step <id> --action complete`) runs that milestone's verification command with a 30-minute limit, since gates usually run a full suite, a build and browser tests. Set a different limit per milestone with `verificationTimeoutSeconds` (30 seconds to 2 hours) in the plan, or "verification time limit" in the milestone editor. A gate that runs out of time records `timeout` and says which limit it hit.

### Verification Invariants & Security
- **Strict Sequential Execution**: Tests are executed sequentially per repository to prevent resource starvation and test harness interference.
- **Dangerous Operator Rejection**: Command strings containing shell operators (`&&`, `||`, `;`, `|`, `` ` ``, `$()`) are rejected to eliminate command injection risks and ensure deterministic status reporting.
- **Cryptographic SHA Anchoring**: Results are pinned to the exact Git commit SHA of each repository.
- **Dirty Tree Detection (`pass_dirty`)**: If tests pass but uncommitted changes remain in the repository working tree, ContextSpace reports `pass_dirty` with warnings to commit before finishing, ensuring that verification proof is anchored to immutable Git history.
- **Durable State Recording**: Test results, timings, commands, and SHA fingerprints are persisted in `.contextspace-state.json`. Subsequent checks or agents can inspect recorded verification evidence without redundant test re-runs.

## 🔌 MCP Server & Tools

`ctxspace mcp setup` registers ContextSpace's MCP server so your assistant can drive the whole loop without leaving the session. It configures:

- **AI agents:** Claude Code, Codex, Antigravity (`agy`), and Pi (which needs the `pi-mcp-adapter` package). One server is registered per agent at user level, so it works in every workspace and finds the workspace from the agent's working directory.
- **Editors and desktop apps:** Claude Desktop, Cursor, and VS Code.

On Linux, the desktop app keeps a lasting copy of the CLI and MCP server under `~/.local/share/contextspace/cli` (it survives a restart, and it is the app's own version), and registrations run its launcher, `~/.local/share/contextspace/cli/bin/ctxspace`. Open the app once so the copy exists, then run `ctxspace mcp setup`. Where there is no such copy, registrations fall back to `npx -y @mrpatronz/nexusflow@latest`, which only reaches the last npm release (2.39) because npm publishing is deprecated. An existing ContextSpace entry is never replaced for an agent; if one still runs npm, setup says so, and you remove it and run setup again. Run `ctxspace mcp setup --dry-run` to see what would be registered with each agent without changing anything, or `--no-agents` to configure editors and desktop apps only. `ctxspace doctor` lists installed agents that have no registration. Registering agents is not yet available on native Windows.

An ad-hoc `nexusflow mcp run` with no `--role` fails closed to the `readonly` tool surface. The explicit `nexusflow mcp setup` command installs `--role interactive` for the full workspace-management experience, including committing, finishing, and archiving workspaces; use `--role readonly` or `--role review` for untrusted or inspection-only agents. The server exposes:

| Tool | What it does |
|:---|:---|
| `search_workspace` | `git grep` across every repo in the workspace |
| `workspace_status` | Per-repo branch / dirty / ahead-behind / remote status |
| `get_workspace_diff` | Changed files, insertions/deletions, and unpushed commits |
| `commit_workspace` | Commit (and push) all changed repos with one message |
| `sync_workspace` | Rebase every repo onto its base branch (auto-stashes dirty trees) |
| `refresh_context` | Regenerate maps/plan/context (only re-analyzes changed repos) |
| `run_doctor` | Structured workspace health diagnostics |
| `add_knowledge` | Record a titled decision, gotcha, assumption, or question with optional scope/evidence |
| `promote_knowledge` | Copy a learning into a repo's persistent base knowledge |
| `finish_workspace` | Commit, push, and return PR/compare links (never deletes anything) |
| `preview_archive` | Show what archiving would remove and keep, and what blocks it (changes nothing) |
| `archive_workspace` | Archive another workspace (never the one the server serves or runs inside); `park`, `keepBranches`, `dryRun`; never deletes remote branches |
| `unarchive_workspace` | Restore an archived workspace as active; nothing is removed or checked out |
| `get_service_logs` | Tail a running service's logs |
| `get_work_context` | Read the assignment, document IDs, the plan as `ctxspace plan` prints it, the milestones, and edit revisions |
| `update_milestone_plan` | Deprecated: use `ctxspace plan`. Still edits milestones for one release |
| `request_user_input` | Flag the CLI chat of an agent that is blocked on the user, so a user with many chats open can see which one is waiting. The agent still asks its full question in the chat and ends its turn; the user replies there. Optional `options` become answer buttons that fill the prompt; the user still presses Enter |
| `show_in_reader` | Open a document, a file at a line, or a diff in the reader beside the user's chat. Show-only: the file must exist inside the workspace, nothing is edited, and a repeat within a minute is ignored |
| `annotate_document` | Leave a question, risk or to-do note on one line of a file, shown in the reader as a margin note labelled as the AI's |
| `suggest_next` | Offer the user one next move with its reason, shown as a Next button in the progress strip |
| `set_milestone` | Deprecated: use `ctxspace plan start|block|done`. Still works for one release |
| `get_screen_context` | Ask what the user is looking at. Answers only when the user has switched sharing on in the app; it is off by default and switching it off deletes what was stored |
| `update_work_assignment` | Set work type, size, stage, objective, expected output, stopping point, and scope |
| `add_work_document` | Attach original text or a document link with role, status, and scope |
| `update_work_document` | Edit source labels and scope while preserving original content |
| `read_work_document` | Read an attached source by its document ID |
| `get_planning_notes` | Deprecated: use `ctxspace plan`. Reads the older notes file for one release |
| `save_planning_notes` | Deprecated: use `ctxspace plan add`. What it saves moves into the plan at the next refresh |

AIs change the plan with `ctxspace plan`, which works in every AI tool without MCP; there are no MCP plan tools.
Assignment and source writes are available to `interactive`, `developer`, and `full` roles.
Read the current revision before editing; see [planning through MCP](docs/work-guidance.md#planning-through-mcp).
After upgrading a running MCP server, reconnect it in the assistant to discover the new tools.

Read-only tools are annotated as such. `finish_workspace` never removes worktrees, and `archive_workspace` refuses the workspace the server serves or runs inside, because an agent works in those worktrees; archive that one with the CLI or the app. Naming another workspace needs an `interactive` or `full` session. MCP servers route console output to stderr, so tools never write into the protocol stream. `list_workspaces` leaves archived workspaces out unless `includeArchived` is set. Pass `--debug` (or set `CONTEXTSPACE_DEBUG=1`) on any CLI command to surface diagnostic logging on stderr.

## 🕐 Session History & Resumption

ContextSpace can discover and display your past AI coding sessions across all supported assistants. This lets you:

- **Browse** conversation transcripts from previous sessions
- **Search** through your interaction history
- **Resume** a session by copying the resume command to your clipboard

Session data is read directly from each assistant's local storage:

| Assistant | Session Location |
|:---|:---|
| Antigravity | `~/.gemini/antigravity-cli/brain/` |
| Claude Code | `~/.claude/projects/` |
| OpenAI Codex | `~/.codex/sessions/` |
| GitHub Copilot | `~/.copilot/` |

Access sessions via the Web Dashboard's **Sessions** tab or through the API:

```
GET /api/workspace/:id/sessions
GET /api/session/:assistant/:sessionId/transcript
```

## 🗄️ Pluggable Storage & Vault Adapters

ContextSpace supports multiple storage backends to control where workspace context maps, plans, and persistent AI knowledge files are stored. This allows keeping your Git repository workspaces completely clean from AI file clutter.

Available storage providers:
- **Local (`local`)** — Stores files directly in the workspace directory (default).
- **Central Vault (`central-vault`)** — Stores files in a centralized folder on your machine at `~/.contextspace/vault/` (with fallback to `~/.nexusflow/vault/`). The folder is plain markdown, so it can be opened as (or symlinked into) an Obsidian vault.

### CLI Adapter Management

Configure storage adapters from the command line:

```bash
# List all registered storage adapters and the active provider
ctxspace adapter list

# View configurations and fields for a specific adapter
ctxspace adapter info central-vault

# Switch to a different adapter (e.g. central-vault) and configure its settings
ctxspace adapter use central-vault

# Scaffolds a template for creating a new custom storage adapter plugin
ctxspace adapter init my-custom-plugin
```

## 🕐 Scheduled Workspace Jobs

Keep workspaces fresh without manual runs — schedule recurring `sync` or `refresh` jobs per workspace:

```bash
# Rebase + regenerate context every 2 hours
ctxspace schedule add --task sync --every 2h

# Nightly context refresh for a specific workspace
ctxspace schedule add ~/dev/workspaces/my-feature --task refresh --every 1d

# Inspect, pause, or run jobs
ctxspace schedule list
ctxspace schedule disable <id>
ctxspace schedule run <id>
```

Jobs are stored in `~/.contextspace/schedules.json` (fallback: `~/.nexusflow/schedules.json`) and executed while a ContextSpace server is running — start one with `ctxspace ui` (use `--daemon` for a background host). A job whose interval elapsed while no server was running simply runs on the next scheduler tick.

Scheduled runs are **token-efficient by design**: they use the same analysis cache as `ctxspace refresh`, so only repos whose content changed are re-analyzed, and unchanged context files are left byte-identical (no git churn, no invalidated AI prompt caches). The dashboard API exposes the same functionality under `/api/schedules`.

## 🧩 Resource Library & Open AgentSkills Standard

ContextSpace provides first-class support for portable Agent Skills and Codex-native custom agents, aligned directly with the open **[agentskills.io](https://agentskills.io)** standard. Skills are complete directories; agents are validated native TOML definitions rather than skills disguised as personas.

Skills bundle metadata triggers (for AI autonomous discovery) with full Markdown execution playbooks, auxiliary reference runbooks (`references/`), and automation scripts (`scripts/`).

### Start Work GUI: Direct Selection & In-Page Creation

Starting work in the Web Dashboard or Desktop App includes streamlined skill and category management:
- **Direct Skills Selection**: Select specific skills via checkboxes directly on the Start Work page when configuring a feature workspace.
- **In-Page Tag & Category Creation**: Author and assign new categories, vertical subsystems, or traits on the fly without navigating away to administrative settings.
- **Inline Playbook Preview**: Inspect skill playbooks and reference markdown directly before assigning them.

### Category Boxes & Visual Drag-and-Drop

In the **Skills & Agents** hub, skills are grouped into clear visual accordion boxes by category. You can drag and drop skill cards between category boxes to re-categorize them, or use the quick menu on touch and mobile devices.

#### Built-in Category Templates & Skills:
- 🔀 **Pull Requests & Review**: `pr-review-toolkit`, `pr-description-gen`, `merge-conflict-resolver`
- 🧪 **Testing & Quality Assurance**: `verifier-workspace`, `e2e-runner`, `unit-test-coverage`
- 📦 **Cross-Repo & Release Ordering**: `cross-repo-local-package-loop`, `release-ordering`
- 🗄️ **Database & Migrations**: `schema-migration-validator`, `sql-fluff-linter`
- 🛡️ **Security & Auditing**: `secret-scanner`, `security-auditor`

#### Custom Categories & Workspace Scoping
- **Custom Categories**: Users can create, customize (colors, icons, descriptions), or delete custom categories. Custom overrides to built-in templates can be deleted at any time to restore default values.
- **Workspace Scoping**: Switch the scope dropdown to a feature workspace, edit a local draft, and save the complete selection with an optimistic revision check. Refresh the workspace to reconcile the saved selection.

### Codex Agent Administration

The Codex Agent Library supports creating, editing, importing, and deleting basic native agents with `name`, `description`, and `developer_instructions`, plus optional model, reasoning, and sandbox defaults. Selected agents are installed at `.codex/agents/<name>.toml`. Provider-neutral agent translation, agent teams, and collaboration kits are intentionally outside this feature.

### Cross-Harness Deployment

When a workspace is refreshed, ContextSpace reconciles enabled resources through `.contextspace/resources.lock.json` (fallback: `.nexusflow/resources.lock.json`). It refuses unmanaged target collisions, removes only unchanged ContextSpace-owned outputs, and reports modified-file conflicts instead of overwriting them. Redundant `.codex/skills/` and `.cursor/skills/` mirror directories are retired in favor of universal discovery under `.agents/skills/`.

| Assistant Harness | Deployment Path | Format |
|:---|:---|:---|
| **Google Antigravity** | `.agents/skills/<name>/SKILL.md` | Universal `agentskills.io` standard (playbook + `references/` + `scripts/`) |
| **Claude Code** | `.claude/skills/<name>/SKILL.md` | Compatibility projection for Claude Code |
| **OpenAI Codex** | `.agents/skills/<name>/SKILL.md` | Complete portable Agent Skill directory |
| **Cursor** | `.agents/skills/<name>/SKILL.md` | Complete portable Agent Skill directory |
| **GitHub Copilot** | `.agents/skills/<name>/SKILL.md` | Complete portable Agent Skill directory |

Codex custom agents are separate resources and deploy to `.codex/agents/<name>.toml`.

## 🏷️ Enterprise Categories & Domain Packs

Large enterprise codebases suffer from AI context bloat when company-wide standards and domain-specific rules are mixed together. ContextSpace solves this with a generic 3-tier hierarchy:

1. **Root Organization Conventions** (`OrganizationConventions`): Universal company guardrails applied across all repositories in the workspace:
   - Conventional commit message regex patterns (e.g. `^(feat|fix|refactor|test|chore|docs)\([A-Za-z0-9_.-]+\): .+$`).
   - Pull request templates and code-review compliance checklists.
   - Root compliance rules (e.g. GDPR, secrets hygiene, architectural invariants).
2. **Subsystem Verticals** (`categoryType: 'vertical'`): Isolated business domain rules (e.g. Invoicing, Billing, Identity) with dedicated verification test gates and microservice associations. Verticals support nested parent/child hierarchies.
3. **Horizontal Traits** (`categoryType: 'trait'`): Cross-cutting invariants (e.g. security audits, GDPR data privacy, accessibility, performance thresholds) that apply across any business domain.

### Concurrency & Catalog Persistence

Enterprise categories and domain packs are durably persisted in `~/.contextspace/domain-catalog.json` (with automatic fallback to `~/.nexusflow/domain-catalog.json`).
- **Concurrency Locks**: Multi-process mutex locking (`acquireLock`) ensures CLI processes and running GUI servers never conflict or overwrite concurrent edits.
- **Atomic Writes**: Persistent JSON updates use atomic write semantics (`atomicWriteJson`) to prevent data corruption.

### CLI Management

Manage categories and domain packs with `ctxspace tag` (alias `ctxspace category`):

```bash
# List active categories, vertical hierarchy, and horizontal traits
ctxspace tag list

# Add a domain pack or category to the current workspace
ctxspace tag add economy

# Inspect rules, verification gates, and microservices for a tag
ctxspace tag show economy

# Remove a domain pack from the workspace
ctxspace tag remove economy
```

### Full GUI Administration

The **Skills & Agents** page and the **Start Work** wizard provide complete GUI administration:
- **Create & Edit**: Define new categories and domain packs with custom labels, descriptions, icons, verification commands, and rule lists.
- **Hierarchical Nesting**: Assign parent verticals to build clear domain trees.
- **Reset & Revert**: Revert customizations to factory defaults or delete custom packs with confirmation safety.

## 👥 Teamwork Strategy Workflows

ContextSpace allows you to predefine orchestration workflows and cooperation rules that govern how multiple AI subagents coordinate when solving complex, multi-repo software engineering tasks.

You can select a strategy workflow when creating a workspace (or define custom ones). Built-in templates include:
- **Plan-Implement-Review** — A structured, multi-agent flow where an Orchestrator coordinates planning, implementation, review, and documentation.
- **Research-Verify** — A fast iteration strategy centered on research, drafting code, and immediately running verification test suites.
- **Solo Developer** — A simplified, lightweight direct-action workflow for minor tweaks and linear tasks.
- **Cost-Aware Sol Control + Luna Worker** — Optional advisory instructions for a cheaper Luna/max builder and a more capable/expensive Sol reviewer, with fresh-context review, acceptance-driven feedback, finite safety-guard escalation, and no silent model upgrades.

### Custom Strategies & AI Inspection

You can create, edit, or delete custom strategies directly via the Web Dashboard's **Team Strategies** tab. Strategies are written in clean Markdown guidelines and stored in:
`~/.contextspace/workflows/` (with fallback to `~/.nexusflow/workflows/`)

The dashboard integrates an **AI Strategy Analysis** inspector:
1. Select an AI assistant harness installed on your machine (e.g. *Claude Code*, *Antigravity*).
2. (Optional) Provide a comment or specific evaluation focus (e.g. *"Ensure subagent roles are distinct"*).
3. Click **Inspect Strategy** to have the AI analyze the strategy rules, identify ambiguities/contradictions, rate its orchestration effectiveness, and generate an optimized rewritten guideline.

## 🌐 Workrooms (Experimental)

Workrooms let two or more developers share explicitly reviewed feature context, handoffs, workflow progress, skills, agents, and workflows over a private LAN or an existing VPN. Each developer keeps their own Git checkout, credentials, terminal, editor, and AI sessions. NexusFlow never collects source files, diffs, local paths, or AI transcripts automatically, but user-authored context can contain sensitive text and must be reviewed before inclusion.

Open **Workrooms** in the dashboard to start or join one. A host selects one network address, sets a room password, and creates a 30-minute one-use invitation. The guest verifies the invitation's pinned TLS fingerprint and waits for explicit host approval. The privileged NexusFlow dashboard always remains on localhost; Workrooms use a separate, narrowly scoped HTTPS server that runs only while hosted.

Shared resources are immutable, digest-verified, and bounded by per-package and room-wide storage quotas. NexusFlow downloads them to a local review cache, shows the exact applied definition and complete file contents, identifies local create/update conflicts, and requires approval bound to both the package digest and the reviewed local resource revision before updating the local catalog. Optional compatibility metadata is enforced again at both download and apply: `platforms` lists `win32`, `linux`, and/or `darwin`, while `nexusflow` accepts an exact `major.minor.patch` version or space-separated comparisons such as `>=2.8.0 <3.0.0`. Hosts can quarantine a bad version, which removes it from downloads and future exports, then explicitly purge its digest to release the package bytes and room quota; both actions are audited. Quarantine and purge do not remotely erase review-cache copies that another developer already downloaded; those remain local until that developer removes them. Agent credentials can read context and propose workflow completion only; MCP Workroom reads are explicitly labeled as untrusted collaborator data and are available only to read-only/review tool roles. Human host authority is encrypted at rest and unlocked into a generation-bound HttpOnly local-dashboard session for confirmation and every other mutation. If that browser cookie is lost, a host must enter the room password to recover control; a guest must leave the locked local connection and join again. A paused host must also re-enter the room password to resume. Hosts can create encrypted portable backups; imports are fully validated before a listener starts, are quarantined if any later creation step fails, always receive new credentials and a new TLS identity, and can be inspected and discarded from the dashboard before retrying the original export.

The optional **Cost-Aware Sol Control + Luna Worker** strategy can be selected locally or shared as an immutable Workroom workflow. It is advisory: NexusFlow does not currently launch those roles, enforce their model/cost tiers or reasoning effort, create fresh review contexts, track acceptance, or wait for provider rate-limit resets. The developer or selected agent harness must perform those controls. Accepted, in-scope review findings return to the same cheaper builder until the explicit acceptance criteria are met; a blocked prerequisite, repeated no-progress finding, or finite safety guard requires an explicit human decision and never silently auto-accepts or loops forever.

Workrooms do not provide a public relay, NAT traversal, remote commands, shared terminals, raw diff sharing, browser-only guest access, or automatic resource updates. For home working, connect both machines to the same organization VPN and choose the VPN interface when hosting.

## 🖥️ Dashboard (Desktop App & Browser)

The primary distribution is the Electron desktop app from GitHub Releases (or
`ctxspace desktop install`). A source checkout can run it with
`npm run setup && npm run build && npm start --prefix desktop`. It embeds the
same full-featured dashboard available in a browser. For browser access, run
`ctxspace dashboard`; `ctxspace ui` starts the underlying server without
opening anything (add `--open` to launch a browser). The browser is fully
functional except that native desktop update installation is unavailable; its
update panel links to the release page. For the platform rationale (Electron vs
Tauri and friends), see [docs/desktop-platform.md](docs/desktop-platform.md). The dashboard is a full-featured dark-themed GUI:

- **Workspaces tab** — create, browse, and manage feature workspaces
- **Skills & Agents tab** — manage reusable skills, categories, drag-and-drop boxes, and workspace skill assignments
- **Team Strategies tab** — inspect and author coordination workflows and multi-agent roles
- **Open with…** — launch the workspace directly in a detected Codex Desktop, Claude Desktop, VS Code, VS Code Insiders, Cursor, JetBrains IDE, or other supported editor; unavailable apps stay out of the primary picker
- **AI & Sessions (GA)** — use the embedded first-party Claude/Codex SDK or local CLI harnesses with provider-owned model selection, then inspect and resume recorded sessions; subscription sign-ins are reused when available
- **Chat & CLI** — create a workspace from the floating chat, keep multiple workspace sessions open, and choose a second workspace for a resizable side-by-side view. The CLI inspector opens repository code, workspace documents, and linked source documents without leaving the conversation.
- **Document previews** — read Markdown, text, HTML, images, and PDF files from the workspace root. HTML is sanitized and sandboxed; PDFs use the browser's built-in viewer. Office files remain downloadable.
- **Logs panel** — real-time aggregated service log output
- **Config panel** — edit ContextSpace settings from the browser


The deprecated `POST /api/open-editor` endpoint remains available to older GUI clients only for recognized graphical editors. Interactive terminal editors such as Vim, Neovim, Nano, and Emacs are not supported by that detached HTTP launch route because it cannot provide a TTY.

The dashboard runs a local [Hono](https://hono.dev) server on port 3000 and serves a [React](https://react.dev) + [Vite](https://vite.dev) frontend.

When running the Vite development server separately on `http://localhost:5173`, start the backend with `NEXUSFLOW_DASHBOARD_ORIGIN` set to that exact origin. Workroom browser requests intentionally fail closed when this development origin is absent or differs by host, scheme, or port.

## ⚙️ Configuration

ContextSpace stores its config at `~/.contextspace/config.json` (fallback: `~/.nexusflow/config.json`):

```json
{
  "version": "0.1.0",
  "devDir": "~/dev",
  "workspacesDir": "~/dev/workspaces",
  "scanDepth": 2,
  "defaultAssistant": null
}
```

| Key | Default | Description |
|:---|:---|:---|
| `devDir` | `~/dev` | Root directory to scan for git repos |
| `workspacesDir` | `~/dev/workspaces` | Where feature workspaces are created |
| `scanDepth` | `2` | How many levels deep to scan for repos |
| `defaultAssistant` | `null` | Pre-select an assistant during workspace creation |

Run `ctxspace init` to interactively set these values.

## 🏗️ Architecture

```
ContextSpace/
├── src/
│   ├── index.ts              # CLI entry point (Commander.js)
│   ├── server.ts             # Hono API server (REST endpoints)
│   ├── types.ts              # Shared TypeScript interfaces
│   ├── commands/             # CLI command handlers
│   │   ├── create.ts         #   ctxspace create
│   │   ├── init.ts           #   ctxspace init
│   │   ├── list.ts           #   ctxspace list
│   │   ├── open.ts           #   ctxspace open
│   │   ├── start.ts          #   ctxspace start
│   │   ├── stop.ts           #   ctxspace stop
│   │   ├── status.ts         #   ctxspace status
│   │   ├── flow.ts           #   ctxspace flow (milestones & fleet radar)
│   │   ├── verify.ts         #   ctxspace verify (mechanical test gates)
│   │   ├── tag.ts            #   ctxspace tag / category (enterprise domains)
│   │   ├── skill.ts          #   ctxspace skill (portable skills)
│   │   ├── logs.ts           #   ctxspace logs
│   │   └── ui.ts             #   ctxspace ui
│   ├── core/                 # Core workspace logic
│   │   ├── constants.ts      #   Brand, manifest & lockfile constants
│   │   ├── config.ts         #   Config management (~/.contextspace/)
│   │   ├── domain-catalog.ts #   Enterprise catalog persistence & locks
│   │   ├── domain-packs.ts   #   Organization conventions, verticals & traits
│   │   ├── lifecycle.ts      #   Milestone state machine & fleet radar
│   │   ├── verify.ts         #   Sequential verification runner & SHA anchoring
│   │   ├── work-guidance.ts  #   Source docs & active AI assignments
│   │   ├── scanner.ts        #   Git repo scanner
│   │   ├── worktree.ts       #   Git worktree operations
│   │   └── workspace.ts      #   Workspace CRUD
│   ├── analyzers/            # Codebase analysis
│   │   ├── tech-stack.ts     #   Language/framework detection
│   │   ├── detect-ports.ts   #   Port & server detection
│   │   ├── detect-apis.ts    #   API endpoint scanning
│   │   ├── detect-deps.ts    #   Dependency analysis
│   │   ├── detect-existing.ts#   Existing AI config detection
│   │   └── readme-summarizer.ts# README content extraction
│   ├── generators/           # AI context file & skill generators
│   │   ├── base.ts           #   Shared context builder
│   │   ├── claude.ts         #   CLAUDE.md generator
│   │   ├── antigravity.ts    #   Antigravity AGENTS.md generator
│   │   ├── codex.ts          #   Codex AGENTS.md generator
│   │   ├── copilot.ts        #   copilot-instructions.md generator
│   │   ├── cursor.ts         #   contextspace.mdc generator
│   │   └── skills-generator.ts # Cross-harness skill deployment (.agents, .claude)
│   ├── orchestration/        # Service start/stop/log management
│   └── utils/                # Helper utilities
│       ├── skills-catalog.ts #   Skills & Categories catalog manager (~/.contextspace/)
│       ├── git.ts            #   Git operations
│       ├── detect-ai.ts      #   AI assistant detection
│       ├── detect-editors.ts #   Editor detection
│       ├── session-finder.ts #   AI session history discovery
│       └── prompts.ts        #   Interactive prompts
├── gui/                      # React + Vite Web Dashboard
│   └── src/
│       ├── pages/
│       │   ├── WorkspacesPage.tsx # Workspaces & launch targets
│       │   ├── StartWorkPage.tsx  # Interactive creation with skills & tags
│       │   ├── SkillsPage.tsx     # Skills & Agents categorized drag-and-drop hub
│       │   └── StrategiesPage.tsx # Teamwork strategy inspector
│       └── App.tsx           # Main application routing & layout
├── package.json
└── tsconfig.json
```


## 🤝 Contributing

Contributions are welcome! Here's how to get set up:

### Development Setup

```bash
# Clone the repo
git clone https://github.com/antan87/Context-Space.git
cd Context-Space

# Install all source dependencies
npm install
npm run setup

# Start the TypeScript compiler in watch mode
npm run dev

# In another terminal, start the GUI dev server
cd gui && npm run dev
```

### Build

```bash
# Full build (TypeScript + GUI)
npm run build

# Clean build artifacts
npm run clean
```

### Test

```bash
# Run tests
npm test

# Watch mode
npm run test:watch
```

### Code Style

- **TypeScript** — strict mode, ES modules
- **Imports** — use `.js` extensions for local imports (`import { x } from './config.js'`)
- **Node built-ins** — use the `node:` prefix (`import path from 'node:path'`)
- **JSDoc** — add doc comments to all exported functions
- **Error handling** — wrap external calls (git, filesystem) in try/catch

### Adding a New AI Assistant

1. Add the assistant identifier to the `AIAssistant` type in [types.ts](src/types.ts)
2. Add detection logic in [detect-ai.ts](src/utils/detect-ai.ts)
3. Create a new generator in `src/generators/` (follow the pattern in [claude.ts](src/generators/claude.ts))
4. Register it in the [generator index](src/generators/index.ts)
5. Add session discovery logic in [session-finder.ts](src/utils/session-finder.ts)

### Adding a New Analyzer

1. Create a new file in `src/analyzers/` following the existing patterns
2. Export the analyzer function and register it in [analyzers/index.ts](src/analyzers/index.ts)
3. The analyzer output is fed into the context generators and the `WORKSPACE.md` file

### Pull Request Guidelines

- Fork the repo and create a feature branch
- Write clear commit messages
- Add tests for new functionality
- Make sure `npm run build` passes before submitting
- Update documentation if you change user-facing behavior

## 📄 License

MIT — see [LICENSE](LICENSE) for details.
