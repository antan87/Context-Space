import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  SIDEBAR_KEY_STEP,
  SIDEBAR_KEY_STEP_LARGE,
  SIDEBAR_MIN_WIDTH,
  sidebarMaxFor,
} from '../features/worktrees/sidebarWidth.js';
import { cn } from '../lib/utils.js';

interface SidebarResizeHandleProps {
  width: number;
  /** Moves the sidebar and returns the width it took. A drag saves only where it ends (persist=true). */
  onResize: (next: number, persist: boolean) => number;
  onReset: () => void;
  /** True while a drag is under way, so the sidebar can follow the pointer without easing behind it. */
  onDraggingChange: (dragging: boolean) => void;
}

/**
 * The edge of the expanded sidebar, which is dragged, or moved with the arrow keys, to set its width. It sits just
 * outside the sidebar, whose own edge holds its scrollbar, and takes no room from the page beside it.
 */
export function SidebarResizeHandle({ width, onResize, onReset, onDraggingChange }: SidebarResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const finish = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    onDraggingChange(false);
    onResize(current.last, true);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Holding the page still keeps a drag from selecting its text.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, last: width };
    setDragging(true);
    onDraggingChange(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    current.last = onResize(current.startWidth + event.clientX - current.startX, false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? SIDEBAR_KEY_STEP_LARGE : SIDEBAR_KEY_STEP;
    switch (event.key) {
      case 'ArrowRight': onResize(width + step, true); break;
      case 'ArrowLeft': onResize(width - step, true); break;
      case 'Home': onResize(SIDEBAR_MIN_WIDTH, true); break;
      case 'End': onResize(Number.MAX_SAFE_INTEGER, true); break;
      case 'Enter': onReset(); break;
      default: return;
    }
    event.preventDefault();
  };

  return (
    // No width of its own: the handle floats over the first pixels beside the sidebar.
    <div className="relative z-30 w-0 shrink-0 max-md:hidden">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={sidebarMaxFor(window.innerWidth)}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels wide`}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"
        tabIndex={0}
        title="Drag to resize the sidebar. Double-click or press Enter to reset it."
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={onReset}
        onKeyDown={onKeyDown}
        className="group absolute inset-y-0 left-0 w-1.5 cursor-col-resize touch-none focus-visible:outline-hidden"
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-y-0 left-0 w-0.5 bg-transparent transition-colors',
            'group-hover:bg-primary/40 group-focus-visible:bg-primary group-data-[dragging]:bg-primary',
          )}
        />
      </div>
    </div>
  );
}
