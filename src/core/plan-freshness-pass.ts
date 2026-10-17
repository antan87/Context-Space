/**
 * @module core/plan-freshness-pass
 * The backend's pass over every active workspace's plan, shortly after it starts and then once a day: it withdraws
 * the questions nobody needs answered any more (core/plan-freshness), whichever tool left them behind, so they are
 * gone before anyone opens the Overview.
 */

import { loadConfig } from './config.js';
import { freshenPlan } from './plan.js';
import { listWorkspaces } from './workspace.js';

export const FRESHNESS_FIRST_DELAY_MS = 30_000;
export const FRESHNESS_INTERVAL_MS = 24 * 60 * 60_000;

/** Withdraws stale questions in every active workspace and returns how many. A plan that cannot be read is left as it is. */
export async function freshenAllPlans(workspacesDir: string): Promise<number> {
  let withdrawn = 0;
  for (const workspace of (await listWorkspaces(workspacesDir)).filter((candidate) => !candidate.archivedAt)) {
    try {
      withdrawn += (await freshenPlan(workspace.workspacePath)).length;
    } catch {
      // A damaged or busy plan is for its own workspace to report.
    }
  }
  return withdrawn;
}

/** Starts the pass; the returned function stops it. Its timers never keep the process alive. */
export function startPlanFreshness(options: { log?: (message: string) => void } = {}): () => void {
  const run = async () => {
    try {
      const withdrawn = await freshenAllPlans((await loadConfig()).workspacesDir);
      if (withdrawn > 0) options.log?.(`withdrew ${withdrawn} question${withdrawn === 1 ? '' : 's'} nobody needs answered any more`);
    } catch (error) {
      options.log?.(`could not check the plans: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const first = setTimeout(() => void run(), FRESHNESS_FIRST_DELAY_MS);
  const daily = setInterval(() => void run(), FRESHNESS_INTERVAL_MS);
  first.unref?.();
  daily.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
