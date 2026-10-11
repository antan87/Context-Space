import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Ellipsis, Play, RotateCcw, Settings } from 'lucide-react';
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

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** Every tool, for when the pinned ones are not the one wanted, and a way to set up more. */
function AllTools({ tools, label, onPick }: { tools: string[]; label: string; onPick: (tool: string) => void }) {
  const navigate = useNavigate();
  return <Menu>
    <MenuTrigger aria-label={label} title={label} className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
      <Ellipsis className="size-4" aria-hidden="true" />
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

/** No session runs yet: pick a tool and what to work on, then start. */
function StartCard({ sessions, plan }: { sessions: ReturnType<typeof useWorkspaceSessions>; plan?: PlanView }) {
  const items = startableItems(plan).slice(0, 4);
  const [tool, setTool] = useState<string | undefined>(undefined);
  const [on, setOn] = useState<string | null | undefined>(undefined);
  const chosenTool = tool ?? sessions.lastTool;
  const chosenItem = on === undefined ? items[0]?.id ?? null : on;
  const item = items.find((candidate) => candidate.id === chosenItem);
  const pinned = sessions.tools.slice(0, PINNED_TOOLS);
  if (sessions.unavailable) return <p className="text-sm text-muted-foreground">{sessions.reason ?? 'Sessions cannot start on this device.'}</p>;
  return <section aria-label="Start a session" className="space-y-3 rounded-xl border border-border bg-card p-3">
    <div>
      <h3 className="text-sm font-semibold text-foreground">Start a session</h3>
      <p className="text-xs text-muted-foreground">The AI gets this workspace's plan and context.</p>
    </div>
    <div role="radiogroup" aria-label="Tool" className="flex flex-wrap items-center gap-1">
      {pinned.map((id) => <button key={id} type="button" role="radio" aria-checked={id === chosenTool} onClick={() => setTool(id)}
        className={cn('inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs', id === chosenTool ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
        <HarnessIcon harness={id} className="size-3.5" />{harnessName(id)}
      </button>)}
      {sessions.tools.length > PINNED_TOOLS && <AllTools tools={sessions.tools.slice(PINNED_TOOLS)} label="More tools" onPick={setTool} />}
      {sessions.tools.length === 0 && !sessions.loading && <span className="text-xs text-muted-foreground">No AI tools are installed. <Link to="/settings" className="underline">Set up tools…</Link></span>}
    </div>
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs text-muted-foreground">Work on</legend>
      {items.map((candidate) => <label key={candidate.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-accent/40">
        <input type="radio" name="work-on" className="mt-1" checked={chosenItem === candidate.id} onChange={() => setOn(candidate.id)} />
        <span className="min-w-0">{candidate.title} <span className="font-mono text-[11px] text-muted-foreground">{candidate.id}</span>
          <span className="block text-xs text-muted-foreground">{candidate.status === 'in_progress' ? 'In progress' : 'Ready to start'}</span></span>
      </label>)}
      <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-accent/40">
        <input type="radio" name="work-on" checked={chosenItem === null} onChange={() => setOn(null)} />Something else
      </label>
    </fieldset>
    <Button size="sm" disabled={!chosenTool} onClick={() => chosenTool && sessions.start(chosenTool, item ? firstMessageFor(item) : undefined)}>
      {chosenTool && <HarnessIcon harness={chosenTool} className="size-3.5" />}<Play />Start{chosenTool ? ` ${harnessName(chosenTool)}` : ''}
    </Button>
    {item && <p className="text-[11px] text-muted-foreground">Its first message names {item.label} and tells it to read the plan.</p>}
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
    {sessions.running.length === 0 ? <StartCard sessions={sessions} plan={plan} /> : <>
      <section aria-label="New session" className="space-y-1.5">
        <Heading>New session</Heading>
        <div className="flex items-center gap-1">
          {sessions.lastTool && <Button size="sm" variant="outline" className="min-w-0 flex-1 justify-start" onClick={() => sessions.start(sessions.lastTool!)}>
            <HarnessIcon harness={sessions.lastTool} className="size-3.5" /><span className="truncate">{harnessName(sessions.lastTool)}</span>
          </Button>}
          {pinned.map((tool) => <IconButton key={tool} variant="outline" size="sm" label={`Start ${harnessName(tool)}`} icon={<HarnessIcon harness={tool} className="size-3.5" />} onClick={() => sessions.start(tool)} />)}
          <AllTools tools={sessions.tools} label="Every tool" onPick={(tool) => sessions.start(tool)} />
        </div>
      </section>
      <section aria-label="Running now" className="space-y-1">
        <Heading>Running now · {sessions.running.length}</Heading>
        <ul>{sessions.running.map((terminal) => {
          const on = workingOn(plan, terminal.target)[0];
          return <li key={terminal.id}>
            <button type="button" onClick={() => sessions.show(terminal.id, terminal.target)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/50" aria-label={`Show ${harnessName(terminal.target)}${on ? `, working on ${on.label}` : ''}, ${terminal.working ? 'working' : 'idle'}`}>
              <HarnessIcon harness={terminal.target} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{on?.title ?? harnessName(terminal.target)}</span>
                <span className="block text-[11px] text-muted-foreground">{harnessName(terminal.target)} · {terminal.working ? 'working' : 'idle'}</span></span>
              <LiveDot state={terminal.working ? 'working' : 'idle'} />
              <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </li>;
        })}</ul>
      </section>
    </>}
    <section aria-label="Continue where you left off" className="space-y-1">
      <Heading>{sessions.running.length === 0 ? 'Or continue where you left off' : 'Continue where you left off'}</Heading>
      {recent.length === 0 ? <p className="px-1.5 text-xs text-muted-foreground">{sessions.savedLoading ? 'Finding saved conversations…' : 'No saved conversations yet.'}</p> : <ul>
        {recent.map((session) => <li key={`${session.assistant}:${session.id}`} className="flex items-center gap-2 px-1.5 py-1">
          <HarnessIcon harness={session.assistant} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm" title={session.title}>{session.title}</span>
            <span className="block text-[11px] text-muted-foreground">{harnessName(session.assistant)} · {whenText(session.updatedAt)}</span></span>
          <IconButton label={`Continue ${session.title} in ${harnessName(session.assistant)}`} icon={<RotateCcw />} className="text-muted-foreground" onClick={() => sessions.resume(session)} />
        </li>)}
      </ul>}
      <Link to={`/workspaces/${encodeURIComponent(workspace)}/sessions`} className="block px-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        All sessions, with transcripts
      </Link>
    </section>
  </aside>;
}
