import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  Button,
  Checkbox,
  Composer,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Spinner,
} from '../../design/index.js';
import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import {
  conflictCurrent,
  isNoteConflict,
  pickNoteEditChanges,
  type NoteConflictCurrent,
  type NoteField,
} from './noteConflict.js';

export interface NoteDialogAreaOption {
  id: string;
  title: string;
  steps?: Array<{ key: string; text: string; done?: boolean }>;
}

export interface NoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When note is provided, we are in edit mode. When null or undefined, create mode. */
  note?: {
    id: string;
    title: string;
    body: string;
    pinned: boolean;
    archived?: boolean;
    area?: string;
    step?: string;
    /** The note's revision when the dialog opened (a workspace moved to its database). */
    rev?: number;
  } | null;
  /** Available areas on the board for the area / step selectors */
  areas?: NoteDialogAreaOption[];
  /** Default area ID if creating a new note */
  defaultAreaId?: string;
  /** Default step key if creating a new note */
  defaultStepKey?: string;
  /** Called to persist the note */
  onSave: (data: {
    title?: string;
    body?: string;
    pinned?: boolean;
    area?: string | null;
    step?: string | null;
    /** The revision the edit started from: the save is refused (409 `rev_conflict`) when the note changed since. */
    rev?: number;
  }) => Promise<boolean | void>;
}

export function NoteDialog({
  open,
  onOpenChange,
  note,
  areas = [],
  defaultAreaId,
  defaultStepKey,
  onSave,
}: NoteDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const areaId = useId();
  const stepId = useId();
  const pinId = useId();

  const titleInputRef = useRef<HTMLInputElement>(null);
  const conflictFirstButtonRef = useRef<HTMLButtonElement>(null);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [area, setArea] = useState('');
  const [step, setStep] = useState('');
  const [preview, setPreview] = useState(false);
  const [font, setFont] = useState<'sans' | 'mono'>('sans');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The note's revision when the edit started, and the note as it is now when a save was refused because it changed meanwhile.
  const [baseRev, setBaseRev] = useState<number | undefined>(undefined);
  const [conflict, setConflict] = useState<{ current: NoteConflictCurrent | null } | null>(null);
  const [sameAsTheirs, setSameAsTheirs] = useState(false);
  const [copied, setCopied] = useState(false);

  // What the fields started from (on open or after "Load their version") and which fields the person actually touched:
  // normal saves diff against initial, while "Save yours over theirs" sends only touched fields differing from theirs.
  const initialRef = useRef({ title: '', body: '', pinned: false, area: '', step: '' });
  const touchedRef = useRef(new Set<NoteField>());
  // Incremented on every open, close, note switch or unmount so a slow save settling later changes nothing on screen.
  const sessionRef = useRef(0);
  // Synchronous re-entrancy guard so two clicks in the same tick send one save.
  const submittingRef = useRef(false);

  // What the fields start from is read when the dialog opens or switches to another note, and at no other time: the board changing under
  // an open dialog (a live change, the plan read again) must never overwrite what is typed.
  const latest = useRef({ note, defaultAreaId, defaultStepKey, areas });
  useEffect(() => { latest.current = { note, defaultAreaId, defaultStepKey, areas }; });
  const noteId = note?.id;
  useLayoutEffect(() => {
    sessionRef.current += 1;
    submittingRef.current = false;
    return () => {
      sessionRef.current += 1;
      submittingRef.current = false;
    };
  }, [open, noteId]);
  useEffect(() => {
    if (!open) return undefined;
    const { note: current, defaultAreaId: area0, defaultStepKey: step0, areas: choices } = latest.current;
    setConflict(null);
    setSameAsTheirs(false);
    setCopied(false);
    setBaseRev(current?.rev);
    touchedRef.current.clear();
    const snap = current
      ? {
          title: current.title,
          body: current.body,
          pinned: current.pinned,
          area: current.area ?? '',
          step: current.step ?? '',
        }
      : {
          title: '',
          body: '',
          pinned: false,
          area: area0 ?? choices[0]?.id ?? '',
          step: step0 ?? '',
        };
    initialRef.current = snap;
    setTitle(snap.title);
    setBody(snap.body);
    setPinned(snap.pinned);
    setArea(snap.area);
    setStep(snap.step);
    setPreview(false);
    setError(null);
    setIsSubmitting(false);

    // Autofocus title input smoothly after open unless the user already moved focus inside the dialog
    const timer = setTimeout(() => {
      const input = titleInputRef.current;
      if (!input) return;
      const dialogEl = input.closest('[role="dialog"]');
      if (!dialogEl || !dialogEl.contains(document.activeElement)) {
        input.focus();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [open, noteId]);

  useEffect(() => {
    if (conflict) conflictFirstButtonRef.current?.focus();
  }, [conflict]);

  const selectedAreaObj = areas.find((a) => a.id === area);
  const availableSteps = selectedAreaObj?.steps ?? [];
  const areaMissing = Boolean(area && !selectedAreaObj);
  const stepMissing = Boolean(step && !availableSteps.some((s) => s.key === step));

  const handleAreaChange = useCallback((newArea: string) => {
    touchedRef.current.add('area');
    setSameAsTheirs(false);
    setArea(newArea);
    // Reset step if current step does not belong to new area
    const targetArea = areas.find((a) => a.id === newArea);
    if (step && !targetArea?.steps?.some((s) => s.key === step)) {
      touchedRef.current.add('step');
      setStep('');
    }
  }, [areas, step]);

  const isEdit = Boolean(note);

  /** `rev`: the revision to save against; by default the one the edit started from. */
  const handleSave = useCallback(async (rev: number | undefined = baseRev, resolving?: NoteConflictCurrent | null) => {
    if (!open || submittingRef.current) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    const cleanBody = body.slice(0, 4000);

    let payload: Parameters<NoteDialogProps['onSave']>[0];
    if (isEdit) {
      const changes = pickNoteEditChanges({
        current: { title: cleanTitle, body: cleanBody, pinned, area, step },
        initial: initialRef.current,
        touched: touchedRef.current,
        rev,
        resolving,
      });
      if (!changes) {
        if (resolving) {
          setSameAsTheirs(true);
          setError(null);
          return;
        }
        if (rev !== undefined) {
          setConflict(null);
          setSameAsTheirs(false);
          onOpenChange(false);
          return;
        }
        payload = {
          title: cleanTitle,
          body: cleanBody,
          pinned,
          area: area || null,
          step: step || null,
        };
      } else {
        payload = changes;
      }
    } else {
      payload = {
        title: cleanTitle,
        body: cleanBody,
        pinned,
        ...(area ? { area } : {}),
        ...(step ? { step } : {}),
      };
    }

    submittingRef.current = true;
    const session = sessionRef.current;
    setIsSubmitting(true);
    setError(null);
    setSameAsTheirs(false);
    try {
      const res = await onSave(payload);
      if (sessionRef.current !== session) return;
      if (res !== false) {
        setConflict(null);
        setSameAsTheirs(false);
        onOpenChange(false);
      } else {
        setError('Could not save note. Please check your connection and try again.');
      }
    } catch (err) {
      if (sessionRef.current !== session) return;
      // Someone changed the note meanwhile: nothing was saved, and what was typed stays in the fields
      if (isNoteConflict(err)) {
        setConflict({ current: conflictCurrent(err) });
        setSameAsTheirs(false);
        setCopied(false);
        setError(null);
      } else {
        // Keep any active conflict panel on 400/503/other errors so the next save still compares against their version.
        setError(err instanceof Error ? err.message : 'Could not save note.');
      }
    } finally {
      if (sessionRef.current === session) {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    }
  }, [open, baseRev, title, onSave, body, pinned, isEdit, area, step, onOpenChange]);

  const copyMine = useCallback(async () => {
    const session = sessionRef.current;
    const ok = await safeCopyToClipboard(`${title.trim()}\n\n${body}`);
    if (sessionRef.current === session) setCopied(ok);
  }, [title, body]);

  // Plain functions: they only run on a press, and read the conflict as it is then.
  const loadTheirs = () => {
    const current = conflict?.current;
    if (!current || submittingRef.current) return;
    const snap = {
      title: current.title,
      body: current.body ?? '',
      pinned: Boolean(current.pinned),
      area: current.area ?? '',
      step: current.step ?? '',
    };
    initialRef.current = snap;
    touchedRef.current.clear();
    setTitle(snap.title);
    setBody(snap.body);
    setPinned(snap.pinned);
    setArea(snap.area);
    setStep(snap.step);
    setBaseRev(current.rev);
    setConflict(null);
    setSameAsTheirs(false);
    setError(null);
    titleInputRef.current?.focus();
  };

  const saveMineAnyway = () => {
    const current = conflict?.current;
    if (!current) return;
    void handleSave(current.rev, current);
  };

  const theirDetails = (() => {
    const current = conflict?.current;
    if (!current) return null;
    const notes: string[] = [];
    const theirArea = current.area ?? '';
    const theirStep = current.step ?? '';
    const theirPinned = Boolean(current.pinned);
    if (theirArea !== area) {
      const label = theirArea ? (areas.find((a) => a.id === theirArea)?.title ?? theirArea) : 'None';
      notes.push(`Area: ${label}`);
    }
    if (theirStep !== step) {
      const allSteps = areas.flatMap((a) => a.steps ?? []);
      const label = theirStep ? (allSteps.find((s) => s.key === theirStep)?.text ?? theirStep) : 'None';
      notes.push(`Step: ${label}`);
    }
    if (theirPinned !== pinned) {
      notes.push(theirPinned ? 'Pinned' : 'Not pinned');
    }
    return notes.length > 0 ? notes.join(' · ') : null;
  })();

  const handleFormSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    if (conflict) return; // the person chooses what to do with the other version first
    void handleSave();
  }, [handleSave, conflict]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!conflict) void handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onOpenChange(false);
    }
  }, [open, handleSave, onOpenChange, conflict]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-xl"
        showCloseButton
        initialFocus={titleInputRef}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg font-semibold text-foreground">
            {isEdit ? 'Edit note' : 'New note'}
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            {isEdit
              ? 'Update the note content, formatting, or pinned status.'
              : 'Add a calm note to the canvas for markdown documentation, ideas, or links.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleFormSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogPanel className="space-y-4 pt-1">
            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive-foreground"
              >
                {error}
              </div>
            )}

            {conflict && (
              <div
                role="alert"
                data-testid="note-conflict"
                className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-foreground"
              >
                <p className="font-medium">
                  {conflict.current?.updatedBy && conflict.current.updatedBy !== 'user' ? `${conflict.current.updatedBy} changed` : 'Someone else changed'} this note while you were editing it, so your changes were not saved. What you typed is still here.
                </p>
                {conflict.current && (
                  <details className="rounded border border-border/60 bg-background/60 px-2 py-1">
                    <summary className="cursor-pointer text-[12.5px] text-muted-foreground">Their version</summary>
                    <div className="mt-1 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words text-[12.5px]">
                      <strong>{conflict.current.title}</strong>
                      {theirDetails && (
                        <div className="text-[12px] text-muted-foreground">{theirDetails}</div>
                      )}
                      {conflict.current.body ? `\n${conflict.current.body}` : ''}
                    </div>
                  </details>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button ref={conflictFirstButtonRef} type="button" size="xs" variant="outline" className="text-[12.5px]" onClick={() => void copyMine()}>
                    {copied ? 'Copied your text' : 'Copy your text'}
                  </Button>
                  {conflict.current && (
                    <>
                      <Button type="button" size="xs" variant="outline" className="text-[12.5px]" onClick={loadTheirs} disabled={isSubmitting} title="Replaces what you typed with their version">
                        Load their version
                      </Button>
                      <Button type="button" size="xs" className="text-[12.5px]" onClick={saveMineAnyway} disabled={isSubmitting || !title.trim()}>
                        Save yours over theirs
                      </Button>
                    </>
                  )}
                </div>
                {sameAsTheirs && (
                  <p className="text-[12.5px] text-foreground">
                    Your version is the same as theirs.
                  </p>
                )}
              </div>
            )}

            {/* Title field */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={titleId}
                  className="text-[13px] font-medium text-foreground"
                >
                  Title <span className="text-destructive" aria-hidden="true">*</span>
                </label>
                <span className="text-[12.5px] text-muted-foreground tabular-nums">
                  {title.length}/200
                </span>
              </div>
              <Input
                ref={titleInputRef}
                id={titleId}
                name="title"
                value={title}
                onChange={(e) => {
                  touchedRef.current.add('title');
                  setSameAsTheirs(false);
                  setTitle(e.target.value);
                }}
                placeholder="Note title..."
                maxLength={200}
                readOnly={isSubmitting}
                required
                className="text-sm"
              />
            </div>

            {/* Body field with Preview & Font toggle */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={bodyId}
                  className="text-[13px] font-medium text-foreground"
                >
                  Body
                </label>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant={font === 'mono' ? 'secondary' : 'ghost'}
                    className="h-6 px-2 text-[12.5px] font-normal"
                    onClick={() => setFont(font === 'mono' ? 'sans' : 'mono')}
                    title="Toggle monospace font in editor"
                  >
                    {font === 'mono' ? 'Mono' : 'Sans'}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={preview ? 'secondary' : 'ghost'}
                    className="h-6 px-2 text-[12.5px] font-normal"
                    onClick={() => setPreview((prev) => !prev)}
                    title="Toggle Markdown preview"
                  >
                    {preview ? 'Edit' : 'Preview'}
                  </Button>
                </div>
              </div>

              {preview ? (
                <div
                  className="min-h-[140px] max-h-[260px] overflow-y-auto rounded-lg border border-border/80 bg-muted/20 p-3 text-[13px] leading-relaxed text-foreground break-words"
                  tabIndex={0}
                  role="region"
                  aria-label="Markdown preview"
                >
                  {body.trim() ? (
                    <div className="board-text">
                      <ChatMarkdown content={body} onCard />
                    </div>
                  ) : (
                    <p className="italic text-muted-foreground">Nothing to preview yet.</p>
                  )}
                </div>
              ) : (
                <Composer
                  id={bodyId}
                  name="body"
                  value={body}
                  onChange={(value) => {
                    touchedRef.current.add('body');
                    setSameAsTheirs(false);
                    setBody(value);
                  }}
                  placeholder="Write Markdown, lists, notes, or links..."
                  maxLength={4000}
                  readOnly={isSubmitting}
                  rows={5}
                  mono={font === 'mono'}
                />
              )}

              <div className="flex items-center justify-between text-[12.5px] text-muted-foreground">
                <span>Markdown supported</span>
                <span className="tabular-nums">{body.length}/4000</span>
              </div>
            </div>

            {/* Area & Step Selectors (if areas exist) */}
            {areas.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor={areaId}
                    className="text-[13px] font-medium text-foreground"
                  >
                    Area
                  </label>
                  <select
                    id={areaId}
                    value={area}
                    disabled={isSubmitting}
                    onChange={(e) => handleAreaChange(e.target.value)}
                    className="block h-8.5 w-full rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20"
                  >
                    {areaMissing && (
                      <option value={area}>(Removed area)</option>
                    )}
                    {areas.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor={stepId}
                    className="text-[13px] font-medium text-foreground"
                  >
                    Step <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <select
                    id={stepId}
                    value={step}
                    onChange={(e) => {
                      touchedRef.current.add('step');
                      setSameAsTheirs(false);
                      setStep(e.target.value);
                    }}
                    disabled={isSubmitting || (availableSteps.length === 0 && !step)}
                    className="block h-8.5 w-full rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground outline-none disabled:opacity-60 focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20"
                  >
                    <option value="">(None / General Area)</option>
                    {stepMissing && (
                      <option value={step}>(Removed step)</option>
                    )}
                    {availableSteps.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.text} {s.done ? '✓' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Pin to top */}
            <div className="pt-1">
              <label
                htmlFor={pinId}
                className="inline-flex cursor-pointer select-none items-center gap-2 text-[13px] font-medium text-foreground"
              >
                <Checkbox
                  id={pinId}
                  checked={pinned}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) => {
                    touchedRef.current.add('pinned');
                    setSameAsTheirs(false);
                    setPinned(Boolean(checked));
                  }}
                />
                <span>Pin to top</span>
              </label>
            </div>
          </DialogPanel>

          <DialogFooter className="mt-4 gap-2 border-t border-border/40 pt-3">
            <span className="mr-auto hidden sm:inline text-[12.5px] text-muted-foreground">
              <kbd className="rounded border border-border px-1 py-0.5 text-[12.5px] font-mono">⌘/Ctrl+Enter</kbd> to save
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-[13px]"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="text-[13px]"
              disabled={!title.trim() || isSubmitting || conflict !== null}
            >
              {isSubmitting ? (
                <>
                  <Spinner className="size-3.5" />
                  <span>Saving…</span>
                </>
              ) : isEdit ? (
                'Save changes'
              ) : (
                'Add note'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
