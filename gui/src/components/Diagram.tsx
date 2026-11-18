import { useContext, useEffect, useLayoutEffect, useCallback, useRef, useState, type ReactNode } from 'react';
import { drawDiagram, diagramAlt, diagramCardLayout, diagramReaderLayout, diagramProblem, diagramScrollHint, type DiagramDrawing } from '../lib/diagram.js';
import { DIAGRAM_RESOURCE_REASON } from '../lib/diagramSafety.js';
import { Button } from './ui/button.js';
import { DiagramFixContext, DiagramFullScreenContext } from './diagramFixContext.js';
import { isAppDark, watchEditorTheme } from '../lib/editorTheme.js';

/** A readable-size view of the start of an image; it never takes focus or keys from its card. */
function CardDiagram({ url, zoom }: { url: string; zoom: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [layout, setLayout] = useState<ReturnType<typeof diagramCardLayout> | null>(null);
  const measure = useCallback(() => {
    const box = viewport.current;
    const img = image.current;
    if (!box || !img?.naturalWidth || !img.naturalHeight || !box.clientWidth || !box.clientHeight) return;
    const next = diagramCardLayout({ width: img.naturalWidth, height: img.naturalHeight }, { width: box.clientWidth, height: box.clientHeight }, zoom);
    setLayout((old) => old?.width === next.width && old.height === next.height && old.cropRight === next.cropRight && old.cropBottom === next.cropBottom ? old : next);
  }, [zoom]);
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [measure, url]);
  const cropped = layout?.cropRight || layout?.cropBottom;
  return <div ref={viewport} data-diagram-viewport className="relative min-h-0 w-full flex-1 overflow-hidden">
    <img ref={image} src={url} alt="" draggable={false} onLoad={measure}
      className="absolute block max-w-none"
      style={{ width: layout?.width, height: layout?.height, left: cropped ? 0 : '50%', top: cropped ? 0 : '50%', transform: cropped ? undefined : 'translate(-50%, -50%)' }} />
    {layout?.cropBottom && <span data-diagram-fade="bottom" aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-4" style={{ background: 'linear-gradient(to bottom, transparent, var(--card))' }} />}
    {layout?.cropRight && <span data-diagram-fade="right" aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-4" style={{ background: 'linear-gradient(to right, transparent, var(--card))' }} />}
  </div>;
}

/** Reader diagrams fit down to a 12 px text floor (scaling up to 1.5x if needed); wider ones scroll sideways at that readable scale. */
function ReaderDiagram({ url, alt, fontSize, cut }: { url: string; alt: string; fontSize?: number; cut: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [layout, setLayout] = useState<ReturnType<typeof diagramReaderLayout> | null>(null);
  const [fades, setFades] = useState({ left: false, right: false });
  const fullScreen = useContext(DiagramFullScreenContext);

  const measureScroll = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const next = {
      left: box.scrollLeft > 1,
      right: box.scrollLeft + box.clientWidth < box.scrollWidth - 1,
    };
    setFades((old) => (old.left === next.left && old.right === next.right ? old : next));
  }, []);

  const measure = useCallback(() => {
    const box = viewport.current;
    const img = image.current;
    if (!box) return;
    const rectWidth = box.getBoundingClientRect().width;
    const availableWidth = rectWidth > 0 ? Math.min(box.clientWidth || rectWidth, rectWidth) : box.clientWidth;
    if (!img?.naturalWidth || !img.naturalHeight || !availableWidth) return;
    const next = diagramReaderLayout({ width: img.naturalWidth, height: img.naturalHeight }, availableWidth, fontSize);
    setLayout((old) => (
      old?.width === next.width
      && old.height === next.height
      && old.scale === next.scale
      && old.scrolls === next.scrolls
        ? old
        : next
    ));
    if (next.scrolls) measureScroll();
  }, [fontSize, measureScroll]);

  useLayoutEffect(() => {
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (viewport.current && observer) observer.observe(viewport.current);
    return () => {
      observer?.disconnect();
    };
  }, [measure, url]);

  const scrolls = Boolean(layout?.scrolls);
  useLayoutEffect(() => {
    if (!scrolls) {
      if (scroller.current && scroller.current.scrollLeft !== 0) scroller.current.scrollLeft = 0;
      setFades((old) => (!old.left && !old.right ? old : { left: false, right: false }));
      return;
    }
    measureScroll();
  }, [layout, scrolls, url, measureScroll]);

  return <>
    <div ref={viewport} className="relative w-full min-w-0">
      <div
        ref={scroller}
        tabIndex={scrolls && !cut ? 0 : undefined}
        role={scrolls && !cut ? 'region' : undefined}
        aria-label={scrolls && !cut ? `${alt}, scrolls sideways` : undefined}
        onScroll={measureScroll}
        className={scrolls
          ? 'w-full min-w-0 overflow-x-auto overflow-y-hidden rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
          : 'w-full min-w-0 overflow-hidden'}
      >
        <img
          ref={image}
          src={url}
          alt={alt}
          draggable={false}
          onLoad={measure}
          className="not-prose m-0 block max-w-none"
          style={layout ? { width: layout.width, height: layout.height } : { maxWidth: '100%', height: 'auto' }}
        />
      </div>
      {scrolls && fades.left && (
        <span
          data-diagram-fade="left"
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 w-8"
          style={{ height: layout?.height, background: 'linear-gradient(to left, transparent, var(--background))' }}
        />
      )}
      {scrolls && fades.right && (
        <span
          data-diagram-fade="right"
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 w-8"
          style={{ height: layout?.height, background: 'linear-gradient(to right, transparent, var(--background))' }}
        />
      )}
    </div>
    {scrolls && (
      <p data-diagram-scroll-hint="" className="not-prose mt-1 mb-0 text-xs leading-4 text-muted-foreground">
        {diagramScrollHint(fullScreen)}
      </p>
    )}
  </>;
}

/** One inert image in both places. Source visibility belongs to this mounted fence, not polled answer data. */
export function Diagram({ source, card = false, cardZoom = 1, code, cut = false }: { source: string; card?: boolean; cardZoom?: number; code?: ReactNode; cut?: boolean }) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => isAppDark() ? 'dark' : 'light');
  const [drawing, setDrawing] = useState<{ source: string; theme: string; result: NonNullable<DiagramDrawing> } | null>(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => watchEditorTheme((next) => setTheme(next === 'vs-dark' ? 'dark' : 'light')), []);
  const onFix = useContext(DiagramFixContext);
  const mounted = useRef(false);
  const pending = useRef<{ source: string; theme: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Run after each render: a rejected lazy import gets another chance on the next external render,
  // without a retry loop, while completed drawings and in-flight requests are left alone.
  useEffect(() => {
    if (drawing?.source === source && drawing.theme === theme) { pending.current = null; return; }
    if (pending.current?.source === source && pending.current.theme === theme) return;
    const request = { source, theme };
    pending.current = request;
    void drawDiagram(source, theme).then((result) => {
      if (!mounted.current || pending.current !== request) return;
      pending.current = null;
      if (result) setDrawing({ source, theme, result });
    });
  });
  // Keep the previous themed image while its replacement draws, preserving Source and its focus.
  const result = drawing?.source === source ? drawing.result : null;
  const error = result && 'error' in result ? result.error : null;
  const line = error?.match(/Parse error on line (\d+):/i)?.[1];
  const problem = error ? diagramProblem(source, error) : null;
  const fallback = card
    ? <pre className="m-0 min-h-0 max-h-12 overflow-hidden whitespace-pre font-mono text-[12px] leading-4 text-foreground">{source.split('\n').slice(0, 3).join('\n')}</pre>
    : code;
  return <div data-diagram-box className={card ? 'flex min-h-0 w-full flex-1 flex-col justify-center overflow-hidden' : 'my-3 w-full min-w-0 max-w-full'}>
    {error && <>
      <span role="status" data-diagram-error={card ? undefined : ''} className="block text-[12px] leading-4 text-muted-foreground">{card ? `Can't draw this diagram${line ? ` · line ${line}` : ''}` : problem?.message}</span>
      {card && error === DIAGRAM_RESOURCE_REASON && <span className="block text-[12px] leading-4 text-muted-foreground">{error}</span>}
      {!card && <>
        {problem?.sourceLine !== undefined && <p data-diagram-error-line className="my-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{problem.sourceLine}</p>}
        {problem?.detail && <p className="my-1 whitespace-normal break-words text-[12px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{problem.detail}</p>}
        {onFix && <button type="button" className="nodrag nopan min-h-6 cursor-pointer rounded border border-border px-2 py-1 text-[12px] leading-4 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={(event) => {
            const button = event.currentTarget;
            void Promise.resolve(onFix(error)).then(() => {
              const active = document.activeElement;
              if (button.isConnected && !button.closest('[inert]') && (active === button || active?.closest('.xterm'))) button.focus({ preventScroll: true });
            });
          }}>Ask the AI to fix it</button>}
      </>}
    </>}
    {result && 'url' in result ? <>
      {card ? <CardDiagram url={result.url} zoom={cardZoom} /> : <ReaderDiagram key={source} url={result.url} alt={diagramAlt(source)} fontSize={result.fontSize} cut={cut} />}
      {!card && <>
        <Button type="button" size="xs" variant="outline" aria-expanded={showSource} tabIndex={cut ? -1 : undefined}
          className="nodrag nopan mt-1 text-xs"
          onClick={() => setShowSource((shown) => !shown)}>Source</Button>
        {showSource && code}
      </>}
    </> : fallback}
  </div>;
}
