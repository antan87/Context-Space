import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderGit2, Pencil, Play, Plus, Trash2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import { Input } from '../components/ui/input.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty.js';
import { Spinner } from '../components/ui/spinner.js';
import { RepoChecklist } from '../components/RepoChecklist.js';
import { ScaffoldRepoInline } from '../components/ScaffoldRepoInline.js';
import {
  useCreateProject,
  useDeleteProject,
  useProjects,
  useRepos,
  useUpdateProject,
  useWorkspaces,
} from '../lib/api/queries.js';
import { handleDelegatedRowClick } from '../lib/delegatedRowClick.js';
import type { Project, RepoInfo } from '../types.js';

interface ProjectFormState {
  /** Null when creating a new project. */
  editingId: string | null;
  name: string;
  description: string;
  repoPaths: string[];
}

const EMPTY_FORM: ProjectFormState = { editingId: null, name: '', description: '', repoPaths: [] };

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useProjects();
  const repos = useRepos();
  const workspaces = useWorkspaces();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();

  const [form, setForm] = useState<ProjectFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  /** Number of existing workspaces started from each project. */
  const workspaceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ws of workspaces.data ?? []) {
      if (ws.projectId) counts[ws.projectId] = (counts[ws.projectId] ?? 0) + 1;
    }
    return counts;
  }, [workspaces.data]);

  const openCreate = () => {
    setFormError(null);
    setForm(EMPTY_FORM);
  };

  const openEdit = (project: Project) => {
    setFormError(null);
    setForm({
      editingId: project.id,
      name: project.name,
      description: project.description ?? '',
      repoPaths: project.repos.map((r) => r.path),
    });
  };

  const toggleRepo = (repo: RepoInfo) => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            repoPaths: prev.repoPaths.includes(repo.path)
              ? prev.repoPaths.filter((p) => p !== repo.path)
              : [...prev.repoPaths, repo.path],
          }
        : prev,
    );
  };

  const submitForm = async () => {
    if (!form) return;
    setFormError(null);
    try {
      if (form.editingId) {
        await updateProject.mutateAsync({
          id: form.editingId,
          name: form.name,
          description: form.description || null,
          repos: form.repoPaths,
        });
      } else {
        await createProject.mutateAsync({
          name: form.name,
          description: form.description || undefined,
          repos: form.repoPaths,
        });
      }
      setForm(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteProject.mutateAsync(pendingDelete.id);
    } finally {
      setPendingDelete(null);
    }
  };

  const formValid = Boolean(form && form.name.trim() && form.repoPaths.length > 0);
  const saving = createProject.isPending || updateProject.isPending;

  return (
    <div className="mx-auto max-w-4xl animate-fade-in">
      <header className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/70 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Projects</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Named groups of repositories you start work from. Registered once, reused for every feature workspace.
          </p>
        </div>
        <Button onClick={openCreate} className="gap-1.5 shadow-sm">
          <Plus size={15} /> New project
        </Button>
      </header>

      {projects.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner className="size-6" />
        </div>
      ) : (projects.data ?? []).length === 0 ? (
        <Empty className="border border-border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2 />
            </EmptyMedia>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              Register your first project to start work without re-picking repositories every time.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={openCreate}>
            <Plus /> New project
          </Button>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {(projects.data ?? []).map((project) => (
            <li
              key={project.id}
              onClick={(e) => handleDelegatedRowClick(e, () => navigate(`/new?project=${encodeURIComponent(project.id)}`))}
              className="rounded-xl border border-border/80 bg-card/70 backdrop-blur-md p-4 transition-all duration-200 hover:border-primary/40 hover:bg-accent/30 hover:shadow-xs cursor-pointer select-text"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">{project.name}</h2>
                    {(workspaceCounts[project.id] ?? 0) > 0 && (
                      <Badge variant="secondary">
                        {workspaceCounts[project.id]} workspace{workspaceCounts[project.id] === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </div>
                  {project.description && (
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">{project.description}</p>
                  )}
                  <ul className="mt-2 flex flex-col gap-0.5">
                    {project.repos.map((repo) => (
                      <li key={repo.path} className="truncate font-mono text-xs text-muted-foreground">
                        {repo.path}
                        <span className="ml-2 text-muted-foreground">[{repo.defaultBranch}]</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" onClick={() => navigate(`/new?project=${encodeURIComponent(project.id)}`)}>
                    <Play /> Start work
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${project.name}`} onClick={() => openEdit(project)}>
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${project.name}`}
                    onClick={() => setPendingDelete(project)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Create / edit dialog */}
      <Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{form?.editingId ? 'Edit project' : 'New project'}</DialogTitle>
            <DialogDescription>
              A project is a reusable group of source repositories. Removing one later never touches disk.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Name</span>
              <Input
                value={form?.name ?? ''}
                onChange={(e) => setForm((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                placeholder="e.g. Acme Billing"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">
                Description <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <Input
                value={form?.description ?? ''}
                onChange={(e) => setForm((prev) => (prev ? { ...prev, description: e.target.value } : prev))}
                placeholder="What this group of repos is for"
              />
            </label>
            <div>
              <span className="mb-1 block text-sm font-medium">Repositories</span>
              <RepoChecklist
                repos={repos.data ?? []}
                selectedPaths={form?.repoPaths ?? []}
                onToggle={toggleRepo}
                loading={repos.isLoading}
                emptyHint="No repositories found in your dev directory."
              />
              <ScaffoldRepoInline
                onCreated={(repo) =>
                  setForm((prev) => (prev ? { ...prev, repoPaths: [...prev.repoPaths, repo.path] } : prev))
                }
              />
            </div>
            {formError && <p className="text-sm text-destructive-foreground">{formError}</p>}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button onClick={submitForm} disabled={!formValid || saving}>
              {saving ? <Spinner /> : null}
              {form?.editingId ? 'Save changes' : 'Create project'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This only removes the project from the registry — repositories and workspaces on disk are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteProject.isPending}>
              {deleteProject.isPending ? <Spinner /> : null}
              Remove project
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
