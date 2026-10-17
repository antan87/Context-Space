# Releasing ContextSpace

ContextSpace ships three artifacts from this one repository, all in **lockstep** on a
single version:

| Channel | Artifact | Published to |
| --- | --- | --- |
| npm | `@mrpatronz/nexusflow` (CLI + server + bundled GUI) | npm registry (deprecated; optional via `NPM_PUBLISHING_ENABLED`) |
| VS Code extension | `ContextSpace.vsix` (`contextspace.contextspace-vscode`) | GitHub Releases; optional VS Code Marketplace |
| Desktop | `ContextSpaceSetup.exe` (Windows NSIS), `ContextSpace-<version>.AppImage` (Linux), plus `latest.yml`/`latest-linux.yml` and `.sha256` sidecars | GitHub Releases |

ContextSpace is distributed primarily via GitHub Releases (desktop installers, release binaries, and installable VSIX).
The npm package is deprecated and optional: publishing to npm is skipped unless `NPM_PUBLISHING_ENABLED=true` is set.
Stable GitHub Releases include an installable VSIX even when Marketplace publishing is disabled.
The Marketplace channel is optional until its publishing variable and credentials are enabled.

## The one rule: version lives in the root `package.json`

The root [`package.json`](./package.json) `version` is the **single source of truth**.
[`scripts/sync-version.mjs`](./scripts/sync-version.mjs) propagates it to every other
version-bearing file:

- `extension/package.json`
- `desktop/package.json`
- `gui/package.json`

The desktop installer has no separate version target: electron-builder reads it
from `desktop/package.json` (already synced above).

CI runs `node scripts/sync-version.mjs --check` and **fails on any drift**.

## Releasing with one command

```bash
npm run release:ship                   # release whatever is unreleased on main
npm run release:ship -- --dry-run      # say what the next step would be; change nothing
npm run release:ship -- --bump minor   # choose the bump instead of inferring it
```

This is the normal way to release, for a person or an agent. It reads GitHub's own state, takes
the one next step, and repeats until the release is published and verified. Because it works from
that state and not from anything an agent remembers, several agents running it at once land on the
same step and join one release instead of each preparing their own.

What it does, in order:

1. **Stops if releases are paused** (see [The brake](#the-brake)) or a release run is already going,
   and waits for that run instead of racing it.
2. **Opens one release PR**, `chore: prepare release X.Y.Z`, on the branch `release/next`. The bump
   comes from the unreleased commits: `feat` is minor; `fix`, `perf` and `revert` are patch; docs,
   chores, tests and refactors do not release by themselves. A breaking change (`!` or a
   `BREAKING CHANGE:` footer) is never turned into a major release unless you pass `--bump major`.
   The branch is created only if nobody else has, so two agents cannot both open one.
3. **Merges it only if it is a plain version bump**: only the version files changed, only
   `"version"` lines changed, and the PR is the one it checked. It merges that exact commit
   (`--match-head-commit`). Anything else stops for a person.
4. **Waits for every required check on the tip of `main`**, then dispatches the release pinned to
   that commit. If `main` moves while it waits, it releases the newer tip, so a busy `main` does not
   make the pinned dispatch fail.
5. **Follows the run to the end**, then checks that the tag and the GitHub Release assets agree.

It resumes from whatever state it finds, so running it again after a timeout, a crash or a
failure continues instead of starting over. Exit codes: `0` released or nothing to release, `1`
failed or needs a person, `2` paused, `3` timed out while waiting (run it again).

It never approves a deployment, cancels a run, force-pushes, or edits repository settings. If the
`release` environment still lists required reviewers, the run waits for them and the command says so.

### Nightly release

[`nightly-release.yml`](./.github/workflows/nightly-release.yml) runs the same command every night at
03:00 UTC. It releases whatever is unreleased on `main`, with no approval step. A night with nothing
unreleased exits quietly. It needs the repository secret `RELEASE_TOKEN` (a personal access token with
contents, pull requests and Actions access), and it still stops for the same reasons as a manual release:
the brake, a failing required check, or a release PR that is not a plain version bump.

Its version bump comes from the unreleased commits, as with a manual release, so every merged `feat`
adds a minor version. Pass `--bump patch` in the workflow to keep nightly bumps to patches.

### The brake

Set the repository variable `RELEASES_PAUSED` to `true` to stop every release, whoever or whatever
asks for it. The workflow's guard refuses to publish and `release:ship` stops before changing anything.
Clear it to release again:

```bash
gh variable set RELEASES_PAUSED --body true   # pause
gh variable delete RELEASES_PAUSED            # resume
```

Only the owner should set or clear it; agents never do.

### When it stops for a person

| It says | Why | What to do |
| --- | --- | --- |
| paused | `RELEASES_PAUSED` is set | The owner clears it |
| a breaking change calls for a major release | `!` or `BREAKING CHANGE:` since the last tag | Run it again with `--bump major` if that is intended |
| required checks are not green | A check failed on the tip of `main` | Fix `main`, then run it again |
| release PR is not a plain version bump | Someone changed the PR | Look at it; close it and run again, or fix it |
| the branch `release/next` has no open PR | An agent died after pushing | Open a PR from it or delete the branch |

## The manual path

The command above automates the following; use it by hand only when the command cannot run.

### How to cut a release

The release workflow is dispatched explicitly from the protected default branch.
Do not push a hand-created tag: the workflow guard creates the immutable tag only
after it has verified the requested version and synchronized source files.

Start from a clean working tree. From a feature branch, bump and synchronize the
version without creating a local tag, then open and merge a reviewed PR through
the protected `main` branch:

```bash
npm version minor --no-git-tag-version   # or patch / major
git status                               # review the synchronized version files
git commit -m "chore: prepare release"   # version hook already staged the synced files
git push origin HEAD
```

After the PR is merged, wait until every required check (see [Publish gate](#publish-gate))
has succeeded on the merge commit, then dispatch the release using the exact version
in the merged `package.json` and **pin the commit you verified** with `expected_sha`.
Dispatch always loads the tip of `main`; if another PR merged after you verified, a
pinned release fails instead of shipping a commit you did not check. You can trigger
it either from GitHub Actions UI (**Actions** -> **Release** -> **Run workflow**,
entering the version and the SHA) or via `gh`:

```bash
VERSION=$(node -p "require('./package.json').version")
SHA=$(git rev-parse origin/main)   # the commit whose checks you verified
gh api "repos/antan87/Context-Space/dispatches" \
  -f event_type=release \
  -F "client_payload[version]=$VERSION" \
  -F "client_payload[expected_sha]=$SHA"
```

Or using `gh workflow run`:

```bash
VERSION=$(node -p "require('./package.json').version")
SHA=$(git rev-parse origin/main)   # the commit whose checks you verified
gh workflow run release.yml -f version=$VERSION -f expected_sha=$SHA
```

`expected_sha` is optional so existing dispatch commands keep working, but an
unpinned dispatch releases whatever `main` is at when the workflow starts.

The `npm version` command runs the `version` lifecycle script
(`sync-version.mjs && git add -A`), so all channel manifests are reviewed in the
same PR. The repository-dispatch event loads the workflow from protected `main`;
it does not rely on a tag push triggering workflow code from an unreviewed ref.

The [`release.yml`](./.github/workflows/release.yml) workflow then:

1. **`guard`** — rejects any ref other than `main`, verifies the source is on `main`,
   checks the requested version against `package.json`, runs the sync check, checks the
   pinned `expected_sha` (when given) and that the version is not lower than any existing
   release tag, requires every check in `.github/release-required-checks.json` to have
   succeeded on this exact SHA, and only then creates the immutable tag.
2. **`npm` / `vscode` / `desktop`** run in parallel. npm and Marketplace skip versions
   that are already published; desktop rebuilds its installers and metadata on each
   run. Stable releases always package the VSIX. npm publishing is optional and gated behind
   the repository variable `NPM_PUBLISHING_ENABLED=true`;
   Marketplace publishing runs only when
   the repository variable `VSCODE_PUBLISHING_ENABLED=true` and Azure OIDC credentials
   are present.
3. **`github-release`** — creates **one** GitHub Release for the tag with generated
   notes and attaches the stable-release VSIX, both desktop installers, their checksum sidecars, and the
   electron-updater metadata (`latest.yml` and `latest-linux.yml`). It then writes a
   channel-status table to the run summary.

Every job checks out the guard-approved SHA, and the jobs that hold publish
credentials (`npm`, `vscode`, `github-release`) run in the `release` environment.

## Publish gate

Nothing publishes unless every required check succeeded on the exact source SHA.
The guard fails closed: a required check that is missing, queued, in progress,
skipped, neutral, cancelled, failed, reported by an app other than GitHub Actions,
or recorded for a different SHA blocks the release. The same applies when GitHub's
check-run API cannot be read completely. When a check was re-run, its latest run decides.

The required checks are listed in
[`.github/release-required-checks.json`](./.github/release-required-checks.json):
every job in `ci.yml` and `security.yml`. `npm test` derives the expected names from
those workflows and fails when the list drifts, so a new CI job must be added
there (and to branch protection) in the same PR. Required jobs must not be
conditional, because a skipped required check would block every release.

If a required check fails, fix it on `main` and release the fixing commit; do not
re-dispatch against a commit you believe is flaky until its check is re-run green.

Check what the guard would decide, without publishing:

```bash
GH_TOKEN=$(gh auth token) node scripts/release-guard.mjs checks \
  --sha "$(git rev-parse origin/main)" --repo antan87/Context-Space
```

### Several releases at once

`npm run release:ship` is built for this: every agent that runs it converges on the same release PR and the same dispatch. The notes below describe the guard's own protections, which apply however a release is started.

Only one release runs at a time (the `release` concurrency group), and a run that is
waiting for approval in the `release` environment keeps the group. GitHub keeps at most
one pending run per group, so a newer pending dispatch silently cancels an older one.
Before dispatching, run the read-only preflight. It never dispatches, tags or approves
anything:

```bash
npm run release:preflight                      # the version main carries
npm run release:preflight -- --version 2.30.0  # or name it
npm run release:preflight -- --rerun           # only to finish a partial release
```

It prints `NO-GO` with every reason, or `GO` with the exact dispatch command pinned to the
commit it verified. It refuses when:

- a release run is queued, waiting, pending or in progress (it names the run);
- `main` does not carry the version yet, or the version is lower than an existing tag;
- the version is already released from this commit (use `--rerun` to finish a partial
  release, such as a Marketplace retry) or its tag sits on a different commit;
- a required check on the tip of `main` is not green. It reuses the publish gate's own
  decision, so the two cannot disagree.

Anything it cannot read is a `NO-GO`, not a guess. Dispatch only the command it prints,
and only with the owner's go-ahead for that release.

The preflight is a check, not a lock: two dispatches in the same instant can both pass it.
The pinned `expected_sha`, the single release lane and the idempotent tag step keep that
safe, because both runs release the same commit. When it happens, keep the run that started
first and cancel the one you dispatched, so the owner is asked to approve each gate once.

The guard enforces two rules that do not depend on anyone checking first:

- **Versions move forward.** A version lower than any existing `vX.Y.Z[-pre]` tag is
  refused, so a stale bump cannot publish after a newer release and move npm's `latest`
  back. The same version is allowed so a partial release can be re-run. There is no
  override; releasing a lower version (a backport) needs a pipeline change first.
- **The source is the commit you verified.** With `expected_sha`, a release fails when
  `main` has moved past it. Verify the new head and dispatch again.

### Owner-applied repository settings

The workflow cannot configure these itself. Apply and review them as the repository owner:

1. **Required status checks on `main`**: the same names as the JSON list, from the
   GitHub Actions app, so an unchecked commit cannot merge either:

   ```bash
   jq '{strict: false, checks: [.checks[] | {context: ., app_id: 15368}]}' \
     .github/release-required-checks.json |
     gh api -X PATCH repos/antan87/Context-Space/branches/main/protection/required_status_checks --input -
   ```

   (`15368` is the GitHub Actions app ID; confirm it with
   `gh api repos/antan87/Context-Space/commits/<sha>/check-runs --jq '.check_runs[0].app.id'`.)
2. **Include administrators** (`enforce_admins`) so direct pushes cannot skip those checks.
3. **`release` environment**: deployment branches limited to `main`. The branch policy is what
   stops a workflow edited on another branch from reaching the credentials; the guard's ref check
   only fails early. Required reviewers are the owner's choice:
   - **With reviewers** (the original setup), every release waits for the owner to approve each
     job that uses the environment, so agents have to hand the owner a click.
   - **Without reviewers**, a release runs unattended once the guard is satisfied: it dispatches
     only from `main`, every required check is green on that exact commit, the version moves
     forward, and `RELEASES_PAUSED` is not set. The owner's control is then the merge to `main`
     and the brake. To remove the reviewers and keep the branch policy:

     ```bash
     gh api -X PUT repos/antan87/Context-Space/environments/release --input - <<'JSON'
     {"reviewers": [], "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
     JSON
     ```

     Check the result with `gh api repos/antan87/Context-Space/environments/release`. Put the reviewer
     back with `{"reviewers": [{"type": "User", "id": <your user id>}], ...}` if you want the click again.
4. **Credentials bound to the environment**: set the npm trusted publisher's environment
   to `release`. If Marketplace publishing is enabled, give the Azure federated credential
   the subject `repo:antan87/Context-Space:environment:release`. Keep no long-lived publish
   tokens as repository secrets; any workflow run can read those.

### Emergency releases

There is no check bypass. For an urgent fix, the owner may merge the fix without
waiting for review, but the release still needs every required check green on
that exact commit and the owner's approval in the `release` environment. Both
are recorded in the run log.

### Channel status

An npm publish failure or VS Code Marketplace failure does not stop the desktop installers or the
GitHub Release. The channel is reported in the run summary. After fixing any credentials, re-run
the workflow: the tag, npm and Marketplace steps are idempotent for an already-published version.

## Version baseline

Lockstep versions must always move forward from the versions already published to
npm, the Marketplace, and GitHub Releases. Check the live channel versions before
choosing a bump; never lower the root `package.json` version and never bypass the
protected PR plus dispatch guard with a manual tag.

## Prereleases

Tags with a semver prerelease suffix (e.g. `v1.2.0-rc.1`):

- publish to npm under the `next` dist-tag (keeps `latest` stable),
- mark the GitHub Release as a prerelease,
- **skip** the Marketplace (it doesn't support semver prerelease suffixes).

Use these to rehearse the pipeline end-to-end before a real release.

## Required credentials

- npm trusted publishing is configured through the package/repository OIDC trust;
  the workflow requests `id-token: write` from the `release` environment and does
  not use an `NPM_TOKEN` secret.
- `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` — Azure OIDC for `vsce publish`, used only
  when the repository variable `VSCODE_PUBLISHING_ENABLED=true`.

## Local dry-run checks (no publishing)

```bash
node scripts/sync-version.mjs --check   # all channels agree with root
npm run build && npm pack --dry-run     # inspect the generated package contents
(cd extension && npx vsce package)      # produces a .vsix at the synced version

# On Windows, electron-builder produces the NSIS installer; on Linux it produces
# the AppImage. Both builds also emit electron-updater metadata:
npm run build --prefix desktop
```

## Explicit desktop bootstrap (mutating)

After the package and desktop release are published, bootstrap the matching native
desktop release from the installed CLI:

```bash
ctxspace desktop install
```

## Upgrade compatibility

Keep the published npm identity, legacy CLI alias, and desktop application ID stable.
The renamed desktop app reuses an existing NexusFlow profile when no ContextSpace
profile exists. On Linux, CLI installation updates an existing NexusFlow AppImage
and desktop entry in place; fresh installs use ContextSpace paths.

The Windows packaging job also downloads and verifies the published 2.9.0 installer,
installs it on a disposable runner, and upgrades it with the candidate installer.
It checks the existing install directory/uninstall registration, launches both
installed versions, and verifies profile, persistent browser data, workspace
configuration, and knowledge-file continuity. This check runs before the ordinary
packaged-app test so a fresh ContextSpace profile cannot mask a migration failure.
