import { BsOpenai } from 'react-icons/bs';
import { SiClaude, SiCursor, SiGithubcopilot } from 'react-icons/si';
import { Pi, TerminalSquare } from 'lucide-react';
import { AntigravityIcon } from './AntigravityIcon.js';
import { harnessName } from './harnessNames.js';

export { harnessName };

/** Logos identify the chosen tool; generic window/workspace actions stay neutral. */
export function HarnessIcon({ harness, className = 'size-4' }: { harness: string; className?: string }) {
  if (harness === 'antigravity') return <AntigravityIcon className={className} alt="" aria-hidden="true" />;
  const icons: Record<string, typeof BsOpenai> = { codex: BsOpenai, claude: SiClaude, copilot: SiGithubcopilot, cursor: SiCursor, pi: Pi };
  const Icon = icons[harness] ?? TerminalSquare;
  return <Icon className={className} aria-hidden="true" />;
}
