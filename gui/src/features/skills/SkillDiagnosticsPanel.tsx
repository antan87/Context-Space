import type { SkillDiagnosticItem } from '../../types.js';

/**
 * Skills that did not load, or loaded with something to fix, and what to do about each. Shown on
 * the global Skills page and on a workspace's Skills tab, so a skill that "doesn't work" is never
 * silent in one place and explained in the other.
 */
export function SkillDiagnosticsPanel({ diagnostics }: { diagnostics: SkillDiagnosticItem[] }) {
  if (diagnostics.length === 0) return null;
  // Collapsed by default: these are about files the user may not touch, so they should not push the skills down.
  return (
    <details role="status" className="rounded-lg border border-amber-500/40 p-4 text-sm group">
      <summary className="cursor-pointer font-semibold list-none flex items-center justify-between">
        <span>Skill discovery notices ({diagnostics.length})</span>
        <span className="text-xs font-normal text-muted-foreground group-open:hidden">Show</span>
        <span className="text-xs font-normal text-muted-foreground hidden group-open:inline">Hide</span>
      </summary>
      <ul className="mt-3 space-y-2">
        {diagnostics.map((item, index) => (
          <li key={`${item.scope}-${item.id}-${index}`}>
            <strong>{item.id}</strong> ({item.scope}){item.level === 'warning' ? '' : ' — not loaded'}: {item.message}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        You can also check from a terminal with <code>ctxspace skill lint</code>.
      </p>
    </details>
  );
}
