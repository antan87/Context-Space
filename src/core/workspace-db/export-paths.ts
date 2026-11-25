export const PLAN_EXPORT = 'PLAN.md';
export const DATA_EXPORT = 'contextspace-data.json';
export type ExportFile = typeof PLAN_EXPORT | typeof DATA_EXPORT;

export const visibleDraftKey = (file: ExportFile) => `visible_draft_${file}`;
export const fetchedDraftBaseKey = (digest: string) => `git_draft_base_${digest}`;
