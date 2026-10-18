/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export interface TreeFile {
  file: string;
}

export interface TreeNode<T extends TreeFile = TreeFile> {
  name: string;
  path: string;
  directories: TreeNode<T>[];
  files: T[];
  compactedPaths?: string[];
}

interface MutableTreeNode<T> {
  name: string;
  path: string;
  directories: Map<string, MutableTreeNode<T>>;
  files: T[];
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(\.\/|\/)+/, '');
}

function toTreeNode<T extends TreeFile>(mutable: MutableTreeNode<T>): TreeNode<T> {
  const sortedDirKeys = [...mutable.directories.keys()].sort((a, b) => a.localeCompare(b));
  const directories = sortedDirKeys.map(key => toTreeNode(mutable.directories.get(key)!));
  const files = [...mutable.files].sort((a, b) =>
    normalizePath(a.file).localeCompare(normalizePath(b.file))
  );
  return {
    name: mutable.name,
    path: mutable.path,
    directories,
    files,
  };
}

function compactTreeNode<T extends TreeFile>(
  node: TreeNode<T>,
  isRoot: boolean,
  compact: boolean
): TreeNode<T> {
  node.directories = node.directories.map(child => compactTreeNode(child, false, compact));

  if (!compact || isRoot) {
    return node;
  }

  if (node.files.length === 0 && node.directories.length === 1) {
    const child = node.directories[0]!;
    const compactedPaths = [
      ...(node.compactedPaths ?? (node.path ? [node.path] : [])),
      ...(child.compactedPaths ?? (child.path ? [child.path] : [])),
    ];
    return {
      name: `${node.name}/${child.name}`,
      path: child.path,
      directories: child.directories,
      files: child.files,
      compactedPaths,
    };
  }

  return node;
}

/**
 * Builds a deterministic visual tree from a list of files.
 * Single-child directory chains are compacted into combined paths (e.g. "src/features")
 * unless options.compact is false.
 */
export function buildCompactedTree<T extends TreeFile>(
  files: readonly T[],
  options: { compact?: boolean } = { compact: true }
): TreeNode<T> {
  const root: MutableTreeNode<T> = {
    name: '',
    path: '',
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    if (!file || typeof file.file !== 'string') continue;
    const normalized = normalizePath(file.file);
    const parts = normalized.split('/').filter(part => part && part !== '.');

    if (parts.length <= 1) {
      root.files.push(file);
      continue;
    }

    let current = root;
    let currentPath = '';
    for (const segment of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let next = current.directories.get(segment);
      if (!next) {
        next = { name: segment, path: currentPath, directories: new Map(), files: [] };
        current.directories.set(segment, next);
      }
      current = next;
    }
    current.files.push(file);
  }

  const uncompacted = toTreeNode(root);
  return compactTreeNode(uncompacted, true, options.compact ?? true);
}

/**
 * Flattens a tree into files in the exact visual depth-first order they appear on screen:
 * subdirectories first (alphabetical by name), then directory files (alphabetical by path).
 */
export function flattenTreeFiles<T extends TreeFile>(root: TreeNode<T>): T[] {
  const result: T[] = [];
  const walk = (node: TreeNode<T>) => {
    for (const dir of node.directories) {
      walk(dir);
    }
    for (const file of node.files) {
      result.push(file);
    }
  };
  walk(root);
  return result;
}

/**
 * Returns files in deterministic visual tree order.
 */
export function treeOrderedFiles<T extends TreeFile>(
  files: readonly T[],
  options?: { compact?: boolean }
): T[] {
  return flattenTreeFiles(buildCompactedTree(files, options));
}

/**
 * Collects all directory paths present in the tree.
 */
export function getAllDirectoryPaths<T extends TreeFile>(root: TreeNode<T>): string[] {
  const result: string[] = [];
  const walk = (node: TreeNode<T>) => {
    for (const dir of node.directories) {
      result.push(dir.path);
      walk(dir);
    }
  };
  walk(root);
  return result;
}

/**
 * Returns all ancestor directory paths for a target file or path within the given tree.
 */
export function getAncestorPaths<T extends TreeFile>(
  root: TreeNode<T>,
  targetPath: string
): string[] {
  if (!targetPath) return [];
  const normalized = normalizePath(targetPath);
  const ancestors = new Set<string>();

  const walk = (node: TreeNode<T>): boolean => {
    let containsTarget = false;

    // Check if target directly matches this directory
    if (node.path && (normalized === node.path || normalized.startsWith(`${node.path}/`))) {
      ancestors.add(node.path);
      containsTarget = true;
    }
    if (node.compactedPaths) {
      for (const p of node.compactedPaths) {
        if (normalized === p || normalized.startsWith(`${p}/`)) {
          ancestors.add(node.path);
          containsTarget = true;
        }
      }
    }

    // Check files in this directory
    for (const file of node.files) {
      if (!file?.file) continue;
      const fNorm = normalizePath(file.file);
      if (fNorm === normalized || fNorm.startsWith(`${normalized}/`)) {
        containsTarget = true;
      }
    }

    // Check subdirectories
    for (const dir of node.directories) {
      if (walk(dir)) {
        containsTarget = true;
      }
    }

    if (containsTarget && node.path) {
      ancestors.add(node.path);
    }
    return containsTarget;
  };

  walk(root);
  return Array.from(ancestors);
}

/**
 * Case-insensitively filters a list of files by matching the search query
 * against their file path.
 * If query is empty or whitespace-only, returns all files.
 */
export function filterTreeFiles<T extends TreeFile>(
  files: readonly T[],
  query: string
): T[] {
  if (!query || !query.trim()) {
    return [...files];
  }
  const q = query.trim().toLowerCase();
  const normalizedQ = normalizePath(q);
  return files.filter(f => {
    if (!f || typeof f.file !== 'string') return false;
    const raw = f.file.toLowerCase();
    const normalized = normalizePath(f.file).toLowerCase();
    return raw.includes(q) || normalized.includes(q) || (normalizedQ ? normalized.includes(normalizedQ) : false);
  });
}

/**
 * Returns all directory paths containing matching files for a given search query,
 * based on the compacted visual tree hierarchy.
 */
export function getMatchingBranchPaths<T extends TreeFile>(
  files: readonly T[],
  query: string,
  options?: { compact?: boolean }
): Set<string> {
  if (!query || !query.trim()) {
    return new Set();
  }
  const matching = filterTreeFiles(files, query);
  if (matching.length === 0) {
    return new Set();
  }
  const tree = buildCompactedTree(matching, options);
  return new Set(getAllDirectoryPaths(tree));
}

export interface VisibleTreeRow<T extends TreeFile = TreeFile> {
  type: 'folder' | 'file';
  id: string;
  path: string;
  name: string;
  parentPath: string | null;
  isExpanded?: boolean;
  /** Depth (1 for top-level rows), position among siblings and number of siblings, as ARIA states them. */
  level: number;
  posinset: number;
  setsize: number;
  /** The file a file row stands for. */
  file?: T;
  compactedPaths?: string[];
}

/**
 * Returns all currently visible rows (folders and files) in visual tree order,
 * respecting the current folder expansion set.
 */
export function getVisibleTreeRows<T extends TreeFile>(
  root: TreeNode<T>,
  expandedPaths: Set<string>
): VisibleTreeRow<T>[] {
  const result: VisibleTreeRow<T>[] = [];

  const walk = (node: TreeNode<T>, parentPath: string | null, level: number) => {
    const setsize = node.directories.length + node.files.length;
    let posinset = 0;
    for (const dir of node.directories) {
      const isExpanded = expandedPaths.has(dir.path) || (dir.compactedPaths?.some((p) => expandedPaths.has(p)) ?? false);
      posinset += 1;
      result.push({
        type: 'folder',
        id: `dir:${dir.path}`,
        path: dir.path,
        name: dir.name,
        parentPath,
        isExpanded,
        level,
        posinset,
        setsize,
        compactedPaths: dir.compactedPaths,
      });
      if (isExpanded) walk(dir, dir.path, level + 1);
    }
    for (const file of node.files) {
      const norm = normalizePath(file.file);
      const fileName = norm.split('/').filter(Boolean).at(-1) ?? norm;
      posinset += 1;
      result.push({ type: 'file', id: `file:${norm}`, path: norm, name: fileName, parentPath, level, posinset, setsize, file });
    }
  };

  walk(root, null, 1);
  return result;
}

export type TreeNavAction =
  | { type: 'focus'; targetRow: VisibleTreeRow<TreeFile> }
  | { type: 'toggle'; path: string }
  | { type: 'activate'; path: string }
  | { type: 'none' };

/**
 * Computes the next navigation action (focus, toggle, activate, or none) for a keyboard event
 * within a WAI-ARIA Treeview based on current active row and visible rows.
 */
export function computeTreeKeyNavigation(
  key: string,
  currentRow: VisibleTreeRow<TreeFile> | undefined,
  visibleRows: readonly VisibleTreeRow<TreeFile>[]
): TreeNavAction {
  if (!currentRow || visibleRows.length === 0) {
    return { type: 'none' };
  }

  const currentIndex = visibleRows.findIndex(r => r.id === currentRow.id);
  if (currentIndex === -1) {
    return { type: 'none' };
  }

  switch (key) {
    case 'ArrowDown': {
      if (currentIndex < visibleRows.length - 1) {
        return { type: 'focus', targetRow: visibleRows[currentIndex + 1]! };
      }
      return { type: 'none' };
    }
    case 'ArrowUp': {
      if (currentIndex > 0) {
        return { type: 'focus', targetRow: visibleRows[currentIndex - 1]! };
      }
      return { type: 'none' };
    }
    case 'ArrowRight': {
      if (currentRow.type === 'folder') {
        if (!currentRow.isExpanded) {
          return { type: 'toggle', path: currentRow.path };
        }
        const nextRow = visibleRows[currentIndex + 1];
        if (nextRow && nextRow.parentPath === currentRow.path) {
          return { type: 'focus', targetRow: nextRow };
        }
      }
      return { type: 'none' };
    }
    case 'ArrowLeft': {
      if (currentRow.type === 'folder' && currentRow.isExpanded) {
        return { type: 'toggle', path: currentRow.path };
      }
      if (currentRow.parentPath) {
        const parentRow = visibleRows.find(r => r.type === 'folder' && r.path === currentRow.parentPath);
        if (parentRow) {
          return { type: 'focus', targetRow: parentRow };
        }
      }
      return { type: 'none' };
    }
    case 'Home': {
      return { type: 'focus', targetRow: visibleRows[0]! };
    }
    case 'End': {
      return { type: 'focus', targetRow: visibleRows[visibleRows.length - 1]! };
    }
    case 'Enter':
    case ' ': {
      if (currentRow.type === 'folder') {
        return { type: 'toggle', path: currentRow.path };
      }
      return { type: 'activate', path: currentRow.path };
    }
    default:
      return { type: 'none' };
  }
}

/** How long typed letters keep adding to one type-ahead search, as in a native tree. */
const TYPE_AHEAD_MS = 600;

export interface FileTreeProps<T extends TreeFile> {
  files: readonly T[];
  /** The tree of `files`, when the caller already built it (it is the same as `buildCompactedTree(files, { compact })`). */
  root?: TreeNode<T>;
  label: string;
  /** What a file row shows. The tree owns focus, selection and activation; this only draws the row. */
  renderFile: (file: T, meta: { selected: boolean }) => ReactNode;
  /** A file row was clicked, or chosen with Enter or Space. */
  onActivateFile?: (file: T) => void;
  selectedPath?: string;
  /** Opens the folders above this path and scrolls it into view, once per `revealKey`. */
  revealPath?: string;
  revealKey?: number;
  compact?: boolean;
  /** Uncontrolled only: whether folders start open. Folders that appear later follow the same default. */
  defaultExpanded?: boolean;
  expandedPaths?: Set<string>;
  onExpandedPathsChange?: (paths: Set<string>) => void;
}

/**
 * A WAI-ARIA tree of files. Rows are rendered flat, each stating its level, so the list stays
 * cheap and keyboard order is plain list order. Focus sits on the row itself (one tab stop for
 * the whole tree, arrows move it, Enter or Space activates, letters jump to a matching name), and
 * the row content is drawn by the caller without controls of its own.
 *
 * Keep the original Git path intact: the hierarchy is only a presentation.
 */
export function FileTree<T extends TreeFile>({
  files,
  root: prebuiltRoot,
  label,
  renderFile,
  onActivateFile,
  selectedPath,
  revealPath,
  revealKey,
  compact = true,
  defaultExpanded = true,
  expandedPaths: controlledExpandedPaths,
  onExpandedPathsChange,
}: FileTreeProps<T>) {
  const list = useRef<HTMLUListElement>(null);
  const builtRoot = useMemo(() => (prebuiltRoot ? null : buildCompactedTree(files, { compact })), [prebuiltRoot, files, compact]);
  const root = prebuiltRoot ?? builtRoot!;
  const allPaths = useMemo(() => getAllDirectoryPaths(root), [root]);
  const target = revealPath ?? selectedPath;

  const [internalExpandedPaths, setInternalExpandedPaths] = useState<Set<string>>(() => {
    const initial = defaultExpanded ? new Set(allPaths) : new Set<string>();
    if (target) for (const ancestor of getAncestorPaths(root, target)) initial.add(ancestor);
    return initial;
  });
  // Uncontrolled: a folder that appears later follows the default; one the user toggled keeps its state.
  const knownPaths = useRef(new Set(allPaths));
  useEffect(() => {
    const added = allPaths.filter((path) => !knownPaths.current.has(path));
    knownPaths.current = new Set(allPaths);
    if (controlledExpandedPaths === undefined && defaultExpanded && added.length > 0) {
      setInternalExpandedPaths((previous) => new Set([...previous, ...added]));
    }
  }, [allPaths, controlledExpandedPaths, defaultExpanded]);

  const expandedPaths = controlledExpandedPaths ?? internalExpandedPaths;
  const setExpandedPaths = useCallback((next: Set<string>) => {
    if (controlledExpandedPaths === undefined) setInternalExpandedPaths(next);
    onExpandedPathsChange?.(next);
  }, [controlledExpandedPaths, onExpandedPathsChange]);

  const toggle = (path: string, compactedPaths?: string[]) => {
    const next = new Set(expandedPaths);
    const allPaths = compactedPaths && compactedPaths.length > 0 ? [path, ...compactedPaths] : [path];
    const anyExpanded = allPaths.some((p) => next.has(p));
    if (anyExpanded) {
      for (const p of allPaths) next.delete(p);
    } else {
      for (const p of allPaths) next.add(p);
    }
    setExpandedPaths(next);
  };

  const rows = useMemo(() => getVisibleTreeRows(root, expandedPaths), [root, expandedPaths]);
  const rowIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const selectedId = selectedPath ? `file:${normalizePath(selectedPath)}` : null;

  // A reveal opens the folders above its file and scrolls the file into view, once. A refresh of the
  // listing or a folder the user toggles never scrolls or reopens anything.
  const pendingReveal = useRef<{ id: string; path: string; expanded: boolean } | null>(null);
  useEffect(() => {
    pendingReveal.current = target ? { id: `file:${normalizePath(target)}`, path: target, expanded: false } : null;
  }, [target, revealKey]);
  useEffect(() => {
    const pending = pendingReveal.current;
    if (!pending) return;
    if (rowIds.has(pending.id)) {
      pendingReveal.current = null;
      rowElement(list.current, pending.id)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (pending.expanded) return;
    const missing = getAncestorPaths(root, pending.path).filter((path) => !expandedPaths.has(path));
    if (missing.length === 0) return;
    // Asked once per reveal: a parent that keeps its own folder state may decline, and must not be asked forever.
    pending.expanded = true;
    setExpandedPaths(new Set([...expandedPaths, ...missing]));
  }, [rowIds, root, expandedPaths, setExpandedPaths]);

  // Roving tab stop: the row last focused, else the selected file, else the first row.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const activeId = focusedId && rowIds.has(focusedId)
    ? focusedId
    : selectedId && rowIds.has(selectedId) ? selectedId : rows[0]?.id ?? null;

  const focusRow = (row: VisibleTreeRow<T>) => {
    setFocusedId(row.id);
    rowElement(list.current, row.id)?.focus();
  };

  const activate = (row: VisibleTreeRow<T>) => {
    if (row.type === 'folder') toggle(row.path, row.compactedPaths);
    else if (row.file) onActivateFile?.(row.file);
  };

  const typeAhead = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    // Only keys pressed on a row of this tree; anything inside a row keeps its own keys.
    const element = event.target as HTMLElement;
    if (element.getAttribute('role') !== 'treeitem' || element.closest('[role="tree"]') !== list.current) return;
    const current = rows.find((row) => row.id === element.dataset.rowId);
    if (!current) return;

    // `/` is left alone: it is the filter's shortcut.
    if (event.key.length === 1 && /\S/.test(event.key) && event.key !== '/') {
      const now = Date.now();
      const text = (now - typeAhead.current.at < TYPE_AHEAD_MS ? typeAhead.current.text : '') + event.key.toLowerCase();
      typeAhead.current = { text, at: now };
      const start = rows.indexOf(current);
      const ordered = [...rows.slice(start + (text.length === 1 ? 1 : 0)), ...rows.slice(0, start + (text.length === 1 ? 1 : 0))];
      const match = ordered.find((row) => row.name.toLowerCase().startsWith(text));
      if (match) {
        event.preventDefault();
        focusRow(match);
      }
      return;
    }

    const action = computeTreeKeyNavigation(event.key, current, rows);
    if (action.type === 'none') return;
    event.preventDefault();
    if (action.type === 'focus') focusRow(action.targetRow as VisibleTreeRow<T>);
    else if (action.type === 'toggle') {
      const targetRow = rows.find((r) => r.path === action.path);
      toggle(action.path, targetRow?.compactedPaths);
    } else activate(current);
  };

  return (
    <ul ref={list} role="tree" aria-label={label} className="min-w-0" onKeyDown={onKeyDown}>
      {rows.map((row) => {
        const selected = row.id === selectedId;
        return (
          <li
            key={row.id}
            role="treeitem"
            data-row-id={row.id}
            data-tree-row={row.type}
            data-path={row.type === 'folder' ? row.path : undefined}
            data-file-path={row.type === 'file' ? row.path : undefined}
            aria-level={row.level}
            aria-posinset={row.posinset}
            aria-setsize={row.setsize}
            aria-expanded={row.type === 'folder' ? Boolean(row.isExpanded) : undefined}
            aria-selected={row.type === 'file' ? selected : undefined}
            tabIndex={row.id === activeId ? 0 : -1}
            title={row.type === 'folder' ? row.path : undefined}
            onFocus={() => setFocusedId(row.id)}
            onClick={() => activate(row)}
            className={cn(
              'tree-row flex min-w-0 cursor-pointer select-none items-stretch rounded pr-1 text-xs outline-none',
              'hover:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
              selected && 'bg-accent font-medium text-foreground',
            )}
          >
            {/* One guide per level above the row: the tree reads as a tree at 12px per level. */}
            {Array.from({ length: row.level - 1 }, (_, index) => (
              <span key={index} aria-hidden="true" className="ml-[9px] w-[3px] shrink-0 border-l border-border/70" />
            ))}
            {row.type === 'folder' ? (
              <span className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1">
                <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', row.isExpanded && 'rotate-90')} aria-hidden="true" />
                {row.isExpanded
                  ? <FolderOpen className="size-3.5 shrink-0 text-warning-foreground" aria-hidden="true" />
                  : <Folder className="size-3.5 shrink-0 text-warning-foreground/80" aria-hidden="true" />}
                <span className="truncate">{row.name}</span>
              </span>
            ) : (
              <span className="flex min-w-0 flex-1 items-center">{renderFile(row.file!, { selected })}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function rowElement(list: HTMLElement | null, id: string): HTMLElement | null {
  if (!list) return null;
  for (const element of list.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
    if (element.dataset.rowId === id) return element;
  }
  return null;
}
