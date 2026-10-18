import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { newsGroups, newsSummary, useMarkNewsSeen, useWhatsNew } from './whatsNew.js';

/**
 * "Since you last looked": what changed in the workspace since the user last looked, and who made it, above the
 * plan. One line says how much; Show lists it the way `ctxspace news` does; Got it says the user has seen it, and
 * the card goes. It shows nothing when nothing changed, and an archived workspace shows it without Got it.
 */
export function SinceYouLooked({ workspaceId, readOnly = false }: { workspaceId: string; readOnly?: boolean }) {
  const news = useWhatsNew(workspaceId);
  const seen = useMarkNewsSeen(workspaceId);
  const [open, setOpen] = useState(false);
  const view = news.data;
  if (!view || view.empty) return null;

  return <section aria-label="Since you last looked" className="space-y-3 rounded-xl border border-border/40 bg-card/60 px-4 py-3 shadow-2xs backdrop-blur-xs">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 break-words text-sm text-foreground">{newsSummary(view)}</p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="xs" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</Button>
        {!readOnly && <Button size="xs" disabled={seen.isPending} onClick={() => seen.mutate(view.at)}>Got it</Button>}
      </div>
    </div>
    {seen.error instanceof Error && <p role="alert" className="text-xs text-destructive">{seen.error.message}</p>}
    {open && <div className="space-y-3 border-t border-border/30 pt-3">
      {newsGroups(view).map((group) => <section key={group.title} className="space-y-1.5" aria-label={group.title}>
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</h3>
        <ul className="space-y-1 px-1">{group.lines.map((line, index) => <li key={`${index}-${line}`} className="break-words text-sm text-muted-foreground">{line}</li>)}</ul>
      </section>)}
    </div>}
  </section>;
}
