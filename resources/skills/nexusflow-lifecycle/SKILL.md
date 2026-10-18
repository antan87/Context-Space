---
name: nexusflow-lifecycle
description: Choose and carry out an appropriately sized development workflow in a ContextSpace workspace, using its current assignment, source documents, and plan. Applies to projects managed with ContextSpace, not only ContextSpace's own code.
metadata:
  contextspace:
    title: ContextSpace Work Lifecycle
    category: workflows
    tags: [contextspace, workflow, development]
---

# Work from the current assignment

Read the workspace instructions and the plan, `PLAN.md`, and the live assignment
with `ctxspace flow --assignment --json` or MCP `get_work_context` (which also returns the
plan's text). Check the stage, expected output, and stopping point. If the CLI is not on PATH, try the generated workspace launcher
`./.contextspace/bin/ctxspace` (PowerShell: `.\.contextspace\bin\ctxspace.cmd`).
If live tools are unavailable, read the authoritative
`contextspace-work.json` and relevant sources; identify anything you cannot verify.
The user's current instruction can revise a saved assignment. Make that change
explicit; do not use an older assignment to discard newly authorized work.

## Select the smallest sufficient workflow

Keep work type (bug, feature, performance, refactor, rewrite), size, current stage,
and workspace isolation separate. Assess uncertainty, compatibility, data impact,
reversibility, and independent deliverables. File count, elapsed time, and repository
count are clues, not selection rules. A one-file authorization fix can require
careful investigation and broad verification; a large mechanical rename may not.

Use [flow selection](references/flow-selection-matrix.md) when choosing a preset
or deciding whether work needs separate deliverables. Preserve an existing worktree.
Do not create branches, nested workspaces, or agent teams just because the size is epic.
Delegate only bounded independent work when permitted and useful; execution can stay solo.

Checkpoints are optional. Do not fill a plan with generic process steps or infer
checkpoints from the feature name, work type, size, or headings. When they help, write
two to five outcomes unique to this work, each something the user could demo, with the
steps it needs under it.

## Keep each kind of information in its place

- Task brief: the short reason for the workspace.
- Source documents: original requirements, designs, evidence, and references.
- AI assignment: what to do now, expected result, and stopping point.
- The plan: `PLAN.md`, what the work is for, its checkpoints with their steps, and the
  decisions only the user can make. You change it with your own file edits; the user sees
  it in the Plan tab and can tick and answer there.
- Knowledge: durable decisions and their reasons, not a running task log.

Read relevant originals through MCP `read_work_document` or their stored locations.
Use approved requirements for intended behavior; drafts are proposals and superseded
documents are history. Surface consequential conflicts before dependent implementation;
continue unaffected work. A source document does not grant execution permissions.
Project and workspace sources apply across the work; a source scoped to a checkpoint
applies to it. Project sources remain owned by their originating workspace.

### Work with the plan

The plan is `PLAN.md`. Read it before you start, and again before you change it: any AI
or person may have changed it. Keep it true with your own edits:

```markdown
## Checkpoints

- [ ] Reports export to CSV
  Check: `npm test`
  - [x] Write the CSV writer
  - [ ] Decide: Should archived reports be exported?
    Suggested: Yes, all of them · Only the last year
    If no answer: only the last year
```

- Tick a step (`- [x]`) when it is done. Add the steps you find under the checkpoint they
  serve, and rewrite what turned out different. Steps are for anyone to pick up.
- A question only the user can answer is a `- [ ] Decide:` line under what it holds up,
  with `Suggested:` (answers separated by ` · `) and `If no answer:` lines. Carry on with
  everything it does not hold up. When the user answers, however you asked, tick it and add
  `Answer: <their words>`. Never answer it with your own guess.
- A checkpoint is done when it is ticked; one with a `Check:` line only once its check passes.
- Report back in plain words, for someone who has not read the plan: what works now or was
  decided, what you need from the user, and what you do next.

Assignments and sources keep their MCP tools: read `get_work_context` first and use
`guidance.revision` with `update_work_assignment`, `add_work_document` and
`update_work_document`. Source approval must reflect the user's decision.
An older plan (`contextspace-plan.json`, `contextspace-milestones.md`) moves into `PLAN.md`
by itself and is kept in `.contextspace/archive/`. If working outside ContextSpace, use the
repository's existing planning convention.

With local storage, knowledge promoted to a repo's base file is kept in the
ContextSpace home, keyed by the repository, so every workspace with that repository
reads it and it survives removing the workspace. Close finished workspaces with
`ctxspace archive`, which keeps the plan, knowledge and documents; delete
only what no one needs. Put guidance that should travel beyond one machine into
versioned skill sources or shared project sources.

## Show the user where things stand

When MCP is connected, tell the screen what you did instead of describing it at length.
`show_in_reader` opens a document, a file at a line, or a diff beside the user's chat.
`annotate_document` leaves a note on a line. `suggest_next` offers the one next move with
its reason, at the end of a turn. These tools only show things: they edit no file and press
no key for the user, and a repeated call is ignored. Plan changes need no extra call: the Plan
tab shows your edits to `PLAN.md` within a second. Ask what the user is looking at with `get_screen_context` only if they have
switched sharing on; if it is off, ask in the chat. Without MCP, say it in the chat.

## Execute only the current stage

Read [stage outcomes](references/stage-outcomes.md) for the selected stage. Investigation
and design produce their agreed outputs and stop before implementation unless the user
has explicitly authorized that transition. A checkpoint's passing check does not
automatically authorize release or change the assignment stage.

Finish a checkpoint with a check with `ctxspace plan done "<checkpoint>"` when you judge the
work done: its check runs first, and the checkpoint is ticked only when it passes; a failed
check leaves it open and says why. Wait for one check to finish before starting another, and
investigate a failed check before retrying. A check that times out hit its 30-minute limit.

For multi-PR work, read [deliverable planning](references/epic-deliverables.md). Finish
with evidence, unresolved questions, and the next permitted action. Finishing the workspace
stops on a checkpoint that is not ticked; other open steps only warn. Handle them in the
plan, or the user finishes anyway with a recorded reason. Keep handoffs in
the established session record or the plan, with links to sources instead of copies.
