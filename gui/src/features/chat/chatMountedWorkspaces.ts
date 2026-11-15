/**
 * Keeps the most recently visited workspaces mounted in the DOM to avoid unbounded element growth
 * while allowing instant switching between active and recent workspaces without reattaching.
 */
export function computeMountedWorkspaces(
  openTabs: readonly string[],
  activeTab: string | null,
  splitTab: string | null,
  showSplit: boolean,
  previousMounted: readonly string[] = [],
  maxMounted: number = 2,
  runningWorkspaces: readonly string[] = [],
): string[] {
  const activeItems = [activeTab, showSplit ? splitTab : null].filter(
    (t): t is string => typeof t === 'string' && openTabs.includes(t),
  );

  // Active workspaces must always be mounted
  const result: string[] = [];
  for (const item of activeItems) {
    if (!result.includes(item)) {
      result.push(item);
    }
  }

  // Workspaces with active running sessions must also stay mounted so background tasks aren't killed or detached
  for (const ws of runningWorkspaces) {
    if (openTabs.includes(ws) && !result.includes(ws)) {
      result.push(ws);
    }
  }

  // Next, keep the most recently mounted inactive workspaces up to the capacity
  const effectiveMax = Math.max(activeItems.length + 1, maxMounted);
  for (const ws of previousMounted) {
    if (result.length >= effectiveMax) break;
    if (openTabs.includes(ws) && !result.includes(ws)) {
      result.push(ws);
    }
  }

  return result;
}
