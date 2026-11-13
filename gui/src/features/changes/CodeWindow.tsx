import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useDockRect } from '../chat/dockPlacement.js';
import { LARGE_WINDOW } from '../board/boardReaderLayout.js';
import { WorkspaceFileView } from './WorkspaceFileView.js';
import { resolveCodeWindowOpener, setCodeWindowOpen, type OpenerTarget, type WorkspaceFile } from '../workspace-shell/openRequests.js';
import type { Feature } from '../../types.js';
import { CodeSection } from './CodeSection.js';

type SectionProps = Omit<ComponentProps<typeof CodeSection>, 'ws' | 'active' | 'showToast' | 'panelActions' | 'autoSelect' | 'onAskAI' | 'onToggleFullScreen'>;

export interface CodeWindowProps {
  workspaceFile?: WorkspaceFile;
  fileRequestId: number;
  ws: Feature;
  open: boolean;
  /** Where the keyboard returns on close; when it is gone, the Board's Code button. */
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

/** What a key belongs to when it is typed in it: a field, so Escape there is the field's. The editor is not one (it is checked on its own). */
const isField = (target: EventTarget | null) => target instanceof HTMLElement
  && !target.closest('.monaco-editor')
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('.xterm') !== null);

/** Anything open that takes Escape for itself: a menu, a dialog, the editor's find box, suggestions or context menu. */
const OWNS_ESCAPE = '[data-slot="menu-popup"], [role="dialog"], [role="menu"], .find-widget.visible, .monaco-menu-container, .suggest-widget.visible, .parameter-hints-widget.visible';

const quiet = 'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The Code section in a large window over the whole workspace content, the way the Board's reader is a large window over the
 * board. It stays mounted once opened (hidden and inert while closed), so the chosen file and its scroll survive a close.
 */
export default function CodeWindow({ workspaceFile, fileRequestId, ws, open, opener, openerTarget, cover, sectionProps, showToast, askAI, onClose }: CodeWindowProps) {
  const rect = useDockRect(cover);
  const panel = useRef<HTMLDivElement>(null);
  const skipFocusReturn = useRef(false);
  const wasOpen = useRef(false);
  const workspace = ws.branchName;

  const [maximized, setMaximized] = useState(false);
  const fullscreenToggleRef = useRef<HTMLButtonElement>(null);
  const pendingFullscreenFocus = useRef(false);

  const toggleMaximized = useCallback(() => {
    pendingFullscreenFocus.current = true;
    setMaximized((prev) => !prev);
  }, []);

  useLayoutEffect(() => {
    if (pendingFullscreenFocus.current) {
      pendingFullscreenFocus.current = false;
      fullscreenToggleRef.current?.focus({ preventScroll: true });
    }
  }, [maximized]);

  const handleClose = useCallback(() => {
    setMaximized(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) setMaximized(false);
  }, [open]);

  useEffect(() => {
    setCodeWindowOpen(workspace, open);
    return () => setCodeWindowOpen(workspace, false);
  }, [workspace, open]);

  // The keyboard goes into the window when it opens, and back to what opened it when it closes.
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
    const target = resolveCodeWindowOpener(opener, openerTarget);
    target?.focus({ preventScroll: true });
    return undefined;
  }, [open, opener, openerTarget]);

  // Escape when maximized steps back to the normal window first; otherwise it closes the window, unless something in the window has a use for it first.
  // What was open is looked at before the key does its work: a menu or the find box is already closing by the time this runs.
  // Whether another handler took the key is looked at after all of them have run (the filter field clears itself, the Ask AI form closes), so they never also close or exit full screen.
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
          if (maximized) {
            pendingFullscreenFocus.current = true;
            setMaximized(false);
          } else {
            handleClose();
          }
        }
      }, 0);
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, maximized, handleClose]);

  // A press outside the window closes it: it must begin and end on the dimmed area, so a selection dragged out of the window does not.
  const pressedOutside = useRef(false);

  const ask = useCallback(async (message: string) => {
    const sent = await askAI(message);
    if (sent) {
      // The person should see the terminal: the AI's reply is there, and the keyboard is in it
      skipFocusReturn.current = true;
      handleClose();
    }
    return sent;
  }, [askAI, handleClose]);

  const actions = <div className="flex items-center gap-1">
    <button ref={fullscreenToggleRef} type="button" className={quiet} aria-label={maximized ? 'Exit full screen' : 'Full screen'} title={maximized ? 'Exit full screen (Esc)' : 'Full screen'} aria-pressed={maximized} onClick={toggleMaximized}>
      {maximized ? <Minimize2 aria-hidden="true" className="size-4" /> : <Maximize2 aria-hidden="true" className="size-4" />}
    </button>
    <button type="button" className={quiet} aria-label="Close" title="Close" onClick={handleClose}><X aria-hidden="true" className="size-4" /></button>
  </div>;

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      data-code-window-backdrop=""
      hidden={!open}
      inert={open ? undefined : true}
      className={cn(
        'fixed flex items-center justify-center animate-fade-in',
        maximized ? 'inset-0 z-40 bg-background' : 'z-30 bg-background/50',
        !maximized && !rect && 'hidden',
      )}
      style={maximized ? undefined : (rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined)}
      onPointerDown={(event) => {
        if (maximized) return;
        pressedOutside.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (maximized) return;
        const outside = pressedOutside.current && event.target === event.currentTarget;
        pressedOutside.current = false;
        if (outside) handleClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="region"
        aria-label="Code window"
        data-code-window=""
        data-fullscreen={maximized ? 'true' : undefined}
        className={cn(
          '@container flex min-h-0 flex-col overflow-hidden bg-background outline-hidden',
          maximized
            ? 'h-full w-full rounded-none border-0'
            : 'rounded-xl border border-border shadow-2xl',
        )}
        style={maximized ? undefined : { width: `${LARGE_WINDOW.width * 100}%`, height: `${LARGE_WINDOW.height * 100}%` }}
      >
        {workspaceFile && open && <WorkspaceFileView file={workspaceFile} requestId={fileRequestId} actions={actions} />}
        <div style={{ display: workspaceFile ? 'none' : 'contents' }} hidden={!!workspaceFile} inert={workspaceFile ? true : undefined}>
        <CodeSection
          {...sectionProps}
          ws={ws}
          active={open && !workspaceFile}
          autoSelect
          showToast={showToast}
          onAskAI={ask}
          onToggleFullScreen={toggleMaximized}
          panelActions={workspaceFile ? undefined : actions}
        />
        </div>
      </div>
    </div>,
    document.body,
  );
}
