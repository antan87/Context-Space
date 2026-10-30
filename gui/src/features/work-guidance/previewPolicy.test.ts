import { describe, expect, it } from 'vitest';
import {
  buildPreviewDocument,
  ESCAPE_MESSAGE,
  FIT_SCRIPT,
  isStyleSheetHref,
  previewCsp,
  safeAssetUrl,
  sanitizeOptions,
} from './previewPolicy.js';

/**
 * The policy contract. DOM-level effects of these options are asserted against real Chromium in
 * gui/e2e/root-documents.spec.ts; this file pins the decisions themselves so a regression in the
 * rules fails fast under `npm test`.
 */
describe('preview CSP', () => {
  it('never allows script in the default locked mode', () => {
    expect(previewCsp(false)).not.toContain('script-src');
  });

  it('keeps default-src none and closes off base and form hijacking in both modes', () => {
    for (const trusted of [false, true]) {
      const csp = previewCsp(trusted);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
    }
  });

  it('allows remote presentational subresources from any origin in both modes', () => {
    for (const trusted of [false, true]) {
      const csp = previewCsp(trusted);
      expect(csp).toContain('img-src data: https: http:');
      expect(csp).toContain('style-src \'unsafe-inline\' https: http:');
      expect(csp).toContain('font-src data: https: http:');
    }
  });

  it('admits script only for a trusted document', () => {
    expect(previewCsp(true)).toContain('script-src');
    expect(previewCsp(false)).not.toContain('script-src');
  });

  it('never leaks a frame or media capability that the assets policy did not intend', () => {
    expect(previewCsp(false)).not.toContain('frame-src');
    // Locked mode runs no script, so it needs no outbound fetch capability at all.
    expect(previewCsp(false)).not.toContain('connect-src');
  });

  it('grants a trusted document the fetch capability its scripts need to work', () => {
    // Tailwind's Play CDN fetches its engine; without connect-src it runs and styles nothing.
    expect(previewCsp(true)).toContain('connect-src https: http:');
    expect(previewCsp(true)).toContain("'wasm-unsafe-eval'");
  });
});

describe('sanitize options', () => {
  it('forbids script and link in both modes, since head assets are hoisted instead', () => {
    for (const options of [sanitizeOptions(), sanitizeOptions()]) {
      expect(options.FORBID_TAGS).toContain('script');
      expect(options.FORBID_TAGS).toContain('link');
    }
  });

  it('never uses ADD_TAGS, which would let head markup back in through the body', () => {
    expect(sanitizeOptions()).not.toHaveProperty('ADD_TAGS');
  });

  it('always forbids iframe, object, embed, form, meta and base', () => {
    for (const tag of ['iframe', 'object', 'embed', 'form', 'meta', 'base']) {
      expect(sanitizeOptions().FORBID_TAGS).toContain(tag);
    }
  });

  it('keeps inline SVG, which AI output uses for icons and charts', () => {
    expect(sanitizeOptions().USE_PROFILES).toMatchObject({ svg: true });
  });

  it('returns fresh arrays so a caller cannot mutate the shared policy', () => {
    const first = sanitizeOptions();
    first.FORBID_TAGS.push('style');
    expect(sanitizeOptions().FORBID_TAGS).not.toContain('style');
  });
});

describe('asset URL admission', () => {
  it('accepts absolute http and https', () => {
    expect(safeAssetUrl('https://cdn.example.com/a.css')).toBe('https://cdn.example.com/a.css');
    expect(safeAssetUrl('http://cdn.example.com/a.css')).toBe('http://cdn.example.com/a.css');
  });

  it('rejects every other scheme and anything not absolute', () => {
    for (const value of ['javascript:alert(1)', 'data:text/css,body{}', 'blob:https://x/y', 'file:///etc/passwd', '/local.css', '//cdn.example.com/a.css', '', null, undefined]) {
      expect(safeAssetUrl(value)).toBeNull();
    }
  });
});

describe('stylesheet link admission', () => {
  it('admits a remote stylesheet', () => {
    expect(isStyleSheetHref('https://cdn.example.com/a.css', 'stylesheet')).toBe(true);
    expect(isStyleSheetHref('https://cdn.example.com/a.css', 'STYLESHEET')).toBe(true);
  });

  it('rejects every other link relation and non-remote hrefs', () => {
    expect(isStyleSheetHref('https://cdn.example.com/app.js', 'preload')).toBe(false);
    expect(isStyleSheetHref('https://cdn.example.com/app.js', 'prefetch')).toBe(false);
    expect(isStyleSheetHref('https://cdn.example.com/x.html', 'import')).toBe(false);
    expect(isStyleSheetHref('https://cdn.example.com/a.css', null)).toBe(false);
    expect(isStyleSheetHref('data:text/css,body{}', 'stylesheet')).toBe(false);
  });
});

describe('preview document assembly', () => {
  it('declares a charset, which the sanitized body can no longer carry itself', () => {
    expect(buildPreviewDocument({ body: '<p>hi</p>', trusted: false })).toContain('<meta charset="utf-8">');
  });

  it('embeds the matching CSP for each mode', () => {
    const locked = buildPreviewDocument({ body: '<p>hi</p>', trusted: false });
    const trusted = buildPreviewDocument({ body: '<p>hi</p>', trusted: true });
    expect(locked).toContain(previewCsp(false));
    expect(trusted).toContain(previewCsp(true));
    expect(trusted).toContain('script-src');
    expect(locked).not.toContain('script-src');
  });

  it('fits a page that is wider than the frame, in a trusted document only: it is a script', () => {
    const trusted = buildPreviewDocument({ body: '<p>hi</p>', trusted: true });
    const locked = buildPreviewDocument({ body: '<p>hi</p>', trusted: false });
    expect(trusted).toContain(`<script>${FIT_SCRIPT}</script>`);
    expect(trusted.indexOf(FIT_SCRIPT)).toBeLessThan(trusted.indexOf('<body>'));
    expect(locked).not.toContain('<script');
    expect(locked).not.toContain('zoom');
  });

  it('keeps the script from ending its own element or reaching out of the frame, but for one fixed message: Escape', () => {
    expect(FIT_SCRIPT.toLowerCase()).not.toContain('</script');
    // Exactly one way out, and what it says is fixed: it carries nothing of the page.
    const message = `parent.postMessage('${ESCAPE_MESSAGE}','*')`;
    expect(ESCAPE_MESSAGE).toBe('contextspace:escape');
    expect(FIT_SCRIPT.split(message)).toHaveLength(2);
    const rest = FIT_SCRIPT.replace(message, '');
    for (const reach of ['fetch', 'XMLHttpRequest', 'WebSocket', 'postMessage', 'parent', 'top.', 'location', 'cookie', 'localStorage', 'sessionStorage', 'eval', 'Function(', 'import(', 'innerHTML', 'src=']) {
      expect(rest, reach).not.toContain(reach);
    }
    // It answers Escape only when the page has not used it.
    expect(FIT_SCRIPT).toContain("event.key==='Escape'&&!event.defaultPrevented");
  });

  it('scales a page to half at the least, and watches size with a ResizeObserver, not the whole tree of elements', () => {
    expect(FIT_SCRIPT).toContain('Math.max(0.5,room/wide)');
    expect(FIT_SCRIPT).toContain('ResizeObserver');
    expect(FIT_SCRIPT).not.toContain('MutationObserver');
  });

  it('wraps the body in a complete document', () => {
    const document = buildPreviewDocument({ body: '<h1>ok</h1>', trusted: false });
    expect(document.startsWith('<!doctype html>')).toBe(true);
    expect(document).toContain('<body><h1>ok</h1></body>');
  });
  it('hoists stylesheets into the head in both modes', () => {
    const assets = { stylesheets: ['https://cdn.example.com/a.css'], scripts: [] };
    for (const trusted of [false, true]) {
      const document = buildPreviewDocument({ body: '<p>hi</p>', trusted, assets });
      expect(document).toContain('<link rel="stylesheet" href="https://cdn.example.com/a.css">');
      expect(document.indexOf('<link rel="stylesheet"')).toBeLessThan(document.indexOf('<body>'));
    }
  });

  it('emits hoisted scripts only for a trusted document', () => {
    const assets = { stylesheets: [], scripts: ['https://cdn.tailwindcss.com'] };
    expect(buildPreviewDocument({ body: '', trusted: true, assets })).toContain('<script src="https://cdn.tailwindcss.com">');
    expect(buildPreviewDocument({ body: '', trusted: false, assets })).not.toContain('cdn.tailwindcss.com');
  });

  it('places hoisted scripts in the head, before the body, so parser-blocking works', () => {
    // Tailwind's Play CDN injects CSS via document.write, which only lands from a
    // parser-blocking head script. End-of-body placement runs but styles nothing.
    const document = buildPreviewDocument({ body: '<p>hi</p>', trusted: true, assets: { stylesheets: [], scripts: ['https://cdn.tailwindcss.com'] } });
    expect(document.indexOf('<script src=')).toBeLessThan(document.indexOf('<body>'));
  });

  it('escapes a hoisted URL so it cannot break out of the attribute', () => {
    const document = buildPreviewDocument({
      body: '',
      trusted: false,
      assets: { stylesheets: ['https://cdn.example.com/a.css"><script>alert(1)</script>'], scripts: [] },
    });
    expect(document).not.toContain('"><script>');
    expect(document).toContain('&quot;');
  });

  it('tolerates a missing or partial asset list', () => {
    expect(buildPreviewDocument({ body: '<p>hi</p>', trusted: true })).toContain('<body><p>hi</p></body>');
    expect(buildPreviewDocument({ body: '', trusted: false, assets: { stylesheets: ['https://x/a.css'] } as never })).toContain('a.css');
  });

  it('hoists inline CSS into the head, which is where self-contained pages keep it', () => {
    // The real failure: an agent page with 11KB of CSS in a head <style> rendered naked,
    // because DOMPurify returns only the body.
    const document = buildPreviewDocument({ body: '<p>hi</p>', trusted: false, assets: { styles: ['h1{color:red}'] } as never });
    expect(document).toContain('<style>h1{color:red}</style>');
    expect(document.indexOf('<style>')).toBeLessThan(document.indexOf('<body>'));
  });

  it('drops an inline style that could break out of the style element', () => {
    // No regex tag matching (CodeQL js/bad-tag-filter): a hostile block is not hoisted at all.
    for (const css of ['a{}</style><img src=x onerror=alert(1)>', 'a{}</STYLE ><svg onload=1>', 'a{}</style']) {
      const document = buildPreviewDocument({ body: '', trusted: false, assets: { styles: [css] } as never });
      expect(document).not.toContain('onerror');
      expect(document).not.toContain('onload');
      expect(document).not.toContain('</style><');
      expect(document).not.toContain('<style>');
    }
  });

  it('keeps ordinary CSS untouched, including comment-like text', () => {
    const css = 'a{color:red} /* <!-- not a terminator --> */ b::after{content:"-->"}';
    const document = buildPreviewDocument({ body: '', trusted: false, assets: { styles: [css] } as never });
    expect(document).toContain(`<style>${css}</style>`);
  });

  it('carries presentational html and body attributes the CSS is keyed on', () => {
    // :root[data-theme="dark"] and Tailwind utilities on <body> match nothing without these.
    const document = buildPreviewDocument({
      body: '<p>hi</p>',
      trusted: false,
      assets: { htmlAttributes: ['class=dark', 'data-theme=dark', 'lang=en'], bodyAttributes: ['class=min-h-screen bg-dark-900'] } as never,
    });
    expect(document).toContain('<html class="dark" data-theme="dark" lang="en">');
    expect(document).toContain('<body class="min-h-screen bg-dark-900">');
  });

  it('refuses a malformed or non-presentational attribute name', () => {
    const document = buildPreviewDocument({ body: '', trusted: false, assets: { htmlAttributes: ['onload=alert(1)', 'data-x', 'style=color:red'] } as never });
    expect(document).not.toContain('onload');
    expect(document).not.toContain('style="color:red"');
    expect(document).toContain('<html>');
  });
});
