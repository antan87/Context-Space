/**
 * @module lib/clipboard
 * Cross-browser safe clipboard helper with textarea fallback for non-secure contexts.
 */
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

export async function safeCopyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // Clipboard permissions are exposed in some local Electron/webview
  // contexts even when `isSecureContext` is false. Try the native API first
  // and use the DOM fallback only when it rejects or is unavailable.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to fallback
    }
  }

  try {
    if (typeof document === 'undefined' || !document.body) return false;

    const activeElement = document.activeElement as HTMLElement | null;
    const editable = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement ? activeElement : null;
    const selectionStart = editable?.selectionStart ?? null;
    const selectionEnd = editable?.selectionEnd ?? null;
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      return document.execCommand('copy');
    } finally {
      textArea.remove();
      // Copying from the terminal/chat must not leave focus in the hidden
      // fallback textarea; restore both keyboard focus and any selection.
      if (activeElement && activeElement.isConnected) {
        activeElement.focus({ preventScroll: true });
        if (editable && selectionStart !== null && selectionEnd !== null) {
          editable.setSelectionRange(selectionStart, selectionEnd);
        }
      }
      if (selection && range) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  } catch {
    return false;
  }
}

/** Recover text from rich clipboard formats that omit text/plain. */
export function clipboardHtmlToText(html: string): string {
  if (!html) return '';
  // Parse into plain JavaScript objects, never into browser DOM nodes. The
  // HTML tree builder handles malformed clipboard markup and full documents.
  const documentTree = parse(html);
  const isElement = (node: DefaultTreeAdapterTypes.ChildNode): node is DefaultTreeAdapterTypes.Element => 'tagName' in node;
  const htmlElement = documentTree.childNodes.find(node => isElement(node) && node.tagName === 'html');
  const body = htmlElement && isElement(htmlElement)
    ? htmlElement.childNodes.find(node => isElement(node) && node.tagName === 'body')
    : null;
  if (!body || !isElement(body)) return '';
  const blocks = new Set(['address', 'article', 'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'p', 'pre', 'section', 'tr']);
  let text = '';
  const lineBreak = () => { if (text && !text.endsWith('\n')) text += '\n'; };
  const visit = (node: DefaultTreeAdapterTypes.ChildNode): void => {
    if ('value' in node) { text += node.value; return; }
    if (!isElement(node) || ['script', 'style', 'template'].includes(node.tagName)) return;
    if (node.tagName === 'br') { lineBreak(); return; }
    const block = blocks.has(node.tagName);
    if (block) lineBreak();
    node.childNodes.forEach(visit);
    if (block) lineBreak();
  };
  body.childNodes.forEach(visit);
  return text.replace(/^\n+|\n+$/g, '');
}

/** Read plain text first, then rich clipboard text when native apps omit text/plain. */
export async function readClipboardText(): Promise<string> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable');
  try {
    const plain = await navigator.clipboard.readText();
    if (plain) return plain;
  } catch { /* Some clipboard providers expose only HTML through read(). */ }
  if (!navigator.clipboard.read) throw new Error('Clipboard text unavailable');
  const items = await navigator.clipboard.read();
  for (const item of items) {
    if (item.types.includes('text/plain')) {
      const plain = await (await item.getType('text/plain')).text();
      if (plain) return plain;
    }
    if (item.types.includes('text/html')) {
      const rich = clipboardHtmlToText(await (await item.getType('text/html')).text());
      if (rich) return rich;
    }
  }
  return '';
}

export interface CopyPictureResult {
  ok: boolean;
  kind: 'image' | 'fallback-path' | 'failed' | 'skipped';
  message: string;
}

const MAX_RASTER_SIDE = 4096;

/** Returns whether `src` or `mime` represents an SVG image (including workspace `/documents/file?name=*.svg` URLs). */
export function isSvgPictureSource(src: string, mime?: string): boolean {
  if (mime === 'image/svg+xml') return true;
  if (!src) return false;
  if (/^data:image\/svg\+xml/i.test(src)) return true;
  try {
    const url = new URL(src, 'http://localhost');
    if (/\.svg$/i.test(url.pathname)) return true;
    const nameParam = url.searchParams.get('name');
    if (nameParam && /\.svg$/i.test(nameParam.trim())) return true;
  } catch {
    // Fallback check when src is not parseable as URL.
  }
  return /\.svg(?:$|[?#])/i.test(src);
}

function decodeDataSvgUrl(src: string): string | null {
  const match = /^data:image\/svg\+xml([^,]*),(.*)$/i.exec(src);
  if (!match) return null;
  const meta = match[1] ?? '';
  const payload = match[2] ?? '';
  if (/;base64/i.test(meta)) {
    try {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function positiveSvgLength(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.endsWith('%')) return null;
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(trimmed);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function setSvgAttr(openTag: string, name: string, value: string): string {
  const attrPattern = new RegExp(`(\\s${name})\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  if (attrPattern.test(openTag)) {
    return openTag.replace(attrPattern, ` ${name}="${value}"`);
  }
  if (openTag.endsWith('/>')) {
    return `${openTag.slice(0, -2)} ${name}="${value}"/>`;
  }
  return `${openTag.slice(0, -1)} ${name}="${value}">`;
}

function stripSvgSizeStyle(openTag: string): string {
  return openTag.replace(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i, (_full, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? '';
    const kept = raw
      .split(';')
      .map((decl) => decl.trim())
      .filter((decl) => decl && !/^(?:max-width|width|height)\s*:/i.test(decl))
      .join('; ');
    return kept ? ` style="${kept.replace(/"/g, '&quot;')}"` : '';
  });
}

/**
 * Normalizes root `<svg>` width/height attributes from `viewBox` (mirroring `diagram.ts`'s `renderSvg`),
 * replacing percentage widths/heights and inline width/max-width styles so Chromium rasterises the SVG at its intrinsic aspect ratio before 2× scaling.
 */
export function normalizeSvgForRaster(svgText: string): { svg: string; width: number; height: number } | null {
  const tagMatch = /<svg\b[^>]*>/i.exec(svgText);
  if (!tagMatch) return null;
  const openTag = tagMatch[0];
  const widthMatch = /\bwidth\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(openTag);
  const heightMatch = /\bheight\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(openTag);
  const viewBoxMatch = /\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(openTag);
  const viewBoxParts = (viewBoxMatch?.[1] ?? viewBoxMatch?.[2] ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const vbWidth = viewBoxParts.length >= 4 && Number.isFinite(viewBoxParts[2]) && viewBoxParts[2] > 0 ? viewBoxParts[2] : null;
  const vbHeight = viewBoxParts.length >= 4 && Number.isFinite(viewBoxParts[3]) && viewBoxParts[3] > 0 ? viewBoxParts[3] : null;

  let width = positiveSvgLength(widthMatch?.[1] ?? widthMatch?.[2]);
  let height = positiveSvgLength(heightMatch?.[1] ?? heightMatch?.[2]);
  if (width === null && height !== null && vbWidth && vbHeight) {
    width = (height * vbWidth) / vbHeight;
  } else if (height === null && width !== null && vbWidth && vbHeight) {
    height = (width * vbHeight) / vbWidth;
  } else if (width === null && height === null && vbWidth && vbHeight) {
    width = vbWidth;
    height = vbHeight;
  }
  if (width === null || height === null || width <= 0 || height <= 0) return null;

  const roundedWidth = Math.max(1, Math.round(width));
  const roundedHeight = Math.max(1, Math.round(height));
  let updatedTag = stripSvgSizeStyle(openTag);
  if (!/\bxmlns\s*=/i.test(updatedTag)) {
    updatedTag = setSvgAttr(updatedTag, 'xmlns', 'http://www.w3.org/2000/svg');
  }
  updatedTag = setSvgAttr(updatedTag, 'width', String(roundedWidth));
  updatedTag = setSvgAttr(updatedTag, 'height', String(roundedHeight));
  const updatedSvg = `${svgText.slice(0, tagMatch.index)}${updatedTag}${svgText.slice(tagMatch.index + openTag.length)}`;
  return { svg: updatedSvg, width: roundedWidth, height: roundedHeight };
}

function defaultLoadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    try {
      const url = new URL(src, window.location.href);
      if (url.protocol !== 'data:' && url.origin !== window.location.origin) {
        img.crossOrigin = 'anonymous';
      }
    } catch {
      // Same-origin relative path or data URL: leave crossOrigin unset.
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load picture'));
    img.src = src;
  });
}

function scaledCanvasDimensions(baseWidth: number, baseHeight: number, scale: number): { width: number; height: number } {
  let width = Math.max(1, Math.round(baseWidth * scale));
  let height = Math.max(1, Math.round(baseHeight * scale));
  if (width > MAX_RASTER_SIDE || height > MAX_RASTER_SIDE) {
    const factor = MAX_RASTER_SIDE / Math.max(width, height);
    width = Math.max(1, Math.round(width * factor));
    height = Math.max(1, Math.round(height * factor));
  }
  return { width, height };
}

export interface RasterisePictureDeps {
  loadImage?: (src: string) => Promise<HTMLImageElement>;
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  fetchText?: (src: string) => Promise<string>;
}

/** Rasterises a picture (raster 1× or SVG / Mermaid diagram at 2×) into an `image/png` Blob. */
export async function rasterisePictureToPng(
  src: string,
  options?: { isSvg?: boolean; scale?: number; mime?: string },
  deps?: RasterisePictureDeps,
): Promise<Blob> {
  const isSvg = options?.isSvg ?? isSvgPictureSource(src, options?.mime);
  const scale = options?.scale ?? (isSvg ? 2 : 1);
  let effectiveSrc = src;
  let svgDimensions: { width: number; height: number } | null = null;

  if (isSvg) {
    let rawSvg = decodeDataSvgUrl(src);
    if (rawSvg === null && !src.startsWith('data:')) {
      const fetchText = deps?.fetchText ?? (async (target: string) => {
        const res = await fetch(target);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      });
      rawSvg = await fetchText(src);
    }
    if (rawSvg !== null) {
      const normalized = normalizeSvgForRaster(rawSvg);
      if (normalized) {
        svgDimensions = { width: normalized.width, height: normalized.height };
        effectiveSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized.svg)}`;
      }
    }
  }

  const loadImage = deps?.loadImage ?? defaultLoadImage;
  const img = await loadImage(effectiveSrc);
  const baseWidth = img.naturalWidth || svgDimensions?.width || img.width || 1;
  const baseHeight = img.naturalHeight || svgDimensions?.height || img.height || 1;
  const { width, height } = scaledCanvasDimensions(baseWidth, baseHeight, scale);

  const canvas = deps?.createCanvas
    ? deps.createCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode picture as PNG'));
    }, 'image/png');
  });
}

const SKIPPED: CopyPictureResult = { ok: false, kind: 'skipped', message: '' };

export interface CopyPictureDeps {
  rasterise?: () => Promise<Blob>;
  clipboardWrite?: (items: ClipboardItem[]) => Promise<void>;
  ClipboardItemCtor?: typeof ClipboardItem;
  copyTextFallback?: (text: string) => Promise<boolean>;
}

/**
 * Copies a picture to the system clipboard as `image/png` (rasterising SVG / Mermaid diagrams at 2× first).
 * Falls back to copying `fallbackPath` when ClipboardItem or clipboard image write is disallowed (e.g. plain HTTP).
 * `isCurrent` says whether this is still the newest copy: it is asked after the slow render/convert step and right before
 * anything is written, and a copy that is no longer the newest writes nothing (kind `skipped`), so it cannot overwrite a newer one.
 */
export async function copyPictureToClipboard(
  options: { src: string; fallbackPath?: string; fallbackLabel?: string; isSvg?: boolean; mime?: string; isCurrent?: () => boolean },
  deps?: CopyPictureDeps,
): Promise<CopyPictureResult> {
  const isSvg = options.isSvg ?? (
    isSvgPictureSource(options.src, options.mime) ||
    Boolean(options.fallbackPath && isSvgPictureSource(options.fallbackPath, options.mime))
  );
  const ClipboardItemCtor = deps && 'ClipboardItemCtor' in deps
    ? deps.ClipboardItemCtor
    : (typeof ClipboardItem !== 'undefined' ? ClipboardItem : undefined);
  const clipboardWrite = deps && 'clipboardWrite' in deps
    ? deps.clipboardWrite
    : (typeof navigator !== 'undefined' && navigator.clipboard?.write
      ? navigator.clipboard.write.bind(navigator.clipboard)
      : undefined);

  if (ClipboardItemCtor && clipboardWrite) {
    try {
      const pngBlob = deps?.rasterise
        ? await deps.rasterise()
        : await rasterisePictureToPng(options.src, { isSvg, mime: options.mime });
      if (options.isCurrent && !options.isCurrent()) return SKIPPED;
      await clipboardWrite([new ClipboardItemCtor({ 'image/png': pngBlob })]);
      return { ok: true, kind: 'image', message: 'Copied' };
    } catch {
      // Fall through to path fallback below.
    }
  }

  if (options.isCurrent && !options.isCurrent()) return SKIPPED;
  const copyFallback = deps?.copyTextFallback ?? safeCopyToClipboard;
  const fallback = options.fallbackPath?.trim() || options.src;
  const label = options.fallbackLabel?.trim() || 'path';
  if (fallback && await copyFallback(fallback)) {
    return {
      ok: true,
      kind: 'fallback-path',
      message: `Copied ${label} (image copy unavailable)`,
    };
  }
  return { ok: false, kind: 'failed', message: 'Could not copy picture' };
}
