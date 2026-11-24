import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
  Select, SelectItem, SelectPopup, SelectTrigger, SelectValue,
} from '../../design/index.js';
import { ApiError, apiFetch } from '../../lib/api/client.js';
import { planDraftsKey, type PlanDraft, type PlanDraftList, type PlanDraftPreview } from '../plan/planDrafts.js';
import { planFileKey } from '../plan/planFile.js';
import { boardKey } from './boardData.js';

const draftsUrl = (workspace: string) => `/api/workspace/${encodeURIComponent(workspace)}/plan/drafts`;
const changeName = { add: 'Add', remove: 'Remove', reword: 'Reword', edit: 'Edit', move: 'Move' };
type DraftChoice = { action: 'import' | 'discard'; draft: PlanDraft };
const shortDigest = (draft: PlanDraft) => draft.digest.slice(0, 10);

function DraftDigest({ draft }: { draft: PlanDraft }) {
  return <code title={draft.digest} className="font-mono text-xs text-muted-foreground">{shortDigest(draft)}</code>;
}

export function PlanDraftNotice({ workspace, connected, readOnly }: { workspace: string; connected: boolean; readOnly: boolean }) {
  const client = useQueryClient();
  const listKey = planDraftsKey(workspace);
  const url = draftsUrl(workspace);
  const { data } = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => apiFetch<PlanDraftList>(url, { signal }),
    refetchInterval: connected ? false : 3000,
  });
  const drafts = data?.drafts ?? [];
  const [selectedDigest, setSelectedDigest] = useState<string | null>(null);
  const draft = drafts.find((entry) => entry.digest === selectedDigest)
    ?? drafts.find((entry) => entry.file === 'contextspace-data.json')
    ?? drafts[0];
  const [choice, setChoice] = useState<DraftChoice | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = (action: DraftChoice['action'], opener: HTMLButtonElement) => {
    if (!draft) return;
    trigger.current = opener;
    setChoice({ action, draft });
  };

  const handled = (digest: string) => {
    setChoice(null);
    setSelectedDigest(null);
    client.setQueryData<PlanDraftList>(listKey, (cached) => cached && { drafts: cached.drafts.filter((entry) => entry.digest !== digest) });
    for (const key of [listKey, planFileKey(workspace), boardKey(workspace)]) void client.invalidateQueries({ queryKey: key });
  };

  return (
    <>
      {draft && (
        <div data-testid="plan-draft-notice" className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 bg-muted/50 px-4 py-1.5">
          <p role="status" className="min-w-0 flex-1 text-sm font-medium">
            {draft.file === 'PLAN.md' ? 'PLAN.md was edited by hand' : 'The plan changed in Git and here'}
            {(drafts.length === 1 || readOnly) && <span className="ml-2"><DraftDigest draft={draft} /></span>}
          </p>
          {!readOnly && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {drafts.length > 1 && (
                <Select value={draft.digest} onValueChange={setSelectedDigest}>
                  <SelectTrigger aria-label="Pending draft" title={draft.digest} size="xs" variant="ghost">
                    <SelectValue>{shortDigest(draft)} · {drafts.length} drafts</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {drafts.map((entry) => (
                      <SelectItem key={entry.digest} title={entry.digest} value={entry.digest}>
                        {entry.file} · {shortDigest(entry)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
              <Button size="sm" variant="outline" onClick={(event) => open('import', event.currentTarget)}>Import</Button>
              <Button size="sm" variant="ghost" onClick={(event) => open('discard', event.currentTarget)}>Discard</Button>
            </div>
          )}
        </div>
      )}
      {choice && !readOnly && <DraftDialog
        choice={choice}
        url={`${url}/${choice.draft.digest}`}
        onClose={() => setChoice(null)}
        onHandled={() => handled(choice.draft.digest)}
        restoreFocus={() => trigger.current?.isConnected ? trigger.current
          : document.querySelector<HTMLElement>('[data-board-pane] [data-testid="board-code-button"]')}
      />}
    </>
  );
}

function DraftDialog({ choice, url, onClose, onHandled, restoreFocus }: {
  choice: DraftChoice; url: string; onClose: () => void; onHandled: () => void; restoreFocus: () => HTMLElement | null;
}) {
  const importing = choice.action === 'import';
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<PlanDraftPreview>();
  const query = useQuery({
    queryKey: ['plan-draft-preview', url],
    queryFn: ({ signal }) => apiFetch<PlanDraftPreview>(url, { signal }),
    enabled: importing,
    retry: false,
    gcTime: 0,
  });
  const preview = updated ?? (query.isFetching ? undefined : query.data);
  const heading = importing ? 'Import plan draft' : 'Discard plan draft?';
  const description = importing
    ? 'Review the changes before applying this draft.'
    : `Discard the changes from ${choice.draft.file}? The saved draft file will be kept.`;

  const submit = async () => {
    if (inFlight.current || (importing && !preview)) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      await apiFetch(`${url}/${choice.action}`, {
        method: 'POST',
        ...(importing ? { body: JSON.stringify({ token: preview!.token }) } : {}),
      });
      onHandled();
    } catch (cause) {
      const fresh = cause instanceof ApiError && cause.status === 409
        ? (cause.body as { preview?: PlanDraftPreview } | null)?.preview : undefined;
      if (fresh?.digest === choice.draft.digest) {
        setUpdated(fresh);
        cancel.current?.focus();
      }
      setError(cause instanceof Error ? cause.message : 'The draft could not be handled.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !inFlight.current) onClose(); }}>
      <DialogPopup initialFocus={cancel} finalFocus={restoreFocus} showCloseButton={false} bottomStickOnMobile={false} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{description} <DraftDigest draft={choice.draft} /></DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 text-sm">
          {error && <p role="alert" className="whitespace-pre-wrap break-words">{error}</p>}
          {importing && query.isFetching && !preview && <p role="status">Reading the draft…</p>}
          {importing && query.error && !preview && <p role="alert">{query.error.message}</p>}
          {preview && <DraftChanges preview={preview} />}
        </DialogPanel>
        <DialogFooter>
          <Button ref={cancel} variant="outline" onClick={() => { if (!inFlight.current) onClose(); }} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || (importing && !preview)}>
            {importing ? (saving ? 'Applying…' : 'Apply') : (saving ? 'Discarding…' : 'Discard draft')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DraftChanges({ preview }: { preview: PlanDraftPreview }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">Database revision {preview.revision}</p>
      {!preview.baseKnown && <p>The original export could not be found. Every change needs confirmation.</p>}
      {preview.matched.length > 0 && (
        <div>
          <h3 className="font-medium">Matched by words</h3>
          <ul className="list-disc pl-5">{preview.matched.map((match) => <li key={match}>{match}</li>)}</ul>
        </div>
      )}
      {preview.changes.length === 0 ? <p>This draft has no changes to apply.</p> : (
        <ul className="space-y-3">
          {preview.changes.map((change, index) => (
            <li key={index} className="space-y-1 border-t border-border/60 pt-2">
              <p className="font-medium">
                {change.conflict && 'Conflict · '}{changeName[change.kind]}{change.confirm && ' · Confirm'}
              </p>
              {change.before !== undefined && <p className="whitespace-pre-wrap break-words text-muted-foreground"><span className="font-medium">Current </span>{change.before}</p>}
              {change.after !== undefined && <p className="whitespace-pre-wrap break-words"><span className="font-medium">Draft </span>{change.after}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
