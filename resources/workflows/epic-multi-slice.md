# Team Strategy: Epic & Multi-PR Slices

Deliver large changes as independently reviewable outcomes with explicit dependencies.

1. Read the current assignment and approved project and workspace sources.
   Name usable increments where practical, rather than automatically splitting
   schema, API, and UI into separate PRs. For a required infrastructure prerequisite,
   identify its consumer and acceptance criteria.
2. In `PLAN.md`, write each outcome as a checkpoint with its acceptance criteria, a
   `Check:` line, its steps, and the intended branch/PR and compatibility requirements
   in the lines under it. Branch labels do not create branches or PRs automatically.
3. Sequence actual dependencies. Independent increments may proceed concurrently
   with clear ownership and isolation. Each mergeable increment must build and pass
   applicable gates; recheck dependent PRs when their base changes.
4. Keep original contracts in source documents, durable decisions with reasons in
   knowledge, and progress in the plan. Handoffs link those records and include
   the tested revision, outstanding issues, and next permitted action.
5. Respect the current stage and stopping point. Add migration, rollout, and recovery
   evidence when the change affects stored data or deployed consumers. Verify the
   current PR head and checks before reporting readiness; release requires authorization.
