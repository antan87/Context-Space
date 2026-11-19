import { describe, expect, it, vi } from 'vitest';
import {
  copyPictureToClipboard,
  isSvgPictureSource,
  normalizeSvgForRaster,
  rasterisePictureToPng,
} from './clipboard.js';

describe('clipboard picture helpers', () => {
  it('detects SVG sources from data URLs, paths, workspace document query names, and MIME types', () => {
    expect(isSvgPictureSource('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E')).toBe(true);
    expect(isSvgPictureSource('/api/workspace/ws/documents/file?name=wide.svg')).toBe(true);
    expect(isSvgPictureSource('/assets/icon.SVG?v=2')).toBe(true);
    expect(isSvgPictureSource('/api/workspace/ws/documents/file?name=shot.png')).toBe(false);
    expect(isSvgPictureSource('/api/workspace/ws/documents/file?name=raw', 'image/svg+xml')).toBe(true);
  });

  it('normalizes SVG dimensions from viewBox like diagram.ts before 2x rasterising', () => {
    const normalized = normalizeSvgForRaster('<svg viewBox="0 0 240 120" width="100%" style="max-width:240px; width: 100%; background:#fff"></svg>');
    expect(normalized?.width).toBe(240);
    expect(normalized?.height).toBe(120);
    expect(normalized?.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(normalized?.svg).toContain('width="240"');
    expect(normalized?.svg).toContain('height="120"');
    expect(normalized?.svg).toContain('style="background:#fff"');
    expect(normalized?.svg).not.toContain('max-width');
  });

  it('decodes UTF-8 base64 SVG data URLs without mojibake before rasterising', async () => {
    const utf8Svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><text>A → B (2×)</text></svg>';
    const base64 = Buffer.from(utf8Svg, 'utf8').toString('base64');
    const src = `data:image/svg+xml;base64,${base64}`;
    let loadedSrc = '';
    const fakeBlob = new Blob(['png-bytes'], { type: 'image/png' });

    await rasterisePictureToPng(src, { isSvg: true }, {
      loadImage: async (nextSrc) => {
        loadedSrc = nextSrc;
        return { naturalWidth: 100, naturalHeight: 50 } as HTMLImageElement;
      },
      createCanvas: (w, h) => ({
        width: w,
        height: h,
        getContext: () => ({ drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D,
        toBlob: (cb) => cb(fakeBlob),
      }) as unknown as HTMLCanvasElement,
    });

    expect(decodeURIComponent(loadedSrc.split(',')[1]!)).toContain('A → B (2×)');
  });

  it('rasterises SVG and Mermaid diagrams to PNG at 2x scale', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect width="200" height="100"/></svg>';
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const drawImage = vi.fn();
    let createdWidth = 0;
    let createdHeight = 0;
    const fakeBlob = new Blob(['png-bytes'], { type: 'image/png' });

    const blob = await rasterisePictureToPng(src, { isSvg: true }, {
      loadImage: async () => ({ naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement),
      createCanvas: (w, h) => {
        createdWidth = w;
        createdHeight = h;
        return {
          width: w,
          height: h,
          getContext: () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
          toBlob: (cb) => cb(fakeBlob),
        } as unknown as HTMLCanvasElement;
      },
    });

    expect(createdWidth).toBe(400);
    expect(createdHeight).toBe(200);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 400, 200);
    expect(blob).toBe(fakeBlob);
  });

  it('writes raster picture as image/png via ClipboardItem at 1x scale', async () => {
    const fakeBlob = new Blob(['png-data'], { type: 'image/png' });
    const write = vi.fn().mockResolvedValue(undefined);
    let itemData: Record<string, Blob> | undefined;
    class FakeClipboardItem {
      constructor(items: Record<string, Blob>) {
        itemData = items;
      }
    }

    const result = await copyPictureToClipboard(
      { src: '/api/workspace/ws/documents/file?name=pic.png', fallbackPath: 'pic.png' },
      {
        rasterise: async () => fakeBlob,
        clipboardWrite: write,
        ClipboardItemCtor: FakeClipboardItem as unknown as typeof ClipboardItem,
        copyTextFallback: vi.fn(),
      },
    );

    expect(result).toEqual({ ok: true, kind: 'image', message: 'Copied' });
    expect(itemData).toEqual({ 'image/png': fakeBlob });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('falls back to copying picture path and says so when ClipboardItem or clipboard.write is rejected', async () => {
    const copyTextFallback = vi.fn().mockResolvedValue(true);

    const unavailable = await copyPictureToClipboard(
      { src: '/api/workspace/ws/documents/file?name=shot.png', fallbackPath: 'assets/shot.png' },
      {
        rasterise: async () => new Blob(['png'], { type: 'image/png' }),
        clipboardWrite: undefined,
        ClipboardItemCtor: undefined,
        copyTextFallback,
      },
    );

    expect(copyTextFallback).toHaveBeenCalledWith('assets/shot.png');
    expect(unavailable).toEqual({
      ok: true,
      kind: 'fallback-path',
      message: 'Copied path (image copy unavailable)',
    });

    const copyTextFallback2 = vi.fn().mockResolvedValue(true);
    class FakeClipboardItem {
      constructor() {}
    }
    const rejected = await copyPictureToClipboard(
      { src: '/api/workspace/ws/documents/file?name=shot.png', fallbackPath: 'assets/shot.png' },
      {
        rasterise: async () => new Blob(['png'], { type: 'image/png' }),
        clipboardWrite: async () => { throw new Error('NotAllowedError'); },
        ClipboardItemCtor: FakeClipboardItem as unknown as typeof ClipboardItem,
        copyTextFallback: copyTextFallback2,
      },
    );

    expect(copyTextFallback2).toHaveBeenCalledWith('assets/shot.png');
    expect(rejected).toEqual({
      ok: true,
      kind: 'fallback-path',
      message: 'Copied path (image copy unavailable)',
    });
  });

  it('reports failed when both image copy and fallback path copy fail', async () => {
    const result = await copyPictureToClipboard(
      { src: '/api/workspace/ws/documents/file?name=shot.png', fallbackPath: 'assets/shot.png' },
      {
        rasterise: async () => { throw new Error('decode failed'); },
        clipboardWrite: undefined,
        ClipboardItemCtor: undefined,
        copyTextFallback: async () => false,
      },
    );
    expect(result).toEqual({ ok: false, kind: 'failed', message: 'Could not copy picture' });
  });

  it('writes nothing when a newer copy started while this one was still rendering (image and path fallback)', async () => {
    class FakeClipboardItem { constructor(readonly data: Record<string, Blob>) {} }
    let current = true;
    const write = vi.fn().mockResolvedValue(undefined);
    const copyTextFallback = vi.fn().mockResolvedValue(true);
    const slow = async () => { current = false; return new Blob(['png'], { type: 'image/png' }); };
    const stale = await copyPictureToClipboard(
      { src: '/a.png', fallbackPath: 'a.png', isCurrent: () => current },
      { rasterise: slow, clipboardWrite: write, ClipboardItemCtor: FakeClipboardItem as unknown as typeof ClipboardItem, copyTextFallback },
    );
    expect(stale.kind).toBe('skipped');
    expect(write).not.toHaveBeenCalled();
    expect(copyTextFallback).not.toHaveBeenCalled();

    const staleFallback = await copyPictureToClipboard(
      { src: '/a.png', fallbackPath: 'a.png', isCurrent: () => false },
      { rasterise: async () => new Blob(['x']), clipboardWrite: undefined, ClipboardItemCtor: undefined, copyTextFallback },
    );
    expect(staleFallback.kind).toBe('skipped');
    expect(copyTextFallback).not.toHaveBeenCalled();
  });
});
