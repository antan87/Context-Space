import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, FolderGit2, Search, X } from 'lucide-react';
import type { Feature } from '../types.js';
import { jumpTargets } from './workspaceList.js';

/** Native dialog supplies focus containment, Escape, and focus restoration. */
export function QuickSwitch({ workspaces }: { workspaces: Feature[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const actions = [
    { title: 'New workspace', detail: 'Start a task with your repos', route: '/new' },
    { title: 'Overview', detail: 'Your workspace home', route: '/overview' },
    ...jumpTargets(workspaces),
    { title: 'Projects', detail: 'Manage repositories', route: '/projects' },
    { title: 'Workrooms', detail: 'Collaborate with your team', route: '/workrooms' },
    { title: 'Skills & agents', detail: 'Assistant instructions', route: '/skills' },
    { title: 'Settings', detail: 'Make this space yours', route: '/settings' },
  ].filter((a) => `${a.title} ${a.detail}`.toLowerCase().includes(query.trim().toLowerCase()));
  const current = Math.min(active, Math.max(actions.length - 1, 0));
  function open() {
    setQuery('');
    setActive(0);
    dialog.current?.showModal();
    input.current?.focus();
  }
  function choose(route: string) {
    dialog.current?.close();
    navigate(route);
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (dialog.current?.open) document.getElementById(`quick-result-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return <>
    <button type="button" onClick={open} className="mx-2.5 my-2 flex h-9 items-center gap-2 rounded-lg border border-input bg-background/60 px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground" aria-label="Search and jump to a workspace" aria-keyshortcuts="Control+k Meta+k"><Search size={14} /><span>Jump to…</span><kbd className="ml-auto rounded border border-border px-1 text-[10px]">⌘ / Ctrl K</kbd></button>
    <dialog ref={dialog} aria-labelledby="quick-switch-title" className="context-switch m-auto w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-border bg-popover p-0 text-popover-foreground shadow-2xl" onClick={(e) => { if (e.target === dialog.current) { const box = e.currentTarget.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) dialog.current.close(); } }}>
      <h2 id="quick-switch-title" className="sr-only">Jump to a workspace or page</h2>
      <div className="flex items-center gap-3 border-b border-border px-5 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-inset has-[input:focus-visible]:ring-ring"><Search size={18} className="text-primary" /><input ref={input} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(actions.length ? (current + (e.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length : 0); }
        if (e.key === 'Enter' && actions[current]) { e.preventDefault(); choose(actions[current].route); }
      }} role="combobox" aria-expanded="true" aria-controls="quick-results" aria-autocomplete="list" aria-activedescendant={actions[current] ? `quick-result-${current}` : undefined} aria-label="Search pages and workspaces" placeholder="Where do you want to go?" className="h-16 min-w-0 flex-1 bg-transparent text-sm outline-none" /><button onClick={() => dialog.current?.close()} aria-label="Close search" className="rounded p-1 text-muted-foreground hover:bg-accent"><X size={17} /></button></div>
      <div id="quick-results" role="listbox" aria-label="Destinations" className="max-h-[min(400px,60vh)] overflow-y-auto p-2">{actions.map((action, i) => <div key={action.route} id={`quick-result-${i}`} role="option" aria-selected={i === current} onMouseMove={() => setActive(i)} onClick={() => choose(action.route)} className={`flex cursor-pointer items-center gap-3 rounded-lg p-3 ${i === current ? 'bg-accent text-accent-foreground' : ''}`}><FolderGit2 size={17} className="shrink-0 text-primary" /><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{action.title}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{action.detail}</div></div><ArrowRight size={14} /></div>)}{!actions.length && <p className="p-8 text-center text-sm text-muted-foreground">No results. Try a workspace name or “Settings”.</p>}</div>
      <div className="border-t border-border px-5 py-3 text-[10px] text-muted-foreground">↑ ↓ to navigate · Enter to open · Esc to close</div>
    </dialog>
  </>;
}
