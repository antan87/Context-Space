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

export const harnessName = (id: string) => {
  if (!id) return '';
  const key = id.toLowerCase().trim();
  if (CLEAN_NAMES[key]) return CLEAN_NAMES[key];
  const stripped = key.replace(/\s*\([^)]*\)$/, '');
  if (CLEAN_NAMES[stripped]) return CLEAN_NAMES[stripped];
  const strippedOrig = id.replace(/\s*\([^)]*\)$/, '').trim();
  return strippedOrig || id;
};
