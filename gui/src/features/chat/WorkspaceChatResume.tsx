import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, History, LoaderCircle } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';
import { useFloatingChat } from './floatingChatStore.js';
import { useWorkspaceSessionSources } from '../terminal/useWorkspaceSessionSources.js';

export function WorkspaceChatResume({ workspace }: { workspace: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const { openCli, openTerminal } = useFloatingChat();

  useEffect(() => {
    if (inView) return;
    const node = container.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true);
        observer.disconnect();
      }
    }, { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView]);

  // The card shows the newest conversation of up to two tools, so one per tool is enough to ask for.
  const { sessions, sourcesChecked, sourcesPending, sourcesFailed, sourceCount } = useWorkspaceSessionSources(workspace, inView, { newest: 1 });
  const recent = sessions.filter(session => session.threadKind !== 'subagent' && session.recordedCwd)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  const preview = recent.filter((session, index) => recent.findIndex(item => item.assistant === session.assistant) === index).slice(0, 2);

  return <section ref={container} aria-label={`Recent CLI sessions for ${workspace}`} className="w-full min-w-0">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] font-semibold text-muted-foreground">Recent CLI sessions</span>
      <div className="flex items-center gap-1">
        {(!inView || sourcesPending > 0) && <span role="status" className="flex items-center gap-1 text-[10px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />{sourceCount > 0 ? `${sourcesChecked}/${sourceCount}` : ''}</span>}
        <Button size="icon-xs" variant="ghost" onClick={() => openCli(workspace)} aria-label={`View all CLI sessions for ${workspace}`} title="View all CLI sessions">
          <History className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
    {recent.length > 0 ? <div className="mt-0.5 space-y-0.5">
      {preview.map(session => {
        const label = `Open ${session.title} with ${harnessName(session.assistant)} in CLI chat`;
        return <button key={`${session.assistant}:${session.id}`} type="button" onClick={() => openTerminal(workspace, session.assistant, session.id, session.workspacePath)}
          aria-label={label} title={label} className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-foreground hover:bg-accent/60 dark:hover:bg-accent/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 cursor-pointer">
          <HarnessIcon harness={session.assistant} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-medium">{session.title}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{harnessName(session.assistant)}</span>
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>;
      })}
    </div> : <p className="px-1.5 py-1 text-[11px] text-muted-foreground">{!inView || sourcesPending > 0 ? 'Finding saved conversations…' : sourcesFailed > 0 ? 'Could not load recent sessions.' : sessions.length > 0 ? 'Use the CLI session picker for these conversations.' : 'No saved conversations yet.'}</p>}
    {sourcesFailed > 0 && recent.length > 0 && <p className="px-1.5 text-[10px] text-muted-foreground">Some session sources could not be loaded.</p>}
  </section>;
}
