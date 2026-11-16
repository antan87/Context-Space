import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Spinner } from '../../components/ui/spinner.js';
import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { cn } from '../../lib/utils.js';

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
  } | null;
  /** Available areas on the board for the area / step selectors */
  areas?: NoteDialogAreaOption[];
  /** Default area ID if creating a new note */
  defaultAreaId?: string;
  /** Default step key if creating a new note */
  defaultStepKey?: string;
  /** Called to persist the note */
  onSave: (data: {
    title: string;
    body: string;
    pinned: boolean;
    area?: string | null;
    step?: string | null;
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

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [area, setArea] = useState('');
  const [step, setStep] = useState('');
  const [preview, setPreview] = useState(false);
  const [font, setFont] = useState<'sans' | 'mono'>('sans');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the fields start from is read when the dialog opens or switches to another note, and at no other time: the board changing under
  // an open dialog (a live change, the plan read again) must never overwrite what is typed.
  const latest = useRef({ note, defaultAreaId, defaultStepKey, areas });
  useEffect(() => { latest.current = { note, defaultAreaId, defaultStepKey, areas }; });
  const noteId = note?.id;
  useEffect(() => {
    if (!open) return undefined;
    const { note: current, defaultAreaId: area0, defaultStepKey: step0, areas: choices } = latest.current;
    if (current) {
      setTitle(current.title);
      setBody(current.body);
      setPinned(current.pinned);
      setArea(current.area ?? '');
      setStep(current.step ?? '');
    } else {
      setTitle('');
      setBody('');
      setPinned(false);
      setArea(area0 ?? choices[0]?.id ?? '');
      setStep(step0 ?? '');
    }
    setPreview(false);
    setError(null);
    setIsSubmitting(false);

    // Autofocus title input smoothly after open
    const timer = setTimeout(() => {
      titleInputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [open, noteId]);

  const selectedAreaObj = areas.find((a) => a.id === area);
  const availableSteps = selectedAreaObj?.steps ?? [];

  const handleAreaChange = useCallback((newArea: string) => {
    setArea(newArea);
    // Reset step if current step does not belong to new area
    const targetArea = areas.find((a) => a.id === newArea);
    if (!targetArea?.steps?.some((s) => s.key === step)) {
      setStep('');
    }
  }, [areas, step]);

  const isEdit = Boolean(note);

  const handleSave = useCallback(async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const res = await onSave({
        title: cleanTitle,
        body: body.slice(0, 4000),
        pinned,
        ...(isEdit
          ? {
              area: area || null,
              step: step || null,
            }
          : {
              ...(area ? { area } : {}),
              ...(step ? { step } : {}),
            }),
      });
      if (res !== false) {
        onOpenChange(false);
      } else {
        setError('Could not save note. Please check your connection and try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save note.');
    } finally {
      setIsSubmitting(false);
    }
  }, [title, isSubmitting, onSave, body, pinned, isEdit, area, step, onOpenChange]);

  const handleFormSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    void handleSave();
  }, [handleSave]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onOpenChange(false);
    }
  }, [handleSave, onOpenChange]);

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

        <form onSubmit={handleFormSubmit}>
          <DialogPanel className="space-y-4 pt-1">
            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive-foreground"
              >
                {error}
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
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Note title..."
                maxLength={200}
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
                <textarea
                  id={bodyId}
                  name="body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write Markdown, lists, notes, or links..."
                  maxLength={4000}
                  rows={5}
                  className={cn(
                    'w-full min-h-[140px] max-h-[260px] rounded-lg border border-input bg-background p-3 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/72 outline-none transition-shadow',
                    'focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20 resize-y',
                    font === 'mono' ? 'font-mono text-[12.5px]' : 'font-sans',
                  )}
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
                    onChange={(e) => handleAreaChange(e.target.value)}
                    className="block h-8.5 w-full rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20"
                  >
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
                    onChange={(e) => setStep(e.target.value)}
                    disabled={availableSteps.length === 0}
                    className="block h-8.5 w-full rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground outline-none disabled:opacity-60 focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20"
                  >
                    <option value="">(None / General Area)</option>
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
                  onCheckedChange={(checked) => setPinned(Boolean(checked))}
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
              disabled={!title.trim() || isSubmitting}
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
