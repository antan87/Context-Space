import { CircleCheck, CircleDot } from 'lucide-react';
import type { PlanFinishItem } from '../../types.js';

function Rows({ items, tone }: { items: readonly PlanFinishItem[]; tone: 'stop' | 'warn' }) {
  return <ul className="space-y-1">{items.map((item) => <li key={item.id} className="flex items-start gap-2 text-xs">
    <CircleDot aria-hidden="true" className={`mt-px size-3.5 shrink-0 ${tone === 'stop' ? 'text-[var(--state-reopened)]' : 'text-muted-foreground'}`} />
    <span className="min-w-0">{item.label}<span className="block text-muted-foreground">{item.status}</span></span>
  </li>)}</ul>;
}

/**
 * What PLAN.md still has open, for the finish panel, as the finish decision counts it: a checkpoint that is not ticked
 * stops finishing; other open steps and decisions only warn.
 */
export function PlanFinishList({ plan }: { plan?: { blocking: readonly PlanFinishItem[]; open: readonly PlanFinishItem[] } }) {
  if (!plan) return null;
  if (!plan.blocking.length && !plan.open.length) {
    return <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="finish-plan"><CircleCheck aria-hidden="true" className="size-3.5 text-[var(--state-done)]" />Every checkpoint in the plan is done.</p>;
  }
  return <div className="mb-3 space-y-2" data-testid="finish-plan">
    {plan.blocking.length > 0 && <div><p className="mb-1 text-[11px] font-semibold text-destructive-foreground">Stops finishing · checkpoints not done</p><Rows items={plan.blocking} tone="stop" /></div>}
    {plan.open.length > 0 && <div><p className="mb-1 text-[11px] font-semibold text-foreground">Only warns · still open in PLAN.md</p><Rows items={plan.open} tone="warn" /></div>}
  </div>;
}
