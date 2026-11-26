import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Spinner,
} from '../../design/index.js';
import {
  createFolder,
  resolveNewDocumentPath,
  resolveNewFolderPath,
  saveDocument,
  type DocumentFolderResult,
  type DocumentSaveResult,
} from './documentMutations.js';

export interface NewDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  initialFolder: string;
  availableFolders?: readonly string[];
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCreated: (result: DocumentSaveResult) => void;
}

export function NewDocumentDialog({
  open,
  onOpenChange,
  workspaceId,
  initialFolder,
  availableFolders = [],
  returnFocusRef,
  onCreated,
}: NewDocumentDialogProps) {
  const folderId = useId();
  const nameId = useId();
  const folderListId = useId();
  const hintId = useId();
  const errorId = useId();

  const nameInputRef = useRef<HTMLInputElement>(null);
  const createdRef = useRef(false);

  const [folder, setFolder] = useState(initialFolder);
  const [name, setName] = useState('');
  const [touchedName, setTouchedName] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    createdRef.current = false;
    setFolder(initialFolder);
    setName('');
    setTouchedName(false);
    setSubmitError(null);
    setSubmitting(false);
  }, [open, initialFolder]);

  const resolved = useMemo(() => resolveNewDocumentPath(folder, name), [folder, name]);
  const validationError = submitError ?? (touchedName && !resolved.ok ? resolved.error : null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setTouchedName(true);
    if (!resolved.ok) {
      setSubmitError(resolved.error);
      nameInputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const saved = await saveDocument(workspaceId, {
        name: resolved.path,
        content: '',
        createOnly: true,
      });
      createdRef.current = true;
      onOpenChange(false);
      onCreated(saved);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to create document.');
      nameInputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-md"
        initialFocus={nameInputRef}
        finalFocus={() => (createdRef.current ? false : returnFocusRef?.current ?? true)}
      >
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-foreground">New document</DialogTitle>
          <DialogDescription className="text-xs leading-4 text-muted-foreground">
            Create a Markdown, text, or HTML document and start writing immediately.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} noValidate>
          <DialogPanel className="space-y-4">
            <Field>
              <FieldLabel htmlFor={folderId} className="text-xs font-medium text-foreground">
                Folder <span className="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input
                id={folderId}
                name="folder"
                list={availableFolders.length > 0 ? folderListId : undefined}
                value={folder}
                onChange={(event) => {
                  setSubmitError(null);
                  setFolder(event.target.value);
                }}
                placeholder="Workspace root (or e.g. design/plans)"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={submitting}
                className="font-mono text-xs"
              />
              {availableFolders.length > 0 && (
                <datalist id={folderListId}>
                  {availableFolders.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              )}
            </Field>

            <Field invalid={Boolean(validationError)}>
              <FieldLabel htmlFor={nameId} className="text-xs font-medium text-foreground">
                File name
              </FieldLabel>
              <Input
                ref={nameInputRef}
                id={nameId}
                name="name"
                value={name}
                onChange={(event) => {
                  setSubmitError(null);
                  setName(event.target.value);
                }}
                onBlur={() => setTouchedName(true)}
                placeholder="notes.md"
                autoFocus
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={submitting}
                aria-invalid={validationError ? 'true' : 'false'}
                aria-describedby={validationError ? `${hintId} ${errorId}` : hintId}
                className="font-mono text-xs"
              />
              <FieldDescription id={hintId} className="text-xs leading-4 text-muted-foreground">
                {resolved.ok ? (
                  <>
                    Will create <span className="font-mono text-foreground">{resolved.path}</span>
                    {resolved.autoAppendedMd ? ' (.md added automatically)' : ''}
                  </>
                ) : (
                  'Supports .md, .txt, .html, .json, .yaml, .mmd — names without an extension default to .md.'
                )}
              </FieldDescription>
              {validationError && (
                <FieldError id={errorId} role="alert" className="text-xs text-destructive">
                  {validationError}
                </FieldError>
              )}
            </Field>
          </DialogPanel>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="default" size="sm" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner aria-hidden="true" className="size-3.5" />
                  <span>Creating…</span>
                </>
              ) : (
                'Create & edit'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  parentFolder: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCreated: (result: DocumentFolderResult) => void;
}

export function NewFolderDialog({
  open,
  onOpenChange,
  workspaceId,
  parentFolder,
  returnFocusRef,
  onCreated,
}: NewFolderDialogProps) {
  const folderNameId = useId();
  const hintId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [folderName, setFolderName] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFolderName('');
    setTouched(false);
    setSubmitError(null);
    setSubmitting(false);
  }, [open]);

  const resolved = useMemo(() => resolveNewFolderPath(parentFolder, folderName), [parentFolder, folderName]);
  const validationError = submitError ?? (touched && !resolved.ok ? resolved.error : null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setTouched(true);
    if (!resolved.ok) {
      setSubmitError(resolved.error);
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createFolder(workspaceId, resolved.folder);
      onOpenChange(false);
      onCreated(created);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to create folder.');
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-md"
        initialFocus={inputRef}
        finalFocus={() => returnFocusRef?.current ?? true}
      >
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-foreground">New folder</DialogTitle>
          <DialogDescription className="text-xs leading-4 text-muted-foreground">
            {parentFolder ? (
              <>
                Create a subfolder inside <span className="font-mono text-foreground">{parentFolder}</span>.
              </>
            ) : (
              'Create a folder at the workspace root.'
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} noValidate>
          <DialogPanel className="space-y-4">
            <Field invalid={Boolean(validationError)}>
              <FieldLabel htmlFor={folderNameId} className="text-xs font-medium text-foreground">
                Folder name
              </FieldLabel>
              <Input
                ref={inputRef}
                id={folderNameId}
                name="folderName"
                value={folderName}
                onChange={(event) => {
                  setSubmitError(null);
                  setFolderName(event.target.value);
                }}
                onBlur={() => setTouched(true)}
                placeholder="drafts"
                autoFocus
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={submitting}
                aria-invalid={validationError ? 'true' : 'false'}
                aria-describedby={validationError ? `${hintId} ${errorId}` : hintId}
                className="font-mono text-xs"
              />
              <FieldDescription id={hintId} className="text-xs leading-4 text-muted-foreground">
                {resolved.ok ? (
                  <>
                    Will create <span className="font-mono text-foreground">{resolved.folder}/</span>
                  </>
                ) : (
                  'Nested paths like notes/2026 are supported.'
                )}
              </FieldDescription>
              {validationError && (
                <FieldError id={errorId} role="alert" className="text-xs text-destructive">
                  {validationError}
                </FieldError>
              )}
            </Field>
          </DialogPanel>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="default" size="sm" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner aria-hidden="true" className="size-3.5" />
                  <span>Creating…</span>
                </>
              ) : (
                'Create folder'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
