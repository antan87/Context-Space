import { PlanDocument } from '../plan/PlanDocument.js';

/** The plan on the workspace home: PLAN.md, as a document to read, tick and answer. */
export function HomePlan({ workspaceId, workspacePath, readOnly = false, onChanged }: { workspaceId: string; workspacePath?: string; readOnly?: boolean; onChanged?: () => void }) {
  return <PlanDocument workspaceId={workspaceId} workspacePath={workspacePath} readOnly={readOnly} onChanged={onChanged} />;
}
