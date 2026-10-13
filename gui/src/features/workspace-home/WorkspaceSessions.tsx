import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Ellipsis, History, MessagesSquare, RotateCcw, Settings } from 'lucide-react';
import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import { cn } from '../../lib/utils.js';
import { LiveDot } from '../chat/LiveMarker.js';
import { startableItems, whenText, workingOn } from '../plan/planView.js';
import type { PlanView } from '../plan/planTypes.js';
import { usePlan } from '../../lib/api/queries.js';
import { PINNED_TOOLS, firstMessageFor } from './toolPrefs.js';
import { useWorkspaceSessions } from './useSessions.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold text-foreground/80">{children}</h3>;
}

/** Every tool, for when the pinned ones are not the one wanted, and a way to set up more. */
function AllTools({ tools, label, onPick }: { tools: string[]; label: string; onPick: (tool: string) => void }) {
  const navigate = useNavigate();
  return <Menu>
    <MenuTrigger aria-label={label} title={label} className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-border/40 bg-muted/20 text-muted-foreground hover:border-border/70 hover:bg-muted/40 hover:text-foreground transition-all">
      <Ellipsis className="size-3.5" aria-hidden="true" />
    </MenuTrigger>
    <MenuPopup align="end" className="w-56 p-1">
      {tools.map((tool) => <MenuItem key={tool} onClick={() => onPick(tool)} className="flex items-center gap-2 text-xs">
        <HarnessIcon harness={tool} className="size-3.5" />{harnessName(tool)}
      </MenuItem>)}
      {tools.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No AI tools are installed.</p>}
      <div className="my-1 border-t border-border" />
      <MenuItem onClick={() => navigate('/settings')} className="flex items-center gap-2 text-xs"><Settings className="size-3.5" />Set up tools…</MenuItem>
    </MenuPopup>
  </Menu>;
}

/** No session runs yet: pick what to work on, then click any harness to start immediately. */
function StartCard({ sessions, plan }: { sessions: ReturnType<typeof useWorkspaceSessions>; plan?: PlanView }) {
  const items = startableItems(plan).slice(0, 4);
  const [on, setOn] = useState<string | null | undefined>(undefined);
  const chosenItem = on === undefined ? items[0]?.id ?? null : on;
  const item = items.find((candidate) => candidate.id === chosenItem);
  const pinned = sessions.tools.slice(0, PINNED_TOOLS);
  if (sessions.unavailable) return <p className="text-sm text-muted-foreground">{sessions.reason ?? 'Sessions cannot start on this device.'}</p>;
  return <section aria-label="Start a session" className="space-y-3 rounded-xl border border-border/40 bg-card/60 backdrop-blur-xs p-3 shadow-2xs">
    <div className="space-y-1.5">
      {pinned.length > 0 && (
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border/30 bg-muted/20 p-1">
          {pinned.map((id) => (
            <button
              key={id}
              type="button"
              aria-label={`Start ${harnessName(id)}`}
              title={`Start ${harnessName(id)}`}
              onClick={() => sessions.start(id, item ? firstMessageFor(item) : undefined)}
              className="inline-flex h-[26px] min-w-0 items-center gap-1.5 rounded-md border border-border/40 bg-background/60 px-2 text-xs font-medium text-foreground transition-all hover:border-border/70 hover:bg-background hover:shadow-2xs active:scale-[0.98] active:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
            >
              <HarnessIcon harness={id} className="size-3.5 shrink-0" />
              <span className="truncate">{harnessName(id)}</span>
            </button>
          ))}
        </div>
      )}
      {sessions.tools.length > PINNED_TOOLS && (
        <div className="flex items-center justify-between px-0.5 text-xs text-muted-foreground">
          <span className="text-[11px]">More tools</span>
          <AllTools tools={sessions.tools.slice(PINNED_TOOLS)} label="More tools" onPick={(t) => sessions.start(t, item ? firstMessageFor(item) : undefined)} />
        </div>
      )}
      {sessions.tools.length === 0 && !sessions.loading && (
        <span className="block px-0.5 text-xs text-muted-foreground">
          No AI tools are installed. <Link to="/settings" className="underline">Set up tools…</Link>
        </span>
      )}
    </div>
    <fieldset className="min-w-0 space-y-1">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">Work on</legend>
      <div className="min-w-0 space-y-1">
        {items.map((candidate) => (
          <label
            key={candidate.id}
            className={cn(
              'group flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors',
              chosenItem === candidate.id
                ? 'border-primary/40 bg-primary/5 text-foreground ring-1 ring-primary/20'
                : 'border-border/30 bg-muted/10 text-muted-foreground hover:border-border/60 hover:bg-muted/25 hover:text-foreground'
            )}
          >
            <input type="radio" name="work-on" className="size-3.5 shrink-0 accent-primary" checked={chosenItem === candidate.id} onChange={() => setOn(candidate.id)} />
            <span className="inline-flex shrink-0 items-center rounded border border-border/40 bg-muted/40 px-1 py-0.5 font-mono text-[10px] font-medium text-muted-foreground group-hover:text-foreground">
              {candidate.id}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground text-xs" title={candidate.title}>
              <InlinePlanMarkdown content={candidate.title} />
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {candidate.status === 'in_progress' ? (
                <span className="inline-flex items-center gap-1 text-amber-500 font-medium">
                  <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                  In progress
                </span>
              ) : (
                'Ready'
              )}
            </span>
          </label>
        ))}
        <label
          className={cn(
            'group flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors',
            chosenItem === null
              ? 'border-primary/40 bg-primary/5 text-foreground ring-1 ring-primary/20 font-medium'
              : 'border-border/30 bg-muted/10 text-muted-foreground hover:border-border/60 hover:bg-muted/25 hover:text-foreground'
          )}
        >
          <input type="radio" name="work-on" className="size-3.5 shrink-0 accent-primary" checked={chosenItem === null} onChange={() => setOn(null)} />
          <span aria-hidden="true" className="inline-flex shrink-0 items-center rounded border border-border/40 bg-muted/40 px-1 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
            --
          </span>
          <span className="min-w-0 flex-1 truncate">Something else</span>
        </label>
      </div>
    </fieldset>
  </section>;
}

/**
 * Beside the plan: start a session in one click, see what runs now, and continue a saved conversation. With nothing
 * running yet, a Start card picks the tool and what to work on.
 */
export function WorkspaceSessions({ workspace }: { workspace: string }) {
  const sessions = useWorkspaceSessions(workspace);
  const plan = usePlan(workspace).data;
  const pinned = sessions.tools.filter((tool) => tool !== sessions.lastTool).slice(0, PINNED_TOOLS - 1);
  const recent = sessions.recent.slice(0, 4);
  return <aside aria-label="Sessions" className="space-y-4">
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-1.5">
        <MessagesSquare className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-xs font-semibold text-foreground/80">Sessions</h2>
      </div>
      <Link
        to={`/workspaces/${encodeURIComponent(workspace)}/sessions`}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring group"
        title="View full session history with transcripts and token metrics"
      >
        <span>Full history</span>
        <ArrowRight className="size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
      </Link>
    </div>
    {sessions.running.length === 0 ? <StartCard sessions={sessions} plan={plan} /> : <>
      <section aria-label="New session" className="space-y-2 rounded-xl border border-border/40 bg-card/60 backdrop-blur-xs p-3 shadow-2xs">
        <Heading>New session</Heading>
        <div className="flex items-center gap-1.5">
          {sessions.lastTool && <Button size="sm" variant="outline" className="h-7 min-w-0 flex-1 justify-start border-border/40 bg-muted/15 text-xs font-medium" onClick={() => sessions.start(sessions.lastTool!)}>
            <HarnessIcon harness={sessions.lastTool} className="size-3.5" /><span className="truncate">{harnessName(sessions.lastTool)}</span>
          </Button>}
          {pinned.map((tool) => <IconButton key={tool} variant="outline" size="sm" label={`Start ${harnessName(tool)}`} icon={<HarnessIcon harness={tool} className="size-3.5" />} onClick={() => sessions.start(tool)} />)}
          <AllTools tools={sessions.tools} label="Every tool" onPick={(tool) => sessions.start(tool)} />
        </div>
      </section>
      <section aria-label="Running now" className="space-y-2 rounded-xl border border-border/40 bg-card/60 backdrop-blur-xs p-3 shadow-2xs">
        <Heading>Running now · {sessions.running.length}</Heading>
        <ul className="space-y-1">{sessions.running.map((terminal) => {
          const on = workingOn(plan, terminal.target)[0];
          return <li key={terminal.id}>
            <button type="button" onClick={() => sessions.show(terminal.id, terminal.target)}
              className="flex w-full items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-2 py-1.5 text-left transition-colors hover:border-border/60 hover:bg-muted/25" aria-label={`Show ${harnessName(terminal.target)}${on ? `, working on ${on.label}` : ''}, ${terminal.working ? 'working' : 'idle'}`}>
              <HarnessIcon harness={terminal.target} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-foreground">{on?.title ?? harnessName(terminal.target)}</span>
                <span className="block text-[10px] text-muted-foreground">{harnessName(terminal.target)} · {terminal.working ? 'working' : 'idle'}</span></span>
              <LiveDot state={terminal.working ? 'working' : 'idle'} />
              <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </li>;
        })}</ul>
      </section>
    </>}
    <section aria-label="Continue where you left off" className="space-y-2 rounded-xl border border-border/40 bg-card/60 backdrop-blur-xs p-3 shadow-2xs">
      <Heading>{sessions.running.length === 0 ? 'Or continue where you left off' : 'Continue where you left off'}</Heading>
      {recent.length === 0 ? <p className="px-1 text-xs text-muted-foreground">{sessions.savedLoading ? 'Finding saved conversations…' : 'No saved conversations yet.'}</p> : <ul className="space-y-1">
        {recent.map((session) => <li key={`${session.assistant}:${session.id}`} className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-2.5 py-1.5 transition-colors hover:border-border/60 hover:bg-muted/25">
          <HarnessIcon harness={session.assistant} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground" title={session.title}><InlinePlanMarkdown content={session.title} /></span>
            <span className="block text-[10px] text-muted-foreground">{harnessName(session.assistant)} · {whenText(session.updatedAt)}</span>
          </span>
          <IconButton label={`Continue ${session.title} in ${harnessName(session.assistant)}`} icon={<RotateCcw className="size-3" />} className="text-muted-foreground hover:text-foreground shrink-0" onClick={() => sessions.resume(session)} />
        </li>)}
      </ul>}
      <div className="pt-1.5 border-t border-border/30">
        <Link
          to={`/workspaces/${encodeURIComponent(workspace)}/sessions`}
          className="flex items-center justify-between rounded-lg border border-border/30 bg-muted/10 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-border/60 hover:bg-muted/25 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring group shadow-2xs"
          title="All sessions with transcripts"
        >
          <span className="flex items-center gap-1.5">
            <History className="size-3.5 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
            <span>All sessions, with transcripts</span>
          </span>
          <ArrowRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
        </Link>
      </div>
    </section>
  </aside>;
}
