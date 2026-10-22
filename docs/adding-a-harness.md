# Adding a harness

A harness is an AI coding tool the app can start, resume, offer for a workspace, and read skills from
(Claude Code, Codex, Antigravity, Copilot, Cursor, Pi). Everything the app needs to know about one is a
single entry in `HARNESSES` in `src/harnesses/registry.ts`. The assistant ids, the terminal targets, detection,
skill folders, instruction files, the config enum and `GET /api/harnesses` all derive from it.

## 1. The registry entry (required)

Add one entry under a new id (lowercase, it is also the value stored in `defaultAssistant` and in workspaces).
The object must satisfy `HarnessDefinition`, so a missing field is a compile error.

| Field | Meaning |
| --- | --- |
| `name` | How the tool is named in the app: "Built into Claude Code", terminal messages. |
| `setupName` | The label offered when choosing a workspace's assistants. |
| `binary` | The program that starts an interactive session. Also probed on PATH by detection. |
| `detectBinary` | Only when the tool is offered because a different program is installed (Cursor: `cursor`, launched through `cursor-agent`). |
| `terminalBinaries` | Only when the embedded terminal should try several names, in order. |
| `resumeArgs(id)` | Arguments that resume a saved session. Embedded-terminal resume accepts UUID session ids only. |
| `continueArgs` | Arguments that continue the latest session (`[]` if the tool cannot). |
| `promptArgs(text)` | Arguments that start a session with a first message. Leave out if the tool cannot. |
| `history` | `true` when saved sessions can be listed. Needs a reader, see step 2. |
| `skills.workspaceFolder` | The folder inside a workspace the tool reads skills from: `.agents/skills` or `.claude/skills`. |
| `skills.globalRoots` | Folders the tool loads skills from in every workspace (`~/` is the home directory). Skills there are shown as "Built into <name>" and never copied. `[]` if none is known. |
| `skills.maxDepth` | Optional. Levels below a root searched for `SKILL.md` (default 3). |
| `instructions` | `{ outputFile }` if the tool needs its own instruction file (step 4), `null` if it reads `AGENTS.md`. |
| `mcp` | `true` if `core/agent-mcp.ts` registers the ContextSpace MCP server with the tool (step 3). |
| `defaultForNewWorkspaces` | `true` to include the tool in workspaces the MCP create tool makes without an explicit choice. |

The registry order is the order tools are listed, and the order that decides which "Built into" copy is shown
when two tools ship a skill with the same id.

What this alone gives you:

- the tool appears in `ai-detect`, in the embedded terminal, in resume commands and in `ctxspace doctor`;
- it is a valid `defaultAssistant`, a valid assistant in `generateContextFiles`, and its workspace skill folder is written
  by the materializer, checked by the generation lock and listed by `listInstalledSkillIds`;
- its global skill folders are listed as built-in skills, and the skills tab's "Who sees what" names it;
- `GET /api/harnesses` returns it, and the GUI names it from that response when it has no short name of its own.

A skill folder other than the two above needs its own entry in `SKILL_FOLDER_ADAPTERS` (the lock adapter id is
written to workspaces, so it must never change) and a matching adapter in `src/resources/contracts.ts`.

## 2. Saved sessions (only if `history: true`)

Implement `SessionReader` (list sessions, check for any, read a transcript) in its own module and register it in
`MODULAR_SESSION_READERS` in `src/utils/session-readers.ts`. The type of that map comes from the registry, so a
history harness without a reader fails the build. Return `AISession` records with the tool's real session id and
`recordedCwd`; the terminal API checks that cwd against the workspace before it resumes. The GUI asks
`/api/session-sources` and loads each source on its own.

The Antigravity, Claude, Codex, Copilot and workspace readers still live in `session-finder.ts`.

## 3. MCP registration (only if `mcp: true`)

Add one target to `TARGETS` in `src/core/agent-mcp.ts`: the config file, how to read the servers in it, and how to
add ours. `name` and `binary` come from the registry. `agent-mcp.test.ts` fails if the targets and the registry's
`mcp` flags disagree.

## 4. Instruction file (only if `instructions` is not `null`)

Write the generator in `src/generators/<id>.ts` and add it to `GENERATORS` in `src/generators/index.ts`. That map is
typed from the registry, so an instruction file without a generator, or the reverse, does not compile. The file it
writes is the `outputFile` you declared. Tools that read `AGENTS.md` need nothing.

## 5. Icon (optional)

Add the logo to `gui/src/components/icons/HarnessIcon.tsx`; without one the tool gets the generic terminal icon.
A short display name goes in `gui/src/components/icons/harnessNames.ts`; without one the GUI uses the registry
name (minus a trailing "(binary)") wherever the component has the `/api/harnesses` data.

## 6. Tests

```
npx vitest run src/harnesses src/utils/detect-ai.test.ts src/utils/harness-skill-sources.test.ts \
  src/core/agent-mcp.test.ts src/generators src/resources
npm run build:backend
cd gui && npx tsc -b
```

`src/harnesses/registry.test.ts` checks that every entry is complete. Add a case there only if the new tool needs
something the existing checks do not cover, and a reader test (workspace matching, malformed history, launch args)
if it has history.

## Not derived from the registry

These still name harnesses directly. Check them when the new tool should appear there:

- `src/core/workspace-tools.ts`: the workspace-level MCP config files (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.codex/config.toml`).
- `src/resources/materializer.ts`: Codex custom agents (`.codex/agents`) are Codex-only.
- `src/utils/session-finder.ts`: the legacy session readers and how a session's tool is told apart.
- `src/analyzers/detect-existing.ts`: existing instruction files found in a repo.
- `src/utils/workspace-launch.ts`, `src/server.ts` (update commands, desktop transfer checks), `src/utils/update-check.ts`, `src/core/perf-counters.ts`, `src/agent/`: desktop apps, updates, usage accounting and the in-app agent providers.
- GUI: per-tool pickers and labels in `SessionHistory.tsx`, `TranscriptDialog.tsx`, `SettingsPage.tsx`, `WorkspaceLauncher.tsx`, `WorkspaceWorkroomTab.tsx`, `toolPrefs.ts`, `progressView.ts`, `ExternalDiffLauncher.ts`, and the `AIAssistant` union in `gui/src/types.ts`.
