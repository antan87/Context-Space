/**
 * The plan as GET /api/workspace/:id/plan sends it (core/plan-file-app): PLAN.md's free text as written, and its
 * checkpoints, steps and decisions to tick and answer. Pure apart from the queries, so the words are tested alone.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';
import { whenText, whoName } from './planView.js';

export interface PlanProof {
  lastVerificationSha?: string;
  lastVerificationStatus?: string;
  canProgress: boolean;
  at?: string;
}

export interface PlanFileStep { key: string; text: string; done: boolean }

export interface PlanFileDecision {
  key: string;
  question: string;
  done: boolean;
  answer?: string;
  suggested: string[];
  ifNoAnswer?: string;
  detail?: string;
  /** The checkpoint it holds up. */
  checkpoint?: string;
}

export interface PlanFileCheckpoint {
  key: string;
  title: string;
  done: boolean;
  /** The command that proves it; `null` for the workspace's own checks; missing without a check. */
  check?: string | null;
  proof?: PlanProof;
  outcome?: string;
  detail?: string;
  steps: PlanFileStep[];
  decisions: PlanFileDecision[];
}

export interface PlanFileChange {
  at: string;
  by: string;
  action: 'added' | 'removed' | 'ticked' | 'unticked' | 'answered';
  kind: 'checkpoint' | 'step' | 'decision';
  key: string;
  text: string;
  note?: string;
}

export interface PlanFileView {
  file: string;
  /** `store`: an older plan, shown as the PLAN.md it becomes on the first change. */
  source: 'file' | 'store' | 'none';
  title: string;
  intro: string;
  sections: Array<{ heading: string; body: string }>;
  checkpoints: PlanFileCheckpoint[];
  steps: PlanFileStep[];
  decisions: PlanFileDecision[];
  /** The keys of the decisions that wait for the user's answer. */
  waiting: string[];
  changes: PlanFileChange[];
}

export type PlanFileChangeInput =
  | { type: 'tick'; key: string; done: boolean; expected: string }
  | { type: 'answer'; key: string; answer: string; expected: string }
  | { type: 'add'; step: string; checkpoint?: string }
  | { type: 'check'; key: string }
  | { type: 'reopen'; key: string; reason: string; expected: string };

export const planFileKey = (workspace: string | null) => ['plan-file', workspace] as const;

/** The plan, read again when any tool changes PLAN.md (the screen feed says so) and every half minute otherwise. */
export function usePlanFile(workspace: string | null) {
  return useQuery({
    queryKey: planFileKey(workspace),
    queryFn: async ({ signal }) => {
      const plan = await apiFetch<PlanFileView>(`/api/workspace/${encodeURIComponent(workspace!)}/plan`, { signal });
      // An older backend answers this address with something else; say so rather than draw nothing.
      if (!Array.isArray(plan?.checkpoints)) throw new Error('the plan came back in a form this version of the app does not read');
      return plan;
    },
    enabled: Boolean(workspace),
    staleTime: 5000,
    refetchInterval: 30_000,
  });
}

/** One change as the user. Ticking a checkpoint with a check runs the check first, so that can take a while. */
export function useChangePlanFile(workspace: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: PlanFileChangeInput) => apiFetch<{ message: string; plan: PlanFileView }>(
      `/api/workspace/${encodeURIComponent(workspace)}/plan`,
      { method: 'POST', body: JSON.stringify({ change }) },
    ),
    onSuccess: (result) => {
      queryClient.setQueryData(planFileKey(workspace), result.plan);
      void queryClient.invalidateQueries({ queryKey: ['needs-you'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-work', workspace] });
    },
    // A line that changed meanwhile is refused; reading the plan again shows what is there now.
    onError: () => { void queryClient.invalidateQueries({ queryKey: planFileKey(workspace) }); },
  });
}

/** What a checkpoint's last check proved, and how it should look. Empty for a checkpoint without a check. */
export function proofLook(checkpoint: Pick<PlanFileCheckpoint, 'check' | 'proof'>, now: Date = new Date()): { text: string; tone: 'done' | 'failed' | 'quiet' } | null {
  if (checkpoint.check === undefined && !checkpoint.proof) return null;
  const proof = checkpoint.proof;
  if (!proof) return { text: 'Not checked yet', tone: 'quiet' };
  const commit = proof.lastVerificationSha ? ` on ${proof.lastVerificationSha.slice(0, 7)}` : '';
  const when = whenText(proof.at, now);
  const result = proof.canProgress ? `Check passed${commit}` : proof.lastVerificationStatus === 'timeout' ? 'Check took too long' : `Check failed${commit}`;
  return { text: when ? `${result} · ${when}` : result, tone: proof.canProgress ? 'done' : 'failed' };
}

/** Who changed something in the plan, as people say it. */
export function changedBy(by: string): string {
  if (by === 'file') return 'An edit to PLAN.md';
  if (by === 'ai') return 'An AI';
  return whoName(by);
}

const ACTION: Record<PlanFileChange['action'], string> = { added: 'added', removed: 'removed', ticked: 'ticked', unticked: 'unticked', answered: 'answered' };

/** One line of What changed: "Claude ticked “Write the CSV writer”". */
export function changeLine(change: PlanFileChange): string {
  return `${changedBy(change.by)} ${ACTION[change.action]} “${change.text}”${change.note ? `: ${change.note}` : ''}`;
}

/** How far a checkpoint is: its steps ticked, out of all of them. */
export function stepsDone(checkpoint: Pick<PlanFileCheckpoint, 'steps'>): { done: number; total: number } {
  return { done: checkpoint.steps.filter((step) => step.done).length, total: checkpoint.steps.length };
}
