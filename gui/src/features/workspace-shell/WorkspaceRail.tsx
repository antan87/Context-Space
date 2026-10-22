import { Link } from 'react-router-dom';
import { Archive, Boxes, FileCode, FileText, Kanban, LayoutDashboard, Lightbulb, ListChecks, Server, Terminal, type LucideIcon } from 'lucide-react';

import { Tooltip, TooltipPopup, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn } from '../../lib/utils.js';
import { railSectionsFor, type WorkspaceSection } from './destinations.js';

interface RailItem { label: string; purpose: string; icon: LucideIcon }

/** Short names that fit under an icon, and what each part is for, said in the tooltip. */
const ITEMS: Partial<Record<WorkspaceSection, RailItem>> = {
  overview: { label: 'Overview', purpose: 'Workspace summary, mapped repositories, and telemetry', icon: LayoutDashboard },
  plan: { label: 'Plan', purpose: 'The plan and its checkpoints, the brief the assistant works from, and the checks', icon: ListChecks },
  board: { label: 'Board', purpose: 'The plan, documents and the commits new since you last looked, laid out on a canvas you can pan and zoom', icon: Kanban },
  sessions: { label: 'Sessions', purpose: 'CLI sessions, conversation history, and usage logs', icon: Terminal },
  changes: { label: 'Code', purpose: 'The code and its changes: read files, review, commit and finish the work', icon: FileCode },
  documents: { label: 'Docs', purpose: 'Documents in the workspace', icon: FileText },
  knowledge: { label: 'Knowledge', purpose: 'What the assistant has learned in this workspace', icon: Lightbulb },
  skills: { label: 'Skills', purpose: 'Assistant skills, tools, and playbooks configured for this workspace', icon: Boxes },
  services: { label: 'Services', purpose: "Your app's own processes, such as a dev server, and their logs", icon: Server },
};

const ARCHIVED_ITEMS: Partial<Record<WorkspaceSection, RailItem>> = {
  ...ITEMS,
  overview: { label: 'Record', purpose: 'What this archived workspace did and where its work went', icon: Archive },
};

interface WorkspaceRailProps {
  workspaceId: string;
  section: WorkspaceSection;
  archived?: boolean;
  badges?: Partial<Record<WorkspaceSection, number>>;
}

/**
 * What can open beside the chat, at the edge where it opens: one icon each, named under it, with what it is for in the
 * tooltip. The chat is the page, so it has no item of its own; choosing the part that is open closes it again. Each
 * item is a link, so the address says what is open and back and forward move between them.
 */
export function WorkspaceRail({ workspaceId, section, archived = false, badges = {} }: WorkspaceRailProps) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  return (
    <nav
      aria-label="Workspace"
      className="fixed inset-x-0 bottom-0 z-30 flex shrink-0 border-t border-border bg-card/95 backdrop-blur md:static md:inset-auto md:z-auto md:w-16 md:flex-col md:border-l md:border-t-0 md:bg-card/60 md:py-1.5 md:backdrop-blur-none"
    >
      <ul className="flex w-full flex-row justify-around gap-0.5 px-1 py-1 md:flex-col md:justify-start md:px-0.5 md:py-0">
        {railSectionsFor(archived).map((candidate) => {
          const item = (archived ? ARCHIVED_ITEMS[candidate] : ITEMS[candidate]) ?? ITEMS[candidate];
          if (!item) return null;
          const Icon = item.icon;
          const active = candidate === section;
          const count = badges[candidate];
          // An archived workspace has no chat to go back to, so its open part stays open.
          const to = active && !archived ? `${base}/chat` : `${base}/${candidate}`;
          return (
            <li key={candidate} className="min-w-0 flex-1 md:flex-none">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Link
                      to={to} aria-current={active ? 'page' : undefined}
                      aria-label={count ? `${item.label}, ${count}` : item.label}
                      className={cn(
                        'relative flex h-12 flex-col items-center justify-center gap-1 rounded-md px-0.5 text-[10px] leading-none transition-colors md:h-auto md:justify-start md:py-1.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                        active ? 'bg-secondary font-semibold text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                      )}
                    />
                  }
                >
                  <Icon aria-hidden="true" className="size-4" />
                  <span className="max-w-full truncate">{item.label}</span>
                  {count ? <span aria-hidden="true" className="absolute right-1 top-0.5 min-w-4 rounded-full bg-primary/20 px-1 text-center text-[9px] font-semibold tabular-nums text-foreground">{count}</span> : null}
                </TooltipTrigger>
                <TooltipPopup side="left">{item.purpose}{active && !archived ? '. Choose again to close it.' : ''}</TooltipPopup>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
