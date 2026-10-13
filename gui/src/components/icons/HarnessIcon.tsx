import { BsOpenai } from 'react-icons/bs';
import { SiClaude, SiCursor, SiGithubcopilot } from 'react-icons/si';
import { Pi, TerminalSquare } from 'lucide-react';
import { AntigravityIcon } from './AntigravityIcon.js';

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

/** Logos identify the chosen tool; generic window/workspace actions stay neutral. */
export function HarnessIcon({ harness, className = 'size-4' }: { harness: string; className?: string }) {
  if (harness === 'antigravity') return <AntigravityIcon className={className} alt="" aria-hidden="true" />;
  const icons: Record<string, typeof BsOpenai> = { codex: BsOpenai, claude: SiClaude, copilot: SiGithubcopilot, cursor: SiCursor, pi: Pi };
  const Icon = icons[harness] ?? TerminalSquare;
  return <Icon className={className} aria-hidden="true" />;
}
