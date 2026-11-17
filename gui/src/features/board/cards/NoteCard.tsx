import { useContext, useEffect, useId, useRef, useState } from 'react';
import { type NodeProps } from '@xyflow/react';
import { Archive, MoreHorizontal, Pencil, Pin, Terminal } from 'lucide-react';

import { Button, CardFrame, Menu, MenuItem, MenuPopup, MenuTrigger } from '../../../design/index.js';
import { cn } from '../../../lib/utils.js';
import { NoteDialog } from '../NoteDialog.js';
import { BoardActionsContext, firstControl } from '../boardActions.js';
import type { NoteNode } from '../boardLayout.js';
import { Anchors, brickPress, Byline, CardMark, CardText, ReadAll, useCut } from './cardParts.js';

/** A note someone put on the board: its title, the start of its text (Markdown, with links that work), who wrote it and when. The whole text is one button away. */
export function BoardNote({ id, data }: NodeProps<NoteNode>) {
  const titleId = useId();
  const markId = useId();
  const actions = useContext(BoardActionsContext);
  const [editOpen, setEditOpen] = useState(false);
  const [titleRef, titleCut] = useCut<HTMLElement>(data.title);
  const [bodyRef, bodyCut] = useCut<HTMLDivElement>(data.text);
  // A body press reads; a double press edits. Wait briefly for the second press
  // before the modal can cover the card and swallow its double-click.
  const readTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(readTimer.current), []);
  useEffect(() => { if (editOpen) clearTimeout(readTimer.current); }, [editOpen]);

  const noteActionsMenu = actions && !actions.readOnly && (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity pointer-coarse:opacity-100">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 nodrag nopan text-muted-foreground hover:text-foreground"
        aria-label={`Edit ${data.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setEditOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.stopPropagation();
            setEditOpen(true);
          }
        }}
      >
        <Pencil className="size-3" aria-hidden="true" />
      </Button>
      <Menu>
        <MenuTrigger
          className="size-6 nodrag nopan inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
          aria-label={`Actions for ${data.title}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-36 p-1">
          <MenuItem
            onClick={() => setEditOpen(true)}
            className="flex items-center gap-2 text-[12.5px]"
          >
            <Pencil className="size-3.5" aria-hidden="true" />
            <span>Edit note</span>
          </MenuItem>
          <MenuItem
            onClick={() => void actions.updateNote?.(id, { pinned: !data.pinned })}
            className="flex items-center gap-2 text-[12.5px]"
          >
            <Pin className="size-3.5" aria-hidden="true" />
            <span>{data.pinned ? 'Unpin note' : 'Pin note'}</span>
          </MenuItem>
          <MenuItem
            onClick={() => void actions.updateNote?.(id, { archived: !data.archived })}
            className="flex items-center gap-2 text-[12.5px]"
          >
            <Archive className="size-3.5" aria-hidden="true" />
            <span>{data.archived ? 'Restore note' : 'Archive note'}</span>
          </MenuItem>
          {actions.askInCLI && (
            <MenuItem
              onClick={() => {
                const noteSummary = data.title?.trim() || data.text?.slice(0, 60).trim() || 'note';
                actions.askInCLI?.(noteSummary);
              }}
              className="flex items-center gap-2 text-[12.5px]"
            >
              <Terminal className="size-3.5" aria-hidden="true" />
              <span>Ask in CLI</span>
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );

  const dialog = actions && (
    <NoteDialog
      open={editOpen}
      onOpenChange={setEditOpen}
      note={{
        id,
        title: data.title,
        body: data.text,
        pinned: data.pinned,
        archived: data.archived,
        area: data.area,
        step: data.step,
      }}
      areas={actions.availableAreas}
      onSave={async (updates) => {
        const ok = await actions.updateNote?.(id, updates);
        return ok;
      }}
    />
  );

  if (data.compact) {
    const cut = titleCut || bodyCut;
    const title = <span ref={titleRef} id={titleId} className="min-w-0 line-clamp-1 break-words" title={data.title}>{data.title}</span>;
    return (
      <>
        <CardFrame
          archived={data.archived} pinned={data.pinned} fresh={data.fresh} freshKey={data.updatedAt} anchors={<Anchors />}
          labelledBy={titleId}
          describedBy={markId}
          compact
          onPress={cut ? (event) => {
            clearTimeout(readTimer.current);
            brickPress(event, (card) => {
              const trigger = firstControl(card, '[data-card-main]');
              // Read opens only if the card is still shown and nothing else opened in the meantime (the Board left, a menu or a dialog)
              // Only an overlay that opened after the press stops it: one already there (the terminal's Copy menu) does not
              const overlays = '[role="dialog"], [role="menu"], [role="alertdialog"]';
              const before = new Set(document.querySelectorAll(overlays));
              readTimer.current = setTimeout(() => {
                if (!trigger?.isConnected || trigger.offsetParent === null || trigger.getAttribute('aria-expanded') === 'true') return;
                if ([...document.querySelectorAll(overlays)].some((overlay) => !before.has(overlay))) return;
                trigger.click();
              }, 250);
              return null;
            });
          } : undefined}
          onDoubleClick={(event) => {
            // A double press inside a dialog the card opened bubbles up through React's tree, but is not on the card
            if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
            clearTimeout(readTimer.current);
            if (actions?.readOnly) return;
            event.stopPropagation();
            setEditOpen(true);
          }}
        >
          <div className="flex shrink-0 items-start gap-1.5">
            <h2 className={cn('flex min-h-7 min-w-0 flex-1 items-center text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')}>
              {cut ? <ReadAll data={data} title={title} /> : title}
            </h2>
            <div className="flex items-center gap-1 shrink-0">
              <CardMark data={data} markId={markId} />
              {noteActionsMenu}
            </div>
          </div>
          <CardText ref={bodyRef} text={data.text} cut={bodyCut} className="board-text-compact line-clamp-2 max-h-[34px] shrink-0 overflow-hidden text-[13px] leading-[17px]" />
        </CardFrame>
        {dialog}
      </>
    );
  }

  return (
    <>
      <CardFrame
        archived={data.archived} pinned={data.pinned} fresh={data.fresh} freshKey={data.updatedAt} anchors={<Anchors />}
        labelledBy={titleId}
        onDoubleClick={(event) => {
          if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
          if (actions?.readOnly) return;
          event.stopPropagation();
          setEditOpen(true);
        }}
      >
        <div className="flex shrink-0 items-start justify-between gap-1.5">
          <h2 ref={titleRef} id={titleId} className={cn('line-clamp-2 shrink-0 break-words text-sm font-semibold leading-5 flex-1', data.archived ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>
            {data.title}
          </h2>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="rounded bg-muted/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">note</span>
            {noteActionsMenu}
          </div>
        </div>
        <CardText ref={bodyRef} text={data.text} cut={bodyCut} className="mt-1 line-clamp-4 shrink-0 text-[12.5px] leading-[18px]" />
        <div className="mt-auto" />
        <div className="flex items-center justify-between gap-1 pt-1.5 border-t border-border/40">
          <Byline data={data}>{(titleCut || bodyCut) && <ReadAll data={data} />}</Byline>
          {actions?.askInCLI && !actions.readOnly && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const noteSummary = data.title?.trim() || data.text?.slice(0, 60).trim() || 'note';
                actions.askInCLI?.(noteSummary);
              }}
              className="btn-ask-card nodrag nopan inline-flex h-6 min-h-[24px] shrink-0 items-center gap-1 rounded border border-border/80 px-2 text-[11.5px] font-medium text-primary hover:border-primary/50 hover:bg-primary/10 transition-colors cursor-pointer"
              title={`Ask about "${data.title || 'note'}" in CLI`}
            >
              <span>Ask in CLI</span>
              <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      </CardFrame>
      {dialog}
    </>
  );
}
