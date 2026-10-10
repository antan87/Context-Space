import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { PlanChangeInput, PlanKind, PlanView } from './planTypes.js';

const selectClass = 'mt-1 w-full rounded-md border border-border bg-background p-2 text-sm';
const KINDS: PlanKind[] = ['milestone', 'task', 'question', 'decision', 'existing'];

/** Adds one item: what it is, its name, more about it, who answers a question, and what it holds up. */
export function AddPlanItemDialog({ view, open, busy, error, onClose, onAdd }: {
  view: PlanView; open: boolean; busy: boolean; error?: string; onClose: () => void; onAdd: (change: PlanChangeInput) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<PlanKind>('milestone');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [answerer, setAnswerer] = useState<'user' | 'agent'>('user');
  const [holdsUp, setHoldsUp] = useState('');
  const openWork = [...view.milestones, ...view.otherOpen].filter((item) => item.status !== 'done' && item.status !== 'dropped');
  const reset = () => { setKind('milestone'); setTitle(''); setDetail(''); setAnswerer('user'); setHoldsUp(''); };
  const add = async () => {
    const ok = await onAdd({
      type: 'add', kind, title: title.trim(),
      ...(detail.trim() ? { detail: detail.trim() } : {}),
      ...(kind === 'question' ? { owner: answerer } : {}),
      ...(holdsUp ? { before: [holdsUp] } : {}),
    });
    if (ok) { reset(); onClose(); }
  };
  return <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
    <DialogPopup className="max-w-md">
      <DialogHeader><DialogTitle>Add to the plan</DialogTitle></DialogHeader>
      <DialogPanel className="space-y-3">
        <label className="block text-sm">What is it?<select aria-label="What is it?" className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as PlanKind)}>
          {KINDS.map((value) => <option key={value} value={value}>{view.words.kinds[value].label}</option>)}
        </select></label>
        <p className="text-xs text-muted-foreground">{view.words.kinds[kind].meaning}</p>
        <label className="block text-sm">Name<Input className="mt-1" autoFocus value={title} onChange={(event) => setTitle(event.target.value)}
          placeholder={kind === 'question' ? 'Which time zone should exports use?' : 'CSV export endpoint'} /></label>
        <label className="block text-sm">{kind === 'milestone' ? 'What it must deliver (optional)' : 'More about it (optional)'}<Textarea className="mt-1" value={detail} onChange={(event) => setDetail(event.target.value)} /></label>
        {kind === 'question' && <label className="block text-sm">Who answers?<select aria-label="Who answers?" className={selectClass} value={answerer} onChange={(event) => setAnswerer(event.target.value as 'user' | 'agent')}>
          <option value="user">You</option><option value="agent">The AI</option>
        </select></label>}
        {openWork.length > 0 && <label className="block text-sm">Holds up (optional)<select aria-label="Holds up" className={selectClass} value={holdsUp} onChange={(event) => setHoldsUp(event.target.value)}>
          <option value="">Nothing</option>
          {openWork.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogPanel>
      <DialogFooter>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={busy || !title.trim()} onClick={() => void add()}>Add</Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>;
}
