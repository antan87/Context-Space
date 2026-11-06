/**
 * A read-only editor for a file with no uncommitted change: line numbers, syntax colouring, a
 * highlighted target line and the same cross-file navigation as the diff editor, instead of plain
 * preformatted text. Monaco's language and worker setup is shared with MonacoDiffAdapter, which
 * this module imports so the contributions are registered either way.
 */
import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import './MonacoDiffAdapter.js';
import { editorThemeName, watchEditorTheme } from '../../../lib/editorTheme.js';
import { getLanguageFromPath } from '../utils/languageDetector.js';
import { getModifiedFileUri, getOrCreateTextModel, registerCrossFileEditorOpener } from '../utils/changesetModelStore.js';

export interface MonacoFileViewerProps {
  filePath: string;
  repoName: string;
  repoPath?: string;
  content: string;
  targetLine?: number;
  /** Changes on every request to reveal `targetLine`, so asking for the same line again still scrolls. */
  jumpKey?: number;
  onOpenFile?: (repoName: string, filePath: string, line?: number) => void;
}

export function MonacoFileViewer({ filePath, repoName, repoPath, content, targetLine, jumpKey, onOpenFile }: MonacoFileViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const onOpenFileRef = useRef(onOpenFile);
  useEffect(() => { onOpenFileRef.current = onOpenFile; });

  useEffect(() => {
    if (!containerRef.current) return;
    const model = getOrCreateTextModel(getModifiedFileUri(repoName, filePath, monaco, repoPath), content, getLanguageFromPath(filePath), monaco);
    const editor = monaco.editor.create(containerRef.current, {
      model,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
      lineNumbersMinChars: 3,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', Consolas, Menlo, monospace",
      theme: editorThemeName(),
      renderLineHighlight: 'all',
    });
    editorRef.current = editor;
    const stopWatchingTheme = watchEditorTheme((theme) => monaco.editor.setTheme(theme));
    const opener = registerCrossFileEditorOpener((repo, file, line) => onOpenFileRef.current?.(repo, file, line), monaco);
    return () => {
      stopWatchingTheme();
      opener?.dispose();
      editor.dispose();
      editorRef.current = null;
      decorationsRef.current = null;
    };
    // The editor is rebuilt per file; content and target updates are applied below without losing scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, repoName, repoPath]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && !model.isDisposed() && model.getValue() !== content) model.setValue(content);
  }, [content]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !targetLine || targetLine < 1) return;
    const line = Math.min(targetLine, editor.getModel()?.getLineCount() ?? targetLine);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    decorationsRef.current ??= editor.createDecorationsCollection();
    decorationsRef.current.set([{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'bg-primary/20' } }]);
  }, [targetLine, jumpKey, filePath]);

  return <div ref={containerRef} data-testid="code-file-viewer" className="h-full w-full min-h-0" />;
}
