import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/button.js';
import { API_BASE } from '../../lib/apiBase.js';
import { requestDocumentViewLink, type DocumentViewLinkResult } from './boardActions.js';

export interface ReaderPageProps {
  workspaceId: string;
  path: string;
  raw: boolean;
  repo?: string;
  onViewUrlReady?: (url: string) => void;
}

/**
 * Renders an HTML document inside the quiet reader using a read-only /view/<token>/<path> streaming link.
 * In rendered mode, the page loads in a sandboxed iframe with relative assets, scripts, and Escape relay enabled.
 * In raw mode, the unrendered HTML source is loaded and displayed in a code block without the 1 MB preview limit.
 */
export function ReaderPage({ workspaceId, path, raw, repo, onViewUrlReady }: ReaderPageProps) {
  const viewLinkQuery = useQuery<DocumentViewLinkResult, Error>({
    queryKey: ['document-view-link', workspaceId, repo, path],
    queryFn: ({ signal }) => requestDocumentViewLink(workspaceId, path, signal, repo),
    retry: 1,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const viewUrl = viewLinkQuery.data?.url ?? null;
  const absoluteViewUrl = viewUrl ? `${API_BASE}${viewUrl}` : null;

  useEffect(() => {
    if (absoluteViewUrl && onViewUrlReady) {
      onViewUrlReady(absoluteViewUrl);
    }
  }, [absoluteViewUrl, onViewUrlReady]);

  const rawTextQuery = useQuery<string, Error>({
    queryKey: ['document-raw-text', absoluteViewUrl],
    queryFn: async ({ signal }) => {
      const res = await fetch(absoluteViewUrl!, { signal });
      if (!res.ok) throw new Error(`Could not load document source (${res.status}).`);
      return res.text();
    },
    enabled: Boolean(raw && absoluteViewUrl),
    retry: 1,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (viewLinkQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p role="status" className="text-sm text-muted-foreground">Opening document…</p>
      </div>
    );
  }

  if (viewLinkQuery.isError || !viewLinkQuery.data) {
    const errorMsg = viewLinkQuery.error?.message || 'Unable to open document.';
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <p role="alert" className="text-sm text-destructive">{errorMsg}</p>
        <Button size="sm" variant="outline" onClick={() => void viewLinkQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (raw) {
    if (rawTextQuery.isPending) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <p role="status" className="text-sm text-muted-foreground">Loading source…</p>
        </div>
      );
    }

    if (rawTextQuery.isError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
          <p role="alert" className="text-sm text-destructive">
            {rawTextQuery.error?.message || 'Could not load source.'}
          </p>
          <Button size="sm" variant="outline" onClick={() => void rawTextQuery.refetch()}>
            Retry
          </Button>
        </div>
      );
    }

    return (
      <pre className="size-full overflow-auto bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words">
        {rawTextQuery.data}
      </pre>
    );
  }

  return (
    <iframe
      title={`Preview of ${path}`}
      src={`${absoluteViewUrl}?frame=1`}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      referrerPolicy="no-referrer"
      className="size-full border-0 bg-white"
    />
  );
}
