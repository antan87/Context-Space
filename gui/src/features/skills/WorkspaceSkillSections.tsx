import { useState, type ElementType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes, ChevronDown, ChevronRight, Code2, Cpu, Database, Edit2, Eye, FlaskConical, GitPullRequest, Layers, Package, ShieldCheck, Terminal, Zap,
} from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Switch } from '../../components/ui/switch.js';
import { cn } from '../../lib/utils.js';
import type { SkillItem } from '../../types.js';
import {
  coveredByCategory, matchesSkillSearch, setCategory, skillStatus, toggleSkill,
  type CategoryGroup, type SkillChoice, type SkillStatus,
} from './skillSelection.js';

const ICON_MAP: Record<string, ElementType> = {
  'git-pull-request': GitPullRequest,
  'flask-conical': FlaskConical,
  package: Package,
  database: Database,
  'shield-check': ShieldCheck,
  terminal: Terminal,
  zap: Zap,
  cpu: Cpu,
  layers: Layers,
  boxes: Boxes,
  code: Code2,
};

/** What a list of skills needs to turn skills on and off and to look at one. */
interface SkillListProps {
  choice: SkillChoice;
  onChange: (next: SkillChoice) => void;
  onPreview: (skill: SkillItem) => void;
  onEdit: (skill: SkillItem) => void;
  disabled?: boolean;
}

export function SectionHeader({ id, title, hint, action }: { id: string; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 id={id} className="text-sm font-semibold text-foreground">{title}</h3>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

function WhyChip({ status, categoryName }: { status: SkillStatus; categoryName?: string }) {
  if (status.why === 'left-out') return <Badge variant="outline" size="sm" className="font-normal">Left out</Badge>;
  if (status.why === 'category' && categoryName) return <Badge variant="secondary" size="sm" className="font-normal">From {categoryName}</Badge>;
  return null;
}

function SkillRow({
  skill,
  status,
  control,
  categoryName,
  onToggle,
  onPreview,
  onEdit,
  disabled,
  showCategory,
}: {
  skill: SkillItem;
  status: SkillStatus;
  control: 'switch' | 'checkbox' | 'none';
  /** Names the category a skill comes through, when that is not already clear from where it is listed. */
  categoryName?: string;
  onToggle: () => void;
  onPreview: () => void;
  onEdit?: () => void;
  disabled?: boolean;
  showCategory?: boolean;
}) {
  const title = skill.title || skill.name;
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      {control === 'switch' && <Switch checked={status.on} onCheckedChange={onToggle} disabled={disabled} aria-label={`Include ${title}`} className="mt-0.5" />}
      {control === 'checkbox' && <Checkbox checked={status.on} onCheckedChange={onToggle} disabled={disabled} aria-label={`Select ${title}`} className="mt-0.5" />}
      <div
        className={cn('min-w-0 flex-1', control !== 'none' && !disabled && 'cursor-pointer')}
        onClick={control !== 'none' && !disabled ? onToggle : undefined}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn('font-mono text-xs font-semibold', !status.on && control !== 'none' && 'text-muted-foreground')}>{title}</span>
          <WhyChip status={status} categoryName={categoryName} />
          {showCategory && skill.category && skill.category !== 'general' && (
            <Badge variant="outline" size="sm" className="font-normal capitalize">{skill.category}</Badge>
          )}
        </div>
        <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{skill.description || 'No description provided.'}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="icon-xs" onClick={onPreview} title="Read the playbook" aria-label={`Read ${title}`}>
          <Eye className="size-3.5" />
        </Button>
        {onEdit && (
          <Button variant="ghost" size="icon-xs" onClick={onEdit} title="Edit the playbook" aria-label={`Edit ${title}`}>
            <Edit2 className="size-3" />
          </Button>
        )}
      </div>
    </li>
  );
}

function CategoryCard({
  group,
  skills,
  query,
  choice,
  onChange,
  onPreview,
  onEdit,
  disabled,
}: SkillListProps & { group: CategoryGroup; skills: readonly SkillItem[]; query: string }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON_MAP[group.icon || 'boxes'] ?? Boxes;
  const total = group.members.length;
  const included = group.members.filter((skill) => skillStatus(skill, choice).on).length;
  const searching = query.trim().length > 0;
  const nameMatches = matchesSkillSearch({ name: group.id, title: group.name, description: group.description }, query);
  const shown = searching && !nameMatches ? group.members.filter((skill) => matchesSkillSearch(skill, query)) : group.members;
  if (searching && !nameMatches && shown.length === 0) return null;
  const expanded = open || (searching && shown.length > 0);

  let summary: string;
  if (total === 0) summary = group.on ? 'No skills in it yet. Any you add arrive automatically.' : 'No skills in it yet.';
  else if (group.on) summary = included === total ? `All ${total} in. Skills you add to it later arrive automatically.` : `${included} of ${total} in. Skills you add to it later arrive automatically.`;
  else summary = `${total} ${total === 1 ? 'skill' : 'skills'}. Turn it on to include all of them, now and later.`;

  return (
    <li className={cn('overflow-hidden rounded-xl border bg-card/60', group.on ? 'border-primary/50' : 'border-border')}>
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
          <span className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-white shadow-xs" style={{ backgroundColor: group.color || '#3b82f6' }}>
            <Icon className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-foreground">{group.name}</span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">{summary}</span>
          </span>
        </button>
        <Switch
          checked={group.on}
          onCheckedChange={(on) => onChange(setCategory(choice, skills, group.id, on))}
          disabled={disabled}
          aria-label={`Turn on the ${group.name} category`}
        />
      </div>
      {expanded && (
        <div className="border-t border-border/50 bg-background/50">
          {group.description && <p className="px-3 pt-2 text-[11px] text-muted-foreground">{group.description}</p>}
          {shown.length === 0 ? null : group.on ? (
            <ul className="divide-y divide-border/40">
              {shown.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  status={skillStatus(skill, choice)}
                  control="switch"
                  disabled={disabled}
                  onToggle={() => onChange(toggleSkill(choice, skill))}
                  onPreview={() => onPreview(skill)}
                  onEdit={() => onEdit(skill)}
                />
              ))}
            </ul>
          ) : (
            <>
              <p className="px-3 pt-2 text-[11px] text-muted-foreground">Turn the category on to include these, or pick them one by one under Single skills.</p>
              <ul className="divide-y divide-border/40">
                {shown.map((skill) => (
                  <SkillRow
                    key={skill.id}
                    skill={skill}
                    status={skillStatus(skill, choice)}
                    control="none"
                    onToggle={() => undefined}
                    onPreview={() => onPreview(skill)}
                    onEdit={() => onEdit(skill)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Each category with a switch. On means every skill in it, now and later; a switch inside an on category leaves one skill out. */
export function CategoriesSection({ groups, skills, query, ...list }: SkillListProps & { groups: CategoryGroup[]; skills: readonly SkillItem[]; query: string }) {
  return (
    <section aria-labelledby="ws-skills-categories">
      <SectionHeader
        id="ws-skills-categories"
        title="Categories"
        hint="Turn a category on and all its skills are in this workspace. Skills you add to it later arrive automatically. Open one to leave a skill out."
      />
      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
          No categories yet. Put a skill in a category in <Link to="/skills" className="text-primary underline">My library</Link> and it shows up here.
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => <CategoryCard key={group.id} group={group} skills={skills} query={query} {...list} />)}
        </ul>
      )}
    </section>
  );
}

/** My library skills no turned-on category brings in: tick the ones this workspace should have. */
export function SingleSkillsSection({ skills, query, ...list }: SkillListProps & { skills: readonly SkillItem[]; query: string }) {
  const singles = skills.filter((skill) => !coveredByCategory(skill, list.choice) && matchesSkillSearch(skill, query));
  const picked = singles.filter((skill) => skillStatus(skill, list.choice).on).length;
  return (
    <section aria-labelledby="ws-skills-singles">
      <SectionHeader
        id="ws-skills-singles"
        title="Single skills"
        hint="Pick skills one by one. Skills in a category that is on come with the category and are not listed here."
        action={singles.length > 0 ? <Badge variant="outline" className="shrink-0 font-mono">{picked} picked</Badge> : undefined}
      />
      {singles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
          {query.trim()
            ? `No single skills match "${query.trim()}".`
            : skills.length === 0
              ? <>No skills in My library yet. Add some in <Link to="/skills" className="text-primary underline">My library</Link>.</>
              : 'Every skill in My library already comes with a category that is on.'}
        </p>
      ) : (
        <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border bg-card/60">
          {singles.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              status={skillStatus(skill, list.choice)}
              control="checkbox"
              disabled={list.disabled}
              showCategory
              onToggle={() => list.onChange(toggleSkill(list.choice, skill))}
              onPreview={() => list.onPreview(skill)}
              onEdit={() => list.onEdit(skill)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Skills written inside this workspace. They live in its own .agents/skills folder. */
export function WorkspaceOnlySection({
  skills,
  query,
  categoryNames,
  ...list
}: SkillListProps & { skills: readonly SkillItem[]; query: string; categoryNames: ReadonlyMap<string, string> }) {
  const shown = skills.filter((skill) => matchesSkillSearch(skill, query));
  return (
    <section aria-labelledby="ws-skills-local">
      <SectionHeader
        id="ws-skills-local"
        title="This workspace only"
        hint={<>Skills written for this workspace. They are stored in its <code className="font-mono text-foreground">.agents/skills/</code> folder, so tools that read it always see them; turning one on also copies it to <code className="font-mono text-foreground">.claude/skills/</code> for Claude.</>}
      />
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
          {query.trim() ? `No skills here match "${query.trim()}".` : 'None yet. Use New skill to write one for this workspace.'}
        </p>
      ) : (
        <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border bg-card/60">
          {shown.map((skill) => {
            const status = skillStatus(skill, list.choice);
            return (
              <SkillRow
                key={skill.id}
                skill={skill}
                status={status}
                control="checkbox"
                disabled={list.disabled}
                categoryName={categoryNames.get(skill.category)}
                onToggle={() => list.onChange(toggleSkill(list.choice, skill))}
                onPreview={() => list.onPreview(skill)}
                onEdit={() => list.onEdit(skill)}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

const joinNames = (names: readonly string[]) => {
  const shown = names.slice(0, 4).join(', ');
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown;
};

/** Which tool reads which folder, how many skills they all see, what saving will change, and what each tool has of its own. */
export function WhoSeesWhat({
  installedCount,
  state,
  added,
  removed,
  builtIn,
}: {
  installedCount: number;
  /** Whether the choice on screen is saved, waiting to be saved, or based on a selection that has since changed. */
  state: 'saved' | 'unsaved' | 'outdated';
  added: readonly string[];
  removed: readonly string[];
  builtIn: ReadonlyArray<{ label: string; count: number }>;
}) {
  const changes = [
    added.length > 0 ? `add ${joinNames(added)}` : null,
    removed.length > 0 ? `remove ${joinNames(removed)}` : null,
  ].filter(Boolean).join(' and ');
  const lead = state === 'saved' ? 'Saved, but not applied yet.' : 'Not saved yet.';
  return (
    <section aria-labelledby="ws-skills-who" className="rounded-xl border border-border bg-card/60 p-4">
      <h3 id="ws-skills-who" className="text-sm font-semibold text-foreground">Who sees what</h3>
      <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
        <li>
          {installedCount === 0
            ? 'No skills are installed in this workspace yet.'
            : <>Every tool sees the <strong className="text-foreground">{installedCount}</strong> {installedCount === 1 ? 'skill' : 'skills'} in this workspace.</>}
          {' '}Claude reads <code className="font-mono text-foreground">.claude/skills/</code>; the other tools read <code className="font-mono text-foreground">.agents/skills/</code>. Every skill is written to both.
        </li>
        <li>
          {changes
            ? <>{lead} Save and apply will {changes}.</>
            : state === 'saved' ? 'What you selected is what is installed.' : 'Not saved yet. This changes the selection, not which skills are installed.'}
        </li>
        {builtIn.length > 0 && (
          <li>
            Each tool also has its own built-in skills, always on in every folder:{' '}
            {builtIn.map((tool, index) => (
              <span key={tool.label}>
                {index > 0 && ', '}
                <strong className="text-foreground">{tool.label}</strong> {tool.count}
              </span>
            ))}.
          </li>
        )}
      </ul>
    </section>
  );
}
