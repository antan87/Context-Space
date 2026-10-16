import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, FileUp, FolderGit2, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Spinner } from '../components/ui/spinner.js';
import { Textarea } from '../components/ui/textarea.js';
import {
  type CodexAgentItem,
  useAgents,
  useAssignWorkspaceSkills,
  useDeleteAgent,
  useImportAgent,
  useSaveAgent,
  useWorkspaces,
  useWorkspaceSkills,
} from '../lib/api/queries.js';
import { cn } from '../lib/utils.js';

export interface AgentsPageProps {
  showToast?: (message: string, type?: 'success' | 'error' | 'info', duration?: number) => void;
}

type AgentDraft = Omit<CodexAgentItem, 'custom' | 'sourcePath'>;

const EMPTY_AGENT: AgentDraft = {
  id: '',
  name: '',
  category: 'general',
  description: '',
  developerInstructions: '',
};

function slugifyAgentName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function AgentsPage({ showToast }: AgentsPageProps) {
  const [selectedWorkspace, setSelectedWorkspace] = useState('global');
  const [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_AGENT);
  const [importToml, setImportToml] = useState('');
  const [draftEnabledAgents, setDraftEnabledAgents] = useState<string[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CodexAgentItem | null>(null);

  const { data: agents = [], isLoading: loadingAgents, isError: agentsError } = useAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const workspaceQuery = useWorkspaceSkills(selectedWorkspace === 'global' ? '' : selectedWorkspace);
  const saveAgentMutation = useSaveAgent();
  const importAgentMutation = useImportAgent();
  const deleteAgentMutation = useDeleteAgent();
  const assignMutation = useAssignWorkspaceSkills();

  const isWorkspaceView = selectedWorkspace !== 'global';
  const selectedWorkspaceItem = workspaces.find((workspace) => workspace.id === selectedWorkspace);
  const codexAvailable = !isWorkspaceView || selectedWorkspaceItem?.assistants?.includes('codex');
  const assignmentReady =
    isWorkspaceView &&
    codexAvailable &&
    !workspaceQuery.isLoading &&
    !workspaceQuery.isError &&
    !!workspaceQuery.data;

  useEffect(() => {
    if (!isWorkspaceView) {
      setDraftEnabledAgents(null);
      return;
    }
    if (workspaceQuery.data) setDraftEnabledAgents([...(workspaceQuery.data.enabledAgents ?? [])]);
  }, [isWorkspaceView, selectedWorkspace, workspaceQuery.data]);

  const visibleAgents = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return agents;
    return agents.filter((agent) =>
      [agent.name, agent.description, agent.category].some((value) => value.toLowerCase().includes(query)),
    );
  }, [agents, search]);

  const enabledAgents = new Set(draftEnabledAgents ?? workspaceQuery.data?.enabledAgents ?? []);

  function openCreate(): void {
    setEditingId(null);
    setDraft(EMPTY_AGENT);
    setEditorOpen(true);
  }

  function openEdit(agent: CodexAgentItem): void {
    setEditingId(agent.id);
    setDraft({
      id: agent.id,
      name: agent.name,
      category: agent.category,
      description: agent.description,
      developerInstructions: agent.developerInstructions,
      model: agent.model,
      modelReasoningEffort: agent.modelReasoningEffort,
      sandboxMode: agent.sandboxMode,
    });
    setEditorOpen(true);
  }

  async function saveAgent(): Promise<void> {
    try {
      const name = editingId ?? slugifyAgentName(draft.name);
      await saveAgentMutation.mutateAsync({ ...draft, id: name, name });
      setEditorOpen(false);
      showToast?.('Codex agent saved', 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Failed to save agent', 'error');
    }
  }

  async function importAgent(): Promise<void> {
    try {
      await importAgentMutation.mutateAsync({ toml: importToml, category: 'general' });
      setImportOpen(false);
      setImportToml('');
      showToast?.('Codex agent imported', 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Failed to import agent', 'error');
    }
  }

  async function removeAgent(): Promise<void> {
    if (!pendingDelete) return;
    try {
      await deleteAgentMutation.mutateAsync(pendingDelete.id);
      setPendingDelete(null);
      showToast?.('Agent deleted from the personal catalog', 'info');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Failed to delete agent', 'error');
    }
  }

  function toggleAgent(id: string): void {
    if (!assignmentReady || draftEnabledAgents === null) return;
    const next = new Set(draftEnabledAgents);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftEnabledAgents([...next]);
  }

  async function saveSelection(): Promise<void> {
    if (!workspaceQuery.data || draftEnabledAgents === null) return;
    try {
      await assignMutation.mutateAsync({
        workspaceId: selectedWorkspace,
        expectedRevision: workspaceQuery.data.revision ?? 0,
        enabledSkills: workspaceQuery.data.enabledSkills,
        enabledAgents: draftEnabledAgents,
        enabledCategories: workspaceQuery.data.enabledCategories ?? [],
      });
      showToast?.('Agent selection saved. Refresh the workspace to apply it.', 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Failed to save agent selection', 'error');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary"><Bot className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Codex Agent Library</h1>
            <p className="text-sm text-muted-foreground">Create and reuse project-scoped Codex custom agents.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button render={<Link to="/skills" />} variant="outline" size="sm">Skills</Button>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-1.5">
            <FolderGit2 className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor="agent-scope" className="text-xs text-muted-foreground">Scope</Label>
            <select
              id="agent-scope"
              value={selectedWorkspace}
              onChange={(event) => setSelectedWorkspace(event.target.value)}
              className="cursor-pointer bg-transparent text-xs font-semibold text-foreground"
            >
              <option value="global">Personal catalog</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.id}</option>
              ))}
            </select>
          </div>
          {isWorkspaceView ? (
            <Button size="sm" onClick={saveSelection} disabled={!assignmentReady || assignMutation.isPending}>
              {assignMutation.isPending ? 'Saving…' : 'Save selection'}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <FileUp className="mr-1.5 h-4 w-4" />Import TOML
              </Button>
              <Button size="sm" onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" />New agent</Button>
            </>
          )}
        </div>
      </header>

      <div className="border-b border-border/60 bg-muted/20 px-6 py-3">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none z-10" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents…" className="pl-9" />
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-auto p-6">
        {loadingAgents || (isWorkspaceView && workspaceQuery.isLoading) ? (
          <div className="flex justify-center p-12"><Spinner /></div>
        ) : agentsError || (isWorkspaceView && workspaceQuery.isError) ? (
          <Empty className="border border-dashed py-12">
            <EmptyHeader><EmptyTitle>Resources could not be loaded</EmptyTitle><EmptyDescription>Assignment controls remain disabled to protect the saved selection.</EmptyDescription></EmptyHeader>
          </Empty>
        ) : isWorkspaceView && !codexAvailable ? (
          <Empty className="border border-dashed py-12">
            <EmptyHeader><EmptyTitle>Codex is not enabled for this workspace</EmptyTitle><EmptyDescription>Add Codex to the workspace before assigning Codex-native agents.</EmptyDescription></EmptyHeader>
          </Empty>
        ) : visibleAgents.length === 0 ? (
          <Empty className="border border-dashed py-12">
            <EmptyMedia><Bot className="h-8 w-8 text-muted-foreground" /></EmptyMedia>
            <EmptyHeader><EmptyTitle>No Codex agents found</EmptyTitle><EmptyDescription>Create an agent or import a native TOML definition.</EmptyDescription></EmptyHeader>
            {!isWorkspaceView && <Button size="sm" onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" />New agent</Button>}
          </Empty>
        ) : (
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleAgents.map((agent) => {
              const enabled = enabledAgents.has(agent.id);
              return (
                <Card key={agent.id} className={cn('flex flex-col gap-4 p-4', isWorkspaceView && !enabled && 'opacity-60')}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2"><h2 className="font-semibold">{agent.name}</h2><Badge variant="outline">Codex</Badge></div>
                      <p className="mt-2 text-sm text-muted-foreground">{agent.description}</p>
                    </div>
                    {isWorkspaceView ? (
                      <Button variant={enabled ? 'default' : 'outline'} size="sm" onClick={() => toggleAgent(agent.id)} disabled={!assignmentReady}>
                        <Check className={cn('mr-1 h-3.5 w-3.5', !enabled && 'opacity-0')} />{enabled ? 'Enabled' : 'Disabled'}
                      </Button>
                    ) : (
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" aria-label={`Edit ${agent.name}`} onClick={() => openEdit(agent)}><Pencil className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" aria-label={`Delete ${agent.name}`} onClick={() => setPendingDelete(agent)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {agent.sandboxMode && <Badge variant="secondary">{agent.sandboxMode}</Badge>}
                    {agent.modelReasoningEffort && <Badge variant="secondary">{agent.modelReasoningEffort}</Badge>}
                    {agent.model && <Badge variant="secondary">{agent.model}</Badge>}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </main>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{editingId ? 'Edit Codex agent' : 'Create Codex agent'}</DialogTitle><DialogDescription>Only the current stable native fields are managed. Omitted settings inherit from Codex.</DialogDescription></DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2"><Label htmlFor="agent-name">Name</Label><Input id="agent-name" value={draft.name} disabled={!!editingId} onChange={(event) => setDraft({ ...draft, name: slugifyAgentName(event.target.value) })} placeholder="code-reviewer" /></div>
            <div className="grid gap-2"><Label htmlFor="agent-description">Description</Label><Input id="agent-description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Use when reviewing a fixed diff for correctness and security." /></div>
            <div className="grid gap-2"><Label htmlFor="agent-instructions">Developer instructions</Label><Textarea id="agent-instructions" value={draft.developerInstructions} onChange={(event) => setDraft({ ...draft, developerInstructions: event.target.value })} className="min-h-48 font-mono" /></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="grid gap-2"><Label htmlFor="agent-model">Model override</Label><Input id="agent-model" value={draft.model ?? ''} onChange={(event) => setDraft({ ...draft, model: event.target.value || undefined })} placeholder="Inherit" /></div>
              <div className="grid gap-2"><Label htmlFor="agent-effort">Reasoning</Label><select id="agent-effort" value={draft.modelReasoningEffort ?? ''} onChange={(event) => setDraft({ ...draft, modelReasoningEffort: (event.target.value || undefined) as AgentDraft['modelReasoningEffort'] })} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="">Inherit</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option><option value="ultra">Ultra</option></select></div>
              <div className="grid gap-2"><Label htmlFor="agent-sandbox">Sandbox</Label><select id="agent-sandbox" value={draft.sandboxMode ?? ''} onChange={(event) => setDraft({ ...draft, sandboxMode: (event.target.value || undefined) as AgentDraft['sandboxMode'] })} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="">Inherit</option><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option></select></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button><Button onClick={saveAgent} disabled={saveAgentMutation.isPending || !draft.name || !draft.description || !draft.developerInstructions}>{saveAgentMutation.isPending ? 'Saving…' : 'Save agent'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Import Codex agent TOML</DialogTitle><DialogDescription>The import accepts the required native fields and supported model, reasoning, and sandbox overrides.</DialogDescription></DialogHeader>
          <Textarea value={importToml} onChange={(event) => setImportToml(event.target.value)} className="min-h-72 font-mono" placeholder={'name = "reviewer"\ndescription = "Use for code review."\ndeveloper_instructions = "Review the fixed diff."'} />
          <DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button><Button onClick={importAgent} disabled={importAgentMutation.isPending || !importToml.trim()}>{importAgentMutation.isPending ? 'Importing…' : 'Import agent'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the agent from the personal catalog. Existing workspace copies remain until the workspace is refreshed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button variant="destructive" onClick={removeAgent} disabled={deleteAgentMutation.isPending}>
              {deleteAgentMutation.isPending ? 'Deleting…' : 'Delete agent'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
