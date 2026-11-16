import { describe, expect, it, vi } from 'vitest';
import { createDiagramCache, diagramAlt } from './diagram.js';

describe('diagram drawing', () => {
  it('shares pending and completed drawings only for the same source and theme', async () => {
    const render = vi.fn(async (source: string, theme: string) => `<svg>${source}:${theme}</svg>`);
    const draw = createDiagramCache(render);
    const first = draw('flowchart LR\nA-->B', 'light');
    expect(draw('flowchart LR\nA-->B', 'light')).toBe(first);
    const result = await first;
    expect(await draw('flowchart LR\nA-->B', 'light')).toBe(result);
    await draw('flowchart LR\nA-->B', 'dark');
    await draw('flowchart LR\nA-->C', 'light');
    expect(render).toHaveBeenCalledTimes(3);
    expect(result).toHaveProperty('url', expect.stringMatching(/^data:image\/svg\+xml/));
  });

  it('serializes renders, gives each an id, and recovers after a rejection', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const ids: string[] = [];
    let active = 0;
    let peak = 0;
    const draw = createDiagramCache(async (source, _theme, id) => {
      ids.push(id);
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (source === 'broken') { await gate; throw new Error('bad syntax'); }
        return '<svg/>';
      } finally { active -= 1; }
    });
    const broken = draw('broken', 'dark');
    const good = draw('good', 'light');
    await vi.waitFor(() => expect(ids).toHaveLength(1));
    finish();
    expect(await broken).toEqual({ error: 'bad syntax' });
    expect(await good).toHaveProperty('url');
    expect(peak).toBe(1);
    expect(new Set(ids).size).toBe(2);
    expect(await draw('broken', 'dark')).toEqual({ error: 'bad syntax' });
    expect(ids).toHaveLength(2);
  });

  it('locks safety settings and cleans its private measurement container after render failure', async () => {
    const initialize = vi.fn();
    const render = vi.fn(async () => { throw new Error('syntax'); });
    vi.doMock('mermaid', () => ({ default: {
      initialize, render,
      mermaidAPI: { defaultConfig: { securityLevel: 'strict', flowchart: {}, theme: 'default', secure: [] } },
    } }));
    const host = { dataset: {}, remove: vi.fn() };
    const append = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn(() => host), body: { append } });
    try {
      const { renderFrameDiagram } = await import('../diagram-frame.js');
      await expect(renderFrameDiagram('broken safety test', 'dark', 'contextspace-diagram-1')).rejects.toThrow('syntax');
      expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
        startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        htmlLabels: false, flowchart: { htmlLabels: false }, theme: 'dark',
        secure: expect.arrayContaining(['secure', 'securityLevel', 'flowchart', 'theme', 'htmlLabels']),
      }));
      expect(append).toHaveBeenCalledWith(host);
      expect(render).toHaveBeenCalledWith(expect.stringMatching(/^contextspace-diagram-/), 'broken safety test', host);
      expect(host.remove).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('mermaid');
    }
  });

  it('uses only an accTitle line for the image alternative', () => {
    expect(diagramAlt('flowchart LR\n  accTitle: Request checks\n A-->B')).toBe('Request checks');
    expect(diagramAlt('sequenceDiagram\r\naccTitle:  Sign in  \r\nA->>B: Hello')).toBe('Sign in');
    expect(diagramAlt('flowchart LR\nA[accTitle: not a title]')).toBe('Diagram');
    expect(diagramAlt('flowchart LR\naccTitle:   \nA-->B')).toBe('Diagram');
  });
});

describe('fix1 Mermaid diagnostics and loading recovery', () => {
  it('keeps the parse line and expected/got tokens without echoing source or its pointer', async () => {
    const { shortDiagramError } = await import('./diagram.js');
    expect(shortDiagramError(new Error("Parse error on line 2:\n...A[Save (draft)] --> B[End]\n------------^\nExpecting 'SQE', got 'PS'")))
      .toBe("Parse error on line 2: Expecting 'SQE', got 'PS'");
  });

  it('reports only the unknown-type diagnostic without echoing untrusted source', async () => {
    const { shortDiagramError } = await import('./diagram.js');
    expect(shortDiagramError(new Error('No diagram type detected matching given configuration for text: private source')))
      .toBe('No diagram type detected');
  });

  it('bounds a long diagnostic while keeping the got token', async () => {
    const { shortDiagramError } = await import('./diagram.js');
    const result = shortDiagramError(new Error(`Parse error on line 42:\nsecret excerpt\n---^\nExpecting ${"'TOKEN', ".repeat(100)}got 'PS'`));
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toMatch(/^Parse error on line 42: Expecting /);
    expect(result).toMatch(/got 'PS'$/);
    expect(result).not.toContain('secret excerpt');
    expect(shortDiagramError(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(200);
  });

  it('does not cache an unavailable Mermaid load and retries the same source and theme', async () => {
    const render = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('<svg/>');
    const draw = createDiagramCache(render);
    expect(await draw('retry', 'light')).toBeNull();
    expect(await draw('retry', 'light')).toHaveProperty('url');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('treats an actual dynamic import rejection as unavailable rather than broken source', async () => {
    vi.doMock('mermaid', () => { throw new Error('Failed to fetch dynamically imported module'); });
    try {
      const { renderFrameDiagram } = await import('../diagram-frame.js');
      expect(await renderFrameDiagram('import-retry', 'light', 'contextspace-diagram-2')).toBeNull();
      vi.doMock('mermaid', () => ({ default: { mermaidAPI: { defaultConfig: {} }, initialize: () => { throw new Error('Parse error on line 2:'); } } }));
      await expect(renderFrameDiagram('import-retry', 'light', 'contextspace-diagram-3')).rejects.toThrow('Parse error on line 2:');
    } finally { vi.doUnmock('mermaid'); }
  });
});

describe('fix2 readable cards and human diagnostics', () => {
  it('crops a large diagram at 75 percent instead of shrinking it to fit', async () => {
    const { diagramCardLayout } = await import('./diagram.js');
    const layout = diagramCardLayout({ width: 800, height: 900 }, { width: 300, height: 80 });
    expect(layout.scale).toBe(0.75);
    expect(layout.width).toBe(600);
    expect(layout.height).toBe(675);
    expect(layout.cropRight).toBe(true);
    expect(layout.cropBottom).toBe(true);
  });
  it('keeps a small diagram whole at natural size and fits a medium one above the minimum', async () => {
    const { diagramCardLayout } = await import('./diagram.js');
    expect(diagramCardLayout({ width: 100, height: 50 }, { width: 300, height: 80 }))
      .toEqual({ scale: 1, width: 100, height: 50, cropRight: false, cropBottom: false });
    expect(diagramCardLayout({ width: 360, height: 96 }, { width: 300, height: 80 }))
      .toEqual({ scale: 5 / 6, width: 300, height: 80, cropRight: false, cropBottom: false });
  });
  it('keeps the visible size at least 75 percent through the Board camera zoom', async () => {
    const { diagramCardLayout } = await import('./diagram.js');
    const layout = diagramCardLayout({ width: 800, height: 900 }, { width: 300, height: 80 }, 0.9);
    expect(layout.width * 0.9).toBeGreaterThanOrEqual(800 * 0.75);
    expect(layout.height * 0.9).toBeGreaterThanOrEqual(900 * 0.75);
    expect(layout.cropRight && layout.cropBottom).toBe(true);
  });
  it('names the mistake and shows its exact source line without grammar tokens', async () => {
    const { diagramProblem } = await import('./diagram.js');
    const error = "Parse error on line 2: Expecting 'SQE', got 'PS'";
    expect(diagramProblem('flowchart TD\r\nA[Save (draft)] --> B[End]', error)).toEqual({
      message: "Can't draw this diagram: line 2 has a mistake", sourceLine: 'A[Save (draft)] --> B[End]',
    });
    expect(error).toContain("Expecting 'SQE', got 'PS'");
  });
  it('explains an unknown type and keeps a fallback diagnostic for missing or out-of-range lines', async () => {
    const { diagramProblem } = await import('./diagram.js');
    expect(diagramProblem('what is this?', 'No diagram type detected')).toEqual({
      message: "Can't draw this diagram: Mermaid does not know this kind of diagram",
    });
    for (const error of ['Parse error on line 99:', 'Unsupported SVG']) {
      expect(diagramProblem('flowchart TD\nA-->B', error)).toEqual({ message: "Can't draw this diagram", detail: error });
    }
  });
});

describe('fix3 resource refusal and pending entries', () => {
  it.each([
    'flowchart TD\nA@{ img: "https://example.invalid/e4-review-canary", h: 40, w: 40 }',
    'flowchart TD\nA@{ icon: "logos:github" }',
    'flowchart TD\nA["A"]\nclassDef x fill:url(https://example.invalid/canary)',
    'flowchart TD\nA["A"]\nstyle A background:url(https://example.invalid/canary)',
    '@import "https://example.invalid/canary";',
    'flowchart TD\nA["A"]\nclick A href "https://example.invalid/canary"',
    'flowchart TD\nA["//example.invalid/canary"]',
    'flowchart TD\nA["data:image/svg+xml,x"]',
  ])('refuses resource-bearing source before invoking the renderer: %s', async (source) => {
    const render = vi.fn(async () => '<svg/>');
    const draw = createDiagramCache(render);
    expect(await draw(source, 'light')).toEqual({ error: 'It asks to load something from outside.' });
    expect(render).not.toHaveBeenCalled();
  });
  it('allows ordinary labels and plain styles that name no resource', async () => {
    const { diagramResourceReason } = await import('./diagramSafety.js');
    expect(diagramResourceReason('flowchart TD\nA["Image processing (local)"] --> B["Save draft"]\nstyle A fill:#fff')).toBeNull();
  });
  it('retains pending entries even when more than 100 distinct sources are queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let duringSettlement: Promise<unknown> | undefined;
    const render = vi.fn(async (source: string) => {
      await gate;
      if (source === 'first pending' && !duringSettlement) queueMicrotask(() => queueMicrotask(() => {
        duringSettlement = draw('first pending', 'light');
      }));
      return '<svg/>';
    });
    const draw = createDiagramCache(render);
    const first = draw('first pending', 'light');
    const queued = Array.from({ length: 101 }, (_, i) => draw(`pending ${i}`, 'light'));
    const again = draw('first pending', 'light');
    release();
    await Promise.all([first, again, ...queued]);
    expect(again).toBe(first);
    expect(duringSettlement).toBe(first);
    await duringSettlement;
    expect(render).toHaveBeenCalledTimes(102);
  });
});
