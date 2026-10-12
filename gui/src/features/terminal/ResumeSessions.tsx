import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { History, RefreshCw, ArrowRight } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';
import { SessionActivity } from '../sessions/SessionActivity.js';
import { SessionKind, mainSessionFor } from '../sessions/SessionKind.js';
import { SessionUsageDetails } from './SessionUsage.js';
import type { AISession } from '../../types.js';
import type { TerminalStatus } from './client.js';
import { useWorkspaceSessionSources } from './useWorkspaceSessionSources.js';
import { perfMark } from '../../lib/perfMarks.js';

export function matchesResumeSession(s: AISession, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const ast = s.assistant?.toLowerCase() ?? '';
  const vendorAliases = ast === 'antigravity'
    ? 'google antigravity agy'
    : ast === 'claude'
    ? 'claude code anthropic'
    : ast === 'codex'
    ? 'openai codex'
    : ast === 'copilot'
    ? 'github copilot microsoft'
    : ast;
  const hay = `${s.title ?? ''} ${harnessName(s.assistant)} ${s.assistant} ${vendorAliases} ${s.id}`.toLowerCase();
  return hay.includes(q);
}

/**
 * The saved conversations of a workspace, newest first, each one click from continuing. `embedded` is the start screen's
 * form: under the tool buttons, with no frame of its own and no "start new" button, since the tools are right above.
 */
export function ResumeSessions({ workspace, active, busy, status, fill, embedded = false, onStartNew, onResume }: { workspace: string; active: boolean; busy: boolean; status: TerminalStatus | null; fill: boolean; embedded?: boolean; onStartNew: () => void; onResume: (session: AISession) => void }) {
  const [search, setSearch] = useState('');
  const [includeChildren, setIncludeChildren] = useState(false);
  // Each source resolves independently so slow CLI history cannot hold up the rest.
  const { histories, sessions, sourcesChecked, sourcesPending, sourcesFailed, sourceCount } = useWorkspaceSessionSources(workspace, active);
  const settled = active && sourceCount > 0 && sourcesPending === 0;
  const firstArrived = active && sourcesChecked > 0;
  useEffect(() => { if (firstArrived) perfMark('cs:sessions-first', { workspace }); }, [firstArrived, workspace]);
  useEffect(() => {
    if (settled) perfMark('cs:sessions-settled', { workspace, sources: sourceCount, failed: sourcesFailed });
  }, [settled, workspace, sourceCount, sourcesFailed]);
  const children = sessions.filter(s => s.threadKind === 'subagent').length;
  const visible = sessions.filter(s => (includeChildren || s.threadKind !== 'subagent') && matchesResumeSession(s, search))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return <section aria-label="Continue a conversation" className={`min-h-0 overflow-auto ${embedded ? 'px-4 pb-4 pt-2' : 'border-b border-border bg-card p-3'} ${fill ? 'flex-1' : 'max-h-[45%]'}`}>
    <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-1.5 text-xs font-semibold"><History className="size-3.5 text-muted-foreground" />{embedded ? 'Or continue a saved conversation' : 'Continue a conversation'}</h3><span className="flex items-center gap-1">{embedded && <Link to={`/workspaces/${encodeURIComponent(workspace)}/sessions`} title="Every conversation, with its transcript and token use, beside the chat" className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Full history</Link>}<Button size="xs" variant="ghost" aria-label="Refresh saved sessions" onClick={() => { for (const history of histories) void history.refetch(); }}><RefreshCw className="size-3" /></Button></span></div>
    {!embedded && <p className="mt-1 text-xs text-muted-foreground">Choose a saved conversation. It opens in the CLI tool that created it.</p>}
    {includeChildren && <p className="mt-1 text-[11px] text-muted-foreground">Subagents are delegated tasks. Continue their main conversation to pick up your work.</p>}
    <div className="my-2 flex flex-wrap items-center gap-2"><input aria-label="Search saved sessions" placeholder="Search conversations or harnesses" className="min-w-40 flex-1 rounded border border-border bg-background px-2 py-1 text-xs" value={search} onChange={e => setSearch(e.target.value)} /><label className="flex items-center gap-1 text-[11px] text-muted-foreground"><input type="checkbox" checked={includeChildren} onChange={e => setIncludeChildren(e.target.checked)} />Include subagent sessions{children > 0 ? ` (${children})` : ''}</label></div>
    {active && sourcesPending > 0 && <p role="status" className="py-2 text-xs text-muted-foreground">Loading saved conversations… {sourceCount > 0 ? `${sourcesChecked} of ${sourceCount} sources checked.` : 'Finding session sources.'} Results appear as they arrive.</p>}
    {sourcesFailed > 0 && <p role="alert" className="py-2 text-xs text-destructive">Could not load {sourcesFailed} {sourcesFailed === 1 ? 'source' : 'sources'}. Other conversations are shown; use Refresh to retry.</p>}
    {sourcesPending === 0 && sourcesFailed === 0 && visible.length === 0 && <div className="space-y-2 py-3"><p className="text-xs text-muted-foreground">{search.trim() ? 'No matching conversations.' : children && !includeChildren ? 'Only subagent sessions were found. Include them to inspect their parent links.' : 'No saved conversations found for this workspace.'}</p>{!search.trim() && !embedded && <Button size="xs" variant="outline" onClick={onStartNew}>Start a new session</Button>}</div>}
    <div className="max-h-72 divide-y divide-border">
      {visible.map(session => {
        const main = mainSessionFor(session, sessions);
        const tool = status?.targets.find(t => t.id === session.assistant);
        const available = !!status?.available && !!tool?.available;
        return <div key={`${session.assistant}:${session.id}`} className="flex items-center gap-2 py-2" data-testid="resume-session-row">
          <HarnessIcon harness={session.assistant} className="size-5 shrink-0" />
          <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium" title={session.title}>{session.title}</div><div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground"><span>{harnessName(session.assistant)}</span><SessionKind session={session} /><SessionActivity session={session} /><span>{session.messageCount} messages</span><span className="font-mono">{session.id.slice(0, 8)}</span></div><SessionUsageDetails session={session} />{status && !available && <p className="text-[10px] text-warning">{tool?.reason || status.reason || `${harnessName(session.assistant)} is unavailable on this device.`}</p>}{!main && <p className="text-[10px] text-warning">Main conversation unavailable in saved history.</p>}</div>
          <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-foreground" disabled={busy || !available || !main} title={!main ? 'Continue the main conversation from the harness' : !available ? 'Install this harness, then refresh the harness list' : `Continue ${main.title} in ${harnessName(main.assistant)}`} onClick={() => main && onResume(main)}><ArrowRight className="size-3" />{session.threadKind === 'subagent' ? 'Main thread' : 'Continue'}</Button>
        </div>;
      })}
    </div>
  </section>;
}
