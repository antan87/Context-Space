# NexusFlow Repository Guidance

This file contains codebase-stable instructions only. The active feature goal,
workspace scope, and sequencing live in the workspace-level `../AGENTS.md` and
take precedence for feature decisions. Do not copy a feature plan into this
repository file; doing so leaves stale guidance on later feature branches.

## Architecture

- `src/index.ts` wires the CLI; keep command handlers thin.
- `src/core/` owns workspace, Git, persistence, and orchestration behavior.
- `src/generators/` renders assistant-facing workspace artifacts.
- `src/core/storage.ts` is the port for workspace/base knowledge persistence;
  do not bypass it for documents owned by a storage adapter.
- `src/resources/` owns transactional skill and agent materialization.
- Preserve the worktree isolation model and never edit another checkout of a
  repository when the active workspace supplies a dedicated worktree.

## Generated and Durable State

- `AGENTS.md` at a generated workspace root is the canonical assistant context;
  its derived views must remain stamped and reproducible.
- Treat generated views and lockfiles as owned artifacts. Change their source or
  generator, then regenerate, instead of editing a derived view directly.
- Knowledge entries retain the 300-character body limit and must remain
  searchable, adapter-routed, and recoverable when Git persistence fails.
- Keep volatile repository state in live status/progress commands or a
  provenance-checked mechanical snapshot, not unchecked generated prose.

## Verification

- Run `npm test` for repository verification.
- Run `npm run build:backend` when TypeScript, CLI, server, or generated-resource
  code changes.
- Add negative and recovery-path tests for Git, storage-adapter, concurrency,
  and generated-context changes.
- Preserve unrelated working-tree changes and use explicit pathspecs for Git
  staging or commits.

## UI

- UI comes from `gui/src/design` (read its README); no text below 12 px, no raw palette colours or hex in components.

## Releasing

- Release with `npm run release:ship` (details in `RELEASING.md`). It does the whole
  path from GitHub's own state: version-bump PR, merge, pinned dispatch, verification.
  Several agents can run it at once and join one release instead of racing.
  `--dry-run` shows the next step and changes nothing.
- An instruction to release a change authorizes running it for that change. Do not ask
  for each PR or dispatch. Stop and ask only when it stops: a breaking change that needs
  `--bump major`, a failing check, a paused repository, or a release PR that is not a
  plain version bump.
- Never dispatch a version that already has a release run, tag or GitHub Release,
  and never approve or cancel another run's `release` environment gate (the command
  approves nothing). Never change release settings or the `RELEASES_PAUSED` variable:
  it is the owner's brake. `npm run release:preflight` remains the read-only manual check.
