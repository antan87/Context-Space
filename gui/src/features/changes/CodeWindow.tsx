import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from '../../components/ui/icon-button.js';
import { cn } from '../../lib/utils.js';
import { useDockRect } from '../chat/dockPlacement.js';
import { LARGE_WINDOW } from '../board/boardReaderLayout.js';
import { setCodeWindowOpen } from '../workspace-shell/openRequests.js';
import type { Feature } from '../../types.js';
import { CodeSection } from './CodeSection.js';

type SectionProps = Omit<ComponentProps<typeof CodeSection>, 'ws' | 'active' | 'showToast' | 'panelActions' | 'autoSelect' | 'onAskAI'>;

export interface CodeWindowProps {
  ws: Feature;
  open: boolean;
  /** Where the keyboard returns on close; when it is gone, the Board's Code button. */
  opener: HTMLElement | null;
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

/**
 * The Code section in a large window over the whole workspace content, the way the Board's reader is a large window over the
 * board. It stays mounted once opened (hidden and inert while closed), so the chosen file and its scroll survive a close.
 */
export default function CodeWindow({ ws, open, opener, cover, sectionProps, showToast, askAI, onClose }: CodeWindowProps) {
  const rect = useDockRect(cover);
  const panel = useRef<HTMLDivElement>(null);
  const skipFocusReturn = useRef(false);
  const wasOpen = useRef(false);
  const workspace = ws.branchName;

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
    const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-testid="board-code-button"]');
    target?.focus({ preventScroll: true });
    return undefined;
  }, [open, opener]);

  // Escape closes, unless something in the window has a use for it first. What was open is looked at before the key does its work:
  // a menu or the find box is already closing by the time this runs. Whether another handler took the key is looked at after
  // all of them have run (the filter field clears itself, the Ask AI form closes), so they never also close the window.
  const blocked = useRef(false);
  useEffect(() => {
    if (!open) return undefined;
    const onCapture = (event: KeyboardEvent) => {
      blocked.current = event.key === 'Escape' && (document.querySelector(OWNS_ESCAPE) !== null || isField(event.target));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || blocked.current) return;
      setTimeout(() => { if (!event.defaultPrevented) onClose(); }, 0);
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  // A press outside the window closes it: it must begin and end on the dimmed area, so a selection dragged out of the window does not.
  const pressedOutside = useRef(false);

  const ask = useCallback(async (message: string) => {
    const sent = await askAI(message);
    if (sent) {
      // The person should see the terminal: the AI's reply is there, and the keyboard is in it
      skipFocusReturn.current = true;
      onClose();
    }
    return sent;
  }, [askAI, onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      data-code-window-backdrop=""
      hidden={!open}
      inert={open ? undefined : true}
      className={cn('fixed z-30 flex items-center justify-center bg-background/50 animate-fade-in', !rect && 'hidden')}
      style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined}
      onPointerDown={(event) => { pressedOutside.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        const outside = pressedOutside.current && event.target === event.currentTarget;
        pressedOutside.current = false;
        if (outside) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="region"
        aria-label="Code window"
        data-code-window=""
        className="@container flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl outline-hidden"
        style={{ width: `${LARGE_WINDOW.width * 100}%`, height: `${LARGE_WINDOW.height * 100}%` }}
      >
        <CodeSection
          {...sectionProps}
          ws={ws}
          active={open}
          autoSelect
          showToast={showToast}
          onAskAI={ask}
          panelActions={<IconButton size="sm" label="Close" icon={<X />} onClick={onClose} />}
        />
      </div>
    </div>,
    document.body,
  );
}
