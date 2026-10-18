# Adding a CLI harness

CLI chat uses a capability catalog in `src/utils/cli-harnesses.ts`. Add the
harness ID, display name, binary, resume arguments, and continue arguments
there. Add `terminalBinaries` only when the embedded terminal should look for
alternate executable names. The terminal target list, launch
validation, and external terminal command use that registration. A harness
can launch without a saved-session reader (`history: false`).

For saved conversations, implement the `SessionReader` interface in a provider
module and register it once in `src/utils/session-readers.ts`. Its three
operations list sessions, check for any workspace sessions, and read a
transcript. Set `history: true` in the catalog after registration. The type of
the reader registry is derived from the catalog, so adding another history
source without a reader fails the backend build. The GUI requests
`/api/session-sources` and loads each source independently. It has no source
array of its own. Existing Antigravity, Claude, Codex, Copilot, and workspace
readers still live in `session-finder.ts`; new readers use separate modules.

Return `AISession` records with the provider's real session ID and
`recordedCwd`. The terminal API checks that cwd against the workspace before
direct resume. Embedded terminal resume currently accepts UUID session IDs;
another ID format needs a targeted validation change and test.

Add the harness icon and name in `gui/src/components/icons/HarnessIcon.tsx`.
Overview, session history, terminal selection, and the workspace sidebar use
that component. Add a fallback icon only when the harness has no distinct
asset. GUI tests should cover progressive loading and direct resume; backend
tests should cover workspace matching, malformed history, and launch args.

Workspace setup assistants and resource adapters are separate capabilities. A
CLI harness need not implement them. Extend `AIAssistant`, detection, or
resources only when that integration is actually supported.

| Capability | Owning code |
| --- | --- |
| CLI start and resume commands | `cli-harnesses.ts` |
| Saved history, activity, and transcripts | Provider reader + `session-readers.ts` |
| GUI name and icon | `HarnessIcon.tsx` |
| Workspace context and resource generation | `AIAssistant`, detection, resource adapters |

Keep these capabilities independent. A new CLI tool should appear in terminal
selection as soon as its executable is supported; saved history can be added
later without changing the terminal contract.
