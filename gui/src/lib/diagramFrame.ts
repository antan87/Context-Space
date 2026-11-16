import type { DiagramTheme } from './diagram.js';

interface FrameTransport {
  source: Window;
  post: (request: { kind: string; id: string; source: string; theme: DiagramTheme }) => void;
  dispose: () => void;
}
type OpenFrame = (receive: (event: MessageEvent) => void) => FrameTransport;

/** Only a trusted classic bundle may load: no module CORS exception or same-origin sandbox privilege is needed. */
export function diagramFrameDocument(scriptUrl: string, parentOrigin: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const policy = `default-src 'none'; script-src ${scriptUrl}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html data-parent-origin="${escape(parentOrigin)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"></head><body><script src="${escape(scriptUrl)}"></script></body></html>`;
}

/** A single pending request (the shared drawing queue serializes callers), bounded even if a frame hangs. */
export function createDiagramFrameClient(open: OpenFrame, timeoutMs = 20_000) {
  let frame: FrameTransport | null = null;
  let ready = false;
  let pending: {
    id: string; source: string; theme: DiagramTheme;
    resolve: (svg: string | null) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const reset = () => { frame?.dispose(); frame = null; ready = false; };
  const receive = (event: MessageEvent) => {
    if (!frame || event.source !== frame.source || event.origin !== 'null') return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.kind === 'diagram-ready' && !ready) {
      ready = true;
      if (pending) frame.post({ kind: 'diagram-render', id: pending.id, source: pending.source, theme: pending.theme });
      return;
    }
    if (!pending || data.kind !== 'diagram-result' || data.id !== pending.id) return;
    if (typeof data.svg !== 'string' && typeof data.error !== 'string' && data.unavailable !== true) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (data.unavailable === true) { reset(); current.resolve(null); }
    else if (typeof data.error === 'string') current.reject(new Error(data.error));
    else current.resolve(data.svg);
  };
  return (source: string, theme: DiagramTheme, id: string): Promise<string | null> => new Promise((resolve, reject) => {
    if (pending) { reject(new Error('The diagram renderer is busy.')); return; }
    const timer = setTimeout(() => {
      const current = pending;
      pending = null;
      reset();
      current?.reject(new Error('The diagram renderer did not respond in time.'));
    }, timeoutMs);
    pending = { id, source, theme, resolve, reject, timer };
    try {
      if (!frame) frame = open(receive);
      if (ready) frame.post({ kind: 'diagram-render', id, source, theme });
    } catch (error) {
      pending = null;
      clearTimeout(timer);
      reset();
      reject(error instanceof Error ? error : new Error('The diagram renderer could not open.'));
    }
  });
}

function openFrame(receive: (event: MessageEvent) => void): FrameTransport {
  const frame = document.createElement('iframe');
  frame.dataset.diagramFrame = '';
  frame.title = 'Diagram renderer';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.inert = true;
  frame.referrerPolicy = 'no-referrer';
  frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none;border:0';
  const scriptUrl = new URL(`${import.meta.env?.BASE_URL ?? '/'}diagram-frame.js`, location.origin).href;
  frame.srcdoc = diagramFrameDocument(scriptUrl, location.origin);
  // The only new parent-window listener is this frame protocol, never a keyboard/focus listener.
  window.addEventListener('message', receive);
  document.body.append(frame);
  const dispose = () => { window.removeEventListener('message', receive); frame.remove(); };
  if (!frame.contentWindow) { dispose(); throw new Error('The diagram renderer could not open.'); }
  return { source: frame.contentWindow, post: (request) => frame.contentWindow?.postMessage(request, '*'), dispose };
}

export const renderDiagramFrame = createDiagramFrameClient(openFrame);
