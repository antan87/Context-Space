/**
 * CLI capabilities shared by terminal launch and saved-session discovery.
 * The harnesses themselves are declared in `src/harnesses/registry.ts`; these are the names callers already import.
 * See docs/adding-a-harness.md for how to add one.
 */
export {
  HARNESSES as CLI_HARNESSES,
  SESSION_SOURCES,
  harnessPromptArgs,
  isHarnessId as isCliHarnessId,
} from '../harnesses/registry.js';
export type { HarnessId as CliHarnessId, SessionSource } from '../harnesses/registry.js';
