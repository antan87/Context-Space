# Plan usable increments

Start from the user's outcomes. Where practical, a checkpoint should deliver a small
usable capability across the required layers. For invoice performance, examples are
measuring representative latency, improving one supported lookup path, and rolling
the change out with monitoring. A necessary infrastructure-only prerequisite is valid,
but name its consumer and acceptance criteria instead of claiming it is user-visible.

For each checkpoint in `PLAN.md`, write its outcome, acceptance criteria and a `Check:`
line, with the steps it needs under it; note dependencies, the intended branch/PR and
compatibility constraints in the lines under it. Include rollout and recovery details when
the change affects persistent data or deployed consumers. Branch labels in the plan are
intentions; verify actual branches and PRs separately.

Sequence only actual dependencies: put the checkpoints in the order they can ship.
Independent deliverables can proceed concurrently when isolation and ownership are clear.
Each mergeable increment must build and pass its applicable checks. For stacked PRs, write
the base branch and merge order; recheck dependent PRs after their base changes.

Keep a checkpoint's words stable while documents and assignments refer to it. When an
outcome is canceled, take it out of the plan and say why under the goal, or in the chat,
rather than ticking unimplemented behavior as delivered.

Before replanning, inventory existing work with repo, branch/PR/commit, status (merged, on
branch, or no change needed), and evidence, as a list in `PLAN.md` outside the checkpoints.
Write the remaining work as checkpoints and steps, and each open question as a
`- [ ] Decide:` line under the checkpoint it holds up. Mark a flag-only finding as such;
distinguish it from authorized implementation. Use applicable enabled skill templates for
explicitly requested PBI/spec drafts, save them as source documents, and name the
checkpoint they belong to. Enabling a skill does not generate or approve those documents
automatically.

Circular package dependencies can be valid service relationships. Write the release
sequence as checkpoints in order: build the changed producer against compatible published
clients, publish the package, then bump and verify consumers. Plan a compatible transition
for breaking contracts. Package topology alone cannot determine that sequence.
