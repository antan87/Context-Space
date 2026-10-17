import type { HTMLAttributes, ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

import { cn } from '../../lib/utils.js';

const PANEL_ID = 'more-options-panel';

/**
 * The one place for everything a new workspace does not need to ask about.
 * Closed by default: every option inside already has a good default, so a
 * workspace made without opening it is made with those defaults. The closed
 * button says what was changed, so nothing set in here is out of sight.
 *
 * The panel stays in the page while closed (hidden), so the button's
 * aria-controls always points at something.
 */
export function MoreOptions({ open, onOpenChange, changes, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Short phrases for each option that is not at its default; empty when none are. */
  changes: string[];
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card shadow-xs">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={PANEL_ID}
          onClick={() => onOpenChange(!open)}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-4 py-3 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">More options</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {changes.length > 0 ? `Changed: ${changes.join(', ')}` : 'Skills, AI tools, branches and more. The defaults are fine.'}
            </span>
          </span>
          <ChevronDown aria-hidden="true" className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>
      </h2>
      <div id={PANEL_ID} hidden={!open} className="border-t border-border">
        <div className="divide-y divide-border">{children}</div>
      </div>
    </section>
  );
}

/** One option inside More options: what it is, a line on what it does, then its controls. */
export function OptionGroup({ title, hint, icon, action, children, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  /** Something to do with the whole group, at the end of its heading row. */
  action?: ReactNode;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className="px-4 py-4" {...rest}>
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">{icon}{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
