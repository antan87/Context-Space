import { useState } from 'react';
import { Check, Copy, GitBranch } from 'lucide-react';
import { CLI_NAME } from '../../brand.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { useWorkspaceRepositories } from '../../lib/api/queries.js';
import { branchDrifts, switchBackCommand, type BranchDrift } from '../worktrees/branchDrift.js';

// Keyed by workspace, repository and the branch it is on now, so a different switch is flagged again.
const dismissedKey = (workspaceId: string, drift: BranchDrift) =>
  `${CLI_NAME}.branch-notice-dismissed.${workspaceId}.${drift.repoName}.${drift.actual ?? 'detached'}`;

// Browser storage can be missing, blocked or full; a notice must still render without it.
function wasDismissed(workspaceId: string, drift: BranchDrift): boolean {
  try { return window.localStorage.getItem(dismissedKey(workspaceId, drift)) === '1'; } catch { return false; }
}
function rememberDismissed(workspaceId: string, drift: BranchDrift): void {
  try { window.localStorage.setItem(dismissedKey(workspaceId, drift), '1'); } catch { /* it just comes back next time */ }
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
      className="inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-background px-2 py-0.5 font-mono text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={copied ? `Copied: ${command}` : `Copy command: ${command}`}
    >
      <span className="truncate">{command}</span>
      {copied ? <Check aria-hidden="true" size={12} className="shrink-0" /> : <Copy aria-hidden="true" size={12} className="shrink-0" />}
    </button>
  );
}

/**
 * Says so when a workspace's folder is on a different branch than the one the workspace edits on, which
 * makes the editor show another branch's files without a word. It may be deliberate, so it only describes
 * what it sees and shows how to switch back; it never switches anything. "Dismiss" is remembered for that
 * repository and branch in this browser.
 */
export function BranchDriftNotice({ workspaceId }: { workspaceId: string }) {
  const { data } = useWorkspaceRepositories(workspaceId);
  const [, setVersion] = useState(0);
  const drifts = branchDrifts(data).filter((drift) => !wasDismissed(workspaceId, drift));
  if (drifts.length === 0) return null;

  return (
    <div role="status" aria-label="Branch" className="border-b border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm sm:px-6">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <GitBranch aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <ul className="min-w-0 flex-1 basis-64 space-y-1.5">
          {drifts.map((drift) => (
            <li key={drift.repoName} className="space-y-1">
              <p>
                <strong className="font-semibold">Branch changed.</strong>{' '}
                <span className="font-mono">{drift.repoName}</span> is on{' '}
                {drift.actual ? <>branch <span className="font-mono">{drift.actual}</span></> : 'a detached HEAD'}, but this workspace edits on{' '}
                <span className="font-mono">{drift.expected}</span>.{' '}
                {drift.actual
                  ? <>The files you see there belong to <span className="font-mono">{drift.actual}</span>.</>
                  : 'The files you see there are not on any branch.'}
              </p>
              <CommandButton command={switchBackCommand(drift)} />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => { drifts.forEach((drift) => rememberDismissed(workspaceId, drift)); setVersion((v) => v + 1); }}
          className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
