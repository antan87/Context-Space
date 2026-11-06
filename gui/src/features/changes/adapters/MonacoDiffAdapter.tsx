/**
 * Monaco Diff Adapter Component
 * Production-grade diff reviewer with DOM virtualization, Monarch syntax highlighting,
 * side-by-side / unified modes, targetLine jump support, and cross-file symbol navigation.
 * File: gui/src/features/changes/adapters/MonacoDiffAdapter.tsx
 */
import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/json/json.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
import type { DiffAdapterRenderProps } from '../types.js';
import { getLanguageFromPath } from '../utils/languageDetector.js';
import { ensureMonacoWorkerEnvironment } from '../utils/monacoWorkerSetup.js';
import { editorThemeName, watchEditorTheme } from '../../../lib/editorTheme.js';
import { ensureMonacoNavigation } from '../utils/monacoNavigationSetup.js';
import { registerLightweightNavigationProviders } from '../utils/changesetSymbolIndex.js';
import {
  getModifiedFileUri,
  getOriginalFileUri,
  getOrCreateTextModel,
  registerCrossFileEditorOpener,
} from '../utils/changesetModelStore.js';

// Ensure web workers and navigation contributions are configured
ensureMonacoWorkerEnvironment();
ensureMonacoNavigation();
registerLightweightNavigationProviders(monaco);

export interface MonacoDiffAdapterProps extends DiffAdapterRenderProps {
  height?: string | number;
  repoName?: string;
  targetLine?: number;
  jumpNonce?: number;
  onOpenFile?: (repoName: string, filePath: string, line?: number) => void;
  onLineSelect?: (line: number) => void;
}

export const MonacoDiffAdapter: React.FC<MonacoDiffAdapterProps> = ({
  filePath,
  repoName = 'workspace',
  repoPath,
  originalContent,
  modifiedContent,
  viewMode,
  ignoreWhitespace,
  height = 480,
  targetLine,
  jumpNonce,
  onOpenFile,
  onLineSelect,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const decorationCollectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const modelsRef = useRef<{
    original: monaco.editor.ITextModel | null;
    modified: monaco.editor.ITextModel | null;
  }>({
    original: null,
    modified: null,
  });

  const onOpenFileRef = useRef(onOpenFile);
  const onLineSelectRef = useRef(onLineSelect);

  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
    onLineSelectRef.current = onLineSelect;
  });

  const targetLineRef = useRef(targetLine);
  const jumpNonceRef = useRef(jumpNonce);
  useEffect(() => {
    targetLineRef.current = targetLine;
    jumpNonceRef.current = jumpNonce;
  });

  const lastDiffLayoutKeyRef = useRef<string>('');
  const lastJumpKeyRef = useRef<string>('');

  // Dynamically update viewMode without recreating editor
  useEffect(() => {
    if (!editorInstanceRef.current) return;
    editorInstanceRef.current.updateOptions({
      renderSideBySide: viewMode === 'side-by-side',
    });
  }, [viewMode]);

  // Dynamically update whitespace trimming without recreating editor
  useEffect(() => {
    if (!editorInstanceRef.current) return;
    editorInstanceRef.current.updateOptions({
      ignoreTrimWhitespace: ignoreWhitespace,
    });
  }, [ignoreWhitespace]);

  // Update text model contents in-place without destroying editor or losing scroll
  useEffect(() => {
    const { original, modified } = modelsRef.current;
    // A model can be disposed under a mounted editor (its file left the changeset);
    // reading it then throws, so leave it alone until the editor is rebuilt.
    if (original && !original.isDisposed() && originalContent !== undefined && original.getValue() !== originalContent) {
      original.setValue(originalContent);
    }
    if (modified && !modified.isDisposed() && modifiedContent !== undefined && modified.getValue() !== modifiedContent) {
      modified.setValue(modifiedContent);
    }
  }, [originalContent, modifiedContent]);

  // Track targetLine jumps in modified buffer (only on intentional jump requests)
  useEffect(() => {
    if (!editorInstanceRef.current || !targetLine || targetLine <= 0) return;
    const jumpKey = `${targetLine}:${jumpNonce ?? 0}`;
    if (lastJumpKeyRef.current === jumpKey) return;
    lastJumpKeyRef.current = jumpKey;

    const modifiedEditor = editorInstanceRef.current.getModifiedEditor();
    modifiedEditor.revealLineInCenter(targetLine);
    modifiedEditor.setPosition({ lineNumber: targetLine, column: 1 });
    // Scrolling to a line does not take the focus: a path clicked in the terminal must leave the keyboard there.

    // Flash highlight on the target line
    if (!decorationCollectionRef.current) {
      decorationCollectionRef.current = modifiedEditor.createDecorationsCollection();
    }
    decorationCollectionRef.current.set([
      {
        range: new monaco.Range(targetLine, 1, targetLine, 1),
        options: {
          isWholeLine: true,
          className: 'bg-primary/20 border-l-2 border-primary',
        },
      },
    ]);
  }, [targetLine, jumpNonce]);

  useEffect(() => {
    if (!containerRef.current) return;

    const language = getLanguageFromPath(filePath);

    // Create models with file:// and diff-original:// URIs for cross-file navigation
    const originalUri = getOriginalFileUri(repoName, filePath, monaco, repoPath);
    const modifiedUri = getModifiedFileUri(repoName, filePath, monaco, repoPath);

    const originalModel =
      getOrCreateTextModel(originalUri, originalContent, language, monaco) ||
      monaco.editor.createModel(originalContent, language);
    const modifiedModel =
      getOrCreateTextModel(modifiedUri, modifiedContent, language, monaco) ||
      monaco.editor.createModel(modifiedContent, language);
    modelsRef.current = { original: originalModel, modified: modifiedModel };

    // Register editor opener for cross-file definition jumps
    const openerDisposable = registerCrossFileEditorOpener((repo, file, line) => {
      onOpenFileRef.current?.(repo, file, line);
    }, monaco);

    // Instantiate Monaco Diff Editor
    const stopWatchingTheme = watchEditorTheme((theme) => monaco.editor.setTheme(theme));

    let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let cursorSub: monaco.IDisposable | null = null;
    let updateSub: monaco.IDisposable | null = null;

    try {
      diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
        readOnly: true,
        renderSideBySide: viewMode === 'side-by-side',
        // Monaco turns side by side into inline below 900px by default; a side panel is often narrower than that
        // while still roomy enough, and the toggle should show what the user chose.
        renderSideBySideInlineBreakpoint: 560,
        ignoreTrimWhitespace: ignoreWhitespace,
        hideUnchangedRegions: {
          enabled: false,
        },
        renderIndicators: true,
        originalEditable: false,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        // The overview ruler beside the scrollbar marks every change; a minimap only crowds a side panel.
        minimap: { enabled: false },
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
          alwaysConsumeMouseWheel: false,
        },
        lineNumbersMinChars: 3,
        fontSize: 12,
        fontFamily: "'JetBrains Mono', Consolas, Menlo, monospace",
        theme: editorThemeName(),
        // Long lines wrap instead of running off the right edge of either side
        wordWrap: 'on',
        contextmenu: true,
      });

      diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel,
      });

      editorInstanceRef.current = diffEditor;

      // Track cursor changes to sync active hunk and line
      const modifiedEditor = diffEditor.getModifiedEditor();
      cursorSub = modifiedEditor.onDidChangeCursorPosition((e) => {
        onLineSelectRef.current?.(e.position.lineNumber);
      });

      // Adjust and re-center targetLine after Monaco completes diff computation & layout
      updateSub = diffEditor.onDidUpdateDiff(() => {
        const currentTarget = targetLineRef.current;
        if (currentTarget && currentTarget > 0) {
          const key = `${filePath}:${currentTarget}:${jumpNonceRef.current ?? 0}`;
          if (lastDiffLayoutKeyRef.current !== key) {
            lastDiffLayoutKeyRef.current = key;
            modifiedEditor.revealLineInCenter(currentTarget);
            modifiedEditor.setPosition({ lineNumber: currentTarget, column: 1 });
          }
        }
      });

      // If an initial targetLine is supplied, reveal it immediately after mounting
      if (targetLine && targetLine > 0) {
        modifiedEditor.revealLineInCenter(targetLine);
        modifiedEditor.setPosition({ lineNumber: targetLine, column: 1 });
      }
    } catch (err) {
      console.error('[MonacoDiffAdapter] Error initializing diff editor:', err);
    }

    // Cleanup: Strictly dispose listeners and editor widget to prevent memory leaks
    return () => {
      stopWatchingTheme();
      updateSub?.dispose();
      cursorSub?.dispose();
      openerDisposable?.dispose();
      diffEditor?.dispose();
      editorInstanceRef.current = null;
    };
    // Lifecycle hook manages Monaco creation/disposal; content/viewMode/targetLine updates handled in separate effects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, repoName, repoPath]);

  return (
    <div
      ref={containerRef}
      style={{ height: typeof height === 'number' ? `${height}px` : height }}
      className="w-full h-full rounded-lg overflow-hidden border border-border/70 bg-background"
    />
  );
};
