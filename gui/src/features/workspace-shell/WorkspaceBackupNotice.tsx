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
      className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-2 py-0.5 font-mono text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={copied ? `Copied: ${command}` : `Copy command: ${command}`}
    >
      {command}
      {copied ? <Check aria-hidden="true" size={12} /> : <Copy aria-hidden="true" size={12} />}
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
    <div role="status" aria-label="Backup" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm sm:px-6">
      <HardDrive aria-hidden="true" size={16} className="shrink-0 text-amber-600" />
      <p className="min-w-0 flex-1 basis-64">
        <strong className="font-semibold">Not backed up.</strong> {data.summary}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <CommandButton command={`${CLI_NAME} remote add <git-url>`} />
        <span aria-hidden="true" className="text-muted-foreground">then</span>
        <CommandButton command={`${CLI_NAME} remote push`} />
        <button
          type="button"
          onClick={() => { rememberDismissed(workspaceId); setDismissed(true); }}
          className="ml-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
