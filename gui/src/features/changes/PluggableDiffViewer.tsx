/**
 * PluggableDiffViewer Component: Host container orchestrating the pluggable diff engine,
 * view mode switching, whitespace toggling, external IDE launching, hunk triage controls,
 * and changeset symbol navigation.
 * File: gui/src/features/changes/PluggableDiffViewer.tsx
 */
import React, { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import {
  Columns2,
  ExternalLink,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  ListTree,
  MoreHorizontal,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../../components/ui/menu.js';
import type { DiffViewMode, DiffHunkAction } from './types.js';
import {
  parseUnifiedDiff,
  mapRealLineToSnippetLine,
  getHunkSnippetLine,
  getHunkFirstChangedSnippetLine,
  getHunkFirstChangedLineModified,
  hunkIndexAtSnippetLine,
  hunkLineKind,
} from './utils/diffParser.js';
import { FallbackDiffAdapter } from './adapters/FallbackDiffAdapter.js';
import { openInVsCodeAtLine, getEditorLabel } from './adapters/ExternalDiffLauncher.js';
import { ChangesetSymbolNavigator } from './ChangesetSymbolNavigator.js';
import {
  globalChangesetSymbolIndex,
  type ChangesetSymbol,
  type RawAstSymbol,
} from './utils/changesetSymbolIndex.js';

const MonacoDiffAdapter = lazy(() => import('./adapters/MonacoDiffAdapter.js').then((module) => ({ default: module.MonacoDiffAdapter })));

export interface PluggableDiffViewerProps {
  filePath: string;
  repoName: string;
  repoPath?: string;
  patchText: string;
  fullFileContent?: string;
  fullOriginalContent?: string;
  defaultEditor?: string | null;
  viewMode?: DiffViewMode;
  initialTargetLine?: number;
  changesetSymbols?: ChangesetSymbol[];
  preExtractedSymbols?: RawAstSymbol[];
  onToggleViewMode?: () => void;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  onHunkAction?: (action: DiffHunkAction) => Promise<void> | void;
  onRequestRefine?: (action: DiffHunkAction, feedback: string) => Promise<void> | void;
  onOpenFile?: (repoName: string, filePath: string, line?: number) => void;
  onSelectSymbol?: (symbol: ChangesetSymbol) => void;
  onNextFile?: () => void;
  onPrevFile?: () => void;
  fillContainer?: boolean;
}

export const PluggableDiffViewer: React.FC<PluggableDiffViewerProps> = ({
  filePath,
  repoName,
  repoPath = '',
  patchText,
  fullFileContent,
  fullOriginalContent,
  defaultEditor,
  viewMode: controlledViewMode,
  initialTargetLine,
  changesetSymbols,
  preExtractedSymbols,
  onToggleViewMode,
  showToast,
  onHunkAction,
  onRequestRefine,
  onOpenFile,
  onSelectSymbol,
  onNextFile,
  onPrevFile,
  fillContainer = false,
}) => {
  // Local or controlled viewMode
  const [internalViewMode, setInternalViewMode] = useState<DiffViewMode>('side-by-side');
  const viewMode = controlledViewMode ?? internalViewMode;

  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [engine, setEngine] = useState<'monaco' | 'fallback'>('monaco');
  const [activeHunkIndex, setActiveHunkIndex] = useState(0);
  const [hunkStates, setHunkStates] = useState<Record<string, 'accepted' | 'rejected' | 'refining'>>({});
  const [refineModalOpen, setRefineModalOpen] = useState(false);
  const [refineFeedback, setRefineFeedback] = useState('');
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  const [realTargetLine, setRealTargetLine] = useState<number | undefined>(initialTargetLine);
  const [realTargetOrigLine, setRealTargetOrigLine] = useState<number | undefined>(undefined);
  const [explicitSnippetTargetLine, setExplicitSnippetTargetLine] = useState<number | undefined>(undefined);
  const [jumpNonce, setJumpNonce] = useState(0);
  const editorLabel = getEditorLabel(defaultEditor);

  // Parse diff into original and modified buffers and hunk metadata
  const parsed = useMemo(() => parseUnifiedDiff(patchText), [patchText]);
  const hunks = parsed.hunks;
  const currentHunk = hunks[activeHunkIndex] || null;

  // Index symbols of this file in the global changeset symbol index
  const [fileSymbols, setFileSymbols] = useState<ChangesetSymbol[]>([]);
  useEffect(() => {
    const contentToIndex = fullFileContent || parsed.modifiedContent;
    setFileSymbols(globalChangesetSymbolIndex.indexFile(
      repoName,
      filePath,
      contentToIndex,
      hunks,
      repoPath,
      preExtractedSymbols
    ));
  }, [repoName, filePath, fullFileContent, parsed.modifiedContent, hunks, repoPath, preExtractedSymbols]);

  // If initialTargetLine changes from parent, sync realTargetLine and active hunk
  const lastTargetLineJumpRef = useRef<string>('');
  useEffect(() => {
    if (initialTargetLine && initialTargetLine > 0) {
      const jumpKey = `${filePath}:${initialTargetLine}`;
      if (lastTargetLineJumpRef.current === jumpKey) return;
      lastTargetLineJumpRef.current = jumpKey;

      setRealTargetLine(initialTargetLine);
      setRealTargetOrigLine(undefined);
      setExplicitSnippetTargetLine(undefined);
      setJumpNonce((n) => n + 1);
      const matchingIndex = hunks.findIndex(
        (h) =>
          initialTargetLine >= h.startLineModified &&
          initialTargetLine <= h.startLineModified + Math.max(h.lineCountModified, 1) - 1
      );
      if (matchingIndex !== -1) {
        setActiveHunkIndex(matchingIndex);
      }
    }
  }, [initialTargetLine, filePath, hunks]);

  // When !fullFileContent, map real line numbers to snippet lines for MonacoDiffAdapter,
  // while FallbackDiffAdapter receives real line numbers (matching its data-mod-line attributes).
  const monacoTargetLine = useMemo(() => {
    if (!fullFileContent && explicitSnippetTargetLine !== undefined) {
      return explicitSnippetTargetLine;
    }
    if (!realTargetLine || realTargetLine <= 0) return undefined;
    if (fullFileContent) return realTargetLine;
    const snippetLine = mapRealLineToSnippetLine(realTargetLine, hunks);
    if (snippetLine !== null) {
      return snippetLine;
    }
    // If realTargetLine falls on a hunk without additions/context (e.g. pure deletion),
    // find the snippet start position for that hunk
    const hunkIdx = hunks.findIndex(
      (h) =>
        realTargetLine >= h.startLineModified &&
        realTargetLine <= h.startLineModified + Math.max(h.lineCountModified, 1) - 1
    );
    if (hunkIdx !== -1) {
      return getHunkSnippetLine(hunkIdx, hunks);
    }
    return undefined;
  }, [explicitSnippetTargetLine, realTargetLine, fullFileContent, hunks]);

  const fallbackTargetLine = realTargetLine;
  const fallbackTargetOrigLine = realTargetOrigLine;

  const toggleViewMode = () => {
    if (onToggleViewMode) {
      onToggleViewMode();
    } else {
      setInternalViewMode((prev) => (prev === 'side-by-side' ? 'unified' : 'side-by-side'));
    }
  };

  const root = useRef<HTMLDivElement>(null);

  const handleSelectHunk = useCallback((index: number) => {
    if (index >= 0 && index < hunks.length && hunks[index]) {
      const hunk = hunks[index];
      const targetModified = hunk.firstChangedLineModified ?? getHunkFirstChangedLineModified(hunk);
      const targetSnippet = hunk.firstChangedSnippetLine ?? getHunkFirstChangedSnippetLine(index, hunks);
      const hasAdds = hunk.lines.some((line) => hunkLineKind(line) === 'added');
      const targetOriginal = !hasAdds ? (hunk.firstChangedLineOriginal ?? hunk.startLineOriginal) : undefined;

      setActiveHunkIndex(index);
      setRealTargetLine(Math.max(1, targetModified));
      setRealTargetOrigLine(targetOriginal);
      if (!fullFileContent) {
        setExplicitSnippetTargetLine(targetSnippet);
      } else {
        setExplicitSnippetTargetLine(undefined);
      }
      setJumpNonce((n) => n + 1);
    }
  }, [hunks, fullFileContent]);

  const handleNextHunk = useCallback(() => {
    if (activeHunkIndex < hunks.length - 1) {
      handleSelectHunk(activeHunkIndex + 1);
    } else if (onNextFile) {
      onNextFile();
    }
  }, [activeHunkIndex, hunks.length, handleSelectHunk, onNextFile]);

  const handlePrevHunk = useCallback(() => {
    if (activeHunkIndex > 0) {
      handleSelectHunk(activeHunkIndex - 1);
    } else if (onPrevFile) {
      onPrevFile();
    }
  }, [activeHunkIndex, handleSelectHunk, onPrevFile]);

  const handleAcceptHunk = useCallback(async () => {
    if (!currentHunk || !onHunkAction) return;
    await onHunkAction({ ...currentHunk, type: 'accept' });
    setHunkStates((prev) => ({ ...prev, [currentHunk.id]: 'accepted' }));
    showToast?.(`Accepted hunk #${activeHunkIndex + 1}`, 'success');
    handleNextHunk();
  }, [currentHunk, activeHunkIndex, showToast, onHunkAction, handleNextHunk]);

  const handleRejectHunk = useCallback(async () => {
    if (!currentHunk || !onHunkAction) return;
    await onHunkAction({ ...currentHunk, type: 'reject' });
    setHunkStates((prev) => ({ ...prev, [currentHunk.id]: 'rejected' }));
    showToast?.(`Rejected hunk #${activeHunkIndex + 1}`, 'info');
    handleNextHunk();
  }, [currentHunk, activeHunkIndex, showToast, onHunkAction, handleNextHunk]);

  const askButton = useRef<HTMLButtonElement>(null);
  /** Closing the form gives the keyboard back to the button that opened it (and does nothing if the window has closed meanwhile). */
  const closeRefineModal = () => {
    setRefineModalOpen(false);
    requestAnimationFrame(() => askButton.current?.focus({ preventScroll: true }));
  };
  const handleOpenRefineModal = () => {
    setRefineFeedback('');
    setRefineModalOpen(true);
  };

  const handleConfirmRefine = async () => {
    if (!currentHunk || !refineFeedback.trim() || !onRequestRefine) return;
    try {
      await onRequestRefine({ ...currentHunk, type: 'refine' }, refineFeedback.trim());
      closeRefineModal();
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Could not send the request.', 'error');
    }
  };

  const handleSymbolSelect = (symbol: ChangesetSymbol) => {
    const cleanCurrent = filePath.replace(/\\/g, '/').replace(/^\//, '');
    if (symbol.filePath === cleanCurrent) {
      if (!fullFileContent) {
        const snippetLine = mapRealLineToSnippetLine(symbol.lineNumber, hunks);
        if (snippetLine === null) {
          showToast?.(`"${symbol.name}" is outside diff hunks (line ${symbol.lineNumber})`, 'info');
          openInVsCodeAtLine(repoPath, filePath, symbol.lineNumber, symbol.column, defaultEditor);
          return;
        }
      }
      setRealTargetLine(symbol.lineNumber);
      setRealTargetOrigLine(undefined);
      setExplicitSnippetTargetLine(undefined);
      setJumpNonce((n) => n + 1);

      // Synchronize active hunk with target symbol
      const matchingHunkIndex = hunks.findIndex(
        (h) =>
          symbol.lineNumber >= h.startLineModified &&
          symbol.lineNumber <= h.startLineModified + Math.max(h.lineCountModified, 1) - 1
      );
      if (matchingHunkIndex !== -1) {
        setActiveHunkIndex(matchingHunkIndex);
      }
    } else {
      // Cross-file jump
      onSelectSymbol?.(symbol);
      onOpenFile?.(symbol.repoName, symbol.filePath, symbol.lineNumber);
    }
  };

  const handleLineSelect = useCallback((line: number) => {
    if (fullFileContent) {
      const matchingIndex = hunks.findIndex(
        (h) =>
          line >= h.startLineModified &&
          line <= h.startLineModified + Math.max(h.lineCountModified, 1) - 1
      );
      if (matchingIndex !== -1 && matchingIndex !== activeHunkIndex) {
        setActiveHunkIndex(matchingIndex);
      }
    } else {
      // In the snippet view the cursor line is a snippet line.
      const matchingIndex = hunkIndexAtSnippetLine(line, hunks);
      if (matchingIndex !== -1 && matchingIndex !== activeHunkIndex) setActiveHunkIndex(matchingIndex);
    }
  }, [hunks, activeHunkIndex, fullFileContent]);


  // Keyboard shortcut listener for fast hunk triage.
  //
  // Scoped to this viewer. It is also mounted inside the floating CLI chat, so a
  // window-level listener would accept or reject a hunk while the user was
  // typing somewhere else in the app entirely.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      if (!root.current?.contains(target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'n') {
        e.preventDefault();
        handleNextHunk();
      } else if (e.key === 'k' || e.key === 'p') {
        e.preventDefault();
        handlePrevHunk();
      } else if (e.key === 'a') {
        e.preventDefault();
        void handleAcceptHunk();
      } else if (e.key === 'r') {
        e.preventDefault();
        void handleRejectHunk();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNextHunk, handlePrevHunk, handleAcceptHunk, handleRejectHunk]);

  const displayedSymbols = changesetSymbols && changesetSymbols.length > 0 ? changesetSymbols : fileSymbols;

  const atFirst = activeHunkIndex <= 0;
  const atLast = activeHunkIndex >= hunks.length - 1;
  const firstChangedLine = (hunk: DiffHunkAction) => hunk.firstChangedLineModified ?? hunk.startLineModified;
  const countLines = (hunk: DiffHunkAction, sign: '+' | '-') => hunk.lines.filter((line) => hunkLineKind(line) === (sign === '+' ? 'added' : 'removed')).length;
  const toolbarButton = 'inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

  return (
    <div
      ref={root}
      className={cn(
        'flex flex-col overflow-hidden',
        fillContainer
          ? 'h-full w-full min-h-0 bg-background'
          : 'my-2 rounded-lg border border-border bg-card'
      )}
    >
      {/* One slim row: which change is in view and how to move between them, then how the diff is shown. */}
      <div role="toolbar" aria-label="Diff" className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5 text-xs">
        {hunks.length > 0 ? (
          <>
            <button type="button" className={toolbarButton} onClick={handlePrevHunk} disabled={atFirst && !onPrevFile}
              aria-label={atFirst && onPrevFile ? 'Previous file' : 'Previous change'} title={atFirst && onPrevFile ? 'Previous file' : 'Previous change (k)'}>
              <ChevronUp className="size-3.5" />
            </button>
            <button type="button" className={toolbarButton} onClick={handleNextHunk} disabled={atLast && !onNextFile}
              aria-label={atLast && onNextFile ? 'Next file' : 'Next change'} title={atLast && onNextFile ? 'Next file' : 'Next change (j)'}>
              <ChevronDown className="size-3.5" />
            </button>
            <Menu>
              <MenuTrigger className={cn(toolbarButton, 'font-medium text-foreground')} aria-label={`Change ${activeHunkIndex + 1} of ${hunks.length}. Jump to a change`}>
                <span className="tabular-nums">Change {activeHunkIndex + 1} of {hunks.length}</span>
                <ChevronDown className="size-3 opacity-60" />
              </MenuTrigger>
              <MenuPopup align="start" className="max-h-80 w-80 overflow-y-auto">
                {hunks.map((hunk, index) => (
                  <MenuItem key={hunk.id} onClick={() => handleSelectHunk(index)} className={cn('text-xs', index === activeHunkIndex && 'font-semibold')}>
                    <span className="w-16 shrink-0 tabular-nums">Change {index + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                      L{firstChangedLine(hunk)}{hunk.enclosingDeclaration ? ` · ${hunk.enclosingDeclaration}` : ''}
                    </span>
                    <span className="shrink-0 font-mono text-[10px]">
                      <span className="text-success-foreground">+{countLines(hunk, '+')}</span> <span className="text-destructive-foreground">−{countLines(hunk, '-')}</span>
                    </span>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
            {currentHunk?.enclosingDeclaration && (
              <span className="ml-1 hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:inline" title={currentHunk.enclosingDeclaration}>
                {currentHunk.enclosingDeclaration}
              </span>
            )}
            {currentHunk && hunkStates[currentHunk.id] && (
              <span className="ml-1 shrink-0 rounded border border-border px-1 text-[10px] uppercase text-muted-foreground">{hunkStates[currentHunk.id]}</span>
            )}
          </>
        ) : (
          <span className="px-1.5 text-muted-foreground">No changed lines to show</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {onRequestRefine && currentHunk && (
            <button ref={askButton} type="button" className={toolbarButton} onClick={handleOpenRefineModal} title="Ask the AI to change this part">
              <MessageSquare className="size-3.5" /><span className="hidden md:inline">Ask AI</span>
            </button>
          )}
          <button type="button" className={cn(toolbarButton, viewMode === 'side-by-side' && 'bg-accent text-foreground')} onClick={toggleViewMode}
            aria-pressed={viewMode === 'side-by-side'} aria-label="Side by side" title={viewMode === 'side-by-side' ? 'Show the change inline' : 'Show the change side by side'}>
            <Columns2 className="size-3.5" />
          </button>
          <Menu>
            <MenuTrigger className={toolbarButton} aria-label="More diff options" title="More diff options">
              <MoreHorizontal className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-64">
              <MenuCheckboxItem checked={ignoreWhitespace} onCheckedChange={(checked) => setIgnoreWhitespace(Boolean(checked))}>Ignore whitespace</MenuCheckboxItem>
              <MenuCheckboxItem checked={engine === 'fallback'} onCheckedChange={(checked) => setEngine(checked ? 'fallback' : 'monaco')}>Plain patch view</MenuCheckboxItem>
              <MenuSeparator />
              <MenuItem onClick={() => setSymbolsOpen((open) => !open)}>
                <ListTree />Symbols in this file{displayedSymbols.length ? ` (${displayedSymbols.length})` : ''}
              </MenuItem>
              {currentHunk && (
                <MenuItem onClick={() => {
                  openInVsCodeAtLine(repoPath, filePath, firstChangedLine(currentHunk), 1, defaultEditor);
                  showToast?.(`Opened ${filePath}:${firstChangedLine(currentHunk)} in ${editorLabel}`, 'success');
                }}>
                  <ExternalLink />Open line {firstChangedLine(currentHunk)} in {editorLabel}
                </MenuItem>
              )}
              {onHunkAction && currentHunk && (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={() => void handleAcceptHunk()}><Check />Accept this change (a)</MenuItem>
                  <MenuItem onClick={() => void handleRejectHunk()}><X />Reject this change (r)</MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {/* ─── CHANGESET SYMBOL EXPLORER DRAWER ─────────────────────────────────── */}
      {symbolsOpen && (
        <div className="p-3 border-b border-border/70 bg-muted/20 shrink-0">
          <ChangesetSymbolNavigator
            symbols={displayedSymbols}
            activeFilePath={filePath}
            activeLine={realTargetLine || (currentHunk ? currentHunk.startLineModified : undefined)}
            editorLabel={editorLabel}
            onSelectSymbol={handleSymbolSelect}
            onOpenInVsCode={(s) => {
              openInVsCodeAtLine(repoPath, s.filePath, s.lineNumber, s.column, defaultEditor);
              showToast?.(`Opened ${s.filePath}:${s.lineNumber} in ${editorLabel}`, 'success');
            }}
            onClose={() => setSymbolsOpen(false)}
          />
        </div>
      )}

      {/* ─── CENTER DIFF CANVAS ──────────────────────────────────────────────── */}
      <div className={cn(fillContainer ? 'flex min-h-0 flex-1 flex-col' : 'p-2')}>
        {engine === 'monaco' ? (
          <Suspense fallback={<div role="status" className="p-4 text-xs text-muted-foreground">Loading diff editor…</div>}>
          <MonacoDiffAdapter
            filePath={filePath}
            repoName={repoName}
            repoPath={repoPath}
            originalContent={fullOriginalContent || parsed.originalContent}
            modifiedContent={fullFileContent || parsed.modifiedContent}
            patchText={patchText}
            viewMode={viewMode}
            ignoreWhitespace={ignoreWhitespace}
            height={fillContainer ? '100%' : 460}
            targetLine={monacoTargetLine}
            jumpNonce={jumpNonce}
            onOpenFile={onOpenFile}
            onLineSelect={handleLineSelect}
          />
          </Suspense>
        ) : (
          <FallbackDiffAdapter
            filePath={filePath}
            repoPath={repoPath}
            originalContent={fullOriginalContent || parsed.originalContent}
            modifiedContent={fullFileContent || parsed.modifiedContent}
            patchText={patchText}
            viewMode={viewMode}
            ignoreWhitespace={ignoreWhitespace}
            targetLine={fallbackTargetLine}
            targetOrigLine={fallbackTargetOrigLine}
            jumpNonce={jumpNonce}
          />
        )}
      </div>

      {/* ─── REFINE PROMPT MODAL ────────────────────────────────────────────── */}
      {refineModalOpen && (
        <div role="dialog" aria-modal="true" aria-label="Ask AI about this change" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeRefineModal(); } }} className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-2xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare size={16} className="text-primary" />
                <h3 className="text-xs font-bold text-foreground">
                  Ask AI about change {activeHunkIndex + 1} in {filePath.split('/').at(-1)}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeRefineModal}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                <X size={14} />
              </button>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Say what this part should do. It goes to your AI session; with none open, it is copied for you to paste.
            </p>

            <textarea
              value={refineFeedback}
              onChange={(e) => setRefineFeedback(e.target.value)}
              placeholder="e.g. Ensure null safety when calculating vacation debt..."
              rows={3}
              autoFocus
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary resize-none"
            />

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
              <button
                type="button"
                onClick={closeRefineModal}
                className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!refineFeedback.trim()}
                onClick={() => void handleConfirmRefine()}
                className="px-3 py-1 text-xs font-semibold text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-50 rounded-lg transition-colors"
              >
                Send to AI
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
