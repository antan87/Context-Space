import { ListChecks } from 'lucide-react';
import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import { LiveDot } from '../chat/LiveMarker.js';
import { useWorkspaceSessions } from './useSessions.js';

/** How many session tabs fit beside Plan before the rest go under +N. */
const SHOWN_TABS = 4;

/**
 * The plan's tab and the sessions beside it, for the top of the plan: Plan is open, and each running session is one
 * click away. Sessions start in one place, the chat; a ready plan item starts one from its row.
 */
export function WorkspaceTabs({ workspace }: { workspace: string }) {
  // Only the running sessions are shown here, not the saved conversations.
  const sessions = useWorkspaceSessions(workspace, true, { withSaved: false });
  const shown = sessions.running.slice(0, SHOWN_TABS);
  const more = sessions.running.slice(SHOWN_TABS);
  return <div className="flex min-w-0 flex-1 items-center gap-0.5" aria-label="Plan and sessions">
    <span aria-current="page" className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2 text-xs font-medium text-foreground">
      <ListChecks aria-hidden="true" className="size-3.5" />Plan
    </span>
    {shown.map((terminal) => <button key={terminal.id} type="button" onClick={() => sessions.show(terminal.id, terminal.target)}
      title={`${harnessName(terminal.target)}: ${terminal.working ? 'working' : 'idle'}`} aria-label={`Show ${harnessName(terminal.target)}, ${terminal.working ? 'working' : 'idle'}`}
      className="inline-flex h-6 min-w-0 max-w-[11rem] shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
      <HarnessIcon harness={terminal.target} className="size-3 shrink-0" /><span className="truncate">{harnessName(terminal.target)}</span>
      <LiveDot state={terminal.working ? 'working' : 'idle'} />
    </button>)}
    {more.length > 0 && <Menu>
      <MenuTrigger aria-label={`${more.length} more sessions`} className="inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">+{more.length}</MenuTrigger>
      <MenuPopup align="start" className="w-60 p-1">
        {more.map((terminal) => <MenuItem key={terminal.id} onClick={() => sessions.show(terminal.id, terminal.target)} className="flex items-center gap-2 text-xs">
          <HarnessIcon harness={terminal.target} className="size-3.5" /><span className="truncate">{harnessName(terminal.target)}</span>
        </MenuItem>)}
      </MenuPopup>
    </Menu>}
  </div>;
}
