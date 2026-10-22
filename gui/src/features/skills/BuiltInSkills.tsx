import { Library } from 'lucide-react';

import { Button } from '../../components/ui/button.js';
import { Spinner } from '../../components/ui/spinner.js';
import type { SkillItem } from '../../types.js';
import { builtInGroups } from './skillSelection.js';
import { useAddToLibrary, type ShowToast } from './useAddToLibrary.js';

export function AddToLibraryButton({ skill, add, busy }: { skill: SkillItem; add: (skill: SkillItem) => void; busy: boolean }) {
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={busy}
      onClick={() => add(skill)}
      aria-label={`Add ${skill.title || skill.id} to my library`}
      className="shrink-0"
    >
      {busy ? <Spinner className="size-3" /> : <Library className="size-3" />}
      <span>Add to my library</span>
    </Button>
  );
}

/**
 * The skills each tool ships itself. They are always on in that tool, in every folder, and cannot be turned on or off per
 * workspace; the one thing to do with them here is copy one into My library.
 */
export function BuiltInSkills({
  skills,
  showToast,
  onPreview,
}: {
  skills: readonly SkillItem[];
  showToast?: ShowToast;
  onPreview?: (skill: SkillItem) => void;
}) {
  const { add, pending } = useAddToLibrary(showToast);
  const groups = builtInGroups(skills);

  if (groups.length === 0) {
    return <p className="text-xs text-muted-foreground">None of your tools ship skills of their own that were found.</p>;
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <details key={group.harness} className="group rounded-lg border border-border bg-card/60">
          <summary className="flex cursor-pointer select-none items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs hover:bg-muted/40">
            <span className="font-semibold text-foreground">Built into {group.label}</span>
            <span className="text-muted-foreground">
              {group.skills.length} {group.skills.length === 1 ? 'skill' : 'skills'} · always on in {group.label}, in every folder
            </span>
          </summary>
          <ul className="divide-y divide-border/50 border-t border-border/60">
            {group.skills.map((skill) => (
              <li key={skill.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  {onPreview ? (
                    <button type="button" onClick={() => onPreview(skill)} className="max-w-full truncate text-left font-mono text-xs font-medium text-foreground hover:underline">
                      {skill.title || skill.id}
                    </button>
                  ) : (
                    <p className="truncate font-mono text-xs font-medium text-foreground">{skill.title || skill.id}</p>
                  )}
                  {skill.description && <p className="line-clamp-2 text-[11px] text-muted-foreground">{skill.description}</p>}
                </div>
                <AddToLibraryButton
                  skill={skill}
                  add={add}
                  busy={pending?.harness === skill.source?.harness && pending?.id === skill.id}
                />
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
