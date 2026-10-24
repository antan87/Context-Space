/**
 * Policy for rendering agent-created HTML in the document viewer.
 *
 * Every HTML document is trusted by default ("trusted" mode below): its remote scripts run, which is
 * what lets the Play CDN style a page, and never one of the document's own inline scripts, which are
 * stripped with the rest of the active content. A user can switch one document to the locked mode: no
 * script, and remote subresources limited to presentational types.
 *
 * Once scripts run, the CSP in the document's <meta> is NOT a security boundary: a script can navigate its
 * own frame to a page that has no such CSP, and nobody should count on `connect-src` (or any other
 * directive here) to keep a trusted page from sending requests. What protects the app is, together:
 *  - the sandbox: `allow-scripts` and never `allow-same-origin`, so the frame has an opaque origin that
 *    holds none of the app's data, cookies or storage and cannot reach into the app's page; and
 *  - the server: it refuses a state-changing request from such a frame (its `Origin` is "null") and every
 *    /api request the browser marks cross-site that names no app origin, and gives it no CORS allowance
 *    to read an answer (src/server.ts, and the tests in src/server.test.ts).
 * The CSP is kept for what it does well, in the locked mode above all: it keeps a page with no script from
 * loading anything but presentational resources.
 *
 * Kept free of DOM access so the policy is unit-testable without a browser; the DOM-level effects
 * are asserted in gui/e2e/root-documents.spec.ts against real Chromium.
 */

/** Applies to both modes. `base-uri`/`form-action` close off base-tag and form hijacking. */
const BASE = "default-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Q1: any origin, for presentational subresources only. Safe by construction in locked mode because
 * no script runs, so the residual channel is CSS-only and the frame is an opaque origin that holds
 * none of the app's data.
 */
const ASSETS = "img-src data: https: http:; style-src 'unsafe-inline' https: http:; font-src data: https: http:";

/**
 * Q5: what a trusted document (the default) is given, which the locked mode a user can switch one document to is not.
 *
 * `connect-src` is not optional here. Tailwind's Play CDN initializes, then fetches its engine over
 * `fetch()`, so without it the script runs and still generates no CSS. Verified in Chromium: with
 * `connect-src` missing, `window.tailwind` exists and the page stays unstyled.
 */
const TRUSTED_SCRIPT = "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https: http:; connect-src https: http:; worker-src blob:";

export function previewCsp(trusted: boolean): string {
  return trusted ? `${BASE}; ${ASSETS}; ${TRUSTED_SCRIPT}` : `${BASE}; ${ASSETS}`;
}

/**
 * `script` and `link` are forbidden in *both* modes on purpose.
 *
 * DOMPurify returns only the sanitized `<body>`, so anything a real document puts in its `<head>`
 * is discarded before sanitization runs. Rather than fight that, the viewer reads the assets it
 * wants out of the source itself and re-emits them into the `<head>` it builds. That keeps a
 * document's own head markup out of the sanitizer entirely and means the only head content is
 * markup this module authored.
 */
/** Mutable shape, so the result can be handed straight to DOMPurify's `Config`. */
export interface SanitizeConfig {
  USE_PROFILES: { html: boolean; svg: boolean };
  FORBID_TAGS: string[];
}

export const SANITIZE_OPTIONS: SanitizeConfig = {
  USE_PROFILES: { html: true, svg: true },
  FORBID_TAGS: ['script', 'link', 'iframe', 'object', 'embed', 'form', 'meta', 'base'],
};

export function sanitizeOptions(): SanitizeConfig {
  return {
    USE_PROFILES: { ...SANITIZE_OPTIONS.USE_PROFILES },
    FORBID_TAGS: [...SANITIZE_OPTIONS.FORBID_TAGS],
  };
}

/**
 * Absolute http(s) only. Relative and protocol-relative URLs are rejected because the document is
 * rendered from a `srcDoc` frame with no meaningful base, and every scheme other than http(s)
 * (javascript:, data:, blob:, file:) is refused.
 */
export function safeAssetUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
}

/** `rel` decides whether a link is presentational, and only a remote stylesheet qualifies. */
export function isStyleSheetHref(href: string | null | undefined, rel: string | null | undefined): boolean {
  return (rel ?? '').toLowerCase().split(/\s+/).includes('stylesheet') && safeAssetUrl(href) !== null;
}

export interface HeadAssets {
  /** Remote stylesheets, hoisted from the source document. */
  stylesheets: string[];
  /** Remote scripts, hoisted only when the document is trusted. */
  scripts: string[];
  /** Inline CSS lifted out of the source <head>. */
  styles: string[];
  /**
   * Attributes of the source <html>/<body>. Agent-written documents routinely key their whole
   * design system off these, e.g. `:root[data-theme="dark"]` or Tailwind utility classes on
   * <body>, so dropping them leaves correctly-hoisted CSS that still matches nothing.
   */
  htmlAttributes: string[];
  bodyAttributes: string[];
}

export interface PreviewDocumentOptions {
  /** Sanitized body HTML for the document. */
  body: string;
  trusted: boolean;
  assets?: HeadAssets;
}

/**
 * What the trusted page's frame sends the app when Escape is pressed in it: a key pressed in a frame never reaches the page
 * around it, so a reader that closes with Escape would otherwise stop doing so once the keyboard is in the page (and a page can
 * take the keyboard by itself). The app accepts it only from the frame it drew (BoardReader), and it closes the reader: nothing
 * more. It is the one message the script below sends, and it says nothing about the page.
 */
export const ESCAPE_MESSAGE = 'contextspace:escape';

/**
 * Two things for a trusted page, as a script, because the app cannot reach into a sandboxed frame without `allow-same-origin`.
 *
 * Fit: a page that is wider than the frame is scaled down to the frame's width, so a page made for 1280 px is read whole
 * instead of scrolled sideways. CSS `zoom` rather than a transform: it changes the layout too, so the page is not left with a
 * tall empty strip. The zoom is taken off before every measure (no frame is drawn in between). The page is measured again when
 * the frame is resized, when something loads, when its fonts arrive, when <html>, <body> or a child of <body> changes size
 * (a ResizeObserver, which is not set off by the zoom itself once it has settled), and a few times soon after it opens, for a
 * page that builds itself. A page that already fits is not touched. A page that is wider than twice the frame is scaled to half
 * and left to scroll sideways: text any smaller cannot be read.
 *
 * Escape: pressed in the page, and not already used by it, it sends ESCAPE_MESSAGE to the app.
 *
 * Trusted documents only: it is a script.
 */
export const FIT_SCRIPT = `(function(){var frame=0,seen=new WeakSet(),watcher=window.ResizeObserver?new ResizeObserver(later):null;function watch(el){if(watcher&&!seen.has(el)){seen.add(el);watcher.observe(el)}}function fit(){var body=document.body,root=document.documentElement;if(!body)return;watch(root);watch(body);for(var i=0;i<body.children.length&&i<40;i++)watch(body.children[i]);body.style.zoom='';var room=root.clientWidth,wide=Math.max(root.scrollWidth,body.scrollWidth);if(room>0&&wide>room+1)body.style.zoom=String(Math.max(0.5,room/wide))}function later(){cancelAnimationFrame(frame);frame=requestAnimationFrame(fit)}addEventListener('resize',later);addEventListener('load',later,true);document.addEventListener('DOMContentLoaded',later);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(later);[150,600,1800].forEach(function(ms){setTimeout(later,ms)});addEventListener('keydown',function(event){if(event.key==='Escape'&&!event.defaultPrevented)parent.postMessage('${ESCAPE_MESSAGE}','*')})})()`;

const EMPTY_ASSETS: HeadAssets = { stylesheets: [], scripts: [], styles: [], htmlAttributes: [], bodyAttributes: [] };

/** Only presentational, non-executable attributes. `style` is excluded on purpose. */
export const CARRIED_ATTRIBUTES = ['class', 'lang', 'dir', 'data-theme'] as const;

/**
 * Inline CSS is emitted inside a <style> element that this module authors, so a terminator in the
 * source would close it early and turn the rest of the document into markup.
 *
 * Style content is RAWTEXT, so `</style` is the only sequence that can break out, and matching a
 * tag with a regex is exactly what CodeQL's `js/bad-tag-filter` warns against. Rather than escape
 * it, a block that contains one is simply not hoisted: the honest failure is "this document's CSS
 * is not shown" instead of a subtly half-escaped stylesheet. The check lives here, at the point of
 * emission, so the guarantee holds no matter what a caller passes in.
 */
function isHoistableStyle(css: string): boolean {
  return !css.toLowerCase().includes('</style');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The single place attributes reach the generated document, so the allowlist is enforced here
 * rather than trusted from the caller.
 */
function renderAttributes(pairs: string[]): string {
  return pairs.map(pair => {
    const separator = pair.indexOf('=');
    if (separator === -1) return '';
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const allowed = (CARRIED_ATTRIBUTES as readonly string[]).includes(name);
    return allowed && /^[a-z][a-z0-9-]*$/.test(name) ? ` ${name}="${escapeAttribute(value)}"` : '';
  }).join('');
}

/**
 * Hoisted scripts go in the <head>, before the body, which is where an authored page puts the Play
 * CDN. Tailwind's CDN injects its generated stylesheet with `document.write`, and that only lands
 * when the script is parser-blocking during parsing; emitted after the body it silently styles
 * nothing. Verified in Chromium: end-of-body placement yields zero generated CSS, head placement
 * yields a full stylesheet.
 */
export function buildPreviewDocument({ body, trusted, assets }: PreviewDocumentOptions): string {
  const merged = { ...EMPTY_ASSETS, ...assets };
  const styles = merged.styles.filter(isHoistableStyle).map(css => `<style>${css}</style>`).join('');
  const stylesheets = merged.stylesheets.map(href => `<link rel="stylesheet" href="${escapeAttribute(href)}">`).join('');
  const scripts = (trusted ? merged.scripts : []).map(src => `<script src="${escapeAttribute(src)}"></script>`).join('');
  const fit = trusted ? `<script>${FIT_SCRIPT}</script>` : '';
  return `<!doctype html><html${renderAttributes(merged.htmlAttributes)}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewCsp(trusted)}">${styles}${stylesheets}${scripts}${fit}</head><body${renderAttributes(merged.bodyAttributes)}>${body}</body></html>`;
}

const EXTERNAL_SCRIPT = /<script\b[^>]*\bsrc\s*=/i;

/**
 * Detects pages whose styling depends on a script we are not running, so the viewer can explain
 * itself instead of silently rendering an unstyled document. The dominant case is Tailwind's Play
 * CDN, which generates CSS at runtime and has no stylesheet equivalent.
 */
export function dependsOnExternalScript(html: string): boolean {
  return EXTERNAL_SCRIPT.test(html);
}
