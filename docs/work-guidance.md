# Documents, assignments, and the plan

A workspace opens on its **Plan** tab: the goal, the plan, and the sources, with the
AI sessions one click away beside them. These serve different purposes:

| Information | Where it belongs |
| --- | --- |
| Short reason for the workspace | Task brief |
| Product requirements, designs, measurements, background | Source documents |
| What the AI should do now and where it should stop | AI assignment (the goal) |
| Milestones, tasks, questions, decisions and existing work, with their status and history | The plan |
| Decisions and lessons discovered during development | Knowledge |

Avoid copying an entire product specification into the brief, plan, and knowledge.
Keep the original as a source and record only the additional information each needs.

## Add a product owner's document

Under **Source documents**, upload Markdown or plain text, paste text, or add an
HTTP(S) link. Text uploads support `.md`, `.markdown`, and `.txt`, up to 500 KB.
Use links for PDF, Word, or online documents; this version does not extract their
contents or fetch links automatically.

Give each document a title and choose:

- **Role:** requirements, design, evidence, or reference.
- **Status:** draft (the default), approved, or superseded.
- **Scope:** the whole workspace, a particular milestone, or the entire registered project.

An optional owner summary highlights relevant details without replacing the
original. Editing labels preserves uploaded text. For a revised source, add the
new document and supersede the old one. Superseded sources remain readable as
history while their owning workspace exists, but are excluded from AI assignments.

Project sources are shared by reference across workspaces attached to the same
registered project. Add them to a stable project or epic workspace and edit them
there. They are stored with that workspace, not in a separate project library.
Workspace deletion refuses to remove active project sources. To retire the owner,
copy sources to another project workspace if still needed, then supersede the originals.

## Direct the current work

Set **work type**, **size**, and **current stage** independently:

- Type describes the change: bug, feature, performance, refactor, or rewrite.
- Size describes its scope: small task, standard change, or epic.
- Stage describes today's assignment: investigate, design, implement, verify, review, or release.

Changing type or size does not reset progress or replace milestones.

State the current objective, expected output, and stopping point. Select a milestone
when the assignment concerns only that deliverable. Workspace and project sources
remain relevant; milestone sources are included only for the selected milestone.
Investigation and design assignments explicitly stop before implementation.
Stages guide the AI; they are not an execution sandbox or an automatic approval system.

For example, a performance rewrite can begin with an investigation assignment:
“Measure invoice lookup latency; return a baseline and likely causes; stop before
changing code.” Later, advance the assignment to design and then implementation.
The same sources and milestone progress remain available throughout.

### Unsaved edits are kept

Edits to the goal are kept on this device as you type, so switching sections, leaving
the workspace or reloading the app does not lose them. The state next to **Save** reads
Saved, Unsaved, Saving or Conflict. Saving or **Discard unsaved … changes** removes the
kept draft; unread drafts expire after 30 days. A half-filled **Add document** form is
kept only until the window closes, because pasted source text may be sensitive. If the
browser blocks or fills its storage, the page says the draft was not kept.

A kept draft remembers the saved version it started from. If someone saved a newer
version meanwhile, edits to fields they did not change are combined with it and shown
as unsaved. Edits to a field they also changed open a choice (**Keep my edits** or
**Use the saved version**); nothing is applied, and the editing controls stay
locked, until you pick.

## The plan

The plan holds the milestones, the tasks, the questions with who answers them, the
decisions, and the work that already exists. It is one store, `contextspace-plan.json`,
committed with the workspace. You change it in the Plan tab; AI tools change it with
`ctxspace plan`. Both use the same items and the same words.

| Status | Means |
| --- | --- |
| To do | Not started yet. |
| In progress | Someone is working on it, and it says who. |
| Blocked | Stuck, and it always says why. |
| Done | Finished, with what came out of it or the answer. |
| Dropped | Not needed any more, with why. |
| Later | Not now, with when to look again. |

**Needs you** is not a status: it collects the questions waiting for your answer and
the AI's proposals waiting for your OK. The rules:

1. Every close has a reason. Nothing is deleted.
2. The AI closes only its own items. For your items, and for milestones, it asks: you
   see it under Needs you, and accept it or send it back with what still needs doing.
3. A milestone is done when everything it waits for is done and its check passes on the
   latest code. Closing a milestone, or accepting an AI's "done" on one, runs its check.
4. Nothing starts by itself. When a milestone is done, the next one is suggested.
5. Plans change: anyone can add, move, block or reopen an item at any time. Each item
   keeps its history: who did what, and when.
6. Before the workspace is finished, everything a milestone waits for must be handled.
   Other open items only warn. Finishing anyway needs a reason.

Every item has a code and a name, "M2 CSV export endpoint"; the name always comes first.
A row in the Plan tab opens the item: what it must deliver, what it waits for and holds
up, its check and the last result, where the work is, and its history. **How it works**
shows the statuses and rules again. Branch labels describe the intended work; they do not
create branches or PRs.

### Start a session from the plan

With no session running, a **Start a session** card sits beside the plan: pick a tool and
what to work on, then **Start**. A ready item has its own **Start**, which starts your
last-used tool on it. A session started on an item begins with a first message that names
it and tells the AI to read the plan with `ctxspace plan` (Claude Code, Codex, Pi and agy
take it; Copilot and Cursor start without it); the AI then marks the item started itself,
so the history names the tool. Running sessions show as tabs beside **Plan**, named after
the item they work on, and **Continue where you left off** resumes a saved conversation.
`/chat` and `/sessions` still open the sessions directly.

## Give an AI the current context

Save the assignment, then use **Copy AI assignment**, or run:

```sh
ctxspace flow --assignment
ctxspace flow --assignment --json
```

AI tools read the plan with `ctxspace plan` and change it one item at a time with
`ctxspace plan add|start|done|answer|block|later|drop|reopen|edit` (`--help` shows how,
`--json` gives every field). The generated `AGENTS.md` gives them the rules and a short
work routine. MCP clients can call `get_work_context`, which also returns the plan as
`ctxspace plan` prints it, then `read_work_document` using document IDs in the assignment. Read originals before relying on summaries. Approved
requirements establish intended behavior; drafts are proposals. Conflicting
sources should be surfaced to the owner.

### Planning through MCP

AIs change the plan only with `ctxspace plan`; there are no MCP plan tools. The
`interactive`, `developer`, and `full` MCP roles can edit the assignment and sources.
The `readonly`, `review`, and `ci` roles can read them but cannot edit them.
Reconnect an already running MCP server after upgrading to discover new tools.

- `get_work_context` returns `guidance` (including the assignment, documents, and
  revision), the milestones as `lifecycle`, `plan` as `ctxspace plan` prints it,
  shared project sources, and the rendered assignment.
- `update_work_assignment` accepts `guidance.revision`, `workType`, `size`, and
  the complete `assignment`. Omit `milestoneId` to use workspace scope. Saving a
  stage is not authorization to exceed the user's requested scope.
- `add_work_document` accepts `guidance.revision`, `title`, `role`, optional
  `status`/`scope`/`summary`, and exactly one of `content` or `url`. New documents
  default to draft. Links are stored without fetching their contents.
- `update_work_document` accepts `guidance.revision`, `documentId`, and the full
  document metadata. It preserves original text and URLs. Use `scope: {}` for
  workspace scope and `status: "superseded"` to retain a source as history.
- `update_milestone_plan`, `set_milestone`, `get_planning_notes` and
  `save_planning_notes` still work for one release; their descriptions and results
  name the `ctxspace plan` command that replaces them.

All writes reject stale revisions. Reread and merge after a conflict rather than
retrying an old replacement. Write results return the new revision. Workroom
completion proposals still use the separate Workroom approval flow.

For maintainers, `npm run build:backend` followed by
`node scripts/smoke-mcp-planning.mjs` checks actual stdio discovery, planning edits,
the plan text, read-only denials, and conflict recovery in temporary workspaces
without model calls.

`contextspace-work.json` is the authoritative assignment and document index.
Original text and metadata use the configured workspace storage adapter.
`contextspace-plan.md` is a generated summary of the goal and the plan, rewritten after
every change; do not edit it. Prefer live CLI/MCP reads. Run `ctxspace refresh` to
update generated context in older workspaces. Generated context is not a second place to
edit the assignment or the plan.

## Older planning files

Workspaces from before the plan kept authored notes in `contextspace-milestones.md` and a
copy of the assignment in `contextspace-assignment.md`. The first refresh or `ctxspace plan`
command moves the notes into the plan, once and safely repeatable:

- outcome rows add detail and waits to their milestones, or become new milestones;
- open questions, existing work, and flagged or deferred decisions become questions,
  existing items and decisions, with their owner, status and what they hold up;
- rows that cannot be read and any other text become one question for you, "Is anything
  in the notes kept from contextspace-milestones.md still needed?", so nothing is lost.

The file is kept in `.contextspace/archive/` for one release and committed there.
`contextspace-assignment.md` is no longer written; refresh removes it.

Circular *package* dependencies can be legitimate, but what milestones wait for cannot
form a circle. Record a release order (producer build, package publication, consumer
version bumps) as milestones that wait for each other, including compatibility
transitions for breaking contracts.

For skill-based PBI generation, select the applicable skill and make the assignment
explicit, for example: “Use the enabled PBI template; inventory existing work, draft
one work item per remaining milestone, link its evidence, and stop before code.”
Store generated work items as draft source documents. Skills provide procedures;
enabling one does not run it or make its output approved.

Knowledge already supports typed `decision`, `question`, and `gotcha` entries,
rendered with their type labels. Use knowledge for compact reasons and lessons;
use the plan for questions with their owner, status and answer.

## Finish the workspace

Finishing checks the latest verification of every editable repository, and the plan:
anything a milestone still waits for, directly or through what that waits for, stops
finishing, and so does an AI's close still waiting for your OK. Other open items only
warn; items for later count as handled. The finish panel lists both. Handle them in the
plan, or choose **Finish anyway, with a reason**; the reason is recorded with the finish.

## Access tools from a desktop-created workspace

If `ctxspace` is not on PATH, use the generated workspace launcher with the same
arguments. From the workspace root:

```sh
./.contextspace/bin/ctxspace flow --assignment
./.contextspace/bin/ctxspace isolate <repo>
```

In PowerShell use `.\.contextspace\bin\ctxspace.cmd`. These launchers use the
installed runtime and CLI, including desktop's bundled Electron-as-Node runtime;
they do not download a package. Refresh after moving or upgrading the installation.
The launcher creates no global PATH entry. Host repositories remain read-only until
isolated; tool access is not permission to bypass that rule.

MCP configurations are generated for selected assistants: Claude's `.mcp.json`,
Cursor's `.cursor/mcp.json`, Copilot's `.vscode/mcp.json` and `.mcp.json`, and Codex's
`.codex/config.toml`. Other MCP servers/settings are retained. Trust the workspace
in the assistant to enable its interactive tools. Antigravity uses user-level MCP
configuration; configure it there or use the local CLI launcher.

## Diagnose workspace skills

The Skills tab includes workspace-local packages in selection validation and shows
invalid-package, missing-global-source, and duplicate-ID diagnostics. A valid local
package takes precedence over the same global ID. A workspace package labeled
`scope: global` requires its source in the global catalog; restore that source or
correct the scope if it is an authored local skill.

Explicit selection controls deployment; deselecting a local skill removes its
managed Claude copy. Authored `.agents/skills` files are preserved, so assistants
that discover this folder directly may still see them. Move an authored skill out
of that discovery folder if it must be unavailable to those assistants. General
and uncategorized skills are grouped together in the UI. Agent selection currently
uses the global agent catalog; it has no workspace-local agent catalog.
