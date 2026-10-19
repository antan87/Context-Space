import { useMemo, useState } from 'react';
import { FolderOpen, GitBranch, Plus, Search } from 'lucide-react';
import type { RepoInfo } from '../types.js';
import { Input } from './ui/input.js';
import { Button } from './ui/button.js';
import { Popover, PopoverTrigger, PopoverPopup } from './ui/popover.js';
import { desktopFolderPicker } from '../features/setup/setupApi.js';

/** The content inside the AddRepo popover menu. */
export function AddRepoPopupContent({
  repos,
  query,
  setQuery,
  onAdd,
  onClose,
}: {
  repos: RepoInfo[];
  query: string;
  setQuery: (q: string) => void;
  onAdd: (repoPath: string) => void;
  onClose?: () => void;
}) {
  const pick = desktopFolderPicker();
  const trimmedQuery = query.trim();

  const filtered = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  }, [repos, trimmedQuery]);

  const exactMatchRepo = useMemo(() => {
    if (!trimmedQuery) return null;
    const lower = trimmedQuery.toLowerCase();
    return repos.find((r) => r.path.toLowerCase() === lower || r.name.toLowerCase() === lower) ?? null;
  }, [repos, trimmedQuery]);

  const hasExactMatch = exactMatchRepo !== null;
  const showCustomOption = trimmedQuery.length > 0 && !hasExactMatch;

  return (
    <>
      <div className="border-b border-border p-2 space-y-2">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none z-10" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or enter repo path"
            className="pl-8 text-xs h-8"
            aria-label="Search repositories or enter path"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (showCustomOption) {
                  e.preventDefault();
                  onClose?.();
                  onAdd(trimmedQuery);
                } else if (filtered.length === 1) {
                  e.preventDefault();
                  onClose?.();
                  onAdd(filtered[0].path);
                } else if (exactMatchRepo) {
                  e.preventDefault();
                  onClose?.();
                  onAdd(exactMatchRepo.path);
                }
              }
            }}
          />
        </div>
        {pick && (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={async () => {
                const chosen = await pick();
                if (chosen) {
                  onClose?.();
                  onAdd(chosen);
                }
              }}
              className="h-6 text-[11px] gap-1 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <FolderOpen size={12} />
              <span>Browse folder…</span>
            </Button>
          </div>
        )}
      </div>

      <div role="listbox" className="max-h-64 overflow-y-auto py-1 divide-y divide-border/30">
        {showCustomOption && (
          <button
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => {
              onClose?.();
              onAdd(trimmedQuery);
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent text-primary bg-primary/5 font-medium text-xs"
          >
            <GitBranch size={14} className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">
              Add repository at <span className="font-mono font-semibold">"{trimmedQuery}"</span>
            </span>
          </button>
        )}

        {filtered.length === 0 && !showCustomOption ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            {repos.length === 0
              ? 'No repositories scanned. Type a path above or browse to attach a repo.'
              : 'No repositories found.'}
          </div>
        ) : (
          filtered.map((r) => (
            <button
              key={r.path}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                onClose?.();
                onAdd(r.path);
              }}
              className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.name}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{r.path}</span>
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.defaultBranch}</span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

/** A searchable popover for attaching another repository to a workspace. */
export function AddRepoPicker({
  repos,
  disabled,
  onAdd,
}: {
  repos: RepoInfo[];
  disabled?: boolean;
  onAdd: (repoPath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  return (
    <Popover
      open={open}
      onOpenChange={(isOpen) => {
        if (isOpen) setQuery('');
        setOpen(isOpen);
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" disabled={disabled} className="h-8 text-xs text-muted-foreground gap-1.5 cursor-pointer">
            <Plus size={14} /> Add repository
          </Button>
        }
      />

      <PopoverPopup align="end" className="w-[340px]" viewportClassName="p-0">
        <AddRepoPopupContent
          repos={repos}
          query={query}
          setQuery={setQuery}
          onAdd={onAdd}
          onClose={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}
