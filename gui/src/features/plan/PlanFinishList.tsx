import { usePlan } from '../../lib/api/queries.js';
import { TONE_CLASS, itemLook, stateLine } from './planView.js';
import type { PlanItemView, PlanView } from './planTypes.js';

function Rows({ items, view }: { items: PlanItemView[]; view: PlanView }) {
  return <ul className="space-y-1">{items.map((item) => {
    const { icon: Icon, tone } = itemLook(item);
    return <li key={item.id} className="flex items-start gap-2 text-xs">
      <Icon aria-hidden="true" className={`mt-px size-3.5 shrink-0 ${TONE_CLASS[tone]}`} />
      <span className="min-w-0">{item.title} <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
        <span className="block text-muted-foreground">{view.words.kinds[item.kind].label} · {stateLine(item, view.words)}{item.holdsUp.length ? ` · ${item.holdsUp.join(', ')} waits for it` : ''}</span></span>
    </li>;
  })}</ul>;
}

/** What the plan still has open, for the finish panel: what milestones wait for first, then the rest. */
export function PlanFinishList({ workspaceId }: { workspaceId: string }) {
  const { data: view } = usePlan(workspaceId);
  if (!view) return null;
  const { blocks, warns, handled } = view.finish;
  if (!blocks.length && !warns.length) return <p className="mb-3 text-xs text-muted-foreground" data-testid="finish-plan">Everything in the plan is handled.</p>;
  return <div className="mb-3 space-y-2" data-testid="finish-plan">
    {blocks.length > 0 && <div><p className="mb-1 text-[11px] font-semibold text-foreground">A milestone waits for these</p><Rows items={blocks} view={view} /></div>}
    {warns.length > 0 && <div><p className="mb-1 text-[11px] font-semibold text-foreground">Still open · finish them, move them to later, or drop them in the plan</p><Rows items={warns} view={view} /></div>}
    <p className="text-[11px] text-muted-foreground">Already handled: {handled.done} done · {handled.dropped} dropped · {handled.later} for later.</p>
  </div>;
}
