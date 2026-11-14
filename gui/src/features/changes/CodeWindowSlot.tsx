import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { goToWorkspace, parseWorkspacePath } from '../chat/chatRoute.js';
import { invalidateReferenceIntent, referenceRequestIsCurrent, openCodeWindow, useCodeWindowRequest } from '../workspace-shell/openRequests.js';
import {
  buildReviewHistoryState,
  createReviewToken,
  isActiveReviewEntry,
  readReviewMarker,
  retireReviewToken,
  setActiveReviewSession,
  stripReviewHistoryState,
} from './reviewHistory.js';
import type { Feature } from '../../types.js';

const CodeWindow = lazy(() => import('./CodeWindow.js'));

type WindowProps = ComponentProps<typeof CodeWindow>;

type WindowHistorySnapshot = {
  usr: unknown;
  marker: ReturnType<typeof readReviewMarker>;
  key: string | null;
  idx: number | null;
  target: string;
};

type ReviewEntry = {
  token: string;
  locationKey: string | null;
  idx: number | null;
  target: string;
};

type PendingBack = {
  fromKey: string | null;
  fromIdx: number | null;
  fromTarget: string;
  entryToken: string;
  hideOnArriveForRequestId?: number;
};

function readLiveHashTarget(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hash.replace(/^#/, '') || '/';
}

function readWindowHistory(): WindowHistorySnapshot {
  const target = readLiveHashTarget();
  if (typeof window === 'undefined' || !window.history.state || typeof window.history.state !== 'object') {
    return { usr: null, marker: null, key: null, idx: null, target };
  }
  const state = window.history.state as { usr?: unknown; key?: unknown; idx?: unknown };
  const usr = state.usr ?? null;
  return {
    usr,
    marker: readReviewMarker(usr),
    key: typeof state.key === 'string' ? state.key : null,
    idx: typeof state.idx === 'number' ? state.idx : null,
    target,
  };
}

function isOnReviewEntry(
  live: WindowHistorySnapshot,
  entry: ReviewEntry | null,
  workspace: string,
): boolean {
  if (!entry || !live.marker || live.marker.token !== entry.token) return false;
  if (!isActiveReviewEntry(live.usr, workspace)) return false;
  if (entry.idx !== null && live.idx !== null && live.idx !== entry.idx) return false;
  if (entry.locationKey !== null && live.key !== null && live.key !== entry.locationKey) return false;
  if (live.target && entry.target && live.target !== entry.target) return false;
  return true;
}

function didPopBackwardFrom(
  live: WindowHistorySnapshot,
  entry: ReviewEntry,
  navigationType: string,
): boolean {
  if (navigationType !== 'POP') return false;
  if (entry.idx === null || live.idx === null) return false;
  return live.idx < entry.idx;
}

function isAtPendingBackOrigin(live: WindowHistorySnapshot, pending: PendingBack): boolean {
  if (pending.fromIdx !== null && live.idx !== null && live.idx !== pending.fromIdx) return false;
  if (pending.fromKey !== null && live.key !== null && live.key !== pending.fromKey) return false;
  if (pending.fromTarget && live.target && live.target !== pending.fromTarget) return false;
  return true;
}

/**
 * Where the Review page hangs in the workspace page. It costs nothing until the first request to open (a button, the card
 * in the Board, a path pressed in the terminal, or the old `/changes` link): then the window loads, and afterwards it stays
 * mounted, hidden while closed, so the file and its scroll are kept.
 */
export function CodeWindowSlot({ ws, cover, sectionProps, showToast, askAI, returnTo, onOpenStep }: Pick<WindowProps, 'cover' | 'sectionProps' | 'showToast' | 'askAI' | 'returnTo' | 'onOpenStep'> & { ws: Feature }) {
  const workspace = ws.branchName;
  const request = useCodeWindowRequest(workspace);
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { pathname, search, key: locationKey } = location;

  // The old address of Code opens the board with Review over it, and closing leaves the address on the board.
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

  const [backSettledTick, setBackSettledTick] = useState(0);
  const shownRef = useRef(shown);
  useLayoutEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  const reviewEntryRef = useRef<ReviewEntry | null>(null);
  const backInFlightRef = useRef<PendingBack | null>(null);
  const backTimerRef = useRef<number | null>(null);

  const clearBackTimer = useCallback(() => {
    if (backTimerRef.current !== null) {
      window.clearTimeout(backTimerRef.current);
      backTimerRef.current = null;
    }
  }, []);

  const startBack = useCallback((
    live: WindowHistorySnapshot,
    entryToken: string,
    hideOnArriveForRequestId?: number,
  ) => {
    backInFlightRef.current = {
      fromKey: live.key,
      fromIdx: live.idx,
      fromTarget: live.target,
      entryToken,
      hideOnArriveForRequestId,
    };
    clearBackTimer();
    backTimerRef.current = window.setTimeout(() => {
      backTimerRef.current = null;
      backInFlightRef.current = null;
      if (reviewEntryRef.current?.token === entryToken) {
        reviewEntryRef.current = null;
      }
      retireReviewToken(entryToken);
      setActiveReviewSession(null);
      if (hideOnArriveForRequestId !== undefined) {
        setShown((current) => (current.open && current.id === hideOnArriveForRequestId ? { ...current, open: false } : current));
      } else {
        setBackSettledTick((tick) => tick + 1);
      }
    }, 250);
    navigate(-1);
  }, [clearBackTimer, navigate]);

  useEffect(() => () => {
    clearBackTimer();
  }, [clearBackTimer]);

  useEffect(() => {
    const onPopState = () => {
      const live = readWindowHistory();
      const pendingBack = backInFlightRef.current;
      if (pendingBack) {
        if (isAtPendingBackOrigin(live, pendingBack)) return;
        backInFlightRef.current = null;
        clearBackTimer();
        if (reviewEntryRef.current?.token === pendingBack.entryToken) {
          reviewEntryRef.current = null;
        }
        setActiveReviewSession(null);
        if (pendingBack.hideOnArriveForRequestId !== undefined) {
          if (pendingBack.hideOnArriveForRequestId === shownRef.current.id) {
            invalidateReferenceIntent();
          }
          setShown((current) => {
            if (!current.open || current.id !== pendingBack.hideOnArriveForRequestId) return current;
            return { ...current, open: false };
          });
          if (pendingBack.hideOnArriveForRequestId !== shownRef.current.id) {
            setBackSettledTick((tick) => tick + 1);
          }
        } else {
          setBackSettledTick((tick) => tick + 1);
        }
        return;
      }

      if (!shownRef.current.open) return;
      const entry = reviewEntryRef.current;
      if (!entry || isOnReviewEntry(live, entry, workspace)) return;
      if (!(entry.idx !== null && live.idx !== null && live.idx < entry.idx)) {
        retireReviewToken(entry.token);
      }
      reviewEntryRef.current = null;
      setActiveReviewSession(null);
      invalidateReferenceIntent();
      setShown((current) => (current.open ? { ...current, open: false } : current));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [workspace, clearBackTimer]);

  useLayoutEffect(() => {
    const live = readWindowHistory();

    if (oldLink) {
      if (reviewEntryRef.current && !isOnReviewEntry(live, reviewEntryRef.current, workspace)) {
        if (!didPopBackwardFrom(live, reviewEntryRef.current, navigationType)) {
          retireReviewToken(reviewEntryRef.current.token);
        }
        reviewEntryRef.current = null;
        setActiveReviewSession(null);
      }
      return;
    }

    const pendingBack = backInFlightRef.current;
    if (pendingBack) {
      if (isAtPendingBackOrigin(live, pendingBack)) return;
      backInFlightRef.current = null;
      clearBackTimer();
      if (reviewEntryRef.current?.token === pendingBack.entryToken) {
        reviewEntryRef.current = null;
      }
      setActiveReviewSession(null);
      if (pendingBack.hideOnArriveForRequestId !== undefined && shown.open && shown.id === pendingBack.hideOnArriveForRequestId) {
        invalidateReferenceIntent();
        setShown((current) => (
          current.open && current.id === pendingBack.hideOnArriveForRequestId ? { ...current, open: false } : current
        ));
        return;
      }
    }

    const entryIsActive = isActiveReviewEntry(live.usr, workspace);

    if (shown.open) {
      const tracked = reviewEntryRef.current;
      if (tracked) {
        if (isOnReviewEntry(live, tracked, workspace)) {
          setActiveReviewSession({ workspace, token: tracked.token, locationKey: live.key ?? locationKey });
          return;
        }
        if (!didPopBackwardFrom(live, tracked, navigationType)) {
          retireReviewToken(tracked.token);
        }
        reviewEntryRef.current = null;
        setActiveReviewSession(null);
        invalidateReferenceIntent();
        setShown((current) => (current.open ? { ...current, open: false } : current));
        return;
      }

      if (entryIsActive && live.marker) {
        reviewEntryRef.current = {
          token: live.marker.token,
          locationKey: live.key,
          idx: live.idx,
          target: live.target,
        };
        setActiveReviewSession({ workspace, token: live.marker.token, locationKey: live.key ?? locationKey });
        return;
      }

      // If a navigation to another route is in flight via transition before Review pushed, do not push over it.
      if (live.key && live.key !== locationKey) {
        return;
      }

      // Opening Review adds 1 history entry so Browser Back can close it.
      const token = createReviewToken(workspace);
      navigate(
        { pathname, search },
        { state: buildReviewHistoryState(live.usr, { workspace, token }) },
      );
      const pushed = readWindowHistory();
      reviewEntryRef.current = {
        token,
        locationKey: pushed.key,
        idx: pushed.idx,
        target: pushed.target,
      };
      setActiveReviewSession({ workspace, token, locationKey: pushed.key ?? locationKey });
      return;
    }

    // Reopen only on POP (e.g. Browser Forward) into a still-live Review history entry.
    if (entryIsActive && live.marker && navigationType === 'POP') {
      reviewEntryRef.current = {
        token: live.marker.token,
        locationKey: live.key,
        idx: live.idx,
        target: live.target,
      };
      setActiveReviewSession({ workspace, token: live.marker.token, locationKey: live.key ?? locationKey });
      setShown((current) => (current.open ? current : { ...current, open: true, everOpened: true }));
      return;
    }

    // If closed externally while sitting on the active Review entry, retire it and step back cleanly.
    if (reviewEntryRef.current && isOnReviewEntry(live, reviewEntryRef.current, workspace)) {
      const token = reviewEntryRef.current.token;
      reviewEntryRef.current = null;
      setActiveReviewSession(null);
      retireReviewToken(token);
      startBack(live, token);
      return;
    }

    if (reviewEntryRef.current) {
      if (!didPopBackwardFrom(live, reviewEntryRef.current, navigationType)) {
        retireReviewToken(reviewEntryRef.current.token);
      }
      reviewEntryRef.current = null;
      setActiveReviewSession(null);
    }

    // Reload or returning after workspace switch / retired token: scrub stale __review marker via replace.
    if (live.marker && !entryIsActive && (!live.key || live.key === locationKey)) {
      navigate(
        { pathname, search },
        { replace: true, state: stripReviewHistoryState(live.usr) },
      );
    }
  }, [oldLink, shown.open, shown.id, backSettledTick, workspace, locationKey, pathname, search, navigationType, navigate, clearBackTimer, startBack]);

  const close = useCallback(() => {
    if (!shownRef.current.open || backInFlightRef.current) return;
    invalidateReferenceIntent();

    const live = readWindowHistory();
    const entry = reviewEntryRef.current;
    if (entry && isOnReviewEntry(live, entry, workspace)) {
      // Let navigate(-1) commit before hiding Review so history state is settled for any caller.
      setActiveReviewSession(null);
      startBack(live, entry.token, shownRef.current.id);
      return;
    }

    if (entry) {
      if (!didPopBackwardFrom(live, entry, 'POP')) {
        retireReviewToken(entry.token);
      }
      reviewEntryRef.current = null;
    } else if (live.marker && isActiveReviewEntry(live.usr, workspace)) {
      retireReviewToken(live.marker.token);
    }
    setActiveReviewSession(null);
    setShown((current) => (current.open ? { ...current, open: false } : current));
  }, [startBack, workspace]);

  // Once opened it is never unmounted
  const accepted = shown.accepted;
  if (!shown.everOpened || !accepted) return null;
  return (
    <Suspense fallback={null}>
      <CodeWindow
        workspaceFile={accepted.request.workspaceFile}
        commitOpen={accepted.request.commit}
        fileRequestId={accepted.id}
        area={accepted.request.area}
        ws={ws}
        open={shown.open}
        opener={accepted.request.opener}
        openerTarget={accepted.request.openerTarget}
        cover={cover}
        sectionProps={sectionProps}
        showToast={showToast}
        askAI={askAI}
        returnTo={returnTo}
        onOpenStep={onOpenStep}
        onClose={close}
      />
    </Suspense>
  );
}
