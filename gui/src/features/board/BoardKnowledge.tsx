import { Button } from '../../components/ui/button.js';
import { KnowledgeView } from '../knowledge/KnowledgeView.js';
import { useKnowledge } from '../knowledge/useKnowledge.js';

/**
 * What the Board reader draws for Knowledge: the workspace's decisions and gotchas (KnowledgeView), read only. It scrolls on its
 * own, so an entry can be brought into view. A file with no entries is shown as written; one that does not exist says so, and a
 * file that could not be read says that, with a way to try again. A read again (the news says something changed) keeps the
 * scroll, the search and the filter: the text is only swapped under them.
 */
export function BoardKnowledge({ workspaceId, entry, request }: { workspaceId: string; entry?: string; request: number }) {
  const knowledge = useKnowledge(workspaceId);
  const content = knowledge.data;
  return (
    <div data-knowledge-scroll="" data-testid="board-knowledge" className="h-full overflow-y-auto px-4 py-3">
      {content === undefined
        ? knowledge.isError
          ? (
            <p role="alert" className="text-sm text-destructive">
              {knowledge.error instanceof Error ? knowledge.error.message : 'Unable to read the knowledge.'}{' '}
              <Button size="sm" variant="outline" onClick={() => void knowledge.refetch()}>Retry</Button>
            </p>
          )
          : <p role="status" className="text-sm text-muted-foreground">Opening knowledge…</p>
        : content.trim() === ''
          ? <p role="status" className="py-4 text-sm text-muted-foreground">No knowledge yet. Decisions and gotchas appear here as the AI records them.</p>
          : <KnowledgeView markdown={content} focus={{ entry: entry ?? null, request }} />}
    </div>
  );
}
