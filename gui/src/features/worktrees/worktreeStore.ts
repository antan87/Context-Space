/**
 * State store for active worktree navigation, whether the full sidebar is docked, and metadata overrides.
 * File: gui/src/features/worktrees/worktreeStore.ts
 */
import { useState, useCallback, useEffect } from 'react';
import type { WorktreeDescriptor } from './types.js';

// The sidebar is the slim rail unless the person pinned the full list open. Only the pinned choice is stored (absent
// means the rail), and the old `ctxspace_sidebar_collapsed` is no longer read: it meant the opposite default.
const STORAGE_KEY_DOCKED = 'ctxspace_sidebar_docked_v1';
const STORAGE_KEY_TITLES = 'ctxspace_worktree_titles';

export interface WorktreeTitleOverride {
  title: string;
  intent?: string;
}

export function loadSavedTitles(): Record<string, WorktreeTitleOverride> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TITLES);
    return raw ? (JSON.parse(raw) as Record<string, WorktreeTitleOverride>) : {};
  } catch {
    return {};
  }
}

export function saveWorktreeTitle(worktreeId: string, title: string, intent?: string): void {
  try {
    const current = loadSavedTitles();
    current[worktreeId] = { title, intent };
    localStorage.setItem(STORAGE_KEY_TITLES, JSON.stringify(current));
  } catch (err) {
    void err;
  }
}

export function useWorktreeNavigationState() {
  const [isDocked, setIsDocked] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_DOCKED) === 'true';
    } catch {
      return false;
    }
  });

  const [expandedRepos, setExpandedRepos] = useState<Record<string, boolean>>({});
  const [searchFilter, setSearchFilter] = useState('');
  const [editingWorktree, setEditingWorktree] = useState<WorktreeDescriptor | null>(null);
  const [customTitles, setCustomTitles] = useState<Record<string, WorktreeTitleOverride>>(() => loadSavedTitles());

  // Listen for storage updates across tabs/windows
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_TITLES && e.newValue) {
        try {
          setCustomTitles(JSON.parse(e.newValue) as Record<string, WorktreeTitleOverride>);
        } catch (err) {
          void err;
        }
      } else if (e.key === STORAGE_KEY_DOCKED) {
        setIsDocked(e.newValue === 'true');
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setDocked = useCallback((docked: boolean) => {
    setIsDocked(docked);
    try {
      if (docked) localStorage.setItem(STORAGE_KEY_DOCKED, 'true');
      else localStorage.removeItem(STORAGE_KEY_DOCKED);
    } catch (err) {
      void err;
    }
  }, []);

  const toggleRepo = useCallback((repoName: string) => {
    setExpandedRepos((prev) => ({
      ...prev,
      [repoName]: !(prev[repoName] ?? true),
    }));
  }, []);

  const updateTitle = useCallback((worktreeId: string, title: string, intent?: string) => {
    saveWorktreeTitle(worktreeId, title, intent);
    setCustomTitles((prev) => ({
      ...prev,
      [worktreeId]: { title, intent },
    }));
  }, []);

  return {
    isDocked,
    setDocked,
    expandedRepos,
    toggleRepo,
    searchFilter,
    setSearchFilter,
    editingWorktree,
    setEditingWorktree,
    customTitles,
    updateTitle,
  };
}
