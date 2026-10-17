/**
 * Plan payloads for the app, as GET /api/workspace/:id/plan sends them (core/plan-file-app): PLAN.md's free text and
 * its checkpoints, steps and decisions.
 */
import type { PlanFileCheckpoint, PlanFileDecision, PlanFileStep, PlanFileView } from '../src/features/plan/planFile.ts';

const keyOf = (words: string) => words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function step(text: string, done = false): PlanFileStep {
  return { key: keyOf(text), text, done };
}

export function decision(question: string, fields: Partial<PlanFileDecision> = {}): PlanFileDecision {
  return { key: keyOf(question), question, done: false, suggested: [], ...fields };
}

export function checkpoint(title: string, fields: Partial<PlanFileCheckpoint> = {}): PlanFileCheckpoint {
  const decisions = (fields.decisions ?? []).map((entry) => ({ ...entry, checkpoint: keyOf(title) }));
  return { key: keyOf(title), title, done: false, steps: [], ...fields, decisions };
}

/** A plan as the app reads it; the decisions that wait are worked out the way core/plan-file does. */
export function planFile(fields: Partial<PlanFileView> = {}): PlanFileView {
  const checkpoints = fields.checkpoints ?? [];
  const decisions = fields.decisions ?? [];
  const waiting = [...checkpoints.filter((entry) => !entry.done).flatMap((entry) => entry.decisions), ...decisions].filter((entry) => !entry.done).map((entry) => entry.key);
  return {
    file: 'PLAN.md', source: fields.source ?? (checkpoints.length || decisions.length || fields.steps?.length || fields.intro ? 'file' : 'none'),
    title: 'Plan', intro: '', sections: [], steps: [], changes: [], ...fields, checkpoints, decisions, waiting: fields.waiting ?? waiting,
  };
}
