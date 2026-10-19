import { useEffect } from 'react';
import { BellRing, X } from 'lucide-react';
import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';
import { Button } from '../../components/ui/button.js';
import { attentionStore } from './chatAttention.js';
import { useFloatingChat } from './floatingChatStore.js';
import { useChatVisible } from './dockPlacement.js';
import { useChatAttention } from './useChatAttention.js';
import { handleDelegatedRowClick } from '../../lib/delegatedRowClick.js';
import type { Feature } from '../../types.js';

const MAX_CARDS = 4;

/**
 * Persistent alerts for CLI chats whose agent called `request_user_input`.
 * They stay until the user opens that chat or dismisses them: a toast that
 * times out would vanish while the user is in another window, which is the
 * moment they most need it.
 *
 * Shown only while the chat is off screen. With the chat in view the cards would
 * cover it; there the sidebar carries the signal, as each waiting session shows
 * its question.
 */
export function ChatAttentionCards({ workspaces = [] }: { workspaces?: readonly Feature[] }) {
  const { openCli } = useFloatingChat();
  // A workspace is known by its name; the branch is the fallback.
  const nameOf = (branch: string) => workspaces.find((workspace) => workspace.branchName === branch)?.name || branch;
  const chatVisible = useChatVisible();
  const { pending } = useChatAttention();

  // The count in the window title shows in a taskbar or tab strip, whatever is open.
  // Only a title this effect itself wrote is put back, so a title set elsewhere meanwhile is kept.
  useEffect(() => {
    if (pending.length === 0) return;
    const original = document.title;
    const marked = `(${pending.length}) ${original}`;
    document.title = marked;
    return () => {
      if (document.title === marked) document.title = original;
    };
  }, [pending.length]);

  if (pending.length === 0 || chatVisible) return null;
  const shown = pending.slice(0, MAX_CARDS);
  const hidden = pending.length - shown.length;

  return (
    <section
      role="status"
      aria-label="Chats waiting for you"
      className="fixed bottom-20 right-6 z-[60] flex w-[min(24rem,calc(100vw-3rem))] flex-col gap-2"
    >
      {shown.map((request) => {
        const activateChat = () => {
          openCli(request.workspaceId);
          attentionStore.markSeen(request.workspaceId, request.id);
        };

        return (
          <article
            key={request.workspaceId}
            aria-label={`Alert: ${nameOf(request.workspaceId)} is waiting for you`}
            onClick={(e) => handleDelegatedRowClick(e, activateChat)}
            className="animate-rise group relative cursor-pointer rounded-xl border border-amber-500/60 bg-card p-3 text-foreground shadow-lg transition-all hover:border-amber-500/80 hover:bg-accent/40 select-text"
          >
            <div className="flex items-start gap-2">
              <BellRing className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold" title={request.workspaceId}>
                  {nameOf(request.workspaceId)} is waiting for you
                </p>
                <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <HarnessIcon harness={request.harness} className="size-3" />
                  {harnessName(request.harness)}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  attentionStore.markSeen(request.workspaceId, request.id);
                }}
                aria-label={`Dismiss the alert for ${nameOf(request.workspaceId)}`}
                className="shrink-0 cursor-pointer rounded-sm p-1.5 -m-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            {/* The agent wrote this text: render it as plain text only. */}
            <p className="mt-2 line-clamp-4 whitespace-pre-line break-words text-xs leading-relaxed">{request.message}</p>
            <div className="mt-2.5 flex justify-end">
              <Button
                size="xs"
                onClick={activateChat}
              >
                Open chat
              </Button>
            </div>
          </article>
        );
      })}
      {hidden > 0 && (
        <p className="rounded-lg border border-amber-500/40 bg-card px-3 py-1.5 text-center text-[11px] text-muted-foreground shadow">
          {hidden} more {hidden === 1 ? 'chat is' : 'chats are'} waiting. {hidden === 1 ? 'It is' : 'They are'} marked in the sidebar.
        </p>
      )}
    </section>
  );
}
