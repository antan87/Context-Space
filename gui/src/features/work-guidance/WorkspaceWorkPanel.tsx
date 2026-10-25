import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DraftConflictNotice, DraftStateLabel, type DraftState } from './BriefDraftNotices.js';
import {
  assignmentConflicts, clearDraft, emptyDocumentForm, mergeAssignmentDraft, pickAssignment, readDraft, reconcileAssignment, reconcileDocumentForm,
  sameAssignment, sameDocumentForm, writeDraft, type AssignmentDraft, type BriefKind, type DocumentFormDraft, type StoredDraft,
} from './briefDrafts.js';
import { Check, Copy, Eye, FileText, Pencil, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { headline } from '../progress/progressView.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiFetch } from '../../lib/api/client.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import { handleDelegatedRowClick } from '../../lib/delegatedRowClick.js';
import { usePlanFile } from '../plan/planFile.js';
import { planStatesGoal } from '../plan/planView.js';
import type { WorkDocument, WorkGuidance, WorkspaceLifecycle } from '../../types.js';

type WorkContext = {
  guidance: WorkGuidance;
  projectId?: string;
  sharedDocuments?: Array<WorkDocument & { workspaceId: string }>;
  lifecycle: WorkspaceLifecycle | null;
  assignment: string;
  contextRefreshed?: boolean;
  contextRefreshError?: string;
};
type DocumentDraft = Pick<WorkDocument, 'title' | 'role' | 'status' | 'scope' | 'summary'>;
/** Kept drafts that disagree with the version saved since: shown for a choice, never applied silently. */
type DraftConflicts = { assignment?: StoredDraft<AssignmentDraft> };
type LiveDrafts = DraftConflicts & { document?: StoredDraft<DocumentFormDraft> };
type KeptByThisPanel = 'assignment' | 'document';
const emptyDocument = (): DocumentDraft => ({ title: '', role: 'requirements', status: 'draft', scope: {}, summary: '' });
const selectClass = 'mt-1 w-full rounded-md border border-border bg-background p-2 text-sm';
const stages = ['investigate', 'design', 'implement', 'verify', 'review', 'release'] as const;
const WORK_TYPES: Record<WorkGuidance['workType'], string> = { bug: 'Bug fix', feature: 'Feature', performance: 'Performance', refactor: 'Refactor', rewrite: 'Rewrite' };
const SIZES: Record<WorkGuidance['size'], string> = { small: 'Small task', standard: 'Standard change', epic: 'Epic / multiple deliverables' };

/** One part of the plan: what it says, with its pencil to edit it in place. */
function PlanCard({ title, meta, action, children }: { title: string; meta?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  const id = useId();
  return <section aria-labelledby={id} className="rounded-xl border border-border/40 bg-card/60 backdrop-blur-xs px-4 py-3 shadow-2xs">
    <header className={cn('flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1', children && 'mb-2.5 border-b border-border/30 pb-2')}>
      <h3 id={id} className="text-xs font-semibold text-foreground/80">{title}</h3>
      {meta}
      <span className="flex-1" />
      {action}
    </header>
    {children}
  </section>;
}

const CHIP = 'inline-flex items-center rounded-md border border-border/40 bg-muted/30 px-2 py-0.5 text-xs font-medium text-muted-foreground';

/** What kind of work this is, in words: the stage, the type, the size and, for one milestone, which. */
function briefParts(guidance: WorkGuidance, scope?: string): string[] {
  const stage = guidance.assignment.stage;
  return [stage ? stage[0]!.toUpperCase() + stage.slice(1) : '', WORK_TYPES[guidance.workType], SIZES[guidance.size], scope ? `For ${scope}` : ''].filter(Boolean);
}

/**
 * What the work delivers and when it stops. Shown only until the plan has milestones: then each milestone says
 * what it must deliver, and the brief's own words would go stale beside them.
 */
function assignmentNotes(guidance: WorkGuidance, hasMilestones: boolean): ReactNode {
  const delivers = hasMilestones ? undefined : guidance.assignment.expectedOutput?.trim();
  const stops = hasMilestones ? undefined : guidance.assignment.stopCondition?.trim();
  if (!delivers && !stops) return null;
  return <div className="grid gap-3 pt-1 sm:grid-cols-2">
    {delivers && (
      <div className="rounded-lg border border-border/30 bg-muted/15 p-2.5 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-state-done shrink-0" />
          <h4 className="text-xs font-medium text-muted-foreground">Delivers</h4>
        </div>
        <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap line-clamp-4" title={delivers}><InlinePlanMarkdown content={delivers} /></p>
      </div>
    )}
    {stops && (
      <div className="rounded-lg border border-border/30 bg-muted/15 p-2.5 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-state-needs shrink-0" />
          <h4 className="text-xs font-medium text-muted-foreground">Stops when</h4>
        </div>
        <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap line-clamp-4" title={stops}><InlinePlanMarkdown content={stops} /></p>
      </div>
    )}
  </div>;
}

/** The goal as a reader needs it: its opening, the rest on request. */
function GoalSummary({ guidance, scope, hasMilestones }: { guidance: WorkGuidance; scope?: string; hasMilestones: boolean }) {
  const objective = guidance.assignment.objective?.trim() ?? '';
  const opening = headline(objective);

  return <div className="space-y-3">
    <div>
      <h2 className="text-base sm:text-lg font-semibold leading-snug tracking-tight text-foreground">
        {opening ? <InlinePlanMarkdown content={opening} /> : <span className="font-normal text-muted-foreground">No goal yet. Say what this work is for.</span>}
      </h2>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className={CHIP}>{briefParts(guidance, scope).join(' · ')}</span>
      </div>
    </div>
    {objective.length > opening.length && <details className="group rounded-lg border border-border/30 bg-muted/15 px-3 py-2 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">The whole goal</summary>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90 leading-relaxed">{objective}</p>
    </details>}
    {assignmentNotes(guidance, hasMilestones)}
  </div>;
}

/**
 * The brief: the goal and the kind of work, then the sources. It sits under the plan, which holds the milestones,
 * questions and decisions; the old milestone editor and the Notes & questions box are gone. When the plan document
 * opens with the goal (PLAN.md's intro), the brief does not say it again: it is called Brief and shrinks to a line
 * of chips with its edit action, then the sources. Without that text it is the Goal and shows the objective.
 */
export function WorkspaceWorkPanel({ workspaceId, readOnly = false }: { workspaceId: string; /** Archived: show the record, change nothing. */ readOnly?: boolean }) {
  const [context, setContext] = useState<WorkContext | null>(null);
  const [draft, setDraft] = useState<WorkGuidance | null>(null);
  // Which part is being edited. None by default: the plan is read first, and edited one part at a time.
  const [panel, setPanel] = useState<'assignment' | 'documents' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [document, setDocument] = useState<DocumentDraft>(emptyDocument);
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<'text' | 'link'>('text');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<{ title: string; content?: string; location: string } | null>(null);
  const [conflicts, setConflicts] = useState<DraftConflicts>({});
  const [notKept, setNotKept] = useState<Record<KeptByThisPanel, boolean>>({ assignment: false, document: false });
  const [saving, setSaving] = useState<BriefKind | null>(null);
  const [goalCopied, setGoalCopied] = useState(false);
  const goalCopiedTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (goalCopiedTimeoutRef.current) clearTimeout(goalCopiedTimeoutRef.current);
    };
  }, []);
  // The latest unsaved edits, so a reload still finds them when this device cannot store drafts.
  const live = useRef<LiveDrafts>({});
  const base = `/api/workspace/${encodeURIComponent(workspaceId)}`;
  const queryClient = useQueryClient();
  // The plan the page already reads (one query for both). Until it has answered, the brief shows the objective.
  const goalInPlan = planStatesGoal(usePlanFile(workspaceId).data);
  const noun = goalInPlan ? 'brief' : 'goal';
  const load = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try {
      const result = await apiFetch<WorkContext>(`${base}/work`, { signal });
      // Leaving the workspace aborts this load: a stale result must not touch state or the stored drafts of this workspace.
      if (signal?.aborted) return;
      let nextDraft = result.guidance;
      const found: DraftConflicts = {};
      const kept: string[] = [];
      let nextForm: DocumentFormDraft | null = null;
      if (!readOnly) {
        const assignment = reconcileAssignment(live.current.assignment ?? readDraft('assignment', workspaceId), pickAssignment(result.guidance));
        if (assignment.kind === 'restore') { nextDraft = { ...result.guidance, ...assignment.value }; kept.push('goal'); }
        else if (assignment.kind === 'conflict') found.assignment = assignment.draft;
        else clearDraft('assignment', workspaceId);
        const form = reconcileDocumentForm(live.current.document ?? readDraft('document', workspaceId));
        if (form.kind === 'restore') { nextForm = form.value; kept.push('source document'); }
        else clearDraft('document', workspaceId);
      }
      live.current = { ...found }; // A copy: the effects below write to it, and `found` becomes state.
      setContext(result); setDraft(nextDraft); setConflicts(found);
      if (nextForm) { setDocument(nextForm.document); setSourceType(nextForm.sourceType); setContent(nextForm.content); setUrl(nextForm.url); setEditingDocumentId(null); }
      if (kept.length) setMessage(`Unsaved ${kept.join(' and ')} edits kept. Save them, or discard them.`);
      // Kept edits, and edits that clash with a newer save, are shown where they can be finished or settled.
      if (found.assignment || kept.includes('goal')) setPanel('assignment');
      else if (kept.includes('source document')) setPanel('documents');
    } catch (error) {
      if (signal?.aborted) return;
      setError(error instanceof Error ? error.message : 'Unable to load work brief.');
    }
  }, [base, workspaceId, readOnly]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Keep unsaved edits on this device as they are made, so leaving the workspace or reloading does not lose them.
  // A pending conflict owns the stored draft until the user chooses.
  useEffect(() => {
    if (readOnly || !context || !draft || conflicts.assignment) return;
    const saved = pickAssignment(context.guidance);
    const mine = pickAssignment(draft);
    if (sameAssignment(mine, saved)) {
      live.current.assignment = undefined; clearDraft('assignment', workspaceId);
      setNotKept((current) => current.assignment ? { ...current, assignment: false } : current);
      return;
    }
    live.current.assignment = { base: saved, value: mine, savedAt: Date.now() };
    const stored = writeDraft('assignment', workspaceId, saved, mine);
    setNotKept((current) => current.assignment === !stored ? current : { ...current, assignment: !stored });
  }, [readOnly, context, draft, conflicts.assignment, workspaceId]);
  // The Add source document form has no saved version to clash with. Pasted source text may be sensitive, so it is kept per window only.
  useEffect(() => {
    if (readOnly || !context) return;
    const form: DocumentFormDraft = { document, sourceType, content, url };
    if (editingDocumentId || sameDocumentForm(form, emptyDocumentForm())) {
      live.current.document = undefined; clearDraft('document', workspaceId);
      setNotKept((current) => current.document ? { ...current, document: false } : current);
      return;
    }
    live.current.document = { base: emptyDocumentForm(), value: form, savedAt: Date.now() };
    const stored = writeDraft('document', workspaceId, emptyDocumentForm(), form);
    setNotKept((current) => current.document === !stored ? current : { ...current, document: !stored });
  }, [readOnly, context, document, sourceType, content, url, editingDocumentId, workspaceId]);

  const perform = async (operation: () => Promise<void>, savingKind?: BriefKind) => {
    setBusy(true); setError(''); setMessage('');
    if (savingKind) setSaving(savingKind);
    try {
      await operation();
      // The workspace header shows the stage and next milestone; keep it current.
      void queryClient.invalidateQueries({ queryKey: ['workspace-work', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-lifecycle', workspaceId] });
    }
    catch (error) { setError(error instanceof Error ? error.message : 'The operation failed.'); }
    finally { setBusy(false); setSaving(null); }
  };
  const savedMessage = (baseMessage: string, result: { contextRefreshed?: boolean; contextRefreshError?: string }) => {
    if (result.contextRefreshed === false) return `${baseMessage} Generated context refresh failed: ${result.contextRefreshError ?? 'run refresh and retry.'}`;
    return result.contextRefreshed === true ? `${baseMessage} Generated context refreshed.` : baseMessage;
  };
  const milestoneOptions = <>{context?.lifecycle?.steps.map((step) => <option key={step.id} value={step.id}>{step.title}</option>)}</>;
  const patchAssignment = (patch: Partial<WorkGuidance['assignment']>) => setDraft((current) => current ? { ...current, assignment: { ...current.assignment, ...patch } } : current);
  const saveAssignment = () => perform(async () => {
    if (!context || !draft) return;
    const result = await apiFetch<WorkContext>(`${base}/work`, { method: 'PUT', body: JSON.stringify({
      revision: context.guidance.revision, workType: draft.workType, size: draft.size, assignment: draft.assignment,
    }) });
    setContext(result); setDraft(result.guidance); setMessage(savedMessage('Goal saved.', result));
  }, 'assignment');
  const saveDocument = () => perform(async () => {
    if (!context) return;
    const result = await apiFetch<WorkContext>(`${base}/work/documents${editingDocumentId ? `/${editingDocumentId}` : ''}`, {
      method: editingDocumentId ? 'PATCH' : 'POST', body: JSON.stringify({
        ...document, revision: context.guidance.revision,
        ...(!editingDocumentId ? sourceType === 'link' ? { url } : { content } : {}),
      }),
    });
    setContext(result); setDocument(emptyDocument()); setEditingDocumentId(null); setContent(''); setUrl('');
    setMessage(savedMessage('Document saved. Its role, status, and scope now appear in AI context.', result));
  });
  const assignmentDirty = Boolean(draft && context && !sameAssignment(pickAssignment(draft), pickAssignment(context.guidance)));
  const documentFormDirty = !sameDocumentForm({ document, sourceType, content, url }, emptyDocumentForm());
  const assignmentState: DraftState = conflicts.assignment ? 'conflict' : saving === 'assignment' ? 'saving' : assignmentDirty ? 'unsaved' : 'saved';
  const withoutConflict = (kind: BriefKind) => setConflicts((current) => ({ ...current, [kind]: undefined }));
  // The saved version stays on screen until the user chooses, so a kept draft only ever replaces it deliberately.
  const keepAssignmentDraft = () => {
    if (!context || !conflicts.assignment) return;
    setDraft({ ...context.guidance, ...mergeAssignmentDraft(conflicts.assignment, pickAssignment(context.guidance)) }); withoutConflict('assignment');
    setMessage('Your edits are applied to the latest saved assignment. Review them, then save.');
  };
  const useSavedAssignment = () => { if (context) { setDraft(context.guidance); withoutConflict('assignment'); setMessage('Using the saved assignment. Your unsaved edits were discarded.'); } };
  const copyGoal = () => void perform(async () => {
    if (!context) return;
    if (!await safeCopyToClipboard(context.assignment)) throw new Error('Could not copy the goal. Check browser clipboard permissions.');
    setGoalCopied(true);
    if (goalCopiedTimeoutRef.current) clearTimeout(goalCopiedTimeoutRef.current);
    goalCopiedTimeoutRef.current = window.setTimeout(() => setGoalCopied(false), 1500);
    setMessage('Goal copied, with the plan, ready to paste to an assistant.');
  });
  const readDocument = (id: string) => void perform(async () => {
    const result = await apiFetch<{ document: WorkDocument; content?: string; location: string }>(`${base}/work/documents/${id}`);
    setPreview({ title: result.document.title, content: result.content, location: result.location });
  });
  const close = (what: string) => <Button size="xs" variant="ghost" aria-label={`Done with ${what}`} onClick={() => setPanel(null)}>Done</Button>;
  const edit = (label: string, target: NonNullable<typeof panel>) => <IconButton label={label} icon={<Pencil />} className="text-muted-foreground" onClick={() => setPanel(target)} />;
  const hasMilestones = Boolean(context?.lifecycle?.steps.length);
  const briefScope = draft ? context?.lifecycle?.steps.find((step) => step.id === draft.assignment.milestoneId)?.title : undefined;
  const previewBox = preview && <div className="rounded-lg border border-border p-3 space-y-2"><div className="flex justify-between gap-2"><h4 className="text-sm font-semibold">{preview.title}</h4><Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Close document</Button></div>
    {preview.content !== undefined ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{preview.content}</pre> : <a className="text-sm text-primary underline" href={preview.location} target="_blank" rel="noopener noreferrer">Open source document</a>}
  </div>;

  return <section className="mb-5 space-y-3" aria-label="Work brief and sources">
    {error && <p role="alert" className="text-sm text-destructive">{error} Your draft is kept. Reload to review the latest saved version.</p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {!context || !draft ? <p className="text-sm">{error ? 'The plan is unavailable.' : 'Loading the plan…'}</p> : <>
      {conflicts.assignment && <DraftConflictNotice noun="goal" differences={assignmentConflicts(conflicts.assignment, pickAssignment(context.guidance))} onKeep={keepAssignmentDraft} onUseSaved={useSavedAssignment} />}

      <PlanCard title={goalInPlan ? 'Brief' : 'Goal'} action={
        <div className="flex items-center gap-0.5">
          <IconButton label={goalCopied ? 'Goal copied' : `Copy the ${noun} for an assistant`} icon={goalCopied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />} className="text-muted-foreground hover:text-foreground" disabled={busy || !context || Boolean(assignmentDirty)} onClick={copyGoal} />
          <IconButton label="Reload the plan" icon={<RefreshCw className="size-3.5" />} className="text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => void load()} />
          {panel === 'assignment' ? close(`the ${noun}`) : !readOnly && edit(`Edit the ${noun}`, 'assignment')}
        </div>
      }
        meta={<>
          {goalInPlan && panel !== 'assignment' && briefParts(draft, briefScope).map((part) => <span key={part} className={CHIP}>{part}</span>)}
          {!readOnly && panel !== 'assignment' && assignmentState !== 'saved' ? <DraftStateLabel state={assignmentState} kept={!notKept.assignment} /> : null}
        </>}>
        {panel === 'assignment' ? <div className="space-y-4">
          <fieldset disabled={readOnly || Boolean(conflicts.assignment)} className="m-0 min-w-0 border-0 p-0 space-y-4">
          <label className="block text-sm">Current objective<Textarea className="mt-1" value={draft.assignment.objective} onChange={(event) => patchAssignment({ objective: event.target.value })} placeholder="Investigate why invoice totals differ from line items." /></label>
          <label className="block text-sm">Expected output<Textarea className="mt-1" value={draft.assignment.expectedOutput} onChange={(event) => patchAssignment({ expectedOutput: event.target.value })} placeholder="A reproduction, likely cause, and proposed test plan." /></label>
          <label className="block text-sm">Stop when<Textarea className="mt-1" value={draft.assignment.stopCondition} onChange={(event) => patchAssignment({ stopCondition: event.target.value })} placeholder="The proposal is ready for review. Stop before implementation." /></label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">Current stage<select aria-label="Current stage" className={selectClass} value={draft.assignment.stage} onChange={(event) => patchAssignment({ stage: event.target.value as WorkGuidance['assignment']['stage'] })}>
              {stages.map((stage) => <option key={stage} value={stage}>{stage[0].toUpperCase() + stage.slice(1)}</option>)}
            </select></label>
            <label className="text-sm">Work type<select aria-label="Work type" className={selectClass} value={draft.workType} onChange={(event) => setDraft({ ...draft, workType: event.target.value as WorkGuidance['workType'] })}>
              {(['bug', 'feature', 'performance', 'refactor', 'rewrite'] as const).map((value) => <option key={value} value={value}>{WORK_TYPES[value]}</option>)}
            </select></label>
            <label className="text-sm">Size<select aria-label="Size" className={selectClass} value={draft.size} onChange={(event) => setDraft({ ...draft, size: event.target.value as WorkGuidance['size'] })}>
              <option value="small">{SIZES.small}</option><option value="standard">{SIZES.standard}</option><option value="epic">{SIZES.epic}</option>
            </select></label>
          </div>
          {Boolean(context.lifecycle?.steps.length) && <label className="block text-sm">Assignment scope<select aria-label="Assignment scope" className={selectClass} value={draft.assignment.milestoneId ?? ''} onChange={(event) => patchAssignment({ milestoneId: event.target.value || undefined })}>
            <option value="">Whole workspace</option>{milestoneOptions}
          </select></label>}
          <p className="text-xs text-muted-foreground">The assistant reads this as its assignment. Type and size describe the work; changing them does not reset progress.</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            {!readOnly && <Button disabled={busy || Boolean(conflicts.assignment)} onClick={() => void saveAssignment()}>Save goal</Button>}
            {!readOnly && assignmentDirty && !conflicts.assignment && <Button variant="ghost" disabled={busy} onClick={() => { setDraft(context.guidance); setMessage('Unsaved goal edits discarded.'); }}>Discard unsaved goal changes</Button>}
            {!readOnly && <DraftStateLabel state={assignmentState} kept={!notKept.assignment} />}
          </div>
        </div> : goalInPlan ? assignmentNotes(draft, hasMilestones)
          : <GoalSummary guidance={draft} scope={briefScope} hasMilestones={hasMilestones} />}
      </PlanCard>

      <PlanCard title="Sources" action={panel === 'documents' ? close('the sources') : !readOnly && edit('Edit sources', 'documents')}
        meta={context.guidance.documents.length > 0 && <span className="text-xs text-muted-foreground">{context.guidance.documents.length}</span>}>
        {panel === 'documents' ? <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Attach Markdown/text or link to a document. Approved requirements define intended behavior; drafts remain proposals. Superseded documents stay available as history.</p>
        {context.projectId && <p className="text-xs text-muted-foreground">Project sources are stored in the workspace where you add them. Keep that workspace while sources are active; supersede or copy them elsewhere before deleting it.</p>}
        <ul className="space-y-2">{context.guidance.documents.map((doc) => <li key={doc.id} className="rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="font-medium text-sm">{doc.title}</p><p className="text-xs text-muted-foreground">{doc.role} · {doc.status} · {doc.scope.project ? 'Entire project' : doc.scope.milestoneId ? context.lifecycle?.steps.find((step) => step.id === doc.scope.milestoneId)?.title ?? doc.scope.milestoneId : 'Whole workspace'}</p></div>
            <div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => {
              const result = await apiFetch<{ document: WorkDocument; content?: string; location: string }>(`${base}/work/documents/${doc.id}`);
              setPreview({ title: result.document.title, content: result.content, location: result.location });
            })}>Read {doc.title}</Button>{!readOnly && <Button variant="ghost" size="sm" onClick={() => { setDocument(doc); setEditingDocumentId(doc.id); }}>Edit {doc.title}</Button>}</div>
          </div>
        </li>)}</ul>
        {Boolean(context.sharedDocuments?.length) && <div className="space-y-2">
          <h4 className="font-semibold text-sm">Shared project sources</h4>
          {context.sharedDocuments!.map((doc) => <div key={doc.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
            <p className="text-sm">{doc.title}<span className="block text-xs text-muted-foreground">{doc.role} · {doc.status} · managed in {doc.workspaceId}</span></p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => {
              const result = await apiFetch<{ document: WorkDocument; content?: string; location: string }>(`${base}/work/documents/${doc.id}`);
              setPreview({ title: result.document.title, content: result.content, location: result.location });
            })}>Read {doc.title}</Button>
          </div>)}
        </div>}
        {!context.guidance.documents.length && <p className="text-sm text-muted-foreground">No documents yet. Add only the sources this work needs.</p>}
        {previewBox}
        {!readOnly && <div className="border-t border-border pt-4 space-y-3">
          <h4 className="font-medium text-sm">{editingDocumentId ? 'Edit document labels' : 'Add source document'}</h4>
          <label className="block text-sm">Document title<Input value={document.title} onChange={(event) => setDocument({ ...document, title: event.target.value })} /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Document role<select aria-label="Document role" className={selectClass} value={document.role} onChange={(event) => setDocument({ ...document, role: event.target.value as WorkDocument['role'] })}>
              {(['requirements', 'design', 'evidence', 'reference'] as const).map((role) => <option key={role} value={role}>{role[0].toUpperCase() + role.slice(1)}</option>)}
            </select></label>
            <label className="text-sm">Document status<select aria-label="Document status" className={selectClass} value={document.status} onChange={(event) => setDocument({ ...document, status: event.target.value as WorkDocument['status'] })}>
              <option value="draft">Draft</option><option value="approved">Approved</option><option value="superseded">Superseded</option>
            </select></label>
          </div>
          <label className="block text-sm">Document scope<select aria-label="Document scope" className={selectClass} value={document.scope.project ? 'project' : document.scope.milestoneId ? `milestone:${document.scope.milestoneId}` : ''} onChange={(event) => setDocument({ ...document, scope: event.target.value === 'project' ? { project: true } : { milestoneId: event.target.value.replace(/^milestone:/, '') || undefined } })}>
            <option value="">Whole workspace</option>{context.projectId && <option value="project">Entire project (shared)</option>}
            {context.lifecycle?.steps.map((step) => <option key={step.id} value={`milestone:${step.id}`}>{step.title}</option>)}
          </select></label>
          {!editingDocumentId && <>
            <label className="block text-sm">Document source<select aria-label="Document source" className={selectClass} value={sourceType} onChange={(event) => setSourceType(event.target.value as 'text' | 'link')}><option value="text">Upload or paste Markdown/text</option><option value="link">Link to a document</option></select></label>
            {sourceType === 'link' ? <label className="block text-sm">Document URL<Input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label> : <>
              <label className="block text-sm">Upload text document<input type="file" className="mt-1 block w-full text-sm" accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void perform(async () => {
                  if (file.size > 500_000 || !/\.(md|markdown|txt)$/i.test(file.name)) throw new Error('Choose a Markdown or text file up to 500 KB. Link to other document formats.');
                  setContent(await file.text()); setDocument((current) => ({ ...current, title: current.title || file.name }));
                });
              }} /></label>
              <label className="block text-sm">Source text<Textarea value={content} onChange={(event) => setContent(event.target.value)} rows={5} /></label>
            </>}
          </>}
          <label className="block text-sm">Owner summary (optional)<Textarea value={document.summary} onChange={(event) => setDocument({ ...document, summary: event.target.value })} placeholder="Highlight what matters for this task. The original remains available." /></label>
          <div className="flex gap-2"><Button disabled={busy || !document.title.trim() || (!editingDocumentId && !(sourceType === 'link' ? url.trim() : content.trim()))} onClick={() => void saveDocument()}>{editingDocumentId ? 'Save document labels' : 'Add document'}</Button>
            {editingDocumentId && <Button variant="ghost" onClick={() => { setEditingDocumentId(null); setDocument(emptyDocument()); }}>Cancel document edit</Button>}
            {!editingDocumentId && documentFormDirty && <Button variant="ghost" disabled={busy} onClick={() => { setDocument(emptyDocument()); setSourceType('text'); setContent(''); setUrl(''); setMessage('Unsaved source document discarded.'); }}>Discard unsaved source document</Button>}
            {!editingDocumentId && documentFormDirty && <DraftStateLabel state="unsaved" kept={!notKept.document} keptText="Unsaved — kept until you close this window" />}
          </div>
        </div>}
      </div> : <div className="space-y-2">
          {context.guidance.documents.length || context.sharedDocuments?.length ? <ul className="space-y-1">
            {[...context.guidance.documents, ...(context.sharedDocuments ?? [])].map((doc) => <li
              key={doc.id}
              onClick={(e) => !busy && handleDelegatedRowClick(e, () => readDocument(doc.id))}
              className={cn(
                'group flex items-center gap-2 text-sm rounded-lg px-2.5 py-1.5 -mx-1 transition-colors select-text',
                busy ? 'opacity-60 cursor-not-allowed' : 'hover:bg-accent/40 cursor-pointer'
              )}
            >
              <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
              <span className="min-w-0 flex-1 truncate">{doc.title}<span className="ml-2 text-xs text-muted-foreground">{doc.role} · {doc.status}</span></span>
              <IconButton label={`Read ${doc.title}`} icon={<Eye />} className="text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => readDocument(doc.id)} />
            </li>)}
          </ul> : <p className="text-sm text-muted-foreground">None yet. Add the requirements, designs or evidence the assistant should follow.</p>}
          {previewBox}
        </div>}
      </PlanCard>

    </>}
  </section>;
}
