import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Spinner,
  Tabs,
  TabsList,
  TabsTab,
  Textarea,
} from '../../design/index.js';
import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { cn } from '../../lib/utils.js';
import { DocumentPreview, type DocumentKind } from '../work-guidance/DocumentPreview.js';
import type { DocumentConflictDetails } from './documentMutations.js';

export interface DocumentEditorProps {
  docPath: string;
  kind: DocumentKind;
  value: string;
  onChange: (next: string) => void;
  dirty: boolean;
  saving: boolean;
  saveError?: string | null;
  externalChangeNotice?: boolean;
  conflict?: DocumentConflictDetails | null;
  onSave: () => void;
  onCancel: () => void;
  onOverwriteConflict: () => void;
  onSaveAsCopy: () => void;
  onLoadLatest: () => void;
  links?: MarkdownDocumentLinks;
  fileUrl?: string;
  autoFocus?: boolean;
  compact?: boolean;
  showActions?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  tab?: 'write' | 'preview';
  onTabChange?: (next: 'write' | 'preview') => void;
  className?: string;
}

function hasBlockingModalOverlay(): boolean {
  return Array.from(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="menu-popup"], [data-slot="popover-popup"]'),
  ).some(
    (el) =>
      el instanceof HTMLElement
      && el.isConnected
      && !el.closest('[inert], [hidden]')
      && el.getClientRects().length > 0,
  );
}

export function DocumentEditor({
  docPath,
  kind,
  value,
  onChange,
  dirty,
  saving,
  saveError,
  externalChangeNotice = false,
  conflict = null,
  onSave,
  onCancel,
  onOverwriteConflict,
  onSaveAsCopy,
  onLoadLatest,
  links,
  fileUrl = '',
  autoFocus = false,
  compact = false,
  showActions = true,
  textareaRef,
  tab: controlledTab,
  onTabChange,
  className,
}: DocumentEditorProps) {
  const [internalTab, setInternalTab] = useState<'write' | 'preview'>('write');
  const tab = controlledTab ?? internalTab;
  const setTab = (next: 'write' | 'preview') => {
    setInternalTab(next);
    onTabChange?.(next);
  };
  const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resolvedRef = textareaRef ?? localTextareaRef;

  useEffect(() => {
    setInternalTab('write');
  }, [docPath]);

  useEffect(() => {
    if (!autoFocus || tab !== 'write') return;
    const frame = requestAnimationFrame(() => {
      resolvedRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, docPath, tab, resolvedRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.repeat || event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      if (!conflict && !saving) {
        onSave();
      }
      return;
    }
    if (event.key === 'Escape') {
      if (event.defaultPrevented || hasBlockingModalOverlay()) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  const previewData = {
    name: docPath,
    kind,
    content: value,
  };

  return (
    <div
      data-testid="document-editor"
      onKeyDown={handleKeyDown}
      className={cn('flex min-h-0 flex-1 flex-col gap-2.5', className)}
    >
      {/* Toolbar: Write / Preview tabs, Unsaved badge, optional Save / Cancel */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={tab}
            onValueChange={(next) => {
              if (next === 'write' || next === 'preview') setTab(next);
            }}
          >
            <TabsList aria-label="Editor view">
              <TabsTab value="write">Write</TabsTab>
              <TabsTab value="preview">Preview</TabsTab>
            </TabsList>
          </Tabs>

          {dirty && (
            <Badge variant="outline" data-testid="unsaved-changes-badge">
              Unsaved changes
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!compact && (
            <span className="hidden text-xs leading-4 text-muted-foreground sm:inline">
              Ctrl+S to save
            </span>
          )}
          {showActions && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={saving || conflict !== null}
                onClick={onSave}
              >
                {saving ? (
                  <>
                    <Spinner aria-hidden="true" className="size-3.5" />
                    <span>Saving…</span>
                  </>
                ) : (
                  'Save'
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Calm non-destructive notice when file changed on disk while editing */}
      {externalChangeNotice && !conflict && (
        <Alert variant="info" data-testid="document-external-change-notice" className="shrink-0 py-2 text-xs">
          <AlertDescription className="text-xs leading-4 text-foreground">
            Updated on disk while you were editing. Saving will check for conflicts.
          </AlertDescription>
        </Alert>
      )}

      {/* Inline 409 CONFLICT recovery bar preserving every typed character */}
      {conflict && (
        <Alert variant="warning" role="alert" data-testid="document-conflict-bar" className="shrink-0 py-2.5 text-xs">
          <AlertTitle className="text-xs font-semibold leading-4 text-foreground">
            {conflict.currentRevision === null
              ? 'This document was removed or moved on disk while you were editing. Your draft is preserved.'
              : 'This document changed on disk while you were editing. Your draft is preserved.'}
          </AlertTitle>
          <AlertDescription className="mt-2 flex flex-row flex-wrap items-center justify-start gap-2 text-xs text-foreground">
            <Button type="button" size="sm" variant="default" disabled={saving} onClick={onOverwriteConflict}>
              Overwrite with mine
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onSaveAsCopy}>
              Save as copy
            </Button>
            {conflict.currentRevision !== null && conflict.currentContent !== undefined && (
              <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onLoadLatest}>
                Load latest
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Generic save error */}
      {saveError && !conflict && (
        <Alert variant="error" role="alert" className="shrink-0 py-2 text-xs">
          <AlertDescription className="text-xs leading-4 text-foreground">{saveError}</AlertDescription>
        </Alert>
      )}

      {/* Editor body or live preview */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {tab === 'write' ? (
          <Textarea
            ref={resolvedRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={`Edit ${docPath}`}
            placeholder="Write Markdown, text, or HTML…"
            readOnly={saving}
            className={cn(
              'flex-1 font-mono text-[13px] leading-[1.55]',
              compact ? 'min-h-[240px]' : 'min-h-[340px]',
            )}
          />
        ) : (
          <div
            data-testid="document-editor-preview"
            className="min-h-[240px] flex-1 overflow-auto rounded-lg border border-border bg-background p-4"
          >
            {value.trim() ? (
              <DocumentPreview
                preview={previewData}
                fileUrl={fileUrl}
                raw={false}
                trusted
                links={links}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
