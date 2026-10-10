/**
 * Which AI tools this person starts, so the last-used one is a single click and the most-used ones are pinned. Kept on
 * this device only; storage that is unavailable just means no preference.
 */

const KEY = 'contextspace.session-tools';
/** The order for a tool nobody has started yet. */
const DEFAULT_ORDER = ['claude', 'codex', 'antigravity', 'pi', 'copilot', 'cursor'];
export const PINNED_TOOLS = 4;

export interface ToolUse { last?: string; counts: Record<string, number> }

export function readToolUse(): ToolUse {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Partial<ToolUse>;
    const counts = parsed.counts && typeof parsed.counts === 'object' ? parsed.counts : {};
    return { ...(typeof parsed.last === 'string' ? { last: parsed.last } : {}), counts };
  } catch {
    return { counts: {} };
  }
}

export function rememberToolStarted(tool: string): ToolUse {
  const use = readToolUse();
  const next = { last: tool, counts: { ...use.counts, [tool]: (use.counts[tool] ?? 0) + 1 } };
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not remembered */ }
  return next;
}

/** The available tools, most used first, then in the default order. The shell is not an AI tool. */
export function rankTools(available: string[], use: ToolUse): string[] {
  const tools = available.filter((id) => id !== 'shell');
  const rank = (id: string) => DEFAULT_ORDER.indexOf(id) < 0 ? DEFAULT_ORDER.length : DEFAULT_ORDER.indexOf(id);
  return [...tools].sort((a, b) => (use.counts[b] ?? 0) - (use.counts[a] ?? 0) || rank(a) - rank(b) || a.localeCompare(b));
}

/** The tool New session starts: the last one used while it is available, else the first ranked. */
export function defaultTool(available: string[], use: ToolUse): string | undefined {
  const ranked = rankTools(available, use);
  return use.last && ranked.includes(use.last) ? use.last : ranked[0];
}

/** The first message of a session started on a plan item: what to work on, and to read the plan first. */
export function firstMessageFor(item: { id: string; label: string; status: string }): string {
  const start = item.status === 'in_progress' ? '' : ` If it is not started yet, start it with \`ctxspace plan start ${item.id}\`.`;
  return `Work on ${item.label}. Read the plan with \`ctxspace plan\` first.${start}`;
}
