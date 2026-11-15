/**
 * Changeset Text Model Store: Manages multi-file Monaco TextModels with consistent file:// and diff-original:// URIs
 * File: gui/src/features/changes/utils/changesetModelStore.ts
 */
import type * as monaco from 'monaco-editor';

// The Monaco API last handed to this store. The app bundles Monaco as a module
// and never sets window.monaco, and importing it here would pull the whole
// editor out of its lazy chunk, so disposal reaches Monaco through this.
let knownMonaco: typeof monaco | undefined;

/**
 * Resolves the active Monaco API instance safely, preferring explicitly passed API,
 * then the one this store has already been given, then window.monaco if it contains editor.
 */
function resolveMonaco(monacoApi?: typeof monaco): typeof monaco | undefined {
  if (monacoApi?.editor) {
    knownMonaco = monacoApi;
    return monacoApi;
  }
  if (knownMonaco?.editor) return knownMonaco;
  if (typeof window !== 'undefined' && (window as unknown as { monaco?: typeof monaco }).monaco?.editor) {
    return (window as unknown as { monaco?: typeof monaco }).monaco;
  }
  return undefined;
}

export function getCleanPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\//, '');
}

export function getCleanRepo(repoName: string): string {
  return repoName.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
}

/**
 * A short, stable authority for a scope (a repository's worktree path). Models are
 * keyed by URI, and the same repository name and file exist in every workspace of
 * a repository, so without it two viewers would share, and overwrite, one model.
 * The path after the authority stays `/<repo>/<file>`, which is what the editor
 * opener reads. No scope gives an empty authority, the URI as it always was.
 */
export function scopeAuthority(scope?: string): string {
  if (!scope) return '';
  const normalized = scope.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths compare without case; others do.
  const key = /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
  // Two 32-bit FNV-style passes with different seeds: 64 bits as host-safe hex.
  let first = 0x811c9dc5;
  let second = 0x9747b28c;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}

export function getModifiedFileUri(repoName: string, filePath: string, monacoApi?: typeof monaco, scope?: string): monaco.Uri {
  const cleanRepo = getCleanRepo(repoName);
  const cleanPath = getCleanPath(filePath);
  const authority = scopeAuthority(scope);
  const uriString = `file://${authority}/${cleanRepo}/${cleanPath}`;

  const m = resolveMonaco(monacoApi);
  if (m?.Uri?.parse) {
    return m.Uri.parse(uriString);
  }

  const pathString = `/${cleanRepo}/${cleanPath}`;
  return {
    scheme: 'file',
    authority,
    path: pathString,
    query: '',
    fragment: '',
    fsPath: pathString,
    with: () => ({} as unknown as monaco.Uri),
    toString: () => uriString,
    toJSON: () => uriString,
  } as unknown as monaco.Uri;
}

export function getOriginalFileUri(repoName: string, filePath: string, monacoApi?: typeof monaco, scope?: string): monaco.Uri {
  const cleanRepo = getCleanRepo(repoName);
  const cleanPath = getCleanPath(filePath);
  const authority = scopeAuthority(scope);
  const uriString = `diff-original://${authority}/${cleanRepo}/${cleanPath}`;

  const m = resolveMonaco(monacoApi);
  if (m?.Uri?.parse) {
    return m.Uri.parse(uriString);
  }

  const pathString = `/${cleanRepo}/${cleanPath}`;
  return {
    scheme: 'diff-original',
    authority,
    path: pathString,
    query: '',
    fragment: '',
    fsPath: pathString,
    with: () => ({} as unknown as monaco.Uri),
    toString: () => uriString,
    toJSON: () => uriString,
  } as unknown as monaco.Uri;
}

/**
 * Creates or retrieves a persistent text model for a file in the changeset.
 */
export function getOrCreateTextModel(
  uri: monaco.Uri,
  content: string,
  language: string,
  monacoApi?: typeof monaco
): monaco.editor.ITextModel | null {
  const m = resolveMonaco(monacoApi);
  if (!m?.editor) return null;

  try {
    let model = m.editor.getModel(uri);
    if (!model || model.isDisposed()) {
      model = m.editor.createModel(content, language, uri);
    } else if (model.getValue() !== content) {
      model.setValue(content);
    }
    return model;
  } catch (err) {
    console.warn('[changesetModelStore] Error in getOrCreateTextModel:', err);
    try {
      return m.editor.getModel(uri) || m.editor.createModel(content, language);
    } catch {
      return null;
    }
  }
}

/**
 * The models a live editor still holds. Monaco reports an error when a model is
 * disposed under an editor, so those are never disposed here: whoever holds one
 * is using it (it may even be another workspace's viewer sharing the same URI).
 */
function modelsHeldByEditors(m: typeof monaco): Set<monaco.editor.ITextModel> {
  const held = new Set<monaco.editor.ITextModel>();
  try {
    for (const diffEditor of m.editor.getDiffEditors?.() ?? []) {
      const pair = diffEditor.getModel();
      if (pair?.original) held.add(pair.original);
      if (pair?.modified) held.add(pair.modified);
    }
    for (const editor of m.editor.getEditors?.() ?? []) {
      const model = editor.getModel();
      if (model) held.add(model);
    }
  } catch {
    // If the editors cannot be listed there is nothing better to go on.
  }
  return held;
}

/**
 * Disposes the models of one file, for example once it has left the changeset.
 * A file with no models is not an error, and a model an editor still holds is left alone.
 */
export function disposeChangesetModelsFor(repoName: string, filePath: string, monacoApi?: typeof monaco, scope?: string): void {
  const m = resolveMonaco(monacoApi);
  if (!m?.editor) return;

  const held = modelsHeldByEditors(m);
  for (const uri of [getModifiedFileUri(repoName, filePath, m, scope), getOriginalFileUri(repoName, filePath, m, scope)]) {
    try {
      const model = m.editor.getModel(uri);
      if (model && !model.isDisposed() && !held.has(model)) model.dispose();
    } catch (err) {
      console.warn('[changesetModelStore] Error disposing model:', err);
    }
  }
}

/**
 * Disposes the models of several files once the current cleanup pass is over.
 * Monaco reports an error when a model is disposed while a diff editor still
 * holds it, and the editors that unmount together with their owner only release
 * their models after the owner's own cleanup has run.
 */
export function disposeChangesetModelsAfterEditors(
  files: ReadonlyArray<{ repoName: string; file: string; repoPath?: string }>,
  monacoApi?: typeof monaco,
): void {
  if (files.length === 0) return;
  const owned = files.map(({ repoName, file, repoPath }) => ({ repoName, file, repoPath }));
  setTimeout(() => {
    for (const { repoName, file, repoPath } of owned) disposeChangesetModelsFor(repoName, file, monacoApi, repoPath);
  }, 0);
}

/**
 * Disposes all models with file:// or diff-original:// schemes to prevent memory leaks.
 */
export function disposeAllChangesetModels(monacoApi?: typeof monaco): void {
  const m = resolveMonaco(monacoApi);
  if (!m?.editor) return;

  try {
    const held = modelsHeldByEditors(m);
    for (const model of m.editor.getModels()) {
      if ((model.uri.scheme === 'file' || model.uri.scheme === 'diff-original') && !held.has(model)) {
        model.dispose();
      }
    }
  } catch (err) {
    console.warn('[changesetModelStore] Error disposing models:', err);
  }
}

export type OpenFileCallback = (repoName: string, filePath: string, line?: number) => void;

/**
 * Registers an editor opener with Monaco to coordinate cross-file definition navigation.
 */
export function registerCrossFileEditorOpener(
  onOpenFile: OpenFileCallback,
  monacoApi?: typeof monaco
): monaco.IDisposable {
  const m = resolveMonaco(monacoApi);
  if (!m?.editor?.registerEditorOpener) return { dispose: () => {} };

  try {
    return m.editor.registerEditorOpener({
      openCodeEditor(_source: unknown, resource: monaco.Uri, selectionOrPosition: unknown) {
        if (!resource || resource.scheme !== 'file') return false;

        // Extract repoName and relative filePath from URI path: /repoName/path/to/file.ts
        const normalizedPath = resource.path.replace(/^\//, '');
        const slashIndex = normalizedPath.indexOf('/');
        if (slashIndex === -1) return false;

        const repoName = normalizedPath.substring(0, slashIndex);
        const filePath = normalizedPath.substring(slashIndex + 1);

        let targetLine: number | undefined;
        if (selectionOrPosition && typeof selectionOrPosition === 'object') {
          const pos = selectionOrPosition as { lineNumber?: unknown; startLineNumber?: unknown };
          if (typeof pos.lineNumber === 'number') {
            targetLine = pos.lineNumber;
          } else if (typeof pos.startLineNumber === 'number') {
            targetLine = pos.startLineNumber;
          }
        }

        onOpenFile(repoName, filePath, targetLine);
        return true;
      },
    });
  } catch (err) {
    console.warn('[changesetModelStore] Failed to register editor opener:', err);
    return { dispose: () => {} };
  }
}
