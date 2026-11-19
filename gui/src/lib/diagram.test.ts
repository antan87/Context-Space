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

describe('D2 readable wide diagrams in the reader', () => {
  it('fits a diagram to the reader width when scale stays above the readable floor', async () => {
    const { diagramReaderLayout } = await import('./diagram.js');
    const layout = diagramReaderLayout({ width: 1756, height: 709 }, 1360);
    expect(layout.scrolls).toBe(false);
    expect(layout.scale).toBeCloseTo(1360 / 1756, 6);
    expect(layout.width).toBe(1360);
    expect(layout.height).toBeCloseTo(709 * (1360 / 1756), 6);
  });

  it('scales down to 0.75 at the exact readable limit without scrolling', async () => {
    const { diagramReaderLayout } = await import('./diagram.js');
    expect(diagramReaderLayout({ width: 800, height: 200 }, 600)).toEqual({
      scale: 0.75, width: 600, height: 150, scrolls: false,
    });
  });

  it('keeps the readable scale and scrolls when even the readable scale is too wide', async () => {
    const { diagramReaderLayout } = await import('./diagram.js');
    const layout = diagramReaderLayout({ width: 1756, height: 709 }, 413);
    expect(layout.scrolls).toBe(true);
    expect(layout.scale).toBe(0.75);
    expect(layout.width).toBe(1756 * 0.75);
    expect(layout.height).toBe(709 * 0.75);

    const largerFont = diagramReaderLayout({ width: 1000, height: 400 }, 500, 24);
    expect(largerFont).toEqual({ scale: 0.5, width: 500, height: 200, scrolls: false });

    const smallerFont = diagramReaderLayout({ width: 1000, height: 400 }, 500, 14);
    expect(smallerFont.scrolls).toBe(true);
    expect(smallerFont.scale).toBeCloseTo(12 / 14, 6);
    expect(smallerFont.width).toBeCloseTo(1000 * (12 / 14), 6);
  });

  it('never upscales a small diagram whose text is already at least 12 px, and scales smaller-text diagrams up to 1.5x', async () => {
    const { diagramReaderLayout } = await import('./diagram.js');
    expect(diagramReaderLayout({ width: 360, height: 57 }, 900)).toEqual({
      scale: 1, width: 360, height: 57, scrolls: false,
    });
    expect(diagramReaderLayout({ width: 200, height: 100 }, 900, 12)).toEqual({
      scale: 1, width: 200, height: 100, scrolls: false,
    });
    // Gantt dates (10 px) scale up to 1.2x so labels reach 12 px, and scroll sideways when wider than the reader.
    expect(diagramReaderLayout({ width: 200, height: 100 }, 900, 10)).toEqual({
      scale: 1.2, width: 240, height: 120, scrolls: false,
    });
    const wideGantt = diagramReaderLayout({ width: 1264, height: 172 }, 413, 10);
    expect(wideGantt.scale).toBeCloseTo(1.2, 6);
    expect(wideGantt.width).toBeCloseTo(1264 * 1.2, 6);
    expect(wideGantt.height).toBeCloseTo(172 * 1.2, 6);
    expect(wideGantt.scrolls).toBe(true);
    // Class multiplicities (11 px) scale up to ~1.09x, scrolling when narrower than the scaled width.
    const mult = diagramReaderLayout({ width: 301, height: 345 }, 413, 11);
    expect(mult.scale).toBeCloseTo(12 / 11, 6);
    expect(mult.scrolls).toBe(false);
    const multScroll = diagramReaderLayout({ width: 301, height: 345 }, 244, 11);
    expect(multScroll.scale).toBeCloseTo(12 / 11, 6);
    expect(multScroll.scrolls).toBe(true);
    // Upscaling is capped at 1.5x even when labels are smaller than 8 px.
    expect(diagramReaderLayout({ width: 300, height: 100 }, 900, 8)).toEqual({
      scale: 1.5, width: 450, height: 150, scrolls: false,
    });
    expect(diagramReaderLayout({ width: 300, height: 100 }, 900, 6)).toEqual({
      scale: 1.5, width: 450, height: 150, scrolls: false,
    });
  });

  it('reads the real text font size from SVG while ignoring tooltips, unused rules and sequence numbers', async () => {
    const { diagramSvgFontSize } = await import('./diagram.js');
    expect(diagramSvgFontSize('<svg/>')).toBe(16);
    expect(diagramSvgFontSize(
      '<svg id="d1"><style>#d1{font-size:16px}#d1 div.mermaidTooltip{font-size:12px}</style><g><text><tspan>font-size: 8px</tspan></text></g></svg>',
    )).toBe(16);
    expect(diagramSvgFontSize(
      '<svg id="d2"><style>#d2{font-size:16px}</style><text style="font-size: 16px;">Actor</text><text font-size="12px" class="sequenceNumber">1</text></svg>',
    )).toBe(16);
    expect(diagramSvgFontSize(
      '<svg id="d3"><style>#d3{font-size:16px}#d3 .edgeLabel .label{font-size:14px}</style><g class="edgeLabel"><g class="label"><text>places</text></g></g><text>Entity</text></svg>',
    )).toBe(14);
    expect(diagramSvgFontSize(
      '<svg id="d4"><style>#d4{font-size:20px}#d4 g.classGroup text{font-size:10px}</style><g class="node"><text>ClassA</text></g></svg>',
    )).toBe(20);
    expect(diagramSvgFontSize(
      '<svg id="d5"><style>#d5{font-size:16px}</style><text font-size="11">Task A</text></svg>',
    )).toBe(11);
    expect(diagramSvgFontSize(
      '<svg id="d7"><style>#d7{font-size:16px}#tooltip{font-size:10px}</style><text>Main</text></svg>',
    )).toBe(16);
    expect(diagramSvgFontSize(
      '<svg id="d8"><style>#d8{font-size:20px}#d8 svg{font-size:16px}</style><text>Main</text></svg>',
    )).toBe(20);
    expect(diagramSvgFontSize(
      '<svg id="d9"><style>#d9{font-size:16px}#d9 .edgeLabel&gt;text{font-size:12px}</style><g class="edgeLabel"><text>edge</text></g></svg>',
    )).toBe(12);
    expect(diagramSvgFontSize(
      '<svg id="d10"><style>#d10{font-size:16px}</style><g data-edge="A->B"><text data-label="a>b" font-size="11">hi</text></g></svg>',
    )).toBe(11);
    expect(diagramSvgFontSize(
      '<svg id="d11"><style>#d11{font-size:16px}</style><g style="font-size: 12px"><text style="font-size: 0.75em">em-child</text><text style="font-size: 1rem">rem-child</text></g></svg>',
    )).toBe(9);
    expect(diagramSvgFontSize(
      '<svg id="d12"><style>#d12{font-size:16px}</style><text>Label<title>tip</title></text></svg>',
    )).toBe(16);
    // Root #svgId font-size feeds rem resolution on descendants.
    expect(diagramSvgFontSize(
      '<svg id="d13"><style>#d13{font-size:20px}</style><text style="font-size:1rem">Root</text></svg>',
    )).toBe(20);
  });

  it('reads percentages, var() fallbacks and custom properties, gantt, class multiplicities and ignores autonumber badges', async () => {
    const { diagramSvgFontSize } = await import('./diagram.js');
    // Flowchart classDef with 75% (both CSS rule and Mermaid htmlLabels:false nested label + text inline 75% => 16 * 0.75 * 0.75 = 9 px).
    expect(diagramSvgFontSize(
      '<svg id="f1"><style>#f1{font-size:16px}#f1 .small{font-size:75%}</style><g class="small"><text>Small</text></g><text>Normal</text></svg>',
    )).toBe(12);
    expect(diagramSvgFontSize(
      '<svg id="f2"><style>#f2{font-size:16px}#f2 .small rect{font-size:75%!important;}</style><g class="node small"><g class="label" style="font-size:75% !important"><text style="font-size:75% !important"><tspan>Alpha</tspan></text></g></g><g class="node"><text>Beta</text></g></svg>',
    )).toBe(9);
    // var(--x, fallback): uses fallback when undefined, or custom property from <style> / inline <svg> style when defined.
    expect(diagramSvgFontSize(
      '<svg id="v1"><style>#v1{font-size:16px}#v1 .usecase-label{font-size:var(--mermaid-usecase-font-size, 12px)}</style><text class="usecase-label">Sign in</text><text>Other</text></svg>',
    )).toBe(12);
    expect(diagramSvgFontSize(
      '<svg id="v2"><style>:root{--mermaid-usecase-font-size:10px;}#v2{font-size:16px}#v2 .usecase-label{font-size:var(--mermaid-usecase-font-size, 12px)}</style><text class="usecase-label">Sign in</text></svg>',
    )).toBe(10);
    expect(diagramSvgFontSize(
      '<svg id="v3" style="--mermaid-usecase-font-size: 10.5px;"><style>#v3{font-size:16px}#v3 .usecase-label{font-size:var(--mermaid-usecase-font-size, 12px)}</style><text class="usecase-label">Sign in</text></svg>',
    )).toBe(10.5);
    expect(diagramSvgFontSize(
      '<svg id="v4"><style>#v4{font-size:16px}#v4 .lbl{font-size:var(--missing, var(--inner, 75%))}</style><text class="lbl">Nested</text></svg>',
    )).toBe(12);
    // Gantt: 10 px tick dates set the scale, while task labels are 11 px and tooltip CSS rules are ignored.
    expect(diagramSvgFontSize(
      '<svg id="g1"><style>#g1{font-size:16px}#g1 div.mermaidTooltip{font-size:8px}</style><g font-size="10" class="tick"><text>2026-01-04</text></g><text class="taskText" font-size="11">Design</text></svg>',
    )).toBe(10);
    // Class multiplicities: .edgeTerminals at 11 px set the scale, ignoring unused g.classGroup text (10 px) and title (18 px).
    expect(diagramSvgFontSize(
      '<svg id="c1"><style>#c1{font-size:16px}#c1 g.classGroup text{font-size:10px}#c1 .edgeTerminals{font-size:11px}#c1 .classTitleText{font-size:18px}</style><g class="edgeTerminals"><g class="label"><text><tspan>1</tspan></text></g></g><text class="classTitleText">Order</text></svg>',
    )).toBe(11);
    // Sequence diagram with autonumber: .sequenceNumber badges (even at 10 px) are ignored so actor/message labels govern.
    expect(diagramSvgFontSize(
      '<svg id="s1"><style>#s1{font-size:16px}</style><text class="actor">Payroll admin</text><text font-size="10px" class="sequenceNumber">1</text></svg>',
    )).toBe(16);
  });

  it('includes the parsed SVG font size on cached drawings', async () => {
    const draw = createDiagramCache(async () => '<svg id="d6"><style>#d6{font-size:18px}</style><text>Node</text></svg>');
    const result = await draw('flowchart LR\nA-->B', 'light');
    expect(result).toHaveProperty('fontSize', 18);
  });

  it('offers full screen in the scroll hint only when the host says it is available', async () => {
    const { diagramScrollHint } = await import('./diagram.js');
    expect(diagramScrollHint('available')).toBe('Wider than the reader: scroll sideways, or open full screen');
    expect(diagramScrollHint('fullscreen')).toBe('Wider than the reader: scroll sideways');
    expect(diagramScrollHint('none')).toBe('Wider than the space here: scroll sideways');
  });
});
