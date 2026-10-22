import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes,
  Check,
  Search,
  Sparkles,
  ExternalLink,
  Bot,
  X,
  Plus,
  FolderGit2,
} from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Spinner } from '../../components/ui/spinner.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../components/ui/empty.js';
import { cn } from '../../lib/utils.js';
import {
  useSkillCategories,
  useSkills,
  useSkillDiagnostics,
  useAgents,
  useHarnesses,
  useWorkspaceSkills,
  useAssignWorkspaceSkills,
  useRefreshWorkspace,
} from '../../lib/api/queries.js';
import { CONFIG_DIR } from '../../brand.js';
import { repoName } from '../../lib/status.js';
import type { Feature, SkillItem } from '../../types.js';
import { AddToLibraryButton, BuiltInSkills } from './BuiltInSkills.js';
import { SkillDiagnosticsPanel } from './SkillDiagnosticsPanel.js';
import {
  builtInGroups, categoryGroups, choiceFromConfig, installChanges, isLibrarySkill, isWorkspaceOnlySkill, matchesSkillSearch, onSkillIds,
  sameChoice, sameIds, selectionState, skillStatus, toggleSkill,
  type SavedSelection, type SelectionDraft, type SkillChoice,
} from './skillSelection.js';
import { useAddToLibrary } from './useAddToLibrary.js';
import { SkillEditorDialog, SkillPlaybookDialog, type SkillEditTarget } from './WorkspaceSkillDialogs.js';
import {
  CategoriesSection, SectionHeader, SingleSkillsSection, WhoSeesWhat, WorkspaceOnlySection,
} from './WorkspaceSkillSections.js';

const NO_CHOICE: SkillChoice = { categories: [], picks: [], exceptions: [] };

export interface WorkspaceSkillsTabProps {
  ws: Feature;
  showToast?: (message: string, type?: 'success' | 'error' | 'info', duration?: number) => void;
}

/**
 * The one place to change which skills and agents a workspace has. The choice is made here as a draft and written
 * only when Save and apply is pressed; the same press copies the skills into the workspace for every tool.
 */
export function WorkspaceSkillsTab({ ws, showToast }: WorkspaceSkillsTabProps) {
  const { data: diagnostics = [] } = useSkillDiagnostics(ws.branchName);
  const [searchQuery, setSearchQuery] = useState('');
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [previewSkill, setPreviewSkill] = useState<SkillItem | null>(null);
  const [editTarget, setEditTarget] = useState<SkillEditTarget | null>(null);

  const { data: categories = [], isLoading: loadingCategories } = useSkillCategories();
  const { data: skills = [], isLoading: loadingSkills } = useSkills(ws.branchName);
  const { data: harnesses } = useHarnesses();
  const { data: agents = [], isLoading: loadingAgents } = useAgents();
  const {
    data: workspaceSkills,
    isLoading: loadingWorkspaceConfig,
    isError: workspaceConfigError,
  } = useWorkspaceSkills(ws.branchName);

  const assignSkillsMutation = useAssignWorkspaceSkills();
  const refreshWorkspaceMutation = useRefreshWorkspace();
  const { add: addToLibrary, pending: addingToLibrary } = useAddToLibrary(showToast);

  // What the server has, as the screen shows it.
  const saved = useMemo<SavedSelection | undefined>(
    () => workspaceSkills && {
      choice: choiceFromConfig(workspaceSkills.config, skills, workspaceSkills.resolvedSkills),
      agents: workspaceSkills.config.enabledAgents ?? [],
      revision: workspaceSkills.config.revision ?? 0,
    },
    [workspaceSkills, skills],
  );

  const choice = draft?.choice ?? saved?.choice ?? NO_CHOICE;
  const enabledAgentSet = new Set(draft?.agents ?? saved?.agents ?? []);
  const selectionStatus = selectionState(draft, saved);

  /** Changes the choice on screen, starting from what is saved. Going back to what is saved leaves no draft. */
  const edit = (change: (current: SkillChoice, agents: string[]) => { choice: SkillChoice; agents: string[] }) => {
    if (!saved) return;
    setDraft((previous) => {
      const next = change(previous?.choice ?? saved.choice, previous?.agents ?? [...saved.agents]);
      if (sameChoice(next.choice, saved.choice) && sameIds(next.agents, saved.agents)) return null;
      return { ...next, revision: previous?.revision ?? saved.revision };
    });
  };
  const changeChoice = (next: SkillChoice) => edit((_, agents) => ({ choice: next, agents }));
  const toggleSkillById = (skill: SkillItem) => edit((current, agents) => ({ choice: toggleSkill(current, skill), agents }));
  const handleToggleAgent = (agentId: string) =>
    edit((current, agents) => ({
      choice: current,
      agents: agents.includes(agentId) ? agents.filter((id) => id !== agentId) : [...agents, agentId],
    }));

  const librarySkills = useMemo(() => skills.filter(isLibrarySkill), [skills]);
  const workspaceOnlySkills = useMemo(() => skills.filter(isWorkspaceOnlySkill), [skills]);
  const builtInSkills = useMemo(() => skills.filter((skill) => skill.source), [skills]);
  const groups = useMemo(() => categoryGroups(categories, skills, choice.categories), [categories, skills, choice.categories]);
  const categoryNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);

  const willBeOn = useMemo(() => onSkillIds(skills, choice), [skills, choice]);
  const titleOf = (id: string) => {
    const skill = skills.find((candidate) => candidate.id === id);
    return skill?.title || skill?.name || id;
  };
  const installed = workspaceSkills?.installedSkills ?? [];
  const changes = installChanges(skills, willBeOn, installed);
  const needsApply = changes.added.length > 0 || changes.removed.length > 0;

  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents;
    const q = searchQuery.toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    );
  }, [agents, searchQuery]);

  const handleSaveAndApply = async () => {
    if (!saved || selectionStatus === 'outdated') return;
    const next = selectionStatus === 'unsaved' && draft ? draft : { choice: saved.choice, agents: [...saved.agents], revision: saved.revision };
    setIsDeploying(true);
    try {
      await assignSkillsMutation.mutateAsync({
        workspaceId: ws.branchName,
        // The revision this choice started from, so a selection saved meanwhile by someone else is refused, not replaced.
        expectedRevision: next.revision,
        enabledSkills: next.choice.picks,
        enabledAgents: next.agents,
        enabledCategories: next.choice.categories,
        disabledSkills: next.choice.exceptions,
      });
      setDraft(null);
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Failed to save the selection', 'error');
      setIsDeploying(false);
      return;
    }
    try {
      await refreshWorkspaceMutation.mutateAsync({ workspaceId: ws.branchName });
      showToast?.('Saved and applied. Every tool in this workspace now sees these skills.', 'success');
    } catch (error) {
      showToast?.(`Saved, but applying it failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    } finally {
      setIsDeploying(false);
    }
  };

  const handleOpenEdit = (skill: SkillItem) => {
    setPreviewSkill(null);
    setEditTarget({ skill: { ...skill }, scope: skill.scope === 'workspace' ? 'workspace' : 'global' });
  };

  const handleOpenCreateSkill = () => {
    setEditTarget({
      skill: {
        name: '',
        title: '',
        category: 'general',
        description: '',
        tags: [],
        content: '# Skill Title\n\nProcedural playbook instructions for AI assistants...',
        allowedTools: [],
      },
      scope: 'workspace',
    });
  };

  const isLoading = loadingCategories || loadingSkills || loadingAgents || loadingWorkspaceConfig;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 gap-3 text-muted-foreground">
        <Spinner />
        <span className="text-sm">Loading workspace skills...</span>
      </div>
    );
  }

  if (workspaceConfigError) {
    return (
      <Empty className="py-12 border border-dashed rounded-xl">
        <EmptyHeader>
          <EmptyTitle>Could not load workspace skills config</EmptyTitle>
          <EmptyDescription>Unable to read .contextspace/skills.json for this workspace.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const listProps = {
    choice,
    onChange: changeChoice,
    onPreview: setPreviewSkill,
    onEdit: handleOpenEdit,
    disabled: isDeploying,
  };
  const previewStatus = previewSkill ? skillStatus(previewSkill, choice) : null;
  const builtInCounts = builtInGroups(builtInSkills).map((group) => ({ label: group.label, count: group.skills.length }));

  return (
    <div className="flex flex-col gap-4">
      <SkillDiagnosticsPanel diagnostics={diagnostics} />
      {/* Top Banner / Actions Bar */}
      <Card className="p-3.5 sm:p-4 rounded-xl border border-border/40 bg-card/60 backdrop-blur-xs shadow-2xs flex flex-col gap-3">
        <div className="flex items-start gap-3 min-w-0 w-full">
          <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0 mt-0.5 sm:mt-0">
            <Boxes className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground whitespace-nowrap">Workspace Skills &amp; Agents</h3>
              <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0.5 shrink-0">
                {willBeOn.length} {willBeOn.length === 1 ? 'skill' : 'skills'} on
              </Badge>
              {enabledAgentSet.size > 0 && (
                <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0.5 shrink-0">
                  {enabledAgentSet.size} Agents Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              Choose which of your skills this workspace has, by category or one by one. Save and apply copies them in for every tool.
            </p>
            {ws.repos && ws.repos.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">Target repositories:</span>
                {ws.repos.map((rp) => (
                  <span key={rp} className="inline-flex items-center gap-1 font-mono text-[10px] bg-muted/60 px-1.5 py-0.5 rounded border border-border/50 text-foreground">
                    <FolderGit2 className="size-3 text-primary" />
                    {repoName(rp)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={handleOpenCreateSkill}
            className="h-7 px-2.5 text-xs flex items-center gap-1.5 shadow-2xs"
          >
            <Plus className="size-3" />
            <span>New Skill</span>
          </Button>

          <Button
            size="xs"
            variant={selectionStatus !== 'saved' || needsApply ? 'default' : 'outline'}
            onClick={handleSaveAndApply}
            disabled={isDeploying || selectionStatus === 'outdated'}
            className="h-7 px-3 text-xs font-medium flex items-center gap-1.5 shadow-2xs"
          >
            {isDeploying ? <Spinner className="size-3" /> : <Sparkles className="size-3" />}
            <span>{isDeploying ? 'Applying…' : 'Save and apply'}</span>
          </Button>

          {selectionStatus !== 'saved' && (
            <>
              <span role="status" className="text-xs text-muted-foreground">
                {selectionStatus === 'outdated'
                  ? 'This selection was changed elsewhere since you started. Discard your changes to start again.'
                  : 'Unsaved changes'}
              </span>
              <Button size="xs" variant="ghost" onClick={() => setDraft(null)} disabled={isDeploying} className="h-7 px-2 text-xs">
                Discard
              </Button>
            </>
          )}

          <Button
            render={<Link to="/skills" />}
            variant="ghost"
            size="xs"
            className="h-7 px-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            title="Open My library"
          >
            <ExternalLink className="size-3" />
            <span>My library</span>
          </Button>
        </div>
      </Card>

      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none z-10" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter skills & agents by keyword or tag..."
          aria-label="Filter skills and agents"
          className="pl-9 pr-8 h-8 text-xs bg-card"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            aria-label="Clear filter"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="space-y-6">
        <CategoriesSection groups={groups} skills={skills} query={searchQuery} {...listProps} />
        <SingleSkillsSection skills={librarySkills} query={searchQuery} {...listProps} />
        <WorkspaceOnlySection skills={workspaceOnlySkills} query={searchQuery} categoryNames={categoryNames} {...listProps} />

        <section aria-labelledby="ws-skills-built-in">
          <SectionHeader
            id="ws-skills-built-in"
            title="Built into your tools"
            hint="Skills your tools ship themselves. Always on in that tool, in every folder, so there is nothing to turn on here. Add one to My library to turn it on for every tool."
          />
          <BuiltInSkills
            skills={builtInSkills.filter((skill) => matchesSkillSearch(skill, searchQuery))}
            showToast={showToast}
            onPreview={setPreviewSkill}
          />
        </section>

        <WhoSeesWhat
          installedCount={installed.length}
          state={selectionStatus === 'saved' ? 'saved' : 'unsaved'}
          added={changes.added.map(titleOf)}
          removed={changes.removed.map(titleOf)}
          builtIn={builtInCounts}
          harnesses={harnesses}
        />

        {/* Custom Codex Agents Section */}
        {filteredAgents.length > 0 && (
          <div className="border border-border rounded-xl overflow-hidden bg-card/60 transition-colors">
            <div className="p-3 flex items-center justify-between border-b border-border/40 select-none">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-md bg-purple-600 text-white shadow-xs flex items-center justify-center">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-xs text-foreground">Codex Native Agents</h4>
                    <Badge variant="outline" className="text-[9px] px-1 py-0">
                      {filteredAgents.filter((a) => enabledAgentSet.has(a.id)).length}/{filteredAgents.length} active
                    </Badge>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-3 bg-background/50">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {filteredAgents.map((agent) => {
                  const isEnabled = enabledAgentSet.has(agent.id);
                  return (
                    <div
                      key={agent.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleToggleAgent(agent.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleToggleAgent(agent.id);
                        }
                      }}
                      className={cn(
                        'p-3 rounded-lg border text-left cursor-pointer transition-all flex flex-col justify-between select-none shadow-2xs',
                        isEnabled
                          ? 'border-purple-500/60 bg-purple-500/5 text-foreground'
                          : 'border-border bg-card/70 text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={cn(
                              'grid size-4 shrink-0 place-items-center rounded border transition-colors',
                              isEnabled
                                ? 'border-purple-600 bg-purple-600 text-white'
                                : 'border-muted-foreground/40 bg-transparent',
                            )}
                          >
                            {isEnabled && <Check className="size-3 stroke-[3]" />}
                          </span>
                          <span className="font-mono text-xs font-semibold truncate">{agent.name}</span>
                        </div>
                        <Badge variant="secondary" className="text-[9px] px-1 py-0 shrink-0">
                          .codex/agents
                        </Badge>
                      </div>

                      <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed pl-6">
                        {agent.description || 'No description provided.'}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Save and apply writes your choice to <code className="font-mono text-xs text-foreground">{CONFIG_DIR}/skills.json</code>, then copies every skill that is on into <code className="font-mono text-xs text-foreground">.agents/skills/</code> and <code className="font-mono text-xs text-foreground">.claude/skills/</code>. Codex agents go to <code className="font-mono text-xs text-foreground">.codex/agents/</code>.
      </p>

      <SkillPlaybookDialog
        skill={previewSkill}
        isOn={Boolean(previewStatus?.on)}
        onToggle={previewSkill && !previewSkill.source ? () => toggleSkillById(previewSkill) : undefined}
        onEdit={previewSkill && !previewSkill.source ? handleOpenEdit : undefined}
        onClose={() => setPreviewSkill(null)}
        extraAction={previewSkill?.source ? (
          <AddToLibraryButton
            skill={previewSkill}
            add={addToLibrary}
            busy={addingToLibrary?.harness === previewSkill.source.harness && addingToLibrary?.id === previewSkill.id}
          />
        ) : undefined}
      />

      <SkillEditorDialog
        target={editTarget}
        workspaceId={ws.branchName}
        onClose={() => setEditTarget(null)}
        showToast={showToast}
        onSaved={(savedSkill) => {
          // A skill written here is meant for this workspace, so it starts out on.
          if (!savedSkill.isNew) return;
          const created = { id: savedSkill.id, category: savedSkill.category, source: undefined };
          edit((current, agents) => ({ choice: skillStatus(created, current).on ? current : toggleSkill(current, created), agents }));
        }}
      />
    </div>
  );
}
