/**
 * A read-only editor for a file with no uncommitted change: line numbers, syntax colouring, a
 * highlighted target line and the same cross-file navigation as the diff editor, instead of plain
 * preformatted text. Monaco's language and worker setup is shared with MonacoDiffAdapter, which
 * this module imports so the contributions are registered either way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import './MonacoDiffAdapter.js';
import { CodeFileLineNotes } from '../CodeFileLineNotes.js';
import { revealCodeNoteJump } from '../codeNoteJump.js';
import type { LineNote, LineRange } from '../../board/lineNotes.js';
import { editorThemeName, watchEditorTheme } from '../../../lib/editorTheme.js';
import { getLanguageFromPath } from '../utils/languageDetector.js';
import { getModifiedFileUri, getOrCreateTextModel, registerCrossFileEditorOpener } from '../utils/changesetModelStore.js';
import { useCodeFontSize } from '../codeFontSize.js';

export interface MonacoFileViewerProps {
  filePath: string;
  notesWorkspaceId?: string;
  active?: boolean;
  openNoteId?: string;
  onAskInCLI?: (path: string, range: LineRange) => void | Promise<unknown>;
  repoName?: string;
  /** Workspace model identity; never registers repository cross-file navigation. */
  workspaceId?: string;
  repoPath?: string;
  content: string;
  targetLine?: number;
  /** Changes on every request to reveal `targetLine`, so asking for the same line again still scrolls. */
  jumpKey?: number;
  onOpenFile?: (repoName: string, filePath: string, line?: number) => void;
}

export function MonacoFileViewer({ filePath, repoName, repoPath, workspaceId, content, targetLine, jumpKey, onOpenFile, notesWorkspaceId, active = true, openNoteId, onAskInCLI }: MonacoFileViewerProps) {
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [jumpNote, setJumpNote] = useState<LineNote | undefined>();
  const receiveJumpNote = useCallback((note: LineNote | undefined) => {
    setJumpNote(old => JSON.stringify(old) === JSON.stringify(note) ? old : note);
  }, []);
  const [fontSize] = useCodeFontSize();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const onOpenFileRef = useRef(onOpenFile);
  useEffect(() => { onOpenFileRef.current = onOpenFile; });

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.updateOptions({ fontSize });
  }, [fontSize]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ownedModel = workspaceId
      ? monaco.editor.createModel(content, getLanguageFromPath(filePath), monaco.Uri.from({ scheme: 'contextspace-workspace', authority: encodeURIComponent(workspaceId), path: `/${filePath}` }))
      : null;
    const model = ownedModel ?? getOrCreateTextModel(getModifiedFileUri(repoName!, filePath, monaco, repoPath), content, getLanguageFromPath(filePath), monaco);
    const editor = monaco.editor.create(containerRef.current, {
      model,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
      lineNumbersMinChars: 3,
      glyphMargin: true,
      lineHeight: 24,
      fontSize,
      fontFamily: "'JetBrains Mono', Consolas, Menlo, monospace",
      theme: editorThemeName(),
      renderLineHighlight: 'all',
    });
    editorRef.current = editor;
    setEditorInstance(editor);
    const stopWatchingTheme = watchEditorTheme((theme) => monaco.editor.setTheme(theme));
    const opener = workspaceId ? undefined : registerCrossFileEditorOpener((repo, file, line) => onOpenFileRef.current?.(repo, file, line), monaco);
    return () => {
      stopWatchingTheme();
      opener?.dispose();
      editor.dispose();
      ownedModel?.dispose();
      editorRef.current = null;
      setEditorInstance(null);
      decorationsRef.current = null;
    };
    // The editor is rebuilt per file; content and target updates are applied below without losing scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, repoName, repoPath, workspaceId]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && !model.isDisposed() && model.getValue() !== content) model.setValue(content);
  }, [content]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const matchingNote = jumpNote && jumpNote.id === openNoteId && jumpNote.path === filePath && (jumpNote.repo ?? '') === (repoName ?? '') ? jumpNote : undefined;
    const line = revealCodeNoteJump(editor, targetLine, matchingNote, content, Boolean(openNoteId && !matchingNote));
    decorationsRef.current ??= editor.createDecorationsCollection();
    decorationsRef.current.set(line === undefined ? [] : [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pa1-jump-line' } }]);
  }, [targetLine, jumpKey, filePath, repoName, openNoteId, jumpNote, content]);

  const notesWorkspace = notesWorkspaceId ?? workspaceId;
  return <div className="flex h-full min-h-0 w-full flex-col" data-code-file-path={filePath}>
    <div ref={containerRef} data-testid="code-file-viewer" className="min-h-0 w-full flex-1" />
    {editorInstance && notesWorkspace && <CodeFileLineNotes editor={editorInstance} workspace={notesWorkspace} path={filePath} repo={repoName} content={content} active={active} openNoteId={openNoteId} request={jumpKey} onJumpNote={receiveJumpNote} onAskInCLI={onAskInCLI} />}
  </div>;
}
