import { Link } from 'react-router-dom';
import { Boxes } from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Spinner } from '../../components/ui/spinner.js';
import { Switch } from '../../components/ui/switch.js';
import { cn } from '../../lib/utils.js';
import type { SkillCategory, SkillItem } from '../../types.js';
import {
  builtInGroups, categoryGroups, coveredByCategory, isLibrarySkill, onSkillIds, pickAll, setCategory, skillStatus, toggleSkill,
  type SkillChoice,
} from '../skills/skillSelection.js';
import { OptionGroup } from './MoreOptions.js';

/**
 * Which of My library a new workspace starts with: whole categories (every skill in them, now and later) and single
 * skills. Skills a tool ships itself are always on in that tool, so they are only mentioned, never offered.
 */
export function SkillPicker({
  skills,
  categories,
  loading,
  choice,
  onChange,
}: {
  skills: readonly SkillItem[];
  categories: readonly SkillCategory[];
  loading: boolean;
  choice: SkillChoice;
  onChange: (next: SkillChoice) => void;
}) {
  const library = skills.filter(isLibrarySkill);
  const builtIn = builtInGroups(skills);
  const builtInCount = builtIn.reduce((total, group) => total + group.skills.length, 0);
  const groups = categoryGroups(categories, skills, choice.categories);
  const singles = library.filter((skill) => !coveredByCategory(skill, choice));
  const onCount = onSkillIds(library, choice).length;
  const allOn = library.length > 0 && onCount === library.length;

  const skillCard = (skill: SkillItem) => {
    const isChecked = skillStatus(skill, choice).on;
    return (
      <label
        key={skill.id}
        className={cn(
          'flex items-center justify-between gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors select-none text-left',
          isChecked
            ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/40 text-foreground'
            : 'border-border bg-card hover:border-foreground/20 text-muted-foreground',
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Checkbox
            checked={isChecked}
            onCheckedChange={() => onChange(toggleSkill(choice, skill))}
            aria-label={`Select ${skill.title || skill.name}`}
          />
          <div className="min-w-0">
            <p className="font-mono text-xs font-medium truncate text-foreground">{skill.title || skill.name}</p>
            {skill.description && <p className="text-[11px] text-muted-foreground line-clamp-1">{skill.description}</p>}
          </div>
        </div>
        {skill.category && skill.category !== 'general' && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0 capitalize">{skill.category}</Badge>
        )}
      </label>
    );
  };

  return (
    <OptionGroup
      aria-label="Skills"
      icon={<Boxes className="size-4 text-primary" />}
      title={<>
        Skills
        {onCount > 0 && <span className="text-xs font-normal text-muted-foreground">({onCount} selected)</span>}
      </>}
      hint="Guides your AI tools can follow. None are needed."
      action={
        <div className="flex shrink-0 items-center gap-2">
          {library.length > 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => onChange(allOn ? { categories: [], picks: [], exceptions: [] } : pickAll(choice, library))}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {allOn ? 'Deselect All' : 'Select All'}
            </Button>
          )}
          <Link to="/skills" className="flex items-center gap-1 text-xs text-primary hover:underline">
            My library →
          </Link>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center p-3 gap-2 text-xs text-muted-foreground rounded-lg border border-border">
          <Spinner className="size-3" />
          Loading skills...
        </div>
      ) : library.length === 0 && groups.length === 0 ? (
        <div className="space-y-2">
          <div className="p-3 border border-dashed border-border rounded-lg bg-card/20 text-center">
            <p className="text-xs text-muted-foreground">
              No skills yet. Add them in{' '}
              <Link to="/skills" className="text-primary underline">My library</Link>.
            </p>
          </div>
          <BuiltInNote count={builtInCount} />
        </div>
      ) : (
        <div className="space-y-4">
          {groups.length > 0 && (
            <div className="space-y-2">
              <div className="pb-1 border-b border-border/40">
                <h4 className="text-xs font-semibold text-foreground">Categories</h4>
                <p className="text-[11px] text-muted-foreground">Turn one on to include every skill in it, including skills you add to it later.</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {groups.map((group) => (
                  <div
                    key={group.id}
                    className={cn(
                      'flex items-center justify-between gap-3 p-2.5 rounded-lg border transition-colors text-left',
                      group.on ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/40' : 'border-border bg-card',
                    )}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate text-foreground">{group.name}</p>
                      <p className="text-[11px] text-muted-foreground line-clamp-1">
                        {group.members.length} {group.members.length === 1 ? 'skill' : 'skills'}
                        {group.description ? ` · ${group.description}` : ''}
                      </p>
                    </div>
                    <Switch
                      checked={group.on}
                      onCheckedChange={(on) => onChange(setCategory(choice, skills, group.id, on))}
                      aria-label={`Turn on the ${group.name} category`}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {singles.length > 0 && (
            <div className="space-y-2">
              <div className="pb-1 border-b border-border/40">
                <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  Single skills
                  <span className="text-[11px] font-normal text-muted-foreground">({singles.length})</span>
                </h4>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">{singles.map(skillCard)}</div>
            </div>
          )}

          <BuiltInNote count={builtInCount} />
        </div>
      )}
    </OptionGroup>
  );
}

function BuiltInNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="text-[11px] text-muted-foreground">
      Your tools also have {count} built-in {count === 1 ? 'skill' : 'skills'}, always on in every folder.
    </p>
  );
}
