import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  ArrowDownUp, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, ExternalLink, FileCode, GitCommitHorizontal, ListTree,
  Flag, FolderTree, Loader2, MoreHorizontal, RefreshCw, Search, X,
} from 'lucide-react';
import { apiFetch } from '../../lib/api/client.js';
import { perfMark } from '../../lib/perfMarks.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { useElementWidth } from '../../lib/useElementWidth.js';
import { useConfig } from '../../lib/api/queries.js';
import type { CommitRepoResult, Feature } from '../../types.js';
import { Button } from '../../components/ui/button.js';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../../components/ui/menu.js';
import { floatingChatStore } from '../chat/floatingChatStore.js';
import { useCockpitStore } from '../cockpit/cockpitStore.js';
import { usePaneHotkey } from '../terminal/usePaneHotkey.js';
import { useCodeRequest, type CodeRequest, type RepoFile } from '../workspace-shell/openRequests.js';
import { CommitReviewPanel } from './CommitReviewPanel.js';
import { FinishPanel } from './FinishPanel.js';
import { ChangesetSymbolNavigator } from './ChangesetSymbolNavigator.js';
import { DiffErrorBoundary } from './DiffErrorBoundary.js';
import { PluggableDiffViewer } from './PluggableDiffViewer.js';
import { FileTree, buildCompactedTree, filterTreeFiles, flattenTreeFiles, getAllDirectoryPaths } from './FileTree.js';
import { fileTypeGlyph } from './fileTypeGlyph.js';
import { OPENED_UNLISTED, withOpenedFile } from './openedFileRow.js';
import { getEditorLabel, openInVsCodeAtLine } from './adapters/ExternalDiffLauncher.js';
import { disposeChangesetModelsAfterEditors } from './utils/changesetModelStore.js';
import { globalChangesetSymbolIndex, useChangesetSymbolStore, type ChangesetSymbol, type RawAstSymbol } from './utils/changesetSymbolIndex.js';
import { omittedNotice } from './utils/omittedContent.js';

const MonacoFileViewer = lazy(() => import('./adapters/MonacoFileViewer.js').then((module) => ({ default: module.MonacoFileViewer })));

/** Sidebar width limits: the file names stay readable, and the tree never crowds out the code it selects. */
const TREE_MIN_PX = 160;
const TREE_MAX_PX = 480;
const TREE_DEFAULT_PX = 248;
const TREE_WIDTH_KEY = 'contextspace.code-panel.tree-width';
const REFRESH_MS = 10_000;
/** Below this width the tree and the code cannot sit side by side, so the tree opens over the code. */
const NARROW_PX = 620;

type Mode = 'changes' | 'files';
interface CodeFile { file: string; type: string; additions?: number; deletions?: number; size?: number; mtimeMs?: number }
interface CodeRepo { repoName: string; repoPath: string; files: CodeFile[]; error?: string }
interface FileDiff {
  diff: string;
  fileContent?: string;
  originalContent?: string;
  symbols?: RawAstSymbol[];
  contentOmitted?: 'binary' | 'too-large';
  diffOmitted?: boolean;
}

/** The open file. `jump` grows with every request to show it, so asking for the same line twice still scrolls. */
interface Selection extends RepoFile {
  line?: number;
  jump: number;
  /** Opened by name (a link, a definition jump) rather than from the tree, so it stays open while unlisted. */
  pinned: boolean;
}

type Notice = Exclude<CodeRequest, { kind: 'file' }>;

export interface CodeSectionProps {
  ws: Feature;
  /** False while another section is shown: the listing stops refreshing and the hotkeys stand down. */
  active: boolean;
  syncLoading: boolean;
  syncResults: { repoName: string; success: boolean; message: string }[] | null;
  commitMessage: string;
  showCommitModal: boolean;
  commitResults: CommitRepoResult[] | null;
  setSyncResults: (value: null) => void;
  setCommitResults: (value: CommitRepoResult[] | null) => void;
  setCommitMessage: (value: string) => void;
  setShowCommitModal: (value: boolean) => void;
  fetchGitChanges: (wsId: string) => Promise<void>;
  handleSyncAll: (wsId: string) => Promise<void>;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** The panel's own controls (give the chat its room back, close), shown at the end of the toolbar. */
  panelActions?: ReactNode;
}

const fileKey = (repoName: string, file: string) => `${repoName}\0${file}`;
const sameFile = (a: RepoFile | null | undefined, b: RepoFile | null | undefined) => Boolean(a && b && a.repoName === b.repoName && a.file === b.file);

function readTreeWidth(): number {
  try {
    const stored = Number.parseInt(localStorage.getItem(TREE_WIDTH_KEY) ?? '', 10);
    return Number.isFinite(stored) ? Math.min(TREE_MAX_PX, Math.max(TREE_MIN_PX, stored)) : TREE_DEFAULT_PX;
  } catch {
    return TREE_DEFAULT_PX;
  }
}

/**
 * The workspace's code, beside the chat: every repository as one tree on the left (its changes,
 * or all of its files), the chosen file on the right, and the actions that finish the work
 * (review and commit, finish, sync) in the header. Paths clicked in the chat open here.
 *
 * Folder state is kept as the folders the user moved away from the default, per mode: in Changes
 * every folder starts open, so a newly changed folder appears open; in Files every folder starts
 * closed. A refresh therefore never reopens what the user closed, nor closes what they opened.
 */
export function CodeSection(props: CodeSectionProps) {
  const { ws, active, showToast } = props;
  const workspace = ws.branchName;
  const base = `/api/workspace/${encodeURIComponent(workspace)}`;
  const config = useConfig().data?.config;
  const defaultEditor = config?.defaultEditor;
  const editorLabel = getEditorLabel(defaultEditor);
  const cockpit = useCockpitStore();

  const [mode, setMode] = useState<Mode>('changes');
  const [repos, setRepos] = useState<CodeRepo[]>([]);
  const [listedMode, setListedMode] = useState<Mode | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  // The file the loaded diff belongs to travels with it, so a late answer for another file is never shown.
  const [diff, setDiff] = useState<{ target: RepoFile; data: FileDiff } | null>(null);
  const [diffError, setDiffError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  const [treeHidden, setTreeHidden] = useState(false);
  const [treeWidth, setTreeWidth] = useState(readTreeWidth);
  const [draggingTree, setDraggingTree] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const searching = deferredQuery.trim().length > 0;
  // Folders moved away from the default, per `${mode}\0${repo}`; and, while filtering, folders closed.
  const [toggledFolders, setToggledFolders] = useState<Record<string, Set<string>>>({});
  const [searchClosedFolders, setSearchClosedFolders] = useState<Record<string, Set<string>>>({});
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const filterInput = useRef<HTMLInputElement>(null);
  const jumpCounter = useRef(0);
  const [sectionElement, setSectionElement] = useState<HTMLElement | null>(null);
  const width = useElementWidth(sectionElement);
  const narrow = width > 0 && width < NARROW_PX;
  // Beside the chat in a small window the toolbar keeps one row: short labels, and Finish moves into the menu.
  const compactToolbar = width > 0 && width < 560;
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Changes and Files choose what the tree lists, so in a narrow panel choosing one shows the tree. */
  const switchMode = (next: Mode) => {
    setMode(next);
    if (narrow) setDrawerOpen(true);
  };
  const allSymbols = useChangesetSymbolStore();

  // ─── Listing ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const start = () => { timer ??= window.setInterval(() => setRevision((value) => value + 1), REFRESH_MS); };
    const stop = () => { if (timer !== undefined) window.clearInterval(timer); timer = undefined; };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else { setRevision((value) => value + 1); start(); }
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [active]);

  // The server answers `unchanged` while this token is current, so an idle panel does not re-download the tree.
  const knownListing = useRef<{ key: string; token: string } | null>(null);
  const [listingToken, setListingToken] = useState('');
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const key = `${base}|${mode}`;
    const params = new URLSearchParams(mode === 'files' ? { include: 'all' } : {});
    if (knownListing.current?.key === key) params.set('known', knownListing.current.token);
    setLoading(true);
    void apiFetch<{ changes?: CodeRepo[]; unchanged?: boolean; token?: string }>(`${base}/changes${params.toString() ? `?${params}` : ''}`)
      .then((response) => {
        if (cancelled) return;
        setListError('');
        knownListing.current = response.token ? { key, token: response.token } : null;
        if (response.token) setListingToken(response.token);
        setListedMode(mode);
        if (response.unchanged || !response.changes) return;
        const changes = response.changes;
        setRepos((previous) => (JSON.stringify(previous) === JSON.stringify(changes) ? previous : changes));
        // In Files the listing is every file, so a file missing from it is gone. In Changes a missing file
        // was only committed or reverted, and stays open to show what it is now.
        if (mode === 'files') {
          setSelection((current) => (current && !current.pinned && !changes.some((repo) => repo.repoName === current.repoName && repo.files.some((file) => file.file === current.file)) ? null : current));
        }
      })
      .catch((error) => { if (!cancelled) setListError(error instanceof Error ? error.message : 'Could not list the files.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [base, mode, revision, active]);

  // Every symbol in the change set, so a definition in another changed file is one jump away.
  useEffect(() => {
    if (!active || mode !== 'changes' || !listingToken) return;
    let cancelled = false;
    void apiFetch<{ symbols?: (RawAstSymbol & { repoName: string; filePath: string; repoPath?: string })[] }>(`${base}/changes/symbols`)
      .then((data) => {
        if (cancelled || !Array.isArray(data.symbols)) return;
        const byFile = new Map<string, { repoName: string; filePath: string; repoPath?: string; symbols: RawAstSymbol[] }>();
        for (const symbol of data.symbols) {
          const key = fileKey(symbol.repoName, symbol.filePath);
          const entry = byFile.get(key) ?? { repoName: symbol.repoName, filePath: symbol.filePath, repoPath: symbol.repoPath, symbols: [] };
          entry.symbols.push(symbol);
          byFile.set(key, entry);
        }
        for (const entry of byFile.values()) {
          globalChangesetSymbolIndex.indexFile(entry.repoName, entry.filePath, '', [], entry.repoPath, entry.symbols);
        }
      })
      .catch(() => { /* Symbols are a convenience; the code still shows without them. */ });
    return () => { cancelled = true; };
  }, [active, base, mode, listingToken]);

  // ─── Tree model ────────────────────────────────────────────────────────────
  // A file opened by name that git's listing leaves out (a build output, a local config) gets one row of its own, so the
  // tree has the open file in it. It is judged against the Files listing, once that has arrived.
  const openedUnlisted = mode === 'files' && listedMode === 'files' && !loading && selection?.pinned ? selection : null;
  const shownRepos = useMemo(() => withOpenedFile(repos, openedUnlisted), [repos, openedUnlisted]);
  const totalFiles = useMemo(() => shownRepos.reduce((sum, repo) => sum + (repo.files?.length ?? 0), 0), [shownRepos]);
  const trees = useMemo(() => shownRepos.map((repo) => {
    const files = searching ? filterTreeFiles(repo.files ?? [], deferredQuery) : (repo.files ?? []);
    const root = buildCompactedTree(files);
    return { repo, files, root, folders: getAllDirectoryPaths(root), ordered: flattenTreeFiles(root) };
  }), [shownRepos, searching, deferredQuery]);
  const matchingFiles = useMemo(() => trees.reduce((sum, tree) => sum + tree.files.length, 0), [trees]);
  const ordered = useMemo(() => trees.flatMap(({ repo, ordered: files }) => files.map((file) => ({ repoName: repo.repoName, repoPath: repo.repoPath, file: file.file }))), [trees]);
  const currentIndex = selection ? ordered.findIndex((entry) => sameFile(entry, selection)) : -1;

  const expandedFor = useCallback((repoName: string, folders: string[]): Set<string> => {
    if (searching) {
      const closed = searchClosedFolders[repoName];
      return closed ? new Set(folders.filter((folder) => !closed.has(folder))) : new Set(folders);
    }
    const toggled = toggledFolders[`${mode}\0${repoName}`];
    if (mode === 'changes') return toggled ? new Set(folders.filter((folder) => !toggled.has(folder))) : new Set(folders);
    return new Set(toggled ?? []);
  }, [mode, searching, searchClosedFolders, toggledFolders]);

  const setExpandedFor = (repoName: string, folders: string[], expanded: Set<string>) => {
    if (searching) {
      setSearchClosedFolders((previous) => ({ ...previous, [repoName]: new Set(folders.filter((folder) => !expanded.has(folder))) }));
    } else {
      const toggled = mode === 'changes' ? new Set(folders.filter((folder) => !expanded.has(folder))) : new Set(expanded);
      setToggledFolders((previous) => ({ ...previous, [`${mode}\0${repoName}`]: toggled }));
    }
  };

  /** Opens the folders above a file, in whichever modes it can be shown. */
  const revealInTree = (target: RepoFile) => {
    // Every folder prefix, which covers each way the tree can compact single-child folders together.
    const segments = target.file.split('/').slice(0, -1);
    const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    setCollapsedRepos((previous) => (previous[target.repoName] ? { ...previous, [target.repoName]: false } : previous));
    if (ancestors.length === 0) return;
    setToggledFolders((previous) => {
      const next = { ...previous };
      const changesKey = `changes\0${target.repoName}`;
      const filesKey = `files\0${target.repoName}`;
      if (next[changesKey]) next[changesKey] = new Set([...next[changesKey]!].filter((folder) => !ancestors.includes(folder)));
      next[filesKey] = new Set([...(next[filesKey] ?? []), ...ancestors]);
      return next;
    });
    setSearchClosedFolders((previous) => {
      const closed = previous[target.repoName];
      return closed ? { ...previous, [target.repoName]: new Set([...closed].filter((folder) => !ancestors.includes(folder))) } : previous;
    });
  };

  const openFile = (target: RepoFile, options: { line?: number; pinned?: boolean } = {}) => {
    jumpCounter.current += 1;
    setNotice(null);
    setDrawerOpen(false);
    setFinishOpen(false);
    if (props.showCommitModal) props.setShowCommitModal(false);
    if (!sameFile(target, selection)) setDiffError('');
    setSelection({ repoName: target.repoName, repoPath: target.repoPath, file: target.file, line: options.line, jump: jumpCounter.current, pinned: options.pinned ?? false });
    revealInTree(target);
  };

  const step = (delta: 1 | -1) => {
    if (ordered.length === 0) return;
    const next = currentIndex === -1 ? (delta > 0 ? 0 : ordered.length - 1) : currentIndex + delta;
    const target = ordered[next];
    if (target) openFile(target);
  };

  // ─── Requests from the chat (clicked paths) ────────────────────────────────
  const request = useCodeRequest(workspace);
  const handledRequest = useRef(0);
  const openFileRef = useRef(openFile);
  useEffect(() => { openFileRef.current = openFile; });
  useEffect(() => {
    if (!request || request.id === handledRequest.current) return;
    handledRequest.current = request.id;
    const asked = request.request;
    if (asked.kind === 'file') openFileRef.current(asked, { line: asked.line, pinned: true });
    else setNotice(asked);
  }, [request]);

  // A file opened by name that is not a change can only be shown in the tree under Files. The listing can be up to
  // REFRESH_MS old, and a file made moments ago may be a change it does not have yet, so it is listed again once
  // before the view moves, and Changes stays when the file turns up in it. `revision` is left out of the
  // dependencies on purpose: the answer is judged when that listing has arrived, not when it was asked for.
  const relisted = useRef<string | null>(null);
  useEffect(() => {
    if (!selection?.pinned || mode !== 'changes' || listedMode !== 'changes' || loading) return;
    const listed = repos.some((repo) => repo.repoName === selection.repoName && repo.files.some((file) => file.file === selection.file));
    if (listed) { relisted.current = null; return; }
    const asked = `${selection.repoName}\0${selection.file}\0${selection.jump}`;
    if (relisted.current !== asked) { relisted.current = asked; setRevision((value) => value + 1); return; }
    setMode('files');
  }, [selection, mode, listedMode, repos, loading]);

  // ─── The open file ─────────────────────────────────────────────────────────
  const selectedEntry = selection ? repos.find((repo) => repo.repoName === selection.repoName)?.files.find((file) => file.file === selection.file) : undefined;
  const selectedVersion = selectedEntry ? [selectedEntry.type, selectedEntry.additions, selectedEntry.deletions, selectedEntry.size, selectedEntry.mtimeMs].join(':') : '';
  const selectedRepo = selection?.repoName;
  const selectedFile = selection?.file;
  const selectedRepoPath = selection?.repoPath;
  useEffect(() => {
    if (!active || !selectedRepo || !selectedFile) return;
    let cancelled = false;
    void apiFetch<FileDiff>(`${base}/changes/diff?${new URLSearchParams({ repo: selectedRepo, file: selectedFile })}`)
      .then((result) => {
        if (cancelled) return;
        perfMark('cs:diff-ready', { panel: 'code', repo: selectedRepo, file: selectedFile });
        setDiffError('');
        const target = { repoName: selectedRepo, repoPath: selectedRepoPath ?? '', file: selectedFile };
        setDiff((previous) => (previous && sameFile(previous.target, target) && previous.data.diff === result.diff && previous.data.fileContent === result.fileContent && previous.data.originalContent === result.originalContent ? previous : { target, data: result }));
      })
      .catch((error) => { if (!cancelled) setDiffError(error instanceof Error ? error.message : 'Could not open the file.'); });
    return () => { cancelled = true; };
  }, [active, base, selectedRepo, selectedFile, selectedRepoPath, selectedVersion]);

  // Editor models belong to the file on screen; they go when it does.
  useEffect(() => {
    if (!selectedRepo || !selectedFile) return;
    const owned = { repoName: selectedRepo, file: selectedFile, repoPath: selectedRepoPath };
    return () => disposeChangesetModelsAfterEditors([owned]);
  }, [selectedRepo, selectedFile, selectedRepoPath]);

  /** A definition jump or a symbol: the repository and path are known, so it opens directly. */
  const openDefinition = (repoName: string, filePath: string, line?: number) => {
    const repo = repos.find((entry) => entry.repoName === repoName);
    if (!repo) {
      showToast?.(`${repoName}/${filePath} is not in this workspace.`, 'info');
      return;
    }
    openFile({ repoName, repoPath: repo.repoPath, file: filePath }, { line, pinned: true });
  };

  // ─── Commit, finish, sync ──────────────────────────────────────────────────
  const gitChanged = () => {
    void props.fetchGitChanges(workspace);
    setRevision((value) => value + 1);
  };
  const changedFiles = listedMode === 'changes' ? totalFiles : undefined;

  // ─── Sidebar ───────────────────────────────────────────────────────────────
  const setTreeWidthPx = useCallback((value: number) => {
    const width = Math.round(Math.min(TREE_MAX_PX, Math.max(TREE_MIN_PX, value)));
    setTreeWidth(width);
    try { localStorage.setItem(TREE_WIDTH_KEY, String(width)); } catch { /* Width is only a preference. */ }
  }, []);

  const startTreeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = treeWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDraggingTree(true);
    const onMove = (move: PointerEvent) => setTreeWidthPx(startWidth + (move.clientX - startX));
    const onUp = (up: PointerEvent) => {
      setDraggingTree(false);
      if (target.hasPointerCapture(up.pointerId)) target.releasePointerCapture(up.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const changeQuery = (value: string) => {
    // Folders closed while filtering belong to that filter; a new one starts with every match open.
    if (value.trim() !== query.trim()) setSearchClosedFolders({});
    setQuery(value);
  };

  const expandAll = () => {
    setCollapsedRepos({});
    if (searching) { setSearchClosedFolders({}); return; }
    setToggledFolders((previous) => {
      const next = { ...previous };
      for (const { repo, folders } of trees) next[`${mode}\0${repo.repoName}`] = mode === 'changes' ? new Set() : new Set(folders);
      return next;
    });
  };

  const collapseAll = () => {
    if (searching) {
      setSearchClosedFolders(Object.fromEntries(trees.map(({ repo, folders }) => [repo.repoName, new Set(folders)])));
      return;
    }
    setToggledFolders((previous) => {
      const next = { ...previous };
      for (const { repo, folders } of trees) next[`${mode}\0${repo.repoName}`] = mode === 'changes' ? new Set(folders) : new Set();
      return next;
    });
  };

  // Alt+Arrow steps through files; bare j/k stay with the diff viewer's hunks.
  usePaneHotkey((event) => {
    if (!event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
    }
  }, { respectTerminal: false, enabled: active });

  // / filters the tree (showing it first if it is hidden); Escape clears the filter.
  usePaneHotkey((event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/') {
      event.preventDefault();
      if (narrow) setDrawerOpen(true);
      else setTreeHidden(false);
      requestAnimationFrame(() => { filterInput.current?.focus(); filterInput.current?.select(); });
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      changeQuery('');
    } else if (event.key === 'Escape' && drawerOpen) {
      event.preventDefault();
      setDrawerOpen(false);
    }
  }, { respectTerminal: true, enabled: active });

  // ─── Render ────────────────────────────────────────────────────────────────
  const mainView = props.showCommitModal ? 'commit' : finishOpen ? 'finish' : 'file';
  const shownDiff = diff && selection && sameFile(diff.target, selection) ? diff.data : null;
  const fileNotice = omittedNotice(shownDiff && (shownDiff.contentOmitted || shownDiff.diffOmitted) ? { content: shownDiff.contentOmitted, diff: shownDiff.diffOmitted } : undefined);
  // Narrow (beside the chat in a small window): the code takes the width and the tree opens over it.
  const treeAsDrawer = narrow && (selection !== null || mainView !== 'file');
  const treeVisible = narrow ? !treeAsDrawer || drawerOpen : !treeHidden;
  const toggleTree = () => (narrow ? setDrawerOpen((open) => !open) : setTreeHidden((hidden) => !hidden));
  const iconButton = 'size-7 p-0';

  const tree = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 size-3 text-muted-foreground" aria-hidden="true" />
          <input
            ref={filterInput}
            type="search"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                changeQuery('');
                event.currentTarget.blur();
              }
            }}
            placeholder="Filter files (/)"
            aria-label="Filter files"
            className="h-7 w-full rounded border border-border bg-background pl-6 pr-6 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" aria-label="Clear the filter" title="Clear the filter (Esc)" className="absolute right-1 rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => { changeQuery(''); filterInput.current?.focus(); }}>
              <X className="size-3" />
            </button>
          )}
        </div>
        <Button size="xs" variant="ghost" className={iconButton} aria-label="Expand all folders" title="Expand all folders" onClick={expandAll}><ChevronsUpDown className="size-3.5" /></Button>
        <Button size="xs" variant="ghost" className={iconButton} aria-label="Collapse all folders" title="Collapse all folders" onClick={collapseAll}><ChevronsDownUp className="size-3.5" /></Button>
      </div>
      <p data-testid="search-match-count" className="shrink-0 px-2.5 pb-1 pt-1 text-[11px] text-muted-foreground">
        {searching ? `${matchingFiles} of ${totalFiles} files match` : `${totalFiles} ${mode === 'changes' ? 'changed ' : ''}file${totalFiles === 1 ? '' : 's'}`}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2 [scrollbar-gutter:stable]">
        {listedMode !== mode && !listError && (
          <p role="status" className="flex items-center gap-1.5 p-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Listing {mode === 'files' ? 'all files' : 'changes'}…</p>
        )}
        {listedMode === mode && trees.map(({ repo, files, root, folders }) => {
          if (searching && files.length === 0) return null;
          const collapsed = !searching && Boolean(collapsedRepos[repo.repoName]);
          return (
            <div key={repo.repoName}>
              {repos.length > 1 && (
                <button type="button" aria-expanded={!collapsed}
                  className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setCollapsedRepos((previous) => ({ ...previous, [repo.repoName]: !collapsed }))}>
                  <ChevronRight aria-hidden="true" className={cn('size-3 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
                  <span className="truncate">{repo.repoName}</span>
                  <span className="ml-auto shrink-0 font-normal tabular-nums">{files.length}</span>
                </button>
              )}
              {!collapsed && (repo.error ? (
                <p role="alert" className="px-2 text-xs text-destructive">{repo.error}</p>
              ) : (
                <FileTree
                  label={`${repo.repoName} ${mode === 'changes' ? 'changed files' : 'files'}`}
                  files={files}
                  root={root}
                  selectedPath={selection?.repoName === repo.repoName ? selection.file : undefined}
                  revealPath={selection?.repoName === repo.repoName ? selection.file : undefined}
                  revealKey={selection?.jump}
                  expandedPaths={expandedFor(repo.repoName, folders)}
                  onExpandedPathsChange={(expanded) => setExpandedFor(repo.repoName, folders, expanded)}
                  onActivateFile={(file) => openFile({ repoName: repo.repoName, repoPath: repo.repoPath, file: file.file })}
                  renderFile={(file) => {
                    const glyph = fileTypeGlyph(file.file);
                    const Glyph = glyph.icon;
                    const unlisted = file.type === OPENED_UNLISTED;
                    const changed = file.type !== 'unchanged' && !unlisted;
                    return (
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1" title={`${file.file}${unlisted ? ' · opened here, ignored by git or not listed yet' : changed ? ` · ${file.type}` : ''}`}>
                        <Glyph className={cn('size-3.5 shrink-0', glyph.className)} aria-hidden="true" />
                        <span className={cn('truncate', file.type === 'deleted' && 'line-through opacity-70')}>{file.file.split('/').at(-1)}</span>
                        <span className="sr-only">{glyph.label}{unlisted ? ', opened here, ignored by git or not listed yet' : changed ? `, ${file.type}` : ''}</span>
                        {unlisted && <span aria-hidden="true" title="Ignored by git" className="ml-auto shrink-0 font-mono text-[10px] font-semibold text-muted-foreground">I</span>}
                        {changed && (
                          <span aria-hidden="true" title={file.type} className={cn('ml-auto shrink-0 font-mono text-[10px] font-semibold',
                            file.type === 'added' || file.type === 'untracked' ? 'text-emerald-500'
                              : file.type === 'deleted' ? 'text-destructive'
                                : file.type === 'renamed' ? 'text-sky-400' : 'text-amber-500')}>
                            {file.type === 'added' || file.type === 'untracked' ? 'A' : file.type === 'deleted' ? 'D' : file.type === 'renamed' ? 'R' : 'M'}
                          </span>
                        )}
                      </span>
                    );
                  }}
                />
              ))}
            </div>
          );
        })}
        {listedMode === mode && searching && matchingFiles === 0 && (
          <div className="space-y-2 p-3 text-center text-xs text-muted-foreground">
            <p>No file matches &ldquo;{deferredQuery}&rdquo;{mode === 'changes' ? ' among the changes' : ''}.</p>
            {mode === 'changes' && <Button size="xs" variant="outline" onClick={() => setMode('files')}>Search all files</Button>}
          </div>
        )}
        {!searching && listedMode === mode && !loading && !listError && totalFiles === 0 && (
          <div className="space-y-2 p-3 text-center text-xs text-muted-foreground">
            <p>{mode === 'changes' ? 'No uncommitted changes.' : 'No files in these repositories.'}</p>
            {mode === 'changes' && <Button size="xs" variant="outline" onClick={() => setMode('files')}>Browse all files</Button>}
          </div>
        )}
      </div>
    </div>
  );

  const fileName = selection?.file.split('/').at(-1) ?? '';
  const fileFolder = selection ? selection.file.slice(0, selection.file.length - fileName.length) : '';

  return (
    <section ref={setSectionElement} aria-label="Workspace code" className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div role="toolbar" aria-label="Code" className="flex h-10 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-border px-1.5">
        <Button size="xs" variant={treeVisible ? 'secondary' : 'ghost'} className={iconButton} aria-label={treeVisible ? 'Hide the file tree' : 'Show the file tree'} aria-expanded={treeVisible}
          title={treeVisible ? 'Hide the file tree' : 'Show the file tree'} onClick={toggleTree}>
          <FolderTree className={cn('size-3.5', treeVisible && 'text-foreground')} />
        </Button>
        <div role="group" aria-label="Show" className="inline-flex h-7 items-center rounded-md bg-muted/60 p-0.5">
          <button type="button" aria-pressed={mode === 'changes'} onClick={() => switchMode('changes')}
            className={cn('inline-flex h-6 items-center gap-1 rounded px-2 text-xs', mode === 'changes' ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>
            Changes{changedFiles !== undefined && changedFiles > 0 ? <span className="tabular-nums text-muted-foreground">{changedFiles}</span> : null}
          </button>
          <button type="button" aria-pressed={mode === 'files'} onClick={() => switchMode('files')}
            className={cn('inline-flex h-6 items-center rounded px-2 text-xs', mode === 'files' ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>
            Files
          </button>
        </div>
        {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Refreshing" />}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="xs" variant={mainView === 'commit' ? 'secondary' : 'outline'} disabled={changedFiles === 0} aria-pressed={mainView === 'commit'}
            aria-label="Review & commit" title="Review the changes and commit them"
            onClick={() => { setFinishOpen(false); props.setShowCommitModal(!props.showCommitModal); }}>
            <GitCommitHorizontal className="size-3.5" />{compactToolbar ? 'Commit' : 'Review & commit'}
          </Button>
          {!compactToolbar && (
            <Button size="xs" variant={mainView === 'finish' ? 'secondary' : 'ghost'} aria-pressed={mainView === 'finish'}
              onClick={() => { props.setShowCommitModal(false); setFinishOpen((value) => !value); }}>
              Finish…
            </Button>
          )}
          <Menu>
            <MenuTrigger className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="More code actions" title="More code actions">
              <MoreHorizontal className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-60">
              {compactToolbar && (
                <MenuItem onClick={() => { props.setShowCommitModal(false); setFinishOpen((value) => !value); }}><Flag />Finish…</MenuItem>
              )}
              <MenuItem onClick={() => setRevision((value) => value + 1)}><RefreshCw />Refresh now</MenuItem>
              <MenuItem disabled={allSymbols.length === 0} onClick={() => setSymbolsOpen((value) => !value)}>
                <ListTree />Find a symbol in the changes{allSymbols.length ? ` (${allSymbols.length})` : ''}
              </MenuItem>
              {ws.mode !== 'in-place' && (
                <>
                  <MenuSeparator />
                  <MenuItem disabled={props.syncLoading} onClick={() => void props.handleSyncAll(workspace)}><ArrowDownUp />Sync with the base branches</MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
          {props.panelActions && <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />}
          {props.panelActions}
        </div>
      </div>

      {listError && (
        <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive">
          {listError} <button type="button" className="underline" onClick={() => setRevision((value) => value + 1)}>Retry</button>
        </p>
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1">
        {treeVisible && !treeAsDrawer && (
          <>
            <aside aria-label="Files" className={cn('flex min-h-0 flex-col bg-muted/10', narrow ? 'min-w-0 flex-1' : 'shrink-0 border-r border-border')} style={narrow ? undefined : { width: treeWidth }}>
              {tree}
            </aside>
            {!narrow && (
              <div
                role="separator" aria-label="Resize the file tree" aria-orientation="vertical" tabIndex={0}
                aria-valuenow={treeWidth} aria-valuemin={TREE_MIN_PX} aria-valuemax={TREE_MAX_PX}
                title="Drag to resize the file tree; double-click to reset"
                onPointerDown={startTreeDrag}
                onDoubleClick={() => setTreeWidthPx(TREE_DEFAULT_PX)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') { event.preventDefault(); setTreeWidthPx(treeWidth - 16); }
                  if (event.key === 'ArrowRight') { event.preventDefault(); setTreeWidthPx(treeWidth + 16); }
                }}
                className={cn('w-1.5 shrink-0 cursor-col-resize touch-none select-none transition-colors',
                  draggingTree ? 'bg-primary/60' : 'hover:bg-primary/40 focus-visible:bg-primary/50')}
              />
            )}
          </>
        )}
        {treeAsDrawer && drawerOpen && (
          <>
            <button type="button" aria-label="Close the file tree" className="absolute inset-0 z-20 bg-background/40 backdrop-blur-[1px]" onClick={() => setDrawerOpen(false)} />
            <aside aria-label="Files" className="absolute inset-y-0 left-0 z-30 flex w-[min(320px,88%)] flex-col border-r border-border bg-background shadow-2xl">
              {tree}
            </aside>
          </>
        )}

        {!(narrow && !treeAsDrawer) && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {notice && <ReferenceNotice notice={notice} editorLabel={editorLabel}
            onChoose={(candidate) => openFile(candidate, { line: notice.line, pinned: true })}
            onSearch={(text) => { setMode('files'); if (narrow) setDrawerOpen(true); else setTreeHidden(false); changeQuery(text); }}
            onOpenInEditor={(path) => openInVsCodeAtLine('', path, notice.line ?? 1, 1, defaultEditor)}
            onDismiss={() => setNotice(null)} />}
          {props.syncResults && ws.mode !== 'in-place' && (
            <ResultBanner title="Sync results" onDismiss={() => props.setSyncResults(null)}
              rows={props.syncResults.map((result) => ({ key: result.repoName, ok: result.success, text: result.success ? `Synced (${result.message})` : `Conflict: ${result.message}` }))} />
          )}
          {props.commitResults && (
            <ResultBanner title="Commit results" onDismiss={() => props.setCommitResults(null)}
              rows={props.commitResults.map((result) => ({
                key: result.repoName, ok: result.success,
                text: result.committed
                  ? `Committed ${result.filesChanged} file(s) (${result.commitHash ? result.commitHash.slice(0, 7) : 'no hash'}) on ${result.branch}${result.pushed ? ', pushed' : ', not pushed'}`
                  : `Error: ${result.message}`,
              }))} />
          )}
          {symbolsOpen && allSymbols.length > 0 && (
            <div className="max-h-[45%] shrink-0 overflow-auto border-b border-border p-2">
              <ChangesetSymbolNavigator
                symbols={allSymbols}
                activeFilePath={selection?.file}
                editorLabel={editorLabel}
                onSelectSymbol={(symbol: ChangesetSymbol) => { setSymbolsOpen(false); openDefinition(symbol.repoName, symbol.filePath, symbol.lineNumber); }}
                onOpenInVsCode={(symbol: ChangesetSymbol) => {
                  const repoPath = symbol.repoPath || repos.find((repo) => repo.repoName === symbol.repoName)?.repoPath || '';
                  openInVsCodeAtLine(repoPath, symbol.filePath, symbol.lineNumber, symbol.column, defaultEditor);
                }}
                onClose={() => setSymbolsOpen(false)}
              />
            </div>
          )}

          {mainView === 'commit' ? (
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <CommitReviewPanel ws={ws} message={props.commitMessage} setMessage={props.setCommitMessage}
                onClose={() => props.setShowCommitModal(false)}
                onCompleted={(results) => { props.setCommitResults(results); props.setShowCommitModal(false); }}
                onGitChanged={gitChanged} />
            </div>
          ) : mainView === 'finish' ? (
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <FinishPanel ws={ws} onClose={() => setFinishOpen(false)} onGitChanged={gitChanged} />
            </div>
          ) : !selection ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
              <FileCode className="size-8 opacity-35" aria-hidden="true" />
              <p className="text-xs">Choose a file to see its code and what changed.</p>
              <p className="text-[11px]">Paths in the chat open here. <kbd className="font-mono">Alt+↓</kbd> steps through files, <kbd className="font-mono">/</kbd> filters them.</p>
            </div>
          ) : (
            <>
              <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pl-2.5 pr-1">
                <p className="min-w-0 flex-1 truncate text-xs" title={`${selection.repoName}/${selection.file}`}>
                  <span className="text-muted-foreground">{repos.length > 1 ? `${selection.repoName}/` : ''}{fileFolder}</span>
                  <span className="font-medium text-foreground">{fileName}</span>
                  {selection.line ? <span className="text-muted-foreground">:{selection.line}</span> : null}
                </p>
                {ordered.length > 1 && (
                  <div className="flex shrink-0 items-center">
                    <Button size="xs" variant="ghost" className="size-6 p-0" disabled={currentIndex === 0} aria-label="Previous file" aria-keyshortcuts="Alt+ArrowUp" title="Previous file (Alt+↑)" onClick={() => step(-1)}>
                      <ChevronLeft className="size-3.5" />
                    </Button>
                    <span className="min-w-10 text-center text-[11px] tabular-nums text-muted-foreground">{currentIndex >= 0 ? currentIndex + 1 : '–'} / {ordered.length}</span>
                    <Button size="xs" variant="ghost" className="size-6 p-0" disabled={currentIndex === ordered.length - 1} aria-label="Next file" aria-keyshortcuts="Alt+ArrowDown" title="Next file (Alt+↓)" onClick={() => step(1)}>
                      <ChevronRight className="size-3.5" />
                    </Button>
                  </div>
                )}
                <Button size="xs" variant="ghost" className="size-6 p-0" title={`Open in ${editorLabel}`} aria-label={`Open in ${editorLabel}`}
                  onClick={() => openInVsCodeAtLine(selection.repoPath, selection.file, selection.line ?? 1, 1, defaultEditor)}>
                  <ExternalLink className="size-3.5" />
                </Button>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {diffError ? (
                  <p role="alert" className="p-3 text-xs text-destructive">
                    {diffError} <button type="button" className="underline" onClick={() => setRevision((value) => value + 1)}>Retry</button>
                  </p>
                ) : !shownDiff ? (
                  <p role="status" className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Opening {fileName}…</p>
                ) : (
                  <>
                    {fileNotice && <p role="note" className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">{fileNotice}</p>}
                    {shownDiff.diff && !shownDiff.diffOmitted ? (
                      <DiffErrorBoundary key={`${workspace}/${selection.repoName}/${selection.file}`} filePath={selection.file} fallbackContent={shownDiff.diff}>
                        <PluggableDiffViewer
                          filePath={selection.file}
                          repoName={selection.repoName}
                          repoPath={selection.repoPath}
                          patchText={shownDiff.diff}
                          fullFileContent={shownDiff.fileContent}
                          fullOriginalContent={shownDiff.originalContent}
                          preExtractedSymbols={shownDiff.symbols}
                          defaultEditor={defaultEditor}
                          viewMode={narrow ? 'unified' : cockpit.diffViewMode}
                          onToggleViewMode={cockpit.toggleDiffMode}
                          initialTargetLine={selection.line}
                          fillContainer
                          onOpenFile={openDefinition}
                          onSelectSymbol={(symbol) => openDefinition(symbol.repoName, symbol.filePath, symbol.lineNumber)}
                          onNextFile={currentIndex >= 0 && currentIndex < ordered.length - 1 ? () => step(1) : undefined}
                          onPrevFile={currentIndex > 0 ? () => step(-1) : undefined}
                          showToast={showToast}
                          onRequestRefine={async (hunk, feedback) => {
                            const prompt = [`Refine ${selection.repoName}/${selection.file} at line ${hunk.startLineModified}.`, feedback, 'Selected diff hunk:', hunk.patchHeader, ...hunk.lines].join('\n');
                            if (!await safeCopyToClipboard(prompt)) throw new Error('Could not copy the refinement request. Check clipboard permissions.');
                            floatingChatStore.openCli(workspace);
                            showToast?.('Refinement request copied. Paste it into the CLI chat.', 'success');
                          }}
                        />
                      </DiffErrorBoundary>
                    ) : shownDiff.fileContent ? (
                      <div className="min-h-0 flex-1">
                        <Suspense fallback={<p role="status" className="p-3 text-xs text-muted-foreground">Opening the viewer…</p>}>
                          <MonacoFileViewer filePath={selection.file} repoName={selection.repoName} repoPath={selection.repoPath}
                            content={shownDiff.fileContent} targetLine={selection.line} jumpKey={selection.jump} onOpenFile={openDefinition} />
                        </Suspense>
                      </div>
                    ) : !fileNotice ? (
                      <p className="p-3 text-xs text-muted-foreground">This file is empty.</p>
                    ) : null}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        )}
      </div>
    </section>
  );
}

function ResultBanner({ title, rows, onDismiss }: { title: string; rows: { key: string; ok: boolean; text: string }[]; onDismiss: () => void }) {
  return (
    <div role="status" className="shrink-0 border-b border-border bg-muted/20 px-3 py-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold">{title}</span>
        <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={onDismiss}>Dismiss</button>
      </div>
      <ul className="space-y-0.5 font-mono text-[11px]">
        {rows.map((row) => (
          <li key={row.key} className="flex justify-between gap-2">
            <span className="font-semibold">{row.key}</span>
            <span className={row.ok ? 'text-success-foreground' : 'text-destructive-foreground'}>{row.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReferenceNotice({ notice, editorLabel, onChoose, onSearch, onOpenInEditor, onDismiss }: {
  notice: Notice;
  editorLabel: string;
  onChoose: (candidate: RepoFile) => void;
  onSearch: (text: string) => void;
  onOpenInEditor: (absolutePath: string) => void;
  onDismiss: () => void;
}) {
  const name = notice.path.split('/').filter(Boolean).at(-1) ?? notice.path;
  const shown = `${notice.path}${notice.line ? `:${notice.line}` : ''}`;
  return (
    <div role={notice.kind === 'locating' ? 'status' : 'alert'} data-testid="code-reference-notice" className="shrink-0 border-b border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          {notice.kind === 'locating' && (
            <p className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Looking for <code className="font-mono text-foreground">{shown}</code>…</p>
          )}
          {notice.kind === 'ambiguous' && (
            <>
              <p><code className="font-mono">{shown}</code> matches {notice.candidates.length} files. Choose one:</p>
              <ul className="space-y-0.5">
                {notice.candidates.map((candidate) => (
                  <li key={`${candidate.repoName}/${candidate.file}`}>
                    <button type="button" className="w-full truncate rounded px-1.5 py-0.5 text-left font-mono hover:bg-accent" onClick={() => onChoose(candidate)}>
                      <span className="text-muted-foreground">{candidate.repoName}/</span>{candidate.file}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {notice.kind === 'not-found' && (
            <>
              <p>
                <code className="font-mono">{shown}</code>{' '}
                {notice.reason === 'directory' ? 'is a folder, not a file.'
                  : notice.reason === 'outside-repositories' ? "is outside this workspace's repositories."
                    : notice.reason === 'error' ? `could not be looked up: ${notice.message ?? 'unknown error'}.`
                      : "is not a file in this workspace's repositories."}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {notice.reason === 'outside-repositories' && notice.absolutePath
                  ? <Button size="xs" variant="outline" onClick={() => onOpenInEditor(notice.absolutePath!)}><ExternalLink className="size-3" />Open in {editorLabel}</Button>
                  : <Button size="xs" variant="outline" onClick={() => onSearch(notice.reason === 'directory' ? notice.path : name)}><Search className="size-3" />Find &ldquo;{notice.reason === 'directory' ? notice.path : name}&rdquo; in Files</Button>}
              </div>
            </>
          )}
        </div>
        {notice.kind !== 'locating' && (
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={onDismiss}><X className="size-3" /></button>
        )}
      </div>
    </div>
  );
}

