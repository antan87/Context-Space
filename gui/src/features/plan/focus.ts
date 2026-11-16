/**
 * The one answer to "what is the focus": the step being worked on and the checkpoint it serves. Every part of the app that says
 * Now, Last worked on, or Next up (the Now line, the Area pill, the Now row, the header chip, the chat's progress line, and the
 * Area the board puts the work-in-progress things in) reads it here.
 *
 * Someone says which step they work on (`ctxspace plan now`, the app's "Work on this now"): that is `source: 'set'`, and only
 * that is called Now. Without it, or when it is older than a day, the app checks where work last happened in `plan.changes`
 * (newest first: `ticked`, `unticked`, `added`, `answered` on a step or decision in a checkpoint that is still open now): that is
 * `source: 'recent'`, called Last worked on, with that checkpoint's first open workable step. Otherwise the plan's order is a guess:
 * the first open checkpoint and its first open step that is not a heading (`source: 'plan'`, called Next up, never Now or Current).
 */

import { plainText, stripHeadingColon } from '../../lib/plainText.js';
import type { PlanFileChange, PlanFileCheckpoint, PlanFileStep, PlanFileView, PlanNow } from './planFile.js';

/** A step marked as worked on longer ago than this counts as not marked: nobody refreshed it. */
export const NOW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Focus {
  /** The step; missing when the focus checkpoint has no open step to work on. */
  step?: PlanFileStep;
  /** The checkpoint the step is under; null for a step outside the checkpoints. */
  checkpoint: PlanFileCheckpoint | null;
  source: 'set' | 'recent' | 'plan';
  /** Who said it and when: only for `set`. */
  by?: string;
  at?: string;
}

/** The keys of the open steps that have open steps under them, however deep: headings, not steps to work on. */
export function headingKeysOf(steps: ReadonlyArray<PlanFileStep>): Set<string> {
  const byKey = new Map(steps.map((entry) => [entry.key, entry]));
  const headings = new Set<string>();
  for (const entry of steps) {
    if (entry.done) continue;
    const seen = new Set<string>();
    for (let up = entry.parent ? byKey.get(entry.parent) : undefined; up && !seen.has(up.key); up = up.parent ? byKey.get(up.parent) : undefined) {
      seen.add(up.key);
      if (!up.done) headings.add(up.key);
    }
  }
  return headings;
}

/** The first open step that is not a heading. */
export const firstWorkable = (steps: ReadonlyArray<PlanFileStep>): PlanFileStep | undefined => {
  const headings = headingKeysOf(steps);
  return steps.find((step) => !step.done && !headings.has(step.key));
};

/** The open steps of the plan someone can work on (not headings), by key. */
export function workableKeys(plan: Pick<PlanFileView, 'checkpoints' | 'steps'> | undefined): Set<string> {
  const keys = new Set<string>();
  if (!plan) return keys;
  for (const steps of [...plan.checkpoints.map((checkpoint) => checkpoint.steps), plan.steps]) {
    const headings = headingKeysOf(steps);
    for (const step of steps) if (!step.done && !headings.has(step.key)) keys.add(step.key);
  }
  return keys;
}

const RECENT_ACTIONS = new Set<PlanFileChange['action']>(['ticked', 'unticked', 'added', 'answered']);

const changeTime = (change: PlanFileChange): number => {
  const ms = Date.parse(change.at);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

/**
 * The still-open checkpoint where work last happened, from `plan.changes` newest first.
 * `removed` changes do not match on their own; edits count through the `added` change logged at the same time.
 */
function recentCheckpoint(
  checkpoints: ReadonlyArray<PlanFileCheckpoint>,
  changes: ReadonlyArray<PlanFileChange> | undefined,
): PlanFileCheckpoint | undefined {
  if (!changes?.length) return undefined;
  const openByStep = new Map<string, PlanFileCheckpoint>();
  const openByDecision = new Map<string, PlanFileCheckpoint>();
  for (const cp of checkpoints) {
    if (cp.done) continue;
    for (const s of cp.steps) if (!openByStep.has(s.key)) openByStep.set(s.key, cp);
    for (const d of cp.decisions) if (!openByDecision.has(d.key)) openByDecision.set(d.key, cp);
  }
  if (openByStep.size === 0 && openByDecision.size === 0) return undefined;
  const ordered = [...changes].sort((a, b) => {
    const ta = changeTime(a);
    const tb = changeTime(b);
    if (ta === tb) return 0;
    return tb > ta ? 1 : -1;
  });
  for (const change of ordered) {
    if (!RECENT_ACTIONS.has(change.action)) continue;
    if (change.kind === 'step') {
      const cp = openByStep.get(change.key);
      if (cp) return cp;
    } else if (change.kind === 'decision') {
      const cp = openByDecision.get(change.key);
      if (cp) return cp;
    }
  }
  return undefined;
}

/**
 * The focus of the plan. `now` is the record of the step someone said they work on; left out, it is the plan's own (`plan.now`).
 * A record that names a step that is gone, done or only a heading, or that is older than 24 hours, counts as none, falling back
 * to where work last happened (`source: 'recent'`), then to the first open checkpoint in file order (`source: 'plan'`).
 * Null when nothing is open.
 */
export function focusOf(
  plan: (Pick<PlanFileView, 'checkpoints' | 'steps'> & { now?: PlanNow | null; changes?: ReadonlyArray<PlanFileChange> }) | undefined,
  now?: PlanNow | null,
  clock: number = Date.now(),
): Focus | null {
  if (!plan) return null;
  const record = now === undefined ? plan.now : now;
  const age = record ? clock - Date.parse(record.at) : Number.NaN;
  if (record && age <= NOW_MAX_AGE_MS) {
    for (const checkpoint of plan.checkpoints) {
      const step = checkpoint.steps.find((entry) => entry.key === record.key);
      if (step && !step.done && !headingKeysOf(checkpoint.steps).has(step.key)) return { step, checkpoint, source: 'set', by: record.by, at: record.at };
    }
    const loose = plan.steps.find((entry) => entry.key === record.key);
    if (loose && !loose.done && !headingKeysOf(plan.steps).has(loose.key)) return { step: loose, checkpoint: null, source: 'set', by: record.by, at: record.at };
  }
  const recent = recentCheckpoint(plan.checkpoints, plan.changes);
  if (recent) {
    const step = firstWorkable(recent.steps);
    return { ...(step ? { step } : {}), checkpoint: recent, source: 'recent' };
  }
  const checkpoint = plan.checkpoints.find((entry) => !entry.done);
  if (checkpoint) {
    const step = firstWorkable(checkpoint.steps);
    return { ...(step ? { step } : {}), checkpoint, source: 'plan' };
  }
  const loose = firstWorkable(plan.steps);
  return loose ? { step: loose, checkpoint: null, source: 'plan' } : null;
}

/** What the focus is called: "Now" only when someone said so, "Last worked on" for recent work, else "Next up". */
export const focusWord = (focus: Pick<Focus, 'source'>): 'Now' | 'Last worked on' | 'Next up' =>
  focus.source === 'set' ? 'Now' : focus.source === 'recent' ? 'Last worked on' : 'Next up';

/** The focus in words, without markup: the step, else its checkpoint. */
export const focusText = (focus: Pick<Focus, 'step' | 'checkpoint'> | null | undefined): string =>
  focus ? plainText(stripHeadingColon(focus.step?.text ?? focus.checkpoint?.title ?? '')).trim() : '';

/** What makes a focus a different one: the step, its checkpoint, the source and who set it when. Not the time it is looked at. */
export const focusSignature = (focus: Focus | null): string =>
  focus ? [focus.source, focus.step?.key ?? '', focus.checkpoint?.key ?? '', focus.by ?? '', focus.at ?? ''].join('|') : 'none';

/**
 * The time to build the Areas with: the one it was built with, until the focus is a different one. A minute's tick moves the clock
 * but not this, so the Areas (and everything drawn from them, the note dialog's choices among them) keep their identity unless
 * the focus really changed, which includes a set step running out after a day.
 */
export function stableNow(previous: { signature: string; at: number } | undefined, signature: string, clock: number): { signature: string; at: number } {
  return previous && previous.signature === signature ? previous : { signature, at: clock };
}
