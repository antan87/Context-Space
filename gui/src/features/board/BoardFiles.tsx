import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api/client.js';

export interface IndexFile { path: string; repo?: { name: string; path: string }; document: boolean }
type Listing = { changes: Array<{ repoName: string; repoPath: string; files: Array<{ file: string; type: string }>; error?: string }> };
type WorkspaceFiles = { files: Array<{ path: string }>; truncated: boolean; errors: string[] };
const DOCUMENT = /\.(?:md|markdown|mdx|txt|rst|adoc|csv|tsv|log|svg|mmd|html?|png|jpe?g|gif|webp|pdf|docx?|odt|rtf|xlsx?|ods|pptx?|odp)$/i;
const LIMIT = 200;

/** A snapshot requested only while Files is visible, never a background poll. */
export function BoardFiles({ workspaceId, workspacePath, enabled, query, onOpen }: { workspaceId: string; workspacePath?: string; enabled: boolean; query: string; onOpen: (file: IndexFile, button: HTMLElement) => void }) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ files: IndexFile[]; errors: string[]; loading: boolean }>({ files: [], errors: [], loading: true });
  const loaded = useRef('');
  useEffect(() => {
    const key = JSON.stringify([workspaceId, workspacePath, version]);
    if (!enabled || loaded.current === key) return;
    const controller = new AbortController();
    setState({ files: [], errors: [], loading: true });
    const base = `/api/workspace/${encodeURIComponent(workspaceId)}`;
    void Promise.allSettled([
      apiFetch<Listing>(`${base}/changes?include=all`, { signal: controller.signal }),
      apiFetch<WorkspaceFiles>(`${base}/files`, { signal: controller.signal }),
    ]).then(([repos, workspace]) => {
      if (controller.signal.aborted) return;
      const errors: string[] = [];
      const listings = repos.status === 'fulfilled' ? repos.value.changes : [];
      if (repos.status === 'rejected') errors.push('Repository files could not be loaded.');
      if (workspace.status === 'rejected') errors.push('Workspace files could not be loaded.');
      else {
        errors.push(...workspace.value.errors);
        if (workspace.value.truncated) errors.push('Workspace listing is limited by scan depth or entry count. Refine the folder contents to find more files.');
      }
      const files: IndexFile[] = [];
      if (workspace.status === 'fulfilled') for (const file of workspace.value.files) {
        files.push({ path: file.path, document: DOCUMENT.test(file.path) });
      }
      for (const repo of listings) {
        if (repo.error) errors.push(`${repo.repoName}: ${repo.error}`);
        for (const file of repo.files) if (file.type !== 'deleted') files.push({ path: file.file, repo: { name: repo.repoName, path: repo.repoPath }, document: DOCUMENT.test(file.file) });
      }
      loaded.current = key;
      setState({ files, errors, loading: false });
    });
    return () => controller.abort();
  }, [workspaceId, workspacePath, version, enabled]);
  const needle = query.trim().toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  const matches = state.files.filter((file) => {
    const text = `${file.path} ${file.repo?.name ?? 'Workspace'}`.toLowerCase();
    return tokens.every((token) => text.includes(token));
  });
  return <div className="space-y-2 p-2 text-xs">
    <p className="text-muted-foreground">Workspace documents and repository files. Workspace code and configuration are included. Hidden and ignored folders are excluded; scans are limited to 5 folder levels and 10,000 entries.</p>
    <button type="button" className="rounded border px-2 py-1" onClick={() => setVersion((n) => n + 1)}>{state.errors.length ? 'Retry' : 'Refresh'}</button>
    {state.loading && <p role="status">Loading files…</p>}
    {state.errors.map((error) => <p role="alert" key={error} className="text-destructive">{error}</p>)}
    {!state.loading && state.errors.length > 0 && state.files.length > 0 && <p>Partial results</p>}
    {!state.loading && matches.length === 0 && <p>{needle ? 'No matches found' : 'No files found'}</p>}
    {matches.length > LIMIT && <p>Showing {LIMIT} of {matches.length} matches. Refine your search.</p>}
    <ul>{matches.slice(0, LIMIT).map((file) => <li key={`${file.repo?.name ?? ''}:${file.path}`}><button type="button" className="w-full rounded p-1.5 text-left hover:bg-muted" onClick={(event) => onOpen(file, event.currentTarget)}><span className="block break-all font-medium">{file.path}</span><span className="text-muted-foreground">{file.repo ? `Repository · ${file.repo.name}` : 'Workspace'}</span></button></li>)}</ul>
  </div>;
}
