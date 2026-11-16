import { Link } from 'react-router-dom';
import { Archive } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import type { Feature } from '../../types.js';

interface ArchivedNoticeProps {
  workspace: Feature;
  onRestore: () => void;
  restoring?: boolean;
}

function formatDate(value: string | undefined): string {
  if (!value) return 'an unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** One line above every section of an archived workspace: what it is and how to get it back. */
export function ArchivedNotice({ workspace, onRestore, restoring = false }: ArchivedNoticeProps) {
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-secondary/50 p-3 text-xs">
      <span className="flex items-center gap-2 text-foreground">
        <Archive size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <span>
          <strong className="font-semibold">Archived</strong> on {formatDate(workspace.archivedAt)}. Its record is read-only:
          sessions, services, commits and finishing are unavailable until you restore it.
        </span>
      </span>
      <Button size="xs" variant="outline" onClick={onRestore} disabled={restoring}>
        {restoring ? 'Restoring…' : 'Restore workspace'}
      </Button>
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  merged: 'Merged',
  parked: 'Parked (pushed, not merged)',
  reference: 'Reference, never edited here',
};

type ArchiveRecord = NonNullable<Feature['archive']>;

function RecordTable({ record, caption }: { record: ArchiveRecord; caption: string }) {
  if (record.repos.length === 0) return <p className="mt-3 text-xs text-muted-foreground">No repository record was kept for this archive.</p>;
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-xs">
        <caption className="pb-1 text-left text-xs font-semibold text-foreground">{caption}</caption>
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="py-1.5 pr-3 font-semibold">Repository</th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">Branch</th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">Final commit</th>
            <th scope="col" className="py-1.5 font-semibold">State</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {record.repos.map((repo) => (
            <tr key={repo.name}>
              <td className="py-2 pr-3 font-mono font-semibold text-foreground">{repo.name}</td>
              <td className="py-2 pr-3 font-mono">{repo.branch ?? (repo.access === 'reference' ? '—' : 'detached')}</td>
              <td className="py-2 pr-3 font-mono">{repo.headSha ? repo.headSha.slice(0, 10) : '—'}</td>
              <td className="py-2">
                {STATE_LABEL[repo.branchState] ?? repo.branchState}
                {repo.prUrl && <> · <a className="underline" href={repo.prUrl} target="_blank" rel="noreferrer">pull request</a></>}
                {repo.mergeEvidence === 'ancestor' && <span className="text-muted-foreground"> · in the default branch</span>}
                {repo.branchDeleted && <span className="text-muted-foreground"> · branch deleted{repo.remoteBranchDeleted ? ', also on origin' : ''}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The overview of an archived workspace: the delivery record that archive
 * kept, instead of live repository status that no longer applies. Every
 * earlier archive of the workspace stays listed, newest first.
 */
export function ArchivedWorkspaceView({ workspace }: { workspace: Feature }) {
  const base = `/workspaces/${encodeURIComponent(workspace.branchName)}`;
  const records = [workspace.archive, ...[...(workspace.archiveHistory ?? [])].reverse()].filter((record): record is ArchiveRecord => Boolean(record));

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="archived-record" className="rounded-xl border border-border bg-card p-5">
        <h3 id="archived-record" className="font-semibold">Delivery record</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The worktrees were returned and merged branches this workspace created were deleted; your own checkouts were not changed.
          Each final commit is listed, so the work can always be found again.
          {records.some((record) => record.parked) ? ' Some work was archived before it was merged; its branch was kept.' : ''}
        </p>
        {records.length === 0 && <p className="mt-3 text-xs text-muted-foreground">No repository record was kept for this archive.</p>}
        {records.map((record, index) => (
          <RecordTable
            key={record.archivedAt}
            record={record}
            caption={`${index === 0 ? 'Archived' : 'Earlier archive'} ${formatDate(record.archivedAt)}`}
          />
        ))}
      </section>

      <section aria-labelledby="archived-kept" className="rounded-xl border border-border bg-card p-5">
        <h3 id="archived-kept" className="font-semibold">What stays readable</h3>
        <ul className="mt-2 flex flex-wrap gap-2 text-sm">
          <li><Link className="underline" to={`${base}/board`}>Board and planning notes</Link></li>
          <li><Link className="underline" to={`${base}/documents`}>Documents</Link></li>
          <li><Link className="underline" to={`${base}/knowledge`}>Knowledge</Link></li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground font-mono break-all">{workspace.workspacePath}</p>
      </section>
    </div>
  );
}
