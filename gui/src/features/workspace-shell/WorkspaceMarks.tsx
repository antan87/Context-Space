import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { CLI_NAME } from '../../brand.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from '../../components/ui/dialog.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { useWorkspaceBackup, useWorkspaceRepositories } from '../../lib/api/queries.js';
import { branchDrifts, switchBackCommand, type BranchDrift } from '../worktrees/branchDrift.js';

// Browser storage can be missing, blocked or full; a mark must still render without it.
function wasDismissed(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}
function rememberDismissed(key: string): void {
  try { window.localStorage.setItem(key, '1'); } catch { /* it just comes back next time */ }
}
const backupKey = (workspaceId: string) => `${CLI_NAME}.backup-notice-dismissed.${workspaceId}`;
// Keyed by workspace, repository and the branch it is on now, so a different switch is flagged again.
const branchKey = (workspaceId: string, drift: BranchDrift) => `${CLI_NAME}.branch-notice-dismissed.${workspaceId}.${drift.repoName}.${drift.actual ?? 'detached'}`;

function CommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { if (await safeCopyToClipboard(command)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 font-mono text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={copied ? `Copied: ${command}` : `Copy command: ${command}`}
    >
      <span className="truncate">{command}</span>
      {copied ? <Check aria-hidden="true" size={12} className="shrink-0" /> : <Copy aria-hidden="true" size={12} className="shrink-0 text-muted-foreground" />}
    </button>
  );
}

export interface WorkspaceWarning {
  id: string;
  /** The menu line, which says what is wrong and that there is a way to fix it. */
  label: string;
  title: string;
  detail: ReactNode;
}

/**
 * The workspace's warnings that need action. They show as a dot on the header's menu and a line in it, and the
 * line opens the detail. Nothing here appears while a warning is dismissed (remembered per workspace).
 *
 * - Backup: notes a person wrote exist only on this computer, and two commands fix it. The server cannot run them:
 *   it has no way to add a remote or push, on purpose. `doctor` keeps reporting it after a dismissal.
 * - Branch: a workspace's folder is on another branch than the one it edits on, which makes the editor show another
 *   branch's files without a word. It may be deliberate, so it only describes what it sees and how to switch back.
 */
export function useWorkspaceWarnings(workspaceId: string, enabled: boolean): { warnings: WorkspaceWarning[]; dismiss: (id: string) => void } {
  const backup = useWorkspaceBackup(workspaceId).data;
  const repositories = useWorkspaceRepositories(enabled ? workspaceId : null).data;
  const [, setVersion] = useState(0);
  const [backupDismissed, setBackupDismissed] = useState(() => wasDismissed(backupKey(workspaceId)));
  const warnings: WorkspaceWarning[] = [];
  if (enabled && backup?.atRisk && backup.summary && !backupDismissed) {
    warnings.push({
      id: 'backup',
      label: 'Not backed up: show how to fix it',
      title: 'Not backed up',
      detail: <>
        <p className="text-muted-foreground">{backup.summary}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <CommandButton command={`${CLI_NAME} remote add <git-url>`} />
          <span aria-hidden="true" className="text-xs text-muted-foreground">then</span>
          <CommandButton command={`${CLI_NAME} remote push`} />
        </div>
      </>,
    });
  }
  const drifts = enabled ? branchDrifts(repositories).filter((drift) => !wasDismissed(branchKey(workspaceId, drift))) : [];
  if (drifts.length > 0) {
    warnings.push({
      id: 'branch',
      label: 'Branch changed: show the detail',
      title: 'Branch changed',
      detail: <ul className="space-y-2">
        {drifts.map((drift) => (
          <li key={drift.repoName} className="space-y-1">
            <p>
              <span className="font-mono">{drift.repoName}</span> is on{' '}
              {drift.actual ? <>branch <span className="font-mono">{drift.actual}</span></> : 'a detached HEAD'}, but this workspace edits on{' '}
              <span className="font-mono">{drift.expected}</span>.{' '}
              {drift.actual ? <>The files you see there belong to <span className="font-mono">{drift.actual}</span>.</> : 'The files you see there are not on any branch.'}
            </p>
            <CommandButton command={switchBackCommand(drift)} />
          </li>
        ))}
      </ul>,
    });
  }
  const dismiss = (id: string) => {
    if (id === 'backup') { rememberDismissed(backupKey(workspaceId)); setBackupDismissed(true); return; }
    drifts.forEach((drift) => rememberDismissed(branchKey(workspaceId, drift)));
    setVersion((value) => value + 1);
  };
  return { warnings, dismiss };
}

/** One warning's detail, opened from its line in the header menu. */
export function WarningDialog({ warning, onClose, onDismiss }: { warning: WorkspaceWarning | null; onClose: () => void; onDismiss: (id: string) => void }) {
  return (
    <Dialog open={Boolean(warning)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {warning && <DialogPopup className="max-w-md" showCloseButton={false}>
        <section aria-label={warning.title} className="space-y-3 p-5 text-sm">
          <DialogHeader className="p-0"><DialogTitle className="text-base">{warning.title}</DialogTitle></DialogHeader>
          {warning.detail}
          <div className="flex gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => { onDismiss(warning.id); onClose(); }}>Dismiss</Button>
            <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </section>
      </DialogPopup>}
    </Dialog>
  );
}
