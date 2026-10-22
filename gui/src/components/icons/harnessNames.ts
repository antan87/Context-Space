/** The short names of the tools the app knows, by id and by the longer labels the API sends. */
const CLEAN_NAMES: Record<string, string> = {
  codex: 'Codex',
  antigravity: 'Antigravity',
  'antigravity (agy)': 'Antigravity',
  claude: 'Claude Code',
  'claude code': 'Claude Code',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor Agent',
  pi: 'Pi',
  shell: 'Shell',
};

const withoutParenthetical = (name: string) => name.replace(/\s*\([^)]*\)$/, '').trim();

/**
 * A readable name for a harness id or label. `known` is the registry from `/api/harnesses`:
 * where a component has it, a harness this file has not heard of is named from it, not by its raw id.
 */
export const harnessName = (id: string, known?: ReadonlyArray<{ id: string; name: string }>) => {
  if (!id) return '';
  const key = id.toLowerCase().trim();
  if (CLEAN_NAMES[key]) return CLEAN_NAMES[key];
  const stripped = key.replace(/\s*\([^)]*\)$/, '');
  if (CLEAN_NAMES[stripped]) return CLEAN_NAMES[stripped];
  const registered = known?.find((harness) => harness.id === key)?.name;
  if (registered) return withoutParenthetical(registered) || registered;
  return withoutParenthetical(id) || id;
};
