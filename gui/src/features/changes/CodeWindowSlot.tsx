import { lazy, Suspense, useCallback, useEffect, useState, type ComponentProps } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { goToWorkspace, parseWorkspacePath } from '../chat/chatRoute.js';
import { invalidateReferenceIntent, referenceRequestIsCurrent, openCodeWindow, useCodeWindowRequest } from '../workspace-shell/openRequests.js';
import type { Feature } from '../../types.js';

const CodeWindow = lazy(() => import('./CodeWindow.js'));

type WindowProps = ComponentProps<typeof CodeWindow>;

/**
 * Where the Code window hangs in the workspace page. It costs nothing until the first request to open (a button, the card
 * in the Board, a path pressed in the terminal, or the old `/changes` link): then the window loads, and afterwards it stays
 * mounted, hidden while closed, so the file and its scroll are kept.
 */
export function CodeWindowSlot({ ws, cover, sectionProps, showToast, askAI }: Pick<WindowProps, 'cover' | 'sectionProps' | 'showToast' | 'askAI'> & { ws: Feature }) {
  const workspace = ws.branchName;
  const request = useCodeWindowRequest(workspace);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // The old address of Code opens the board with the window over it, and closing leaves the address on the board.
  const section = parseWorkspacePath(pathname);
  const oldLink = section?.workspace === workspace && section.section === 'changes';
  useEffect(() => {
    if (!oldLink) return;
    openCodeWindow(workspace);
    goToWorkspace(navigate, workspace, 'board', { replace: true });
  }, [oldLink, workspace, navigate]);

  // A request from before this page mounted is not asked for again; one made a moment ago (a path pressed in another
  // workspace's terminal, which navigated here) is.
  const [shown, setShown] = useState<{ id: number; open: boolean; everOpened: boolean; accepted: typeof request }>(() => ({ id: request && !(request.request.navigated && Date.now() - request.request.at < 3000) ? request.id : 0, open: false, everOpened: false, accepted: null }));
  if (request && request.id !== shown.id) setShown(referenceRequestIsCurrent(request.request)
    ? { id: request.id, open: !request.request.close, everOpened: shown.everOpened || !request.request.close, accepted: request }
    : { ...shown, id: request.id });
  const close = useCallback(() => { invalidateReferenceIntent(); setShown((current) => ({ ...current, open: false })); }, []);

  // Once opened it is never unmounted
  const accepted = shown.accepted;
  if (!shown.everOpened || !accepted) return null;
  return (
    <Suspense fallback={null}>
      <CodeWindow workspaceFile={accepted.request.workspaceFile} commitOpen={accepted.request.commit} fileRequestId={accepted.id} ws={ws} open={shown.open} opener={accepted.request.opener} openerTarget={accepted.request.openerTarget} cover={cover} sectionProps={sectionProps} showToast={showToast} askAI={askAI} onClose={close} />
    </Suspense>
  );
}
