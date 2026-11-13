import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, CircleHelp, Search } from 'lucide-react';

import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Popover, PopoverPopup } from '../../components/ui/popover.js';
import { cn } from '../../lib/utils.js';
import { newsHeading, type WhatsNewView } from '../plan/whatsNew.js';
import type { NewsLine, NowLineParts } from './nowLine.js';

export interface BoardNowLineProps {
  parts: NowLineParts;
  /** The news list the "N new" part opens, with the lines that go somewhere. */
  news?: WhatsNewView;
  newsLines: NewsLine[];
  readOnly?: boolean;
  gotIt: { pending: boolean; error?: string; onGotIt: () => void };
  back?: { label: string; onBack: () => void };
  onNow: () => void;
  onQuestion: () => void;
  onNewsLine: (line: NewsLine) => void;
  onSearch: () => void;
}

/** The room the step keeps, in px, where the line has it: the Area's name gives way first, then who and when. */
export const STEP_MIN_PX = 200;

const PART = 'nodrag nopan inline-flex min-h-6 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The line at the top of the Board: what is happening now (or next up, when nobody said), what waits for you, what is new, and the way to
 * search. Each part is a button that goes there. The step's words give way first, then the Area's name, then who and when; the question
 * count, the news count and search stay at any width.
 */
export function BoardNowLine({ parts, news, newsLines, readOnly = false, gotIt, back, onNow, onQuestion, onNewsLine, onSearch }: BoardNowLineProps) {
  const [newsOpen, setNewsOpen] = useState(false);
  const newsButton = useRef<HTMLButtonElement>(null);
  const isNow = parts.word === 'Now';
  // What shows beside the step: 0 the Area and who, 1 who only, 2 neither, 3 neither and the question as its count. Each is tried in turn until the step has its room.
  const [level, setLevel] = useState<0 | 1 | 2 | 3>(0);
  const [width, setWidth] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLSpanElement>(null);
  const signature = [parts.word, parts.text, parts.area, parts.who, parts.waiting, parts.news].join('|');
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    setWidth(Math.round(element.clientWidth));
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setWidth(Math.round(element.clientWidth)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A new width or new words start from everything again; the next effect takes away what does not fit
  useLayoutEffect(() => { setLevel(0); }, [signature, width]);
  useLayoutEffect(() => {
    const step = stepRef.current;
    if (!step || level >= 3) return;
    if (step.clientWidth < Math.min(STEP_MIN_PX, step.scrollWidth) - 1) setLevel((level + 1) as 1 | 2 | 3);
  }, [level, signature, width]);
  const questionText = parts.waiting === 1 ? '1 question waits' : `${parts.waiting} questions wait`;
  const full = [parts.word, parts.text, parts.area, parts.who].filter(Boolean).join(' · ');

  return (
    <div ref={root} role="group" aria-label="Where the work is" data-testid="board-now-line" className="@container flex h-8 shrink-0 items-center gap-1 border-b border-border/50 px-2">
      {back && (
        <button
          type="button"
          data-testid="board-back-button"
          aria-label={`Back to ${back.label}`}
          title={`Back to ${back.label} (Alt+←)`}
          onClick={back.onBack}
          className={cn(PART, 'max-w-40 font-medium text-foreground')}
        >
          <ChevronLeft aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{back.label}</span>
        </button>
      )}
      {parts.word ? (
        <button type="button" data-testid="board-now-main" title={full} aria-label={`${parts.word}: ${parts.text}`} onClick={onNow} className={cn(PART, 'min-w-0 shrink justify-start gap-2 overflow-hidden')}>
          {isNow && <span aria-hidden="true" className="board-now-dot size-2 shrink-0 rounded-full bg-state-now" />}
          <span className={cn('shrink-0 font-semibold', isNow ? 'text-foreground' : 'text-muted-foreground')}>{parts.word}</span>
          <span ref={stepRef} className="min-w-0 truncate font-medium text-foreground" data-testid="board-now-step">{parts.text}</span>
          {parts.area && level === 0 && <span className="max-w-[16rem] shrink-0 truncate text-xs text-muted-foreground" data-testid="board-now-area">{parts.area}</span>}
          {parts.who && level < 2 && <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" data-testid="board-now-who">{parts.who}</span>}
        </button>
      ) : (
        <span className="px-1.5 text-[13px] text-muted-foreground">Nothing open in the plan</span>
      )}
      <span className="min-w-0 flex-1" />
      {parts.waiting > 0 && (
        <button type="button" data-testid="board-now-question" onClick={onQuestion} aria-label={questionText} title={questionText} className={cn(PART, 'font-medium text-warning-foreground')}>
          <CircleHelp aria-hidden="true" className="size-3.5 shrink-0" />
          {level >= 3 ? parts.waiting : questionText}
        </button>
      )}
      {parts.news > 0 && news && (
        <Popover open={newsOpen} onOpenChange={setNewsOpen}>
          <button ref={newsButton} type="button" data-testid="board-now-news" aria-expanded={newsOpen} aria-haspopup="dialog" onClick={() => setNewsOpen((open) => !open)} className={cn(PART, 'font-medium text-foreground')}>
            {parts.news} new
          </button>
          <PopoverPopup anchor={newsButton} align="end" className="w-[min(26rem,calc(100vw-1.5rem))]" viewportClassName="py-2 [--viewport-inline-padding:--spacing(2)]">
            <div role="dialog" aria-label="What is new" data-testid="board-news-list" className="w-full min-w-0">
              <p className="px-2 pb-1 text-xs text-muted-foreground">{newsHeading(news)}</p>
              <ul className="max-h-[min(50vh,20rem)] space-y-0.5 overflow-y-auto">
                {newsLines.map((line, index) => (
                  <li key={`${index}-${line.text}`}>
                    {line.jump || line.knowledge ? (
                      <button type="button" onClick={() => { setNewsOpen(false); onNewsLine(line); }} className="block min-h-6 w-full cursor-pointer rounded-md px-2 py-1 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring">{line.text}</button>
                    ) : (
                      <span className="block min-h-6 px-2 py-1 text-[13px] leading-[18px] text-muted-foreground">{line.text}</span>
                    )}
                  </li>
                ))}
              </ul>
              {gotIt.error && <p role="alert" className="px-2 pt-1 text-xs text-destructive">{gotIt.error}</p>}
              {!readOnly && (
                <div className="flex justify-end px-2 pt-2">
                  <Button size="xs" disabled={gotIt.pending} onClick={() => { gotIt.onGotIt(); setNewsOpen(false); }}>Got it</Button>
                </div>
              )}
            </div>
          </PopoverPopup>
        </Popover>
      )}
      <IconButton label="Search the board" shortcut="/" icon={<Search aria-hidden="true" />} onClick={onSearch} className="nodrag nopan shrink-0" />
    </div>
  );
}
