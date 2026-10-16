import { Link } from 'react-router-dom';
import { CircleDashed, CircleHelp, CircleX, ListChecks, MessageCircleQuestion, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { whenText, whoName } from '../plan/planView.js';
import { aiClosedLately, needItems, useNeedsYou, type NeedItem } from './needsYou.js';

const PROPOSAL_WORDS: Record<string, string> = { done: 'says it is done', answer: 'proposes an answer', drop: 'asks to drop it', later: 'asks to put it off', reopen: 'asks to reopen it' };
const CLOSE_WORDS: Record<string, string> = { done: 'finished', dropped: 'dropped', later: 'put off', reopened: 'reopened' };

const base = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`;

/** One thing that waits, said in words, linking to where it is acted on. */
function NeedRow({ item }: { item: NeedItem }) {
  const when = 'at' in item ? whenText(item.at) : '';
  const look = item.kind === 'chat' ? { Icon: MessageCircleQuestion, tone: 'text-[var(--state-needs)]', to: base(item.workspaceId), action: 'Answer in the chat' }
    : item.kind === 'question' ? { Icon: CircleHelp, tone: 'text-[var(--state-needs)]', to: `${base(item.workspaceId)}/plan`, action: 'Answer in the plan' }
      : item.kind === 'proposal' ? { Icon: CircleDashed, tone: 'text-[var(--state-needs)]', to: `${base(item.workspaceId)}/plan`, action: 'Decide in the plan' }
        : { Icon: CircleX, tone: 'text-[var(--state-reopened)]', to: `${base(item.workspaceId)}/plan`, action: 'Open the plan' };
  const line = item.kind === 'chat' ? `${whoName(item.by)} asked in the chat${when ? ` ${when}` : ''}`
    : item.kind === 'question' ? [item.by ? `${whoName(item.by)} asked${when ? ` ${when}` : ''}` : '', item.holdsUp.length ? `holds up ${item.holdsUp.join(', ')}` : ''].filter(Boolean).join(' · ') || 'A question for you'
      : item.kind === 'proposal' ? `${whoName(item.by)} ${PROPOSAL_WORDS[item.action] ?? item.action}${when ? ` · ${when}` : ''}`
        : 'Its check failed';
  return <li>
    <Link to={look.to} title={look.action} className="group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring">
      <look.Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${look.tone}`} />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 break-words text-sm text-foreground">{item.text}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{line}</span>
      </span>
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground group-hover:text-foreground">{look.action}</span>
    </Link>
  </li>;
}

/**
 * The Overview's answer to "what needs me": across every workspace, what waits for an answer or an OK,
 * and what the AI finished lately. The workspaces themselves are in the sidebar, so they are not listed again.
 */
export function NeedsYouOverview({ workspaceIds, titles }: { workspaceIds: readonly string[]; titles: Readonly<Record<string, string>> }) {
  const query = useNeedsYou(workspaceIds);
  const needs = query.data?.workspaces ?? [];
  const groups = needItems(needs);
  const closed = aiClosedLately(needs).slice(0, 8);
  const count = groups.reduce((total, group) => total + group.items.length, 0);
  const title = (workspaceId: string) => titles[workspaceId] ?? workspaceId;

  return <>
    <section aria-labelledby="needs-you-heading" className="space-y-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
      <h2 id="needs-you-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
        Needs you {query.data && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">{count}</span>}
      </h2>
      {query.isPending && workspaceIds.length > 0 ? <div role="status" className="space-y-2" aria-label="Loading what needs you"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        : query.isError ? <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          Could not read what needs you.
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}><RefreshCw />Try again</Button>
        </div>
          : groups.length === 0 ? <p className="text-sm text-muted-foreground">Nothing needs you right now. Questions, checks that fail and work waiting for your OK show up here.</p>
            : <ul className="space-y-3">{groups.map((group) => <li key={group.workspaceId}>
              <Link to={`${base(group.workspaceId)}/plan`} className="px-2.5 text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline">{title(group.workspaceId)}</Link>
              <ul>{group.items.map((item, index) => <NeedRow key={`${item.kind}-${'id' in item ? item.id : index}`} item={item} />)}</ul>
            </li>)}</ul>}
    </section>

    {closed.length > 0 && <section aria-labelledby="ai-closed-heading" className="space-y-1.5 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
      <h2 id="ai-closed-heading" className="text-base font-semibold text-foreground">Finished by the AI lately</h2>
      <ul>{closed.map((entry) => <li key={`${entry.workspaceId}-${entry.id}-${entry.at}`}>
        <Link to={`${base(entry.workspaceId)}/plan`} className="flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring">
          <ListChecks aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--state-done)]" />
          <span className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{whoName(entry.by)}</span> {CLOSE_WORDS[entry.action] ?? entry.action} &ldquo;{entry.title}&rdquo;
            {entry.note && <span className="text-muted-foreground">: {entry.note}</span>}
            <span className="block text-xs text-muted-foreground">{title(entry.workspaceId)}{whenText(entry.at) ? ` · ${whenText(entry.at)}` : ''}</span>
          </span>
        </Link>
      </li>)}</ul>
    </section>}
  </>;
}
