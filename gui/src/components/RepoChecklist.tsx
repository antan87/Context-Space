import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import { Input } from './ui/input.js';
import { Checkbox } from './ui/checkbox.js';
import { StatusBadge } from './ui/status-badge.js';
import { cn } from '../lib/utils.js';
import type { RepoInfo, RepoFreshness } from '../types.js';

interface RepoChecklistProps {
  repos: RepoInfo[];
  selectedPaths: string[];
  onToggle: (repo: RepoInfo) => void;
  loading?: boolean;
  emptyHint?: string;
  className?: string;
  freshnessMap?: Record<string, RepoFreshness>;
  /** Put the keyboard cursor in the filter when the list appears, so choosing starts at once. */
  autoFocusFilter?: boolean;
}

/**
 * Searchable checkbox list of scanned repositories, shared by the project
 * dialog and the ad-hoc start-work flow.
 */
export function RepoChecklist({
  repos,
  selectedPaths,
  onToggle,
  loading,
  emptyHint,
  className,
  freshnessMap,
  autoFocusFilter,
}: RepoChecklistProps) {
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  }, [repos, search]);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none z-10" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter repositories…"
          className="pl-8"
          aria-label="Filter repositories"
          autoFocus={autoFocusFilter}
        />
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
        {loading ? (
          <p className="p-3 text-sm text-muted-foreground">Scanning for repositories…</p>
        ) : visible.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{emptyHint ?? 'No repositories found.'}</p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((repo) => {
              const checked = selectedPaths.includes(repo.path);
              const freshness = freshnessMap?.[repo.path];
              return (
                <li key={repo.path}>
                  <label className={cn('flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent', checked && 'bg-primary/5')}>
                    <Checkbox checked={checked} onCheckedChange={() => onToggle(repo)} aria-label={repo.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{repo.name}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">{repo.path}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {freshness && (
                        <StatusBadge
                          tone={
                            freshness.status === 'up-to-date'
                              ? 'success'
                              : freshness.status === 'behind'
                                ? 'warning'
                                : freshness.status === 'diverged'
                                  ? 'danger'
                                  : freshness.status === 'ahead'
                                    ? 'info'
                                    : 'neutral'
                          }
                          title={freshness.message}
                        >
                          {freshness.status === 'behind'
                            ? `↓ ${freshness.behind} behind`
                            : freshness.status === 'up-to-date'
                              ? 'Up to date'
                              : freshness.status === 'diverged'
                                ? 'Diverged'
                                : freshness.status === 'ahead'
                                  ? `↑ ${freshness.ahead} ahead`
                                  : 'Local'}
                        </StatusBadge>
                      )}
                      <span className="font-mono text-xs text-muted-foreground">{repo.defaultBranch}</span>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
