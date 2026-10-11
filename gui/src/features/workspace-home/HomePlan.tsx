import { PlanChecklist } from '../plan/PlanChecklist.js';
import { firstMessageFor } from './toolPrefs.js';
import { useWorkspaceSessions } from './useSessions.js';

/** The plan on the workspace home: a ready item starts the last-used tool on it, with a first message naming it. */
export function HomePlan({ workspaceId, readOnly = false, onChanged }: { workspaceId: string; readOnly?: boolean; onChanged?: () => void }) {
  const sessions = useWorkspaceSessions(workspaceId, !readOnly);
  const tool = sessions.lastTool;
  return <PlanChecklist workspaceId={workspaceId} readOnly={readOnly} onChanged={onChanged}
    onStartSession={!readOnly && tool ? (item) => sessions.start(tool, firstMessageFor(item)) : undefined} />;
}
