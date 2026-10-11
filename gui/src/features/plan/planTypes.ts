/**
 * The plan as GET /api/workspace/:id/plan/items sends it (core/plan-app). The words come with it, so
 * the tab says exactly what `ctxspace plan` and AGENTS.md say.
 */

export type PlanStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'dropped' | 'later';
export type PlanKind = 'milestone' | 'task' | 'question' | 'decision' | 'existing';
export type ProposalAction = 'done' | 'answer' | 'drop' | 'later' | 'reopen';

export interface PlanHistoryEntry { at: string; by: string; action: string; note?: string }

export interface PlanItemView {
  id: string;
  /** Code and name: "M2 CSV export endpoint". */
  label: string;
  kind: PlanKind;
  title: string;
  status: PlanStatus;
  owner?: string;
  detail?: string;
  waitsFor: Array<{ id: string; label: string; status?: PlanStatus }>;
  /** Labels of the items that wait for this one. */
  holdsUp: string[];
  resolution?: string;
  revisitWhen?: string;
  blockedReason?: string;
  proposal?: { action: ProposalAction; by: string; note: string; at: string };
  links?: { repo?: string; branch?: string; workItem?: string };
  gate?: { required: boolean; command?: string; timeoutSeconds?: number };
  updatedAt: string;
  createdAt?: string;
  startedAt?: string;
  closedAt?: string;
  history?: PlanHistoryEntry[];
}

export interface PlanChangeEntry extends PlanHistoryEntry { itemId: string; label: string }

export interface PlanWords {
  statuses: Record<PlanStatus, { label: string; meaning: string }>;
  kinds: Record<PlanKind, { label: string; prefix: string; meaning: string }>;
  needsYou: { label: string; meaning: string };
  sections: Array<{ key: string; label: string }>;
  rules: string[];
  namesFirst: string;
  changes: Record<string, string>;
}

export interface PlanEvidence { lastVerificationSha?: string; lastVerificationStatus?: string; canProgress: boolean; at: string }

export interface PlanView {
  revision: number;
  counts: { needsYou: number; inProgress: number; todo: number; blocked: number; later: number; done: number; dropped: number };
  needsYou: PlanItemView[];
  milestones: PlanItemView[];
  otherOpen: PlanItemView[];
  closed: PlanItemView[];
  ready: string[];
  changes: PlanChangeEntry[];
  evidence: Record<string, PlanEvidence>;
  finish: { blocks: PlanItemView[]; warns: PlanItemView[]; handled: { done: number; dropped: number; later: number } };
  words: PlanWords;
}

/** One change, as `ctxspace plan` makes it. The app makes every change as the user. */
export type PlanChangeInput =
  | { type: 'add'; kind: PlanKind; title: string; detail?: string; owner?: string; after?: string[]; before?: string[]; gate?: PlanItemView['gate'] }
  | { type: 'start'; id: string }
  | { type: 'done'; id: string; resolution: string }
  | { type: 'answer'; id: string; answer: string }
  | { type: 'drop'; id: string; reason: string }
  | { type: 'later'; id: string; revisitWhen: string }
  | { type: 'block'; id: string; reason: string }
  | { type: 'reopen'; id: string; reason: string }
  | {
    type: 'edit'; id: string; title?: string; detail?: string | null; owner?: string | null;
    after?: string[]; notAfter?: string[]; links?: PlanItemView['links']; gate?: PlanItemView['gate'] | null;
  }
  | { type: 'accept'; id: string }
  | { type: 'reject'; id: string; reason: string };
