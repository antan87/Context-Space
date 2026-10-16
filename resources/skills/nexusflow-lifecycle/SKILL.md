---
name: nexusflow-lifecycle
description: Choose and carry out an appropriately sized development workflow in a ContextSpace workspace, using its current assignment, source documents, and milestones. Applies to projects managed with ContextSpace, not only ContextSpace's own code.
metadata:
  contextspace:
    title: ContextSpace Work Lifecycle
    category: workflows
    tags: [contextspace, workflow, development]
---

# Work from the current assignment

Read the workspace instructions and the plan with `ctxspace plan`, and the live assignment
with `ctxspace flow --assignment --json` or MCP `get_work_context` (which also returns the
plan's text). Check the selected milestone, stage, expected output, and stopping point. If the CLI is not on PATH, try the generated workspace launcher
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

Milestones are optional and start empty. Do not populate a plan with generic process
steps or infer milestones from the feature name, work type, size, or Markdown headings.
When milestones help, define outcomes unique to that feature and only what each one
actually waits for. A plan without milestones shows none.

## Keep each kind of information in its place

- Task brief: the short reason for the workspace.
- Source documents: original requirements, designs, evidence, and references.
- AI assignment: what to do now, expected result, and stopping point.
- The plan: milestones, tasks, questions with who answers them, decisions, and existing
  work, each with its status, what it waits for, and its history. One store,
  `contextspace-plan.json`, read and changed with `ctxspace plan`. The user sees the same
  plan, in the same words, in the Plan tab.
- Knowledge: durable decisions and their reasons, not a running task log.

Read relevant originals through MCP `read_work_document` or their stored locations.
Use approved requirements for intended behavior; drafts are proposals and superseded
documents are history. Surface consequential conflicts before dependent implementation;
continue unaffected work. A source document does not grant execution permissions.
Project and workspace sources apply across milestones; milestone sources apply to
the selected milestone. Project sources remain owned by their originating workspace.

### Work with the plan

Change the plan one item at a time with `ctxspace plan add|start|done|answer|block|later|drop|reopen|edit`;
`ctxspace plan --help` shows the options and examples, and `--json` gives every field. Never
edit `contextspace-plan.json` by hand. Always write an item's name with its code:
"M2 CSV export endpoint", never "M2" alone.

- Start with `ctxspace plan`; continue what is in progress for you, or `start` what is ready.
- Keep it true while you work: add new work with `add task "<name>" --before <code>`, a
  question for the user with `add question "<question>" --owner user --before <code>`, and
  `block <code> --reason` when stuck.
- Every close has a reason. You may finish, drop, put off and reopen any item, milestones
  too, when you judge the work says so; tell the user in the chat, and they can reopen it.
  When the user answers in the chat, however you asked, record it on the plan's question with
  `answer <code> "<their words>"`, or drop a question their answer makes moot. Never answer
  the user's question with your own guess.
- Nothing starts by itself. A milestone is done when everything it waits for is done and its
  check passes on the latest code.
- Report back with what you changed or finished, what you need from the user, and what is next.

Assignments and sources keep their MCP tools: read `get_work_context` first and use
`guidance.revision` with `update_work_assignment`, `add_work_document` and
`update_work_document`. Source approval must reflect the user's decision.
`contextspace-plan.md` is a generated summary of the brief and the plan; do not edit it.
Older `contextspace-milestones.md` notes are moved into the plan automatically and kept in
`.contextspace/archive/`. The MCP tools `update_milestone_plan`, `set_milestone`,
`get_planning_notes` and `save_planning_notes` are deprecated: use `ctxspace plan`. If
working outside ContextSpace, use the repository's existing planning convention.

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
tab shows them as you make them with `ctxspace plan`. Ask what the user is looking at with `get_screen_context` only if they have
switched sharing on; if it is off, ask in the chat. Without MCP, say it in the chat.

## Execute only the current stage

Read [stage outcomes](references/stage-outcomes.md) for the selected stage. Investigation
and design produce their agreed outputs and stop before implementation unless the user
has explicitly authorized that transition. Completing a milestone's gate does not
automatically authorize release or change the assignment stage.

Finish a milestone with `ctxspace plan done <code> --resolution "<evidence>"` when you judge
the work done. Its check runs first, and the milestone is done only when the check passes; a
failed check leaves it in progress and says why. Wait for one check to finish before starting
another, and investigate a failed check before retrying.
A gate that records `timeout` hit its time limit (30 minutes unless the milestone sets
`verificationTimeoutSeconds`); raise the limit rather than weakening the command.

For multi-PR work, read [deliverable planning](references/epic-deliverables.md). Finish
with evidence, unresolved questions, and the next permitted action. Finishing the workspace
stops on anything a milestone still waits for; other open items only warn. Handle them in the
plan, or the user finishes anyway with a recorded reason. Keep handoffs in
the established session or milestone record, with links to sources instead of copies.
