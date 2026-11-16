import { renderDiagramFrame } from './diagramFrame.js';
import { diagramResourceReason } from './diagramSafety.js';

/** Mermaid is loaded on the first drawing only. Its mutable parser/configuration is serialized here. */
export type DiagramTheme = 'light' | 'dark';
export type DiagramDrawing = { url: string } | { error: string } | null;
type RenderSvg = (source: string, theme: DiagramTheme, id: string) => Promise<string | null>;
let nextId = 0;

/** Kept separate from the DOM renderer so deduplication and failure recovery can be tested directly. */
export function createDiagramCache(render: RenderSvg) {
  const cache = new Map<string, Promise<DiagramDrawing>>();
  const pending = new Set<Promise<DiagramDrawing>>();
  const trim = () => {
    for (const [key, drawing] of cache) {
      if (cache.size <= 100) break;
      if (!pending.has(drawing)) cache.delete(key);
    }
  };
  let tail: Promise<unknown> = Promise.resolve();
  return (source: string, theme: DiagramTheme): Promise<DiagramDrawing> => {
    const key = JSON.stringify([source, theme]);
    const cached = cache.get(key);
    if (cached) return cached;
    const drawing = tail.then(async (): Promise<DiagramDrawing> => {
      try {
        const refused = diagramResourceReason(source);
        if (refused) return { error: refused };
        const svg = await render(source, theme, `contextspace-diagram-${++nextId}`);
        if (svg === null) return null; // Unavailable loads are removed after their public promise settles.
        // Data URLs need no lifetime bookkeeping or revocation, and remain inert image documents.
        return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
      } catch (error) {
        return { error: shortDiagramError(error) };
      }
    });
    pending.add(drawing);
    // The exposed promise must actually be settled before it becomes eligible for eviction.
    void drawing.then((result) => {
      if (result === null && cache.get(key) === drawing) cache.delete(key);
      pending.delete(drawing);
      trim();
    });
    tail = drawing;
    cache.set(key, drawing);
    // Bound settled results, while every pending request remains shared until it finishes.
    trim();
    return drawing;
  };
}

/** Keep Mermaid's useful diagnostic, never the echoed source excerpt or pointer. */
export function shortDiagramError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unable to draw this diagram');
  if (/No diagram type detected/i.test(message)) return 'No diagram type detected';
  const parse = message.match(/Parse error on line \d+:/i)?.[0];
  const expected = message.split(/\r?\n/).map((line) => line.trim()).find((line) => /^Expecting\b/.test(line));
  const summary = parse ? [parse, expected].filter(Boolean).join(' ') : message.split(/\r?\n/).find((line) => line.trim())?.trim() || 'Unable to draw this diagram';
  if (summary.length <= 200) return summary;
  const got = parse && expected?.match(/,?\s+got\s+.+$/)?.[0];
  return got && got.length < 100
    ? `${summary.slice(0, 197 - got.length).trimEnd()}...${got}`
    : `${summary.slice(0, 197)}...`;
}

/** Card measurements are CSS pixels; zoom converts them to the size a person actually sees. */
export function diagramCardLayout(natural: { width: number; height: number }, box: { width: number; height: number }, zoom = 1) {
  const scale = Math.max(0.75, Math.min(1, box.width * zoom / natural.width, box.height * zoom / natural.height));
  const width = natural.width * scale / zoom;
  const height = natural.height * scale / zoom;
  return { scale, width, height, cropRight: width > box.width + 0.01, cropBottom: height > box.height + 0.01 };
}

/** The reader explains the mistake to a person; the original diagnostic still goes to the AI. */
export function diagramProblem(source: string, error: string): { message: string; sourceLine?: string; detail?: string } {
  const line = Number(error.match(/Parse error on line (\d+):/i)?.[1]);
  const lines = source.split(/\r?\n/);
  if (Number.isSafeInteger(line) && line > 0 && line <= lines.length) {
    return { message: `Can't draw this diagram: line ${line} has a mistake`, sourceLine: lines[line - 1] };
  }
  if (/No diagram type detected/i.test(error)) return { message: "Can't draw this diagram: Mermaid does not know this kind of diagram" };
  return { message: "Can't draw this diagram", detail: error };
}

export function diagramAlt(source: string): string {
  return source.match(/^[\t ]*accTitle[\t ]*:[\t ]*([^\r\n]*\S)[\t ]*\r?$/m)?.[1]?.trim() || 'Diagram';
}

async function renderSvg(source: string, theme: DiagramTheme, id: string): Promise<string | null> {
  const svg = await renderDiagramFrame(source, theme, id);
  if (svg === null) return null;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror, foreignObject')) throw new Error('Unsupported SVG');
  // Mermaid's responsive width=100% has no intrinsic image size. Use the viewBox for an
  // image that is natural-sized in the reader and object-contained on the card.
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    root.setAttribute('width', String(box[2]));
    root.setAttribute('height', String(box[3]));
    root.style.removeProperty('max-width');
    root.style.removeProperty('width');
  }
  return new XMLSerializer().serializeToString(root);
}

export const drawDiagram = createDiagramCache(renderSvg);
