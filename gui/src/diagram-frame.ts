import type { DiagramTheme } from './lib/diagram.js';
import { diagramResourceReason } from './lib/diagramSafety.js';

/** Runs only in the opaque, network-blocked frame. No SVG is measured in the app's document. */
export async function renderFrameDiagram(source: string, theme: DiagramTheme, id: string): Promise<string | null> {
  const refused = diagramResourceReason(source);
  if (refused) throw new Error(refused);
  if (source.length > 50_000) throw new Error('This diagram is too large to draw.');
  let module: typeof import('mermaid');
  try { module = await import('mermaid'); } catch { return null; }
  const mermaid = module.default;
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    htmlLabels: false, flowchart: { htmlLabels: false },
    theme: theme === 'dark' ? 'dark' : 'default',
    secure: [...Object.keys(mermaid.mermaidAPI.defaultConfig), 'htmlLabels'],
  });
  const host = document.createElement('div');
  host.dataset.diagramRenderHost = '';
  document.body.append(host);
  try { return (await mermaid.render(id, source, host)).svg; }
  finally { host.remove(); }
}

// In Vitest the exported renderer can be checked without creating a browser or registering a listener.
if (typeof window !== 'undefined' && window.parent !== window) {
  const parentOrigin = document.documentElement.dataset.parentOrigin;
  if (parentOrigin) {
    let queue: Promise<unknown> = Promise.resolve();
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== parentOrigin) return;
      const data = event.data;
      if (!data || data.kind !== 'diagram-render' || typeof data.source !== 'string'
        || typeof data.id !== 'string' || !/^contextspace-diagram-\d+$/.test(data.id)
        || (data.theme !== 'light' && data.theme !== 'dark')) return;
      queue = queue.then(async () => {
        try {
          const svg = await renderFrameDiagram(data.source, data.theme, data.id);
          parent.postMessage({ kind: 'diagram-result', id: data.id, ...(svg === null ? { unavailable: true } : { svg }) }, parentOrigin);
        } catch (error) {
          parent.postMessage({ kind: 'diagram-result', id: data.id, error: error instanceof Error ? error.message : String(error) }, parentOrigin);
        }
      });
    });
    parent.postMessage({ kind: 'diagram-ready' }, parentOrigin);
  }
}
