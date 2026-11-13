/**
 * The Assignment card at the top of the Board overview, under the Now line: the assignment's description and the specs sent with it.
 * Compact by default (one line); pressing it opens a panel over the top of the stage to read and edit the description and to add a spec
 * (pasted text, or a Markdown/text file read in the browser). File: gui/src/features/board/AssignmentCard.tsx
 *
 * Everything typed is kept: the description draft per workspace and device, the Add spec form per window (pasted text may be sensitive),
 * and both are written as they are typed, never from an effect that follows the saved data. The state lives here, not in the panel, so
 * closing the panel, stepping into an Area or a guidance refetch leaves it alone.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, X } from 'lucide-react';

import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiFetch, ApiError } from '../../lib/api/client.js';
import { cn } from '../../lib/utils.js';
import { agoText } from '../plan/whatsNew.js';
import { DraftConflictNotice, DraftStateLabel, type DraftState } from '../work-guidance/BriefDraftNotices.js';
import {
  assignmentConflicts, clearDraft, emptyDocumentForm, mergeAssignmentDraft, pickAssignment, readDraft, reconcileAssignment, reconcileDocumentForm,
  sameAssignment, sameDocumentForm, writeDraft, type AssignmentDraft, type DocumentFormDraft, type StoredDraft,
} from '../work-guidance/briefDrafts.js';
import { isCodeWindowOpen } from '../workspace-shell/codeWindowOpen.js';
import type { WorkDocument, WorkGuidance } from '../../types.js';
import {
  OBJECTIVE_LIMIT, SPEC_CHAR_LIMIT, assignmentCardView, assignmentSaveBody, checkObjective, checkSpec, checkSpecFileName, checkSpecText, specSaveBody, specTitleFromFile,
} from './assignmentCardView.js';

const PART = 'inline-flex min-h-6 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50';
/** How many spec chips the compact card names before it says "+N more". */
const CHIPS_SHOWN = 3;
/** A file this large cannot hold 500,000 characters of text (at most 4 bytes each), so it is refused without being read. */
const FILE_READ_LIMIT = SPEC_CHAR_LIMIT * 4 + 1024;

interface WorkResult { guidance: WorkGuidance }
type Conflict = { draft: StoredDraft<AssignmentDraft>; saved: WorkGuidance };

export interface AssignmentCardProps {
  workspaceId: string;
  guidance: WorkGuidance;
  /** Archived workspace: the text and the specs, nothing to edit. */
  readOnly?: boolean;
  /** The Board is stepped into an Area: the card is not shown, but what was typed stays. */
  hidden?: boolean;
  /** The reader is open: its Escape comes first, and the panel steps aside for it. */
  readerOpen: boolean;
  onOpenSource: (doc: WorkDocument, from: HTMLElement | null) => void;
}

export function AssignmentCard({ workspaceId, guidance, readOnly = false, hidden = false, readerOpen, onOpenSource }: AssignmentCardProps) {
  const queryClient = useQueryClient();
  const panelId = useId();
  const queryKey = ['workspace-work', workspaceId];
  const base = `/api/workspace/${encodeURIComponent(workspaceId)}/work`;
  const view = assignmentCardView(guidance);

  const [open, setOpen] = useState(false);
  // The description: the version the edit started from (it supplies the revision to save against), and the text typed
  const [editFrom, setEditFrom] = useState<WorkGuidance | null>(null);
  const [text, setText] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [notKept, setNotKept] = useState({ assignment: false, document: false });
  // The Add spec form
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<DocumentFormDraft>(emptyDocumentForm);
  const [adder, setAdder] = useState(false);
  const [message, setMessage] = useState('');
  const [descriptionError, setDescriptionError] = useState('');
  const [specError, setSpecError] = useState('');

  const cardButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);
  const textArea = useRef<HTMLDivElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const reconciled = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const panelAddButton = useRef<HTMLButtonElement>(null);
  // The latest typed text and form, read by the async paths so nothing typed meanwhile is dropped
  const textRef = useRef('');
  // The edit and the conflict as they are now, for requests that resolve later
  const editFromRef = useRef<WorkGuidance | null>(null);
  const conflictRef = useRef<Conflict | null>(null);
  const setEdit = (value: WorkGuidance | null) => { editFromRef.current = value; setEditFrom(value); };
  const setConf = (value: Conflict | null) => { conflictRef.current = value; setConflict(value); };
  /** Answers never put an older revision back over a newer one already known. */
  const putGuidance = (value: WorkGuidance) => {
    const known = queryClient.getQueryData<WorkGuidance>(queryKey);
    if (!known || known.revision <= value.revision) queryClient.setQueryData(queryKey, value);
  };
  const formRef = useRef<DocumentFormDraft>(form);
  const pendingFocus = useRef<'textarea' | 'edit' | 'title' | 'add' | null>(null);

  const editing = editFrom !== null;
  const dirty = editFrom !== null && text !== editFrom.assignment.objective;
  const formDirty = adding && !sameDocumentForm(form, emptyDocumentForm());
  const pending = !readOnly && (dirty || conflict !== null || formDirty);

  const setTyped = (value: string) => { textRef.current = value; setText(value); };

  // What was typed before (an earlier visit, a reload, another workspace and back) is found once, when the saved version first arrives.
  useEffect(() => {
    if (reconciled.current || readOnly) return;
    reconciled.current = true;
    const saved = pickAssignment(guidance);
    const stored = readDraft('assignment', workspaceId);
    const decision = reconcileAssignment(stored, saved);
    if (decision.kind === 'restore') { setEdit(guidance); setTyped(decision.value.assignment.objective); }
    else if (decision.kind === 'conflict') { setConf({ draft: decision.draft, saved: guidance }); setEdit(guidance); setTyped(decision.draft.value.assignment.objective); }
    else clearDraft('assignment', workspaceId);
    const restored = reconcileDocumentForm(readDraft('document', workspaceId));
    if (restored.kind === 'restore') { formRef.current = restored.value; setForm(restored.value); setAdding(true); } else clearDraft('document', workspaceId);
  }, [guidance, workspaceId, readOnly]);

  // Focus: into the panel when it opens; back to what opened it when it is closed by its own Close or Escape
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const target = textArea.current?.querySelector('textarea') ?? (adding ? titleField.current : null) ?? panel.current;
      target?.focus();
    }
    if (!open && wasOpen.current && returnFocus.current) {
      returnFocus.current = false;
      const from = opener.current;
      (from && from.isConnected && from.offsetParent !== null ? from : cardButton.current)?.focus();
    }
    wasOpen.current = open;
  }, [open, adding]);
  // Inside the panel, a button that goes away hands the keyboard to the next thing, not to the page
  useEffect(() => {
    const next = pendingFocus.current;
    if (!next) return;
    pendingFocus.current = null;
    if (!open) return;
    // Only while the keyboard is nowhere or still in the card: a slow answer must not take it from where the person went
    const at = document.activeElement;
    if (at && at !== document.body && !at.closest('[data-testid="assignment-card-wrap"]')) return;
    const target = next === 'textarea' ? textArea.current?.querySelector('textarea') : next === 'edit' ? editButton.current : next === 'title' ? titleField.current : panelAddButton.current;
    (target ?? panel.current)?.focus();
  }, [editing, adding, open]);
  // The reader takes the stage: the panel steps aside (no focus is moved: the reader has it)
  useEffect(() => { if (readerOpen) setOpen(false); }, [readerOpen]);
  useEffect(() => { if (hidden) setOpen(false); }, [hidden]);

  // Escape with the keyboard nowhere in particular (focus fell to the page when a form closed): the open panel closes. Inside the panel its own
  // handler has it, and the reader, a dialog or the Code window come first.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || readerOpen || isCodeWindowOpen()) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      if (document.querySelector('[role="dialog"], [data-slot="menu-popup"]')) return;
      event.preventDefault();
      returnFocus.current = true;
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, readerOpen]);

  const openPanel = (from: HTMLElement | null, then?: 'edit' | 'add') => {
    opener.current = from;
    if (then === 'edit' && !editFrom && !readOnly) startEdit();
    if (then === 'add' && !readOnly) { pendingFocus.current = 'title'; setAdding(true); }
    setOpen(true);
  };
  const closePanel = (restoreFocus = true) => {
    returnFocus.current = restoreFocus;
    setOpen(false);
  };
  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || readerOpen || isCodeWindowOpen()) return;
    if (document.querySelector('[data-slot="menu-popup"]')) return;
    event.preventDefault();
    closePanel();
  };

  const startEdit = () => { pendingFocus.current = 'textarea'; setEdit(guidance); setTyped(guidance.assignment.objective); setDescriptionError(''); setMessage(''); };
  const keepAssignmentDraft = (value: string, from: WorkGuidance) => {
    const saved = pickAssignment(from);
    const mine: AssignmentDraft = { ...saved, assignment: { ...saved.assignment, objective: value } };
    if (sameAssignment(mine, saved)) { clearDraft('assignment', workspaceId); setNotKept((cur) => ({ ...cur, assignment: false })); return; }
    const stored = writeDraft('assignment', workspaceId, saved, mine);
    setNotKept((cur) => ({ ...cur, assignment: !stored }));
  };
  const changeText = (next: string) => {
    setTyped(next); setDescriptionError('');
    if (editFrom && !conflict) keepAssignmentDraft(next, editFrom);
  };
  const cancelEdit = () => {
    clearDraft('assignment', workspaceId); setNotKept((cur) => ({ ...cur, assignment: false }));
    pendingFocus.current = 'edit';
    setEdit(null); setTyped(''); setConf(null); setDescriptionError(''); setMessage('Edit discarded.');
  };

  const saveDescription = async () => {
    if (!editFrom || saving || conflict) return;
    const problem = checkObjective(text);
    if (problem) { setDescriptionError(problem); return; }
    setSaving(true); setDescriptionError(''); setMessage('');
    try {
      // The text is read-only while this runs. If only the revision moved (a spec was added, nobody changed the assignment), the save
      // goes again against the latest revision without asking; a real change by someone else is shown as a choice.
      let from = editFrom;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await apiFetch<WorkResult>(base, { method: 'PUT', body: JSON.stringify(assignmentSaveBody(from, from.revision, textRef.current)) });
          putGuidance(result.guidance);
          void queryClient.invalidateQueries({ queryKey: ['workspace-lifecycle', workspaceId] });
          clearDraft('assignment', workspaceId);
          setNotKept((cur) => ({ ...cur, assignment: false }));
          pendingFocus.current = 'edit';
          setEdit(null); setTyped(''); setMessage('Description saved.');
          return;
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 409)) throw error;
          let latest: WorkGuidance;
          try { latest = (await apiFetch<WorkResult>(base)).guidance; } catch { throw error; }
          putGuidance(latest);
          if (attempt === 0 && sameAssignment(pickAssignment(latest), pickAssignment(from))) { from = latest; setEdit(latest); continue; }
          // Someone saved meanwhile: what was typed stays, next to what was saved, until the person chooses.
          const saved = pickAssignment(from);
          const draft: StoredDraft<AssignmentDraft> = { base: saved, value: { ...saved, assignment: { ...saved.assignment, objective: textRef.current } }, savedAt: Date.now() };
          writeDraft('assignment', workspaceId, draft.base, draft.value);
          setConf({ draft, saved: latest });
          return;
        }
      }
    } catch (error) {
      setDescriptionError(`Not saved: ${error instanceof Error ? error.message : 'the save failed'}. Your text is kept here; try again.`);
    } finally { setSaving(false); }
  };
  const useMine = () => {
    if (!conflict) return;
    const merged = mergeAssignmentDraft(conflict.draft, pickAssignment(conflict.saved));
    setEdit(conflict.saved); setTyped(merged.assignment.objective); keepAssignmentDraft(merged.assignment.objective, conflict.saved);
    setConf(null); setMessage('Your text is now on top of the newer version. Review it, then save.');
  };
  const useSaved = () => {
    if (!conflict) return;
    clearDraft('assignment', workspaceId); setNotKept((cur) => ({ ...cur, assignment: false }));
    pendingFocus.current = 'edit';
    setEdit(null); setTyped(''); setConf(null); setMessage('Using the saved description. Your edit was discarded.');
  };

  // The Add spec form, kept per window as it is typed
  const changeForm = (patch: Partial<{ title: string; content: string; summary: string }>) => {
    const current = formRef.current;
    const next: DocumentFormDraft = {
      ...current,
      document: { ...current.document, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.summary !== undefined ? { summary: patch.summary } : {}) },
      ...(patch.content !== undefined ? { content: patch.content } : {}),
    };
    formRef.current = next; setForm(next); setSpecError('');
    if (sameDocumentForm(next, emptyDocumentForm())) { clearDraft('document', workspaceId); setNotKept((cur) => ({ ...cur, document: false })); return; }
    const stored = writeDraft('document', workspaceId, emptyDocumentForm(), next);
    setNotKept((cur) => ({ ...cur, document: !stored }));
  };
  const discardSpec = () => {
    clearDraft('document', workspaceId); setNotKept((cur) => ({ ...cur, document: false }));
    pendingFocus.current = 'add';
    formRef.current = emptyDocumentForm(); setForm(formRef.current); setAdding(false); setSpecError('');
  };
  const chooseFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = ''; // The same file can be chosen again after a refusal
    if (!file) return;
    setSpecError('');
    const nameProblem = checkSpecFileName(file.name);
    if (nameProblem) { setSpecError(nameProblem); return; }
    if (file.size > FILE_READ_LIMIT) { setSpecError(`"${file.name}" is too large for a spec (up to ${SPEC_CHAR_LIMIT.toLocaleString('en')} characters). Nothing was added.`); return; }
    let content: string;
    try { content = await file.text(); } catch { setSpecError(`"${file.name}" could not be read. Nothing was added.`); return; }
    const problem = checkSpecText(content);
    if (problem) { setSpecError(problem); return; }
    changeForm({ content, ...(formRef.current.document.title.trim() ? {} : { title: specTitleFromFile(file.name) }) });
  };
  const addSpec = async () => {
    if (adder) return;
    const entry = { title: formRef.current.document.title, content: formRef.current.content, summary: formRef.current.document.summary };
    const problem = checkSpec(entry);
    if (problem) { setSpecError(problem); return; }
    setAdder(true); setSpecError(''); setMessage('');
    try {
      const result = await apiFetch<WorkResult>(`${base}/documents`, { method: 'POST', body: JSON.stringify(specSaveBody(guidance.revision, entry)) });
      putGuidance(result.guidance);
      void queryClient.invalidateQueries({ queryKey: ['workspace-lifecycle', workspaceId] });
      clearDraft('document', workspaceId); setNotKept((cur) => ({ ...cur, document: false }));
      // Adding a spec moves the revision. A description being edited moves with it when nobody changed the assignment itself.
      const current = editFromRef.current;
      if (current && !conflictRef.current && sameAssignment(pickAssignment(current), pickAssignment(result.guidance))) { setEdit(result.guidance); keepAssignmentDraft(textRef.current, result.guidance); }
      pendingFocus.current = 'add';
      formRef.current = emptyDocumentForm(); setForm(formRef.current); setAdding(false); setMessage(`Added "${entry.title.trim()}". The assistant reads it with its assignment.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try { putGuidance((await apiFetch<WorkResult>(base)).guidance); } catch { /* The next press reads it again. */ }
        setSpecError('The assignment was saved by someone else just now. Your spec is kept here; press Add spec again.');
      } else setSpecError(`Not added: ${error instanceof Error ? error.message : 'the save failed'}. Your spec is kept here; try again.`);
    } finally { setAdder(false); }
  };

  const openSpec = (doc: WorkDocument) => {
    const chip = Array.from(cardButton.current?.parentElement?.querySelectorAll<HTMLElement>('[data-spec-chip]') ?? []).find((el) => el.dataset.specChip === doc.id && el.offsetParent !== null);
    closePanel(false);
    onOpenSource(doc, chip ?? cardButton.current);
  };

  const descriptionState: DraftState = conflict ? 'conflict' : saving ? 'saving' : dirty ? 'unsaved' : 'saved';
  const differences = conflict ? assignmentConflicts(conflict.draft, pickAssignment(conflict.saved)) : [];
  const shownDifferences = conflict && differences.length === 0
    ? [{ label: 'Description', draft: conflict.draft.value.assignment.objective, saved: conflict.saved.assignment.objective }]
    : differences;
  const expected = guidance.assignment.expectedOutput?.trim();
  const stops = guidance.assignment.stopCondition?.trim();
  const shownChips = view.specs.slice(0, CHIPS_SHOWN);
  const moreChips = view.specs.length - shownChips.length;
  const showEditorHeadline = editing;

  return (
    <div className={cn('relative z-20 shrink-0', hidden && 'invisible')} inert={hidden ? true : undefined} data-testid="assignment-card-wrap">
      <div role="region" aria-label="Assignment" data-testid="assignment-card" className="@container flex h-9 shrink-0 items-center gap-1 border-b border-border/50 bg-background px-2">
        <button
          ref={cardButton}
          type="button"
          data-testid="assignment-card-main"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`Assignment: ${view.hasDescription ? view.firstLine : 'No description yet'}${pending ? '. Unsaved edits' : ''}`}
          onClick={(event) => (open ? closePanel() : openPanel(event.currentTarget))}
          className={cn(PART, 'min-w-0 flex-1 shrink justify-start gap-2 overflow-hidden')}
        >
          <span className="shrink-0 font-semibold text-foreground">Assignment</span>
          <span className={cn('min-w-0 truncate', view.hasDescription ? 'text-foreground' : 'text-muted-foreground')}>{view.hasDescription ? view.firstLine : 'No description yet'}</span>
          {pending && <span className="shrink-0 rounded-sm bg-muted px-1 text-xs text-muted-foreground">Unsaved</span>}
        </button>
        {!view.hasDescription && !readOnly && (
          <button type="button" className={cn(PART, 'font-medium text-foreground')} onClick={(event) => openPanel(event.currentTarget, 'edit')}>Edit</button>
        )}
        {view.specs.length === 0 ? (
          <span className="hidden shrink-0 px-1.5 text-xs text-muted-foreground @[34rem]:inline">No specs yet</span>
        ) : (
          <>
            <div className="hidden min-w-0 max-w-[45%] items-center gap-1 overflow-hidden @[40rem]:flex" aria-label="Specs">
              {shownChips.map((chip) => {
                const doc = guidance.documents.find((d) => d.id === chip.id)!;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    data-spec-chip={chip.id}
                    title={`Open the spec: ${chip.title}`}
                    onClick={(event) => onOpenSource(doc, event.currentTarget)}
                    className="inline-flex min-h-6 min-w-0 max-w-[11rem] cursor-pointer items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 text-xs text-foreground outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FileText aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{chip.title}</span>
                  </button>
                );
              })}
              {moreChips > 0 && (
                <button type="button" className={cn(PART, 'text-xs text-muted-foreground')} onClick={(event) => openPanel(event.currentTarget)}>+{moreChips} more</button>
              )}
            </div>
            <button type="button" data-testid="assignment-specs-count" className={cn(PART, 'text-xs text-muted-foreground @[40rem]:hidden')} onClick={(event) => openPanel(event.currentTarget)}>
              {view.specs.length === 1 ? '1 spec' : `${view.specs.length} specs`}
            </button>
          </>
        )}
        {!readOnly && (
          <button type="button" data-testid="assignment-add-spec" className={cn(PART, 'font-medium text-foreground')} onClick={(event) => openPanel(event.currentTarget, 'add')}>
            <Plus aria-hidden="true" className="size-3.5" />Add spec
          </button>
        )}
      </div>

      {open && (
        <div
          ref={panel}
          id={panelId}
          tabIndex={-1}
          role="region"
          aria-label="Assignment details"
          data-testid="assignment-panel"
          onKeyDown={onPanelKeyDown}
          className="absolute inset-x-2 top-full mt-1 max-h-[min(34rem,calc(100vh-10rem))] space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-4 text-sm shadow-lg outline-none"
        >
          <header className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Assignment</h2>
            <span className="min-w-0 flex-1" />
            <IconButton label="Close the assignment" icon={<X />} onClick={() => closePanel()} className="text-muted-foreground" />
          </header>
          {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}

          <section aria-label="Description" className="space-y-2">
            <div className="flex min-h-6 items-center gap-2">
              <h3 className="text-xs font-semibold text-foreground/80">Description</h3>
              <span className="min-w-0 flex-1" />
              {!readOnly && !editing && <Button ref={editButton} size="xs" variant="outline" onClick={startEdit}>Edit</Button>}
            </div>
            {conflict && <DraftConflictNotice noun="description" differences={shownDifferences} onKeep={useMine} onUseSaved={useSaved} />}
            {showEditorHeadline && !readOnly ? (
              <div className="space-y-2">
                <div ref={textArea}>
                  <Textarea
                    aria-label="Description"
                    rows={6}
                    className="w-full"
                    value={text}
                    disabled={conflict !== null}
                    readOnly={saving}
                    onChange={(event) => changeText(event.target.value)}
                    placeholder="What should the assistant do, and why?"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('text-xs tabular-nums', text.length > OBJECTIVE_LIMIT ? 'text-destructive' : 'text-muted-foreground')} data-testid="assignment-count">{text.length} / {OBJECTIVE_LIMIT}</span>
                  <DraftStateLabel state={descriptionState} kept={!notKept.assignment} />
                  <span className="min-w-0 flex-1" />
                  <Button size="sm" disabled={saving || conflict !== null} onClick={() => void saveDescription()}>Save</Button>
                  <Button size="sm" variant="ghost" disabled={saving} onClick={cancelEdit}>Cancel</Button>
                </div>
                {descriptionError && <p role="alert" className="text-xs text-destructive">{descriptionError}</p>}
              </div>
            ) : (
              <p className={cn('whitespace-pre-wrap break-words text-[13px] leading-relaxed', view.hasDescription ? 'text-foreground' : 'text-muted-foreground')}>
                {view.hasDescription ? guidance.assignment.objective : 'No description yet.'}
              </p>
            )}
            {!editing && expected && <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground/80">Expected output: </span><span className="whitespace-pre-wrap">{expected}</span></p>}
            {!editing && stops && <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground/80">Stop when: </span><span className="whitespace-pre-wrap">{stops}</span></p>}
          </section>

          <section aria-label="Specs" className="space-y-2">
            <div className="flex min-h-6 items-center gap-2">
              <h3 className="text-xs font-semibold text-foreground/80">Specs</h3>
              {view.specs.length > 0 && <span className="text-xs text-muted-foreground">{view.specs.length}</span>}
              <span className="min-w-0 flex-1" />
              {!readOnly && !adding && <Button ref={panelAddButton} size="xs" variant="outline" onClick={() => { pendingFocus.current = 'title'; setAdding(true); setMessage(''); }}><Plus aria-hidden="true" />Add spec</Button>}
            </div>
            {guidance.documents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No specs yet. A spec is a longer text sent to the assistant with the assignment, for when the description is not enough.</p>
            ) : (
              <ul className="space-y-0.5">
                {guidance.documents.map((doc) => (
                  <li key={doc.id}>
                    <button type="button" onClick={() => openSpec(doc)} className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring">
                      <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-foreground">{doc.title}</span>
                        {doc.summary && <span className="block truncate text-xs text-muted-foreground">{doc.summary}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{agoText(doc.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {adding && !readOnly && (
              <form
                aria-label="Add spec"
                className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3"
                onSubmit={(event) => { event.preventDefault(); void addSpec(); }}
              >
                <fieldset disabled={adder} className="m-0 min-w-0 space-y-2 border-0 p-0">
                <label className="block text-xs font-medium">Title
                  <Input ref={titleField} className="mt-1" value={form.document.title} onChange={(event) => changeForm({ title: event.target.value })} placeholder="Export requirements" />
                </label>
                <label className="block text-xs font-medium">Spec text
                  <Textarea className="mt-1" rows={5} value={form.content} onChange={(event) => changeForm({ content: event.target.value })} placeholder="Paste the spec here, or upload a file." />
                </label>
                <label className="block text-xs font-medium">Upload a file
                  <input
                    type="file"
                    accept=".md,.markdown,.txt,text/plain,text/markdown"
                    data-testid="assignment-spec-file"
                    className="mt-1 block w-full text-xs file:mr-2 file:min-h-6 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-2 file:text-xs"
                    onChange={(event) => void chooseFile(event.currentTarget)}
                  />
                </label>
                <label className="block text-xs font-medium">Summary (optional)
                  <Input className="mt-1" value={form.document.summary} onChange={(event) => changeForm({ summary: event.target.value })} placeholder="One line on what it covers" />
                </label>
                </fieldset>
                <p className="text-xs text-muted-foreground">The text is copied in. It does not follow later edits to the file.</p>
                {specError && <p role="alert" className="text-xs text-destructive">{specError}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {formDirty && <DraftStateLabel state="unsaved" kept={!notKept.document} keptText="Unsaved. Kept until you close this window" />}
                  <span className="min-w-0 flex-1" />
                  <Button type="submit" size="sm" disabled={adder}>Add spec</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={adder} onClick={discardSpec}>Cancel</Button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
