# Plan usable increments

Start from the user's outcomes. Where practical, a milestone should deliver a small
usable capability across the required layers. For invoice performance, examples are
measuring representative latency, improving one supported lookup path, and rolling
the change out with monitoring. A necessary infrastructure-only prerequisite is valid,
but name its consumer and acceptance criteria instead of claiming it is user-visible.

For each milestone, capture its outcome, acceptance criteria, dependencies, intended
branch/PR, compatibility constraints, and verification evidence. Include rollout and
recovery details when the change affects persistent data or deployed consumers.
Branch labels in the plan are intentions; verify actual branches and PRs separately.

Sequence only actual dependencies. Independent deliverables can proceed concurrently
when isolation and ownership are clear. Each mergeable increment must build and pass
its applicable gates. For stacked PRs, record the base branch and merge order; recheck
dependent PRs after their base changes.

Preserve milestone codes referenced by documents and assignments. Nothing in the plan is
deleted: drop a canceled outcome with `ctxspace plan drop <code> --reason`, or move it with
`later`, rather than marking unimplemented behavior as delivered, and tell the user why in
the chat.

Before replanning, inventory existing work with repo, branch/PR/commit, status
(merged, on branch, or no change needed), and evidence: `ctxspace plan add existing "<name>"`,
then close it with what was found. Add the remaining work as tasks or milestones, and each
open question with `add question --owner <who answers> --before <code it holds up>`, so what
it blocks is a wait, not a note. Record a flag-only finding as a decision closed with
"Flag only"; distinguish it from authorized implementation. Use applicable enabled skill
templates for explicitly requested PBI/spec drafts, save them as source documents, and link
them to milestone codes.
Enabling a skill does not generate or approve those documents automatically.

Circular package dependencies can be valid service relationships. Record the release
sequence as milestones that wait for each other: build the changed producer against
compatible published clients, publish the package, then bump and verify consumers. Plan a
compatible transition for breaking contracts. Package topology alone cannot determine that
sequence; what milestones wait for must still form an executable plan without circles, and
`ctxspace plan` refuses a circle.
