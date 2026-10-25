import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { ChatMarkdown, type MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { cn } from '../../lib/utils.js';
import {
  buildPreviewDocument,
  CARRIED_ATTRIBUTES,
  isStyleSheetHref,
  safeAssetUrl,
  sanitizeOptions,
  type HeadAssets,
} from './previewPolicy.js';

export type DocumentKind = 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'download';
export interface DocumentPreviewData {
  name: string;
  kind: DocumentKind;
  content?: string;
  size?: number;
  modifiedAt?: string;
}

/**
 * Reads back everything a real AI-authored page needs that DOMPurify's body-only output throws
 * away. Verified against the HTML that actually exists in these workspaces: most of it carries its
 * entire design system in a single inline <style> inside <head>, and keys it off attributes on
 * <html>/<body> such as `data-theme` and Tailwind utility classes. Losing any one of the three
 * leaves an unstyled page.
 *
 * Only what the owner approved comes back: remote stylesheets and inline CSS always (Q1), remote
 * scripts only for a trusted document (Q5). Inline scripts are never hoisted, so trusting a
 * document does not hand it an inline code path.
 */
function collectHeadAssets(html: string, trusted: boolean): HeadAssets {
  const assets: HeadAssets = { stylesheets: [], scripts: [], styles: [], htmlAttributes: [], bodyAttributes: [] };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return assets;
  }
  for (const link of Array.from(doc.querySelectorAll('link'))) {
    if (!isStyleSheetHref(link.getAttribute('href'), link.getAttribute('rel'))) continue;
    const href = safeAssetUrl(link.getAttribute('href'));
    if (href && !assets.stylesheets.includes(href)) assets.stylesheets.push(href);
  }
  for (const style of Array.from(doc.head.querySelectorAll('style'))) {
    const css = style.textContent ?? '';
    if (css.trim()) assets.styles.push(css);
  }
  if (trusted) {
    for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
      const src = safeAssetUrl(script.getAttribute('src'));
      if (src && !assets.scripts.includes(src)) assets.scripts.push(src);
    }
  }
  for (const [element, target] of [[doc.documentElement, assets.htmlAttributes], [doc.body, assets.bodyAttributes]] as const) {
    if (!element) continue;
    for (const name of CARRIED_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value) target.push(`${name}=${value}`);
    }
  }
  return assets;
}

/**
 * `expanded` is set by DocumentViewer when the document fills the app viewport. Every branch that
 * has an intrinsic height has to opt out of its capped height there, otherwise maximizing only
 * rescales a letterboxed frame.
 */
export function DocumentPreview({ preview, fileUrl, raw, expanded = false, trusted = false, links }: { preview: DocumentPreviewData; fileUrl: string; raw: boolean; expanded?: boolean; trusted?: boolean; links?: MarkdownDocumentLinks }) {
  const htmlDocument = useMemo(() => {
    if (preview.kind !== 'html' || raw) return '';
    const source = preview.content ?? '';
    return buildPreviewDocument({
      body: DOMPurify.sanitize(source, sanitizeOptions()),
      assets: collectHeadAssets(source, trusted),
      trusted,
    });
  }, [preview, raw, trusted]);
  const height = expanded ? 'h-full flex-1' : 'h-[65vh]';

  // Only the trusted path may run script, and it must never be sandboxed into the app's origin.
  const sandbox = trusted ? 'allow-scripts' : '';

  if (preview.kind === 'markdown' && !raw) return <div className={cn('rounded-lg border border-border/80 bg-card/40 p-4 sm:p-5', expanded && 'flex-1 min-h-0')}><ChatMarkdown content={preview.content ?? ''} links={links} /></div>;
  if (preview.kind === 'html' && !raw) return <iframe title={`Preview of ${preview.name}`} sandbox={sandbox} referrerPolicy="no-referrer" srcDoc={htmlDocument} className={`${height} w-full rounded-lg border border-border bg-white shadow-xs`} />;
  if (preview.content !== undefined) return <pre className={cn('whitespace-pre-wrap break-words font-mono text-xs sm:text-sm rounded-lg border border-border bg-muted/20 p-4', expanded ? 'flex-1 min-h-0 overflow-auto' : 'overflow-x-auto')}>{preview.content}</pre>;
  if (preview.kind === 'pdf') return <iframe title={`Preview of ${preview.name}`} src={fileUrl} className={`${height} w-full rounded-lg border border-border`} />;
  if (preview.kind === 'image') return <div className={cn('flex items-center justify-center rounded-lg border border-border/60 bg-muted/10 p-2 sm:p-4', expanded && 'h-full flex-1')}><img src={fileUrl} alt={preview.name} className={expanded ? 'mx-auto h-full w-auto max-w-full object-contain' : 'max-w-full max-h-[65vh] h-auto rounded'} /></div>;
  return <div className="rounded-lg border border-dashed border-border p-8 text-center"><p className="text-sm text-muted-foreground">Preview is unavailable for this format. Download the document to open it in its application.</p></div>;
}
