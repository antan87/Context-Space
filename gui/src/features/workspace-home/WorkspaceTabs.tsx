import { ChevronDown, ListChecks, Plus } from 'lucide-react';
import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import { usePlan } from '../../lib/api/queries.js';
import { LiveDot } from '../chat/LiveMarker.js';
import { workingOn } from '../plan/planView.js';
import { useWorkspaceSessions } from './useSessions.js';

/** How many session tabs fit beside Plan before the rest go under +N. */
const SHOWN_TABS = 4;

/**
 * The plan's tab and the sessions beside it, for the top of the plan: Plan is open, each running session is one click
 * away, and New session starts the last-used tool in one click (its arrow picks another).
 */
export function WorkspaceTabs({ workspace }: { workspace: string }) {
  const sessions = useWorkspaceSessions(workspace);
  const plan = usePlan(workspace);
  const shown = sessions.running.slice(0, SHOWN_TABS);
  const more = sessions.running.slice(SHOWN_TABS);
  const titleOf = (target: string) => workingOn(plan.data, target)[0]?.title ?? harnessName(target);
  return <div className="flex min-w-0 flex-1 items-center gap-0.5" aria-label="Plan and sessions">
    <span aria-current="page" className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2 text-xs font-medium text-foreground">
      <ListChecks aria-hidden="true" className="size-3.5" />Plan
    </span>
    {shown.map((terminal) => <button key={terminal.id} type="button" onClick={() => sessions.show(terminal.id, terminal.target)}
      title={`${harnessName(terminal.target)}: ${terminal.working ? 'working' : 'idle'}`} aria-label={`Show ${titleOf(terminal.target)} in ${harnessName(terminal.target)}, ${terminal.working ? 'working' : 'idle'}`}
      className="inline-flex h-6 min-w-0 max-w-[11rem] shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
      <HarnessIcon harness={terminal.target} className="size-3 shrink-0" /><span className="truncate">{titleOf(terminal.target)}</span>
      <LiveDot state={terminal.working ? 'working' : 'idle'} />
    </button>)}
    {more.length > 0 && <Menu>
      <MenuTrigger aria-label={`${more.length} more sessions`} className="inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">+{more.length}</MenuTrigger>
      <MenuPopup align="start" className="w-60 p-1">
        {more.map((terminal) => <MenuItem key={terminal.id} onClick={() => sessions.show(terminal.id, terminal.target)} className="flex items-center gap-2 text-xs">
          <HarnessIcon harness={terminal.target} className="size-3.5" /><span className="truncate">{titleOf(terminal.target)}</span>
        </MenuItem>)}
      </MenuPopup>
    </Menu>}
    {sessions.lastTool && <div className="ml-1 inline-flex h-6 shrink-0 items-center rounded-md border border-border text-xs">
      <button type="button" onClick={() => sessions.start(sessions.lastTool!)} title={`Start ${harnessName(sessions.lastTool)}`}
        className="inline-flex h-full cursor-pointer items-center gap-1 rounded-l-md px-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
        <Plus aria-hidden="true" className="size-3.5" /><HarnessIcon harness={sessions.lastTool} className="size-3" /><span>New session</span>
      </button>
      <Menu>
        <MenuTrigger aria-label="Start another tool" className="inline-flex h-full cursor-pointer items-center rounded-r-md border-l border-border px-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          <ChevronDown className="size-3" aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-56 p-1">
          {sessions.tools.map((tool) => <MenuItem key={tool} onClick={() => sessions.start(tool)} className="flex items-center gap-2 text-xs">
            <HarnessIcon harness={tool} className="size-3.5" />Start {harnessName(tool)}
          </MenuItem>)}
        </MenuPopup>
      </Menu>
    </div>}
  </div>;
}
