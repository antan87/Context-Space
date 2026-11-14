import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.js';
import { useDockRect } from '../chat/dockPlacement.js';
import { WorkspaceFileView } from './WorkspaceFileView.js';
import { resolveCodeWindowOpener, setCodeWindowOpen, type OpenerTarget, type WorkspaceFile } from '../workspace-shell/openRequests.js';
import type { Feature } from '../../types.js';
import { CodeSection } from './CodeSection.js';
import { indexInSequence, sameCommit, type CommitOpen, type CommitRef } from './commitsMode.js';
import { parseCommitNodeId } from '../board/boardActions.js';

type SectionProps = Omit<ComponentProps<typeof CodeSection>, 'ws' | 'active' | 'showToast' | 'panelActions' | 'autoSelect' | 'onAskAI' | 'requestId' | 'commitOpen' | 'onShownCommit' | 'backAction' | 'breadcrumb' | 'area'>;

export interface CodeWindowProps {
  workspaceFile?: WorkspaceFile;
  /** The commit the window was asked to open on (Commits mode), with the commits of the row it came from. */
  commitOpen?: CommitOpen;
  fileRequestId: number;
  /** Area name shown in the Review breadcrumb when opened from an Area. */
  area?: string;
  ws: Feature;
  open: boolean;
  /** Where the keyboard returns on close; when it is gone, the Board's Review button. */
  opener: HTMLElement | null;
  openerTarget?: OpenerTarget | null;
  /** The workspace content the window covers: both panes in Split. */
  cover: HTMLElement | null;
  sectionProps: SectionProps;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Types a line into the AI session; true when one took it. */
  askAI: (message: string) => Promise<boolean>;
  onClose: () => void;
}

/** The main button of the drawn card of a commit, when it is on screen and can take the keyboard. */
function findCommitCard(commit: CommitRef): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>('.react-flow__node-commit[data-id]')) {
    const parsed = parseCommitNodeId(node.getAttribute('data-id') ?? '');
    if (!parsed || !sameCommit(parsed, commit) || node.closest('[inert], [hidden]')) continue;
    const button = node.querySelector<HTMLElement>('[data-card-main]');
    if (button && button.isConnected && !button.hasAttribute('disabled') && button.getClientRects().length > 0) return button;
  }
  return null;
}

/** What a key belongs to when it is typed in it: a field, so Escape there is the field's. The editor is not one (it is checked on its own). */
const isField = (target: EventTarget | null) => target instanceof HTMLElement
  && !target.closest('.monaco-editor')
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('.xterm') !== null);

/** Anything open that takes Escape for itself: a menu, a dialog, the editor's find box, suggestions or context menu. */
const OWNS_ESCAPE = '[data-slot="menu-popup"], [role="dialog"], [role="menu"], .find-widget.visible, .monaco-menu-container, .suggest-widget.visible, .parameter-hints-widget.visible';

/**
 * The Review page over the workspace content (full-frame below WorkspaceHeader in Board, Split and phone widths).
 * It stays mounted once opened (hidden and inert while closed), so the chosen file and its scroll survive a close.
 */
export default function CodeWindow({ workspaceFile, commitOpen, fileRequestId, area, ws, open, opener, openerTarget, cover, sectionProps, showToast, askAI, onClose }: CodeWindowProps) {
  const rect = useDockRect(cover);
  const panel = useRef<HTMLDivElement>(null);
  const skipFocusReturn = useRef(false);
  const shownCommit = useRef<CommitRef | null>(null);
  const rememberShownCommit = useCallback((commit: CommitRef | null) => { shownCommit.current = commit; }, []);
  const wasOpen = useRef(false);
  const workspace = ws.branchName;

  const handleClose = useCallback(() => {
    skipFocusReturn.current = false;
    onClose();
  }, [onClose]);

  useEffect(() => {
    setCodeWindowOpen(workspace, open);
    return () => setCodeWindowOpen(workspace, false);
  }, [workspace, open]);

  // The keyboard goes into Review when it opens, and back to what opened it when it closes.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      skipFocusReturn.current = false;
      const frame = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(frame);
    }
    if (!wasOpen.current) return undefined;
    wasOpen.current = false;
    if (skipFocusReturn.current) return undefined;
    // [ and ] may have moved to another commit of the row Review was opened from: the keyboard goes to that commit's card when it is drawn.
    const shown = shownCommit.current;
    const sequence = commitOpen?.sequence;
    const shownCard = shown && sequence && indexInSequence(sequence, shown) >= 0 ? findCommitCard(shown) : null;
    const target = shownCard ?? resolveCodeWindowOpener(opener, openerTarget);
    target?.focus({ preventScroll: true });
    return undefined;
  }, [open, opener, openerTarget, commitOpen]);

  // Escape closes Review, unless a menu, dialog, editor widget, filter or form field inside Review has a use for it first.
  const blocked = useRef(false);
  useEffect(() => {
    if (!open) return undefined;
    const onCapture = (event: KeyboardEvent) => {
      blocked.current = event.key === 'Escape' && (document.querySelector(OWNS_ESCAPE) !== null || isField(event.target));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || blocked.current) return;
      setTimeout(() => {
        if (!event.defaultPrevented) {
          handleClose();
        }
      }, 0);
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, handleClose]);

  const ask = useCallback(async (message: string) => {
    skipFocusReturn.current = true;
    let sent = false;
    try {
      sent = await askAI(message);
    } finally {
      if (!sent) skipFocusReturn.current = false;
    }
    if (sent) {
      // The person should see the terminal: the AI's reply is there, and the keyboard is in it
      onClose();
    }
    return sent;
  }, [askAI, onClose]);

  const backAction = (
    <button
      type="button"
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Back to the Board"
      title="Back to the Board (Esc)"
      onClick={handleClose}
    >
      <span aria-hidden="true">← </span>
      <span>Board</span>
      <kbd
        aria-hidden="true"
        className="hidden @[34rem]:inline-flex items-center rounded border border-border bg-muted px-1 py-0.5 font-mono text-xs font-medium leading-none text-muted-foreground"
      >
        Esc
      </kbd>
    </button>
  );

  const breadcrumb = (
    <nav
      aria-label="Breadcrumb"
      data-testid="review-breadcrumb"
      className="hidden @[44rem]:flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
    >
      <span className="shrink-0">Board</span>
      {area && (
        <>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground/60">›</span>
          <span className="min-w-0 truncate">{area}</span>
        </>
      )}
      <span aria-hidden="true" className="shrink-0 text-muted-foreground/60">›</span>
      <span className="shrink-0 font-medium text-foreground">Review</span>
    </nav>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      data-code-window-backdrop=""
      hidden={!open}
      inert={open ? undefined : true}
      className={cn(
        'fixed z-30 flex bg-background animate-fade-in',
        !rect && 'hidden',
      )}
      style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="region"
        aria-label="Review"
        data-code-window=""
        className="@container flex h-full w-full min-h-0 flex-col overflow-hidden rounded-none border-0 bg-background outline-hidden"
      >
        {workspaceFile && open && <WorkspaceFileView file={workspaceFile} requestId={fileRequestId} backAction={backAction} breadcrumb={breadcrumb} />}
        <div style={{ display: workspaceFile ? 'none' : 'contents' }} hidden={!!workspaceFile} inert={workspaceFile ? true : undefined}>
        <CodeSection
          {...sectionProps}
          ws={ws}
          active={open && !workspaceFile}
          autoSelect
          requestId={fileRequestId}
          onShownCommit={rememberShownCommit}
          commitOpen={commitOpen}
          area={area}
          backAction={backAction}
          breadcrumb={breadcrumb}
          showToast={showToast}
          onAskAI={ask}
        />
        </div>
      </div>
    </div>,
    document.body,
  );
}
