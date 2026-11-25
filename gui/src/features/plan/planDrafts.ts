export const planDraftsKey = (workspace: string) => ['plan-drafts', workspace] as const;

export interface PlanDraft {
  digest: string;
  file: 'PLAN.md' | 'contextspace-data.json';
  at: string;
}
export interface PlanDraftList { drafts: PlanDraft[] }

export interface PlanDraftPreview {
  digest: string;
  token: string;
  revision: number;
  baseKnown: boolean;
  matched: string[];
  changes: Array<{
    kind: 'add' | 'remove' | 'reword' | 'edit' | 'move';
    label: string;
    before?: string;
    after?: string;
    conflict: boolean;
    confirm: boolean;
  }>;
}
