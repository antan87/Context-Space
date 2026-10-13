import { useState } from 'react';
import { Check, Copy, HardDrive } from 'lucide-react';
import { CLI_NAME } from '../../brand.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { useWorkspaceBackup } from '../../lib/api/queries.js';

const dismissedKey = (workspaceId: string) => `${CLI_NAME}.backup-notice-dismissed.${workspaceId}`;

// Browser storage can be missing, blocked or full; a notice must still render without it.
function wasDismissed(workspaceId: string): boolean {
  try { return window.localStorage.getItem(dismissedKey(workspaceId)) === '1'; } catch { return false; }
}
function rememberDismissed(workspaceId: string): void {
  try { window.localStorage.setItem(dismissedKey(workspaceId), '1'); } catch { /* it just comes back next time */ }
}

function CommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await safeCopyToClipboard(command)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-background/80 px-2 py-0.5 font-mono text-xs text-foreground shadow-2xs transition-colors hover:border-amber-500/60 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={copied ? `Copied: ${command}` : `Copy command: ${command}`}
    >
      <span>{command}</span>
      {copied ? <Check aria-hidden="true" size={12} className="text-emerald-600 dark:text-emerald-400" /> : <Copy aria-hidden="true" size={12} className="text-muted-foreground" />}
    </button>
  );
}

/**
 * Says so when notes a person wrote here exist only on this computer, and shows the two commands
 * that fix it. It cannot run them: the server has no way to add a remote or push, on purpose.
 * Hidden when there is a remote, when nothing hand-written needs keeping, or after "Dismiss"
 * (remembered per workspace in this browser; `doctor` keeps reporting it).
 */
export function WorkspaceBackupNotice({ workspaceId }: { workspaceId: string }) {
  const { data } = useWorkspaceBackup(workspaceId);
  const [dismissed, setDismissed] = useState(() => wasDismissed(workspaceId));
  if (!data?.atRisk || !data.summary || dismissed) return null;

  return (
    <div role="status" aria-label="Backup" className="border-b border-amber-500/20 bg-amber-500/[0.06] dark:bg-amber-950/25 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-200/90 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-2">
          <HardDrive aria-hidden="true" size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="min-w-0 text-xs text-amber-900 dark:text-amber-200/90 leading-relaxed">
            <strong className="font-semibold text-amber-950 dark:text-amber-300">Not backed up.</strong> {data.summary}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <CommandButton command={`${CLI_NAME} remote add <git-url>`} />
          <span aria-hidden="true" className="text-xs text-amber-950 dark:text-amber-200 font-medium">then</span>
          <CommandButton command={`${CLI_NAME} remote push`} />
          <button
            type="button"
            onClick={() => { rememberDismissed(workspaceId); setDismissed(true); }}
            className="ml-1.5 rounded-md px-2 py-0.5 text-xs text-amber-950 dark:text-amber-200 hover:bg-amber-500/10 hover:text-amber-950 dark:hover:text-amber-100 transition-colors focus-visible:outline-2 focus-visible:outline-ring font-medium"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
