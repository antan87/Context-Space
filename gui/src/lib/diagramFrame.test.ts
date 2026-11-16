import { afterEach, describe, expect, it, vi } from 'vitest';

// Dynamic import makes these assertions fail individually before the module exists.
afterEach(() => vi.useRealTimers());
describe('fix3 isolated frame protocol', () => {
  it('uses an opaque-frame CSP with only its own classic script and inert image/font data', async () => {
    const { diagramFrameDocument } = await import('./diagramFrame.js');
    const html = diagramFrameDocument('http://localhost:4571/diagram-frame.js', 'http://localhost:4571');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('script-src http://localhost:4571/diagram-frame.js');
    expect(html).toContain("style-src 'unsafe-inline'");
    expect(html).toContain('img-src data: blob:');
    expect(html).toContain('font-src data:');
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain('<script src="http://localhost:4571/diagram-frame.js"></script>');
  });
  it('checks the sending window and request id, and reuses one frame', async () => {
    const { createDiagramFrameClient } = await import('./diagramFrame.js');
    let receive!: (event: MessageEvent) => void;
    const source = {} as Window;
    const post = vi.fn();
    const open = vi.fn((handler: typeof receive) => { receive = handler; return { source, post, dispose: vi.fn() }; });
    const draw = createDiagramFrameClient(open, 1000);
    const first = draw('A-->B', 'light', 'one');
    receive({ source: {} as Window, origin: 'null', data: { kind: 'diagram-ready' } } as MessageEvent);
    expect(post).not.toHaveBeenCalled();
    receive({ source, origin: 'null', data: { kind: 'diagram-ready' } } as MessageEvent);
    expect(post).toHaveBeenCalledWith({ kind: 'diagram-render', id: 'one', source: 'A-->B', theme: 'light' });
    let settled = false;
    void first.then(() => { settled = true; });
    receive({ source, origin: 'null', data: { kind: 'diagram-result', id: 'wrong', svg: '<svg/>' } } as MessageEvent);
    receive({ source: {} as Window, origin: 'null', data: { kind: 'diagram-result', id: 'one', svg: '<svg/>' } } as MessageEvent);
    await Promise.resolve();
    expect(settled).toBe(false);
    receive({ source, origin: 'null', data: { kind: 'diagram-result', id: 'one', svg: '<svg/>' } } as MessageEvent);
    expect(await first).toBe('<svg/>');
    const second = draw('C-->D', 'dark', 'two');
    expect(open).toHaveBeenCalledTimes(1);
    receive({ source, origin: 'null', data: { kind: 'diagram-result', id: 'two', error: 'broken' } } as MessageEvent);
    await expect(second).rejects.toThrow('broken');
  });
  it('times out and replaces a silent frame, allowing the next render to finish', async () => {
    vi.useFakeTimers();
    const { createDiagramFrameClient } = await import('./diagramFrame.js');
    let receive!: (event: MessageEvent) => void;
    const source = {} as Window;
    const dispose = vi.fn();
    const open = vi.fn((handler: typeof receive) => { receive = handler; return { source, post: vi.fn(), dispose }; });
    const draw = createDiagramFrameClient(open, 50);
    const hung = draw('A-->B', 'light', 'hung');
    const rejection = expect(hung).rejects.toThrow('did not respond');
    await vi.advanceTimersByTimeAsync(51);
    await rejection;
    expect(dispose).toHaveBeenCalledOnce();
    const next = draw('C-->D', 'light', 'next');
    receive({ source, origin: 'null', data: { kind: 'diagram-ready' } } as MessageEvent);
    receive({ source, origin: 'null', data: { kind: 'diagram-result', id: 'next', svg: '<svg/>' } } as MessageEvent);
    expect(await next).toBe('<svg/>');
    expect(open).toHaveBeenCalledTimes(2);
  });
});
