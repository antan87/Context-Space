import { useState, type ReactNode } from 'react';
import { Check, Copy, GitBranch, HardDrive } from 'lucide-react';
import { CLI_NAME } from '../../brand.js';
import { Button } from '../../components/ui/button.js';
import { Popover, PopoverPopup, PopoverTrigger } from '../../components/ui/popover.js';
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

/** A small mark in the header with a dot, whose detail opens on demand instead of a banner pushing the content down. */
function Mark({ label, icon, title, children }: { label: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label} title={label}
        className="relative grid size-7 cursor-pointer place-items-center rounded-md text-[var(--state-needs)] transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        {icon}
        <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--state-needs)]" />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[min(26rem,calc(100vw-2rem))]">
        <section aria-label={title} className="space-y-2 text-sm">
          <h3 className="font-semibold">{title}</h3>
          {children}
        </section>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * When notes a person wrote here exist only on this computer, and the two commands that fix it. The server
 * cannot run them: it has no way to add a remote or push, on purpose. Hidden when there is a remote, when
 * nothing hand-written needs keeping, or once dismissed (remembered per workspace; `doctor` keeps reporting it).
 */
function BackupMark({ workspaceId }: { workspaceId: string }) {
  const { data } = useWorkspaceBackup(workspaceId);
  const [dismissed, setDismissed] = useState(() => wasDismissed(backupKey(workspaceId)));
  if (!data?.atRisk || !data.summary || dismissed) return null;
  return (
    <Mark label="Not backed up: show how to fix it" icon={<HardDrive aria-hidden="true" className="size-4" />} title="Not backed up">
      <p className="text-muted-foreground">{data.summary}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <CommandButton command={`${CLI_NAME} remote add <git-url>`} />
        <span aria-hidden="true" className="text-xs text-muted-foreground">then</span>
        <CommandButton command={`${CLI_NAME} remote push`} />
      </div>
      <Button size="xs" variant="ghost" onClick={() => { rememberDismissed(backupKey(workspaceId)); setDismissed(true); }}>Dismiss</Button>
    </Mark>
  );
}

/**
 * When a workspace's folder is on another branch than the one it edits on, which makes the editor show another
 * branch's files without a word. It may be deliberate, so it only describes what it sees and how to switch back.
 */
function BranchMark({ workspaceId }: { workspaceId: string }) {
  const { data } = useWorkspaceRepositories(workspaceId);
  const [, setVersion] = useState(0);
  const drifts = branchDrifts(data).filter((drift) => !wasDismissed(branchKey(workspaceId, drift)));
  if (drifts.length === 0) return null;
  return (
    <Mark label="Branch changed: show the detail" icon={<GitBranch aria-hidden="true" className="size-4" />} title="Branch changed">
      <ul className="space-y-2">
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
      </ul>
      <Button size="xs" variant="ghost" onClick={() => { drifts.forEach((drift) => rememberDismissed(branchKey(workspaceId, drift))); setVersion((value) => value + 1); }}>Dismiss</Button>
    </Mark>
  );
}

/** The workspace's warnings as marks in its header, each with its detail one click away. */
export function WorkspaceMarks({ workspaceId }: { workspaceId: string }) {
  return <>
    <BackupMark workspaceId={workspaceId} />
    <BranchMark workspaceId={workspaceId} />
  </>;
}
