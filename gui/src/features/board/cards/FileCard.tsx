import { useContext, useId, useState, type MouseEvent } from 'react';
import { type NodeProps } from '@xyflow/react';
import { PanelRightOpen, type LucideIcon } from 'lucide-react';

import { Button, CardFrame, CARD_BRICK as BRICK, CARD_FOCUS, KIND_ICON, KindLabel } from '../../../design/index.js';
import { cn } from '../../../lib/utils.js';
import { BoardActionsContext, BoardReadingContext, bylineText, firstControl, pictureSrc } from '../boardActions.js';
import { askCard, boardCardId } from '../askText.js';
import { imageAlt, type FileNode, type FileType } from '../boardLayout.js';
import { Anchors, AskCompact, brickPress, CardMark, CardText, hasDragSelection, ReadAll, TITLE_BUTTON, useCut } from './cardParts.js';

const FILE_LABEL: Record<FileType, string> = { image: 'Picture', html: 'HTML page', pdf: 'PDF', markdown: 'Markdown', other: 'File' };
const FILE_ICON: Record<FileType, LucideIcon> = { image: KIND_ICON.picture, html: KIND_ICON.html, pdf: KIND_ICON.pdf, markdown: KIND_ICON.markdown, other: KIND_ICON.other };

/** What stands in a file card where a picture would: the kind of file, and where it is. */
function FileKind({ type, path }: { type: FileType; path: string }) {
  const Icon = FILE_ICON[type];
  return <div className="flex size-full flex-col items-center justify-center gap-1 px-3 text-center">
    <Icon aria-hidden="true" className="size-8 text-muted-foreground" />
    <span className="text-xs font-medium">{FILE_LABEL[type]}</span>
    <code className="max-w-full truncate font-mono text-[12.5px] text-muted-foreground" title={path}>{path}</code>
  </div>;
}

/** A file someone put on the board: a picture shows itself; anything else shows its kind. Open shows it in the reader beside the board. */
export function BoardFile({ id, data }: NodeProps<FileNode>) {
  const titleId = useId();
  const markId = useId();
  const actions = useContext(BoardActionsContext);
  const reading = useContext(BoardReadingContext) === id;
  // The path of a picture that would not load, so a card that now names another file tries it.
  const [brokenPath, setBrokenPath] = useState<string | null>(null);
  const [titleRef, titleCut] = useCut<HTMLElement>(data.title);
  const [textRef, textCut] = useCut<HTMLDivElement>(data.text);
  const picture = data.fileType === 'image' && actions && brokenPath !== data.path;
  if (data.compact && (data.group === 'documents' || data.group === 'pages')) {
    const Icon = FILE_ICON[data.fileType];
    const folderLabel = data.folder || 'Workspace root';
    const openItem = (event: MouseEvent<HTMLElement>) => {
      if (hasDragSelection(event.currentTarget, event)) return;
      actions?.openInReader(
        { path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}) },
        event.currentTarget,
      );
    };
    const content = (
      <>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span id={titleId} className="nodrag select-text min-w-0 max-w-[52%] shrink-0 truncate text-[13.5px] font-medium leading-5 text-foreground" title={data.title}>
          {data.title}
        </span>
        <span className="nodrag select-text min-w-0 flex-1 truncate text-[13px] leading-4 text-muted-foreground" title={folderLabel}>
          {folderLabel}
        </span>
        {data.age && (
          <span id={markId} className="shrink-0 whitespace-nowrap text-[13px] leading-4 text-muted-foreground tabular-nums">
            {data.age}
          </span>
        )}
      </>
    );
    return (
      <article
        aria-labelledby={titleId}
        aria-describedby={data.age ? markId : undefined}
        aria-current={reading ? 'true' : undefined}
        onClick={actions ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}
        className={cn(
          'group relative flex h-full w-full items-center overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs transition-colors hover:bg-accent/35 hover:border-border/80 border-border',
          CARD_FOCUS,
          actions && BRICK,
          reading && 'ring-2 ring-primary',
        )}
      >
        <Anchors />
        {actions ? (
          <button
            type="button"
            data-card-main
            aria-label={`Open ${data.title}`}
            onClick={openItem}
            className="nodrag nopan select-text flex h-full w-full min-w-0 items-center gap-2.5 px-3 text-left outline-hidden hover:no-underline cursor-pointer"
          >
            {content}
          </button>
        ) : (
          <div className="flex h-full w-full min-w-0 items-center gap-2.5 px-3">{content}</div>
        )}
        <AskCompact card={{ kind: 'file', id: boardCardId(id), title: data.title, path: data.path }} label={data.title || data.path} className="right-1 top-1/2 -translate-y-1/2" />
      </article>
    );
  }
  if (data.compact && data.group === 'pictures') {
    const Icon = FILE_ICON[data.fileType];
    const title = <span ref={titleRef} id={titleId} className="nodrag select-text min-w-0 truncate" title={data.title}>{data.title}</span>;
    return (
      <article
        aria-labelledby={titleId}
        aria-describedby={data.age ? markId : undefined}
        aria-current={reading ? 'true' : undefined}
        onClick={actions ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}
        className={cn(
          'group relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-border/80',
          CARD_FOCUS,
          actions && BRICK,
          reading && 'ring-2 ring-primary',
        )}
      >
        <Anchors />
        <div className="min-h-0 flex-1 w-full overflow-hidden border-b border-border/60 bg-black/40">
          {picture
            ? <img
              src={pictureSrc(actions, data.path)}
              alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setBrokenPath(data.path)}
              className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
            />
            : <div className="flex size-full flex-col items-center justify-center gap-0.5 px-2 text-center">
              <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
              <span className="text-[12.5px] font-medium leading-4">{FILE_LABEL[data.fileType]}</span>
            </div>}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-1.5 px-2.5 py-0.5">
          <h2 className="flex min-h-7 min-w-0 flex-1 items-center text-[13.5px] font-medium leading-5 text-foreground">
            {actions
              ? <button
                type="button"
                data-card-main
                className={cn(TITLE_BUTTON, 'flex min-h-7 items-center text-[13.5px] font-medium')}
                aria-label={`Open ${data.title}`}
                onClick={(event) => {
                  if (hasDragSelection(event.currentTarget, event)) return;
                  actions.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}) }, event.currentTarget);
                }}
              >{title}</button>
              : title}
          </h2>
          {data.age && (
            <span id={markId} className="shrink-0 whitespace-nowrap text-[13px] leading-4 text-muted-foreground tabular-nums">
              {data.age}
            </span>
          )}
        </div>
        <AskCompact card={{ kind: 'file', id: boardCardId(id), title: data.title, path: data.path }} label={data.title || data.path} className="right-1.5 top-1.5" />
      </article>
    );
  }
  if (data.compact) {
    const Icon = FILE_ICON[data.fileType];
    const title = <span ref={titleRef} id={titleId} className="nodrag select-text min-w-0 line-clamp-1 break-words" title={data.title}>{data.title}</span>;
    const describedBy = !data.readOnly || data.age ? markId : undefined;
    return <CardFrame archived={data.archived} pinned={data.pinned} fresh={data.fresh} freshKey={data.updatedAt} anchors={<Anchors />} labelledBy={titleId} describedBy={describedBy} reading={reading} compact onPress={actions ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="h-16 w-24 shrink-0 overflow-hidden rounded-md border border-border/80 bg-black/40">
          {picture
            ? <img
              src={pictureSrc(actions, data.path)} alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
              loading="lazy" decoding="async" draggable={false} onError={() => setBrokenPath(data.path)} className="size-full object-cover"
            />
            : <div className="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-center">
              <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
              <span className="text-[12.5px] font-medium leading-4">{FILE_LABEL[data.fileType]}</span>
              <span className="sr-only">{data.path}</span>
            </div>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start gap-1.5">
          <h2 className={cn('flex min-h-7 min-w-0 flex-1 items-center text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')}>
            {actions
              ? <button type="button" data-card-main className={TITLE_BUTTON} aria-label={`Open ${data.title}`} onClick={(event) => { if (hasDragSelection(event.currentTarget, event)) return; actions.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}), ...(data.readOnly ? {} : { byline: bylineText(data) }) }, event.currentTarget); }}>{title}</button>
              : title}
          </h2>
          {data.readOnly
            ? (data.age ? <span id={markId} className="shrink-0 whitespace-nowrap pt-1 text-xs leading-4 text-muted-foreground tabular-nums">{data.age}</span> : null)
            : <CardMark data={data} markId={markId} />}
          </div>
          <CardText ref={textRef} text={data.text} cut={textCut} className="board-text-compact line-clamp-2 max-h-[34px] shrink-0 overflow-hidden text-[13px] leading-[17px]" />
        </div>
      </div>
      <AskCompact card={{ kind: 'file', id: boardCardId(id), title: data.title, path: data.path }} label={data.title || data.path} className="bottom-1 right-1" />
    </CardFrame>;
  }
  return <CardFrame archived={data.archived} pinned={data.pinned} fresh={data.fresh} freshKey={data.updatedAt} anchors={<Anchors />} labelledBy={titleId} reading={reading} onPress={actions ? (event) => brickPress(event, (card) => firstControl(card, 'button[aria-label^="Open "]')) : undefined}>
    <div className="flex shrink-0 items-start justify-between gap-1.5">
      <h2 ref={titleRef} id={titleId} className={cn('nodrag select-text line-clamp-2 shrink-0 break-words text-[13px] font-semibold leading-5 flex-1', data.archived ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</h2>
      <KindLabel kind={data.fileType === 'image' ? 'picture' : data.fileType} />
    </div>
    <div className="group/thumb relative mt-1.5 h-24 shrink-0 overflow-hidden rounded-md border border-border/80 bg-black/40">
      {picture
        ? <>
          <img
            src={pictureSrc(actions, data.path)} alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
            loading="lazy" decoding="async" draggable={false} onError={() => setBrokenPath(data.path)} className="size-full object-cover transition-transform duration-200 group-hover/thumb:scale-105 cursor-pointer"
            onClick={(event) => actions?.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}), byline: bylineText(data) }, event.currentTarget)}
          />
          <span className="absolute bottom-1 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover/thumb:opacity-100 pointer-events-none">
            Double-click to enlarge
          </span>
        </>
        : <FileKind type={data.fileType} path={data.path} />}
    </div>
    {data.text && <CardText ref={textRef} text={data.text} cut={textCut} className="mt-1 line-clamp-2 shrink-0 text-xs leading-[16px]" />}
    <div className="mt-auto" />
    <div className="flex items-center justify-between gap-1 pt-1.5 border-t border-border/40">
      <span className="truncate text-xs text-muted-foreground" title={data.readOnly ? (data.age ?? '') : (bylineText(data) || 'live visual snapshot')}>
        {data.readOnly ? (data.age ?? '') : (bylineText(data) || 'live visual snapshot')}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="xs" variant="ghost" className="nodrag nopan h-6 px-1.5 text-xs" aria-label={`Open ${data.title}`} onClick={(event) => actions?.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}), ...(data.readOnly ? {} : { byline: bylineText(data) }) }, event.currentTarget)} disabled={!actions}><PanelRightOpen aria-hidden="true" className="size-3" />Open</Button>
        {(titleCut || textCut) && <ReadAll data={data} />}
        {actions?.askInCLI && !actions.readOnly && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.askInCLI?.(askCard({ kind: 'file', id: boardCardId(id), title: data.title, path: data.path }));
            }}
            className="btn-ask-card nodrag nopan inline-flex h-6 min-h-[24px] items-center gap-1 rounded border border-border/80 px-2 text-[11.5px] font-medium text-primary hover:border-primary/50 hover:bg-primary/10 transition-colors cursor-pointer"
            title={`Ask about "${data.title || data.path || 'file'}" in CLI`}
          >
            <span>Ask in CLI</span>
            <span aria-hidden="true">↗</span>
          </button>
        )}
      </div>
    </div>
  </CardFrame>;
}
