import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, FileText } from 'lucide-react';
import { apiFetch } from '../../lib/api/client.js';
import { cn } from '../../lib/utils.js';
import { Spinner } from '../../components/ui/spinner.js';

interface ResourcePreviewItem {
  kind: 'skill' | 'agent';
  id: string;
  title: string;
  description: string;
  files: string[];
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const pluralCategories = (count: number) => `${count} ${count === 1 ? 'category' : 'categories'}`;

/**
 * Before creating a workspace, shows every file the chosen skills and agents
 * will add and where, described by what each one does — so a first task needs
 * no knowledge of how resources are organised.
 *
 * The listing can be long, so it stays collapsed behind a one-line summary and
 * never crowds the Create workspace button.
 */
export function ResourcePreview({ skills, categories, exceptions = [], agents, assistants, tagCount }: { skills: string[]; categories: string[]; exceptions?: string[]; agents: string[]; assistants: string[]; tagCount: number }) {
  const [open, setOpen] = useState(false);
  const selection = { skills: [...skills].sort(), categories: [...categories].sort(), disabledSkills: [...exceptions].sort(), agents: [...agents].sort(), assistants: [...assistants].sort() };
  const preview = useQuery({
    queryKey: ['resource-preview', selection],
    queryFn: async ({ signal }) => (await apiFetch<{ resources: ResourcePreviewItem[] }>('/api/resources/preview', {
      signal,
      method: 'POST',
      body: JSON.stringify(selection),
    })).resources,
    enabled: skills.length + categories.length + agents.length > 0,
  });

  if (skills.length + categories.length + agents.length === 0 && tagCount === 0) {
    return <p className="text-xs text-muted-foreground">No skills or agents selected: the workspace gets only its generated assistant context.</p>;
  }

  // A category brings in skills of its own, so once the server has worked them out they are what is counted.
  const skillCount = preview.data ? preview.data.filter((item) => item.kind === 'skill').length : skills.length;
  const counts = [
    skillCount > 0 ? plural(skillCount, 'skill') : null,
    categories.length > 0 ? pluralCategories(categories.length) : null,
    agents.length > 0 ? plural(agents.length, 'agent') : null,
    skills.length + categories.length + agents.length === 0 ? plural(tagCount, 'tag') : null,
  ].filter(Boolean).join(', ');
  const fileCount = preview.data?.reduce((total, item) => total + item.files.length, 0);
  const summary = preview.isLoading ? `${counts} · working out the files…` : fileCount === undefined ? counts : `${counts} · ${plural(fileCount, 'file')}`;
  const detailsId = 'resource-preview-details';

  return (
    <section aria-labelledby="resource-preview-heading" className="rounded-lg border border-border">
      <h3 id="resource-preview-heading" className="text-sm font-medium">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left"
        >
          <span>What this adds to the workspace</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
            {preview.isLoading && <Spinner aria-hidden="true" role="presentation" className="size-3" />}
            <span className="truncate">{summary}</span>
            <ChevronDown aria-hidden="true" className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
          </span>
        </button>
      </h3>
      {preview.isError && <p role="alert" className="px-3 pb-2 text-xs text-destructive">{preview.error instanceof Error ? preview.error.message : 'The preview is unavailable.'} Creating the workspace still checks every selection.</p>}
      <div id={detailsId} hidden={!open} className="max-h-64 overflow-y-auto border-t border-border px-3 py-2">
        {open && (<>
          {tagCount > 0 && <p className="mb-2 text-xs text-muted-foreground">Category tags can add more skills when the workspace is created.</p>}
          {preview.data && (
            <ul className="space-y-2">
              {preview.data.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="text-xs">
                  <p><span className="font-medium text-foreground">{item.title}</span> <span className="text-muted-foreground">— {item.kind === 'skill' ? 'skill' : 'Codex agent'}{item.description ? `: ${item.description}` : ''}</span></p>
                  {item.files.length ? (
                    <ul className="mt-1 space-y-0.5 pl-4">
                      {item.files.map((file) => <li key={file} className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><FileText aria-hidden="true" size={11} />{file}</li>)}
                    </ul>
                  ) : <p className="mt-1 pl-4 text-muted-foreground">No files for the selected assistants.</p>}
                </li>
              ))}
            </ul>
          )}
        </>)}
      </div>
    </section>
  );
}
