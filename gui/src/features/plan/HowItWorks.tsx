import { Button } from '../../components/ui/button.js';
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../../components/ui/dialog.js';
import { NEEDS_YOU_LOOK, STATUS_LOOK, TONE_CLASS, forYou, rememberHowItWorksSeen } from './planView.js';
import type { PlanStatus, PlanWords } from './planTypes.js';

const ORDER: PlanStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'dropped', 'later'];

/** The six status icons with their words, in one line under the plan. */
export function StatusKey({ words }: { words: PlanWords }) {
  return <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="What the icons mean">
    {ORDER.map((status) => {
      const { icon: Icon, tone } = STATUS_LOOK[status];
      return <span key={status} className="inline-flex items-center gap-1"><Icon aria-hidden="true" className={`size-3 ${TONE_CLASS[tone]}`} />{words.statuses[status].label}</span>;
    })}
    <span className="inline-flex items-center gap-1"><NEEDS_YOU_LOOK.icon aria-hidden="true" className={`size-3 ${TONE_CLASS.needs}`} />{words.needsYou.label}</span>
  </p>;
}

/** How the plan works: the statuses, the rules and names first, from the same words AI tools read. */
export function HowItWorksDialog({ words, open, onClose }: { words: PlanWords; open: boolean; onClose: () => void }) {
  const close = () => { rememberHowItWorksSeen(); onClose(); };
  return <Dialog open={open} onOpenChange={(next) => !next && close()}>
    <DialogPopup className="max-w-lg">
      <DialogHeader><DialogTitle>How the plan works</DialogTitle></DialogHeader>
      <DialogPanel className="space-y-4 text-sm">
        <p className="text-muted-foreground">One plan for you and every AI tool. You change it here; AI tools change it with <code className="rounded bg-muted px-1 text-xs">ctxspace plan</code>. Same items, same words.</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5">
          {ORDER.map((status) => {
            const { icon: Icon, tone } = STATUS_LOOK[status];
            return <div key={status} className="contents">
              <dt className="flex items-center gap-1.5 font-medium"><Icon aria-hidden="true" className={`size-4 ${TONE_CLASS[tone]}`} />{words.statuses[status].label}</dt>
              <dd className="text-muted-foreground">{words.statuses[status].meaning}</dd>
            </div>;
          })}
          <dt className="flex items-center gap-1.5 font-medium"><NEEDS_YOU_LOOK.icon aria-hidden="true" className={`size-4 ${TONE_CLASS.needs}`} />{words.needsYou.label}</dt>
          <dd className="text-muted-foreground">{forYou(words.needsYou.meaning)}</dd>
        </dl>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rules</h3>
          <ol className="list-decimal space-y-1 pl-5">{words.rules.map((rule) => <li key={rule}>{forYou(rule)}</li>)}</ol>
        </div>
        <p className="text-muted-foreground">Names come first; codes like M2 are for tools. In the chat, a bare code shows its name.</p>
      </DialogPanel>
      <DialogFooter className="items-center justify-between gap-3 sm:justify-between">
        <span className="text-xs text-muted-foreground">Opens by itself once. After that, only from How it works.</span>
        <Button size="sm" onClick={close}>Got it</Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>;
}
