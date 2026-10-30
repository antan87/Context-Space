import { test, expect } from './fixtures';

function blankPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

test.use({ workspacesData: [{ id: 'demo', branchName: 'demo', description: 'Document browser', repos: [], assistants: [], workspacePath: '/ws/demo', createdAt: '2026-09-22T00:00:00.000Z' }] });

test('opens agent-created Markdown, HTML, PDF and Office documents from the root', async ({ page }) => {
  const documents = [
    { name: 'agent findings.md', kind: 'markdown' },
    { name: 'page.html', kind: 'html' },
    { name: 'evidence.pdf', kind: 'pdf' },
    { name: 'brief.docx', kind: 'download' },
  ].map((doc) => ({ ...doc, size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' }));
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name');
    return route.fulfill({ json: { ...documents.find((doc) => doc.name === name), ...(name?.endsWith('.md') ? { content: '# Agent findings\n\nRoot documents open here.' } : {}), ...(name?.endsWith('.html') ? { content: '<!doctype html><html><head><style>h1 { color: rgb(18, 52, 86); }</style></head><body><h1>Rendered HTML</h1><script>window.unsafe = true</script></body></html>' } : {}) } });
  });
  await page.route('**/api/workspace/demo/documents/file?*', (route) => route.fulfill({ contentType: 'application/pdf', headers: { 'Access-Control-Allow-Origin': '*' }, body: blankPdf() }));
  await page.goto('/#/workspaces/demo/documents');
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await page.getByRole('treeitem', { name: /agent findings.md/ }).click();
  await expect(page.getByRole('heading', { name: 'Agent findings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View source', exact: true }).click();
  await expect(page.getByText('# Agent findings', { exact: false })).toBeVisible();
  await page.getByRole('treeitem', { name: /page.html/ }).click();
  const html = page.getByTitle('Preview of page.html');
  await expect(html).toBeVisible();
  await expect.poll(() => html.evaluate((frame: HTMLIFrameElement) => frame.srcdoc)).toContain('Rendered HTML');
  await expect(page.frameLocator('iframe[title="Preview of page.html"]').getByRole('heading', { name: 'Rendered HTML' })).toHaveCSS('color', 'rgb(18, 52, 86)');
  // The page's own inline script never reaches the frame, whether the scripts of the internet run or not.
  expect(await html.evaluate((frame: HTMLIFrameElement) => frame.srcdoc)).not.toContain('window.unsafe');
  await page.getByRole('treeitem', { name: /evidence.pdf/ }).click();
  await expect(page.getByTitle('Preview of evidence.pdf')).toBeVisible();
  await page.getByRole('treeitem', { name: /brief.docx/ }).click();
  await expect(page.getByText('Preview is unavailable for this format.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', /name=brief.docx&download=1/);
  await page.getByLabel('Filter documents').fill('agent');
  await expect(page.getByRole('treeitem', { name: /evidence.pdf/ })).toHaveCount(0);
  await page.getByLabel('Filter documents').fill('');
  await page.getByRole('treeitem', { name: /agent findings.md/ }).click();
  await page.screenshot({ path: 'test-results/root-documents.png', fullPage: true });
});

test('maximizes a document inside the app borders and restores focus on Escape', async ({ page }) => {
  const documents = [{ name: 'page.html', kind: 'html', size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' }];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({
    json: { name: 'page.html', kind: 'html', content: '<h1>Rendered HTML</h1><style>h1{color:rgb(1,2,3)}</style>' },
  }));
  await page.goto('/#/workspaces/demo/documents');
  await page.getByRole('treeitem', { name: /page.html/ }).click();

  const inlineFrame = page.getByTitle('Preview of page.html');
  await expect(inlineFrame).toBeVisible();
  const inlineBox = await inlineFrame.boundingBox();

  // Stable aria-label plus aria-pressed keeps the control assertable in both states.
  const expand = page.getByRole('button', { name: 'Expand document' });
  await expect(expand).toHaveAttribute('aria-pressed', 'false');
  await expand.click();

  const overlay = page.getByTestId('document-viewer-expanded');
  await expect(overlay).toBeVisible();
  const expandedToggle = overlay.getByRole('button', { name: 'Expand document' });
  await expect(expandedToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(expandedToggle).toBeFocused();

  // The frame is no longer the 65vh letterbox.
  const expandedBox = await overlay.getByTitle('Preview of page.html').boundingBox();
  expect(expandedBox!.height).toBeGreaterThan(inlineBox!.height);

  // Download and the raw toggle stay reachable while expanded.
  await expect(overlay.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
  await expect(overlay.getByRole('button', { name: 'View source', exact: true })).toBeVisible();

  // Never the browser Fullscreen API: the overlay is bounded by the app viewport.
  const viewport = page.viewportSize()!;
  const overlayBox = await overlay.boundingBox();
  expect(overlayBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(overlayBox!.height).toBeLessThanOrEqual(viewport.height);
  expect(await overlay.evaluate((node: HTMLElement) => node.ownerDocument.fullscreenElement)).toBeNull();

  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand document' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Expand document' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTitle('Preview of page.html')).toBeVisible();
});

test('fullscreen of a document covers the chat dock and viewport without chat overlapping', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
    localStorage.setItem('contextspace_floating_chat_state_v1', JSON.stringify({
      openTabs: ['demo'],
      activeTab: 'demo',
      splitTab: null,
      splitRatio: 50,
      modes: { demo: 'cli' },
      harnesses: {},
      terminalLaunches: {},
      drafts: {},
    }));
  });

  const documents = [{ name: 'page.html', kind: 'html', size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' }];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({
    json: { name: 'page.html', kind: 'html', content: '<h1>Rendered HTML</h1><style>h1{color:rgb(1,2,3)}</style>' },
  }));

  await page.goto('/#/workspaces/demo/documents');
  await page.getByRole('treeitem', { name: /page.html/ }).click();

  const chatDock = page.getByRole('region', { name: 'CLI Chat' });
  await expect(chatDock).toBeVisible();

  const expand = page.getByRole('button', { name: 'Expand document' });
  await expand.click();

  const overlay = page.getByTestId('document-viewer-expanded');
  await expect(overlay).toBeVisible();

  const viewport = page.viewportSize()!;
  const overlayBox = await overlay.boundingBox();
  expect(overlayBox!.x).toBe(0);
  expect(overlayBox!.y).toBe(0);
  expect(overlayBox!.width).toBe(viewport.width);
  expect(overlayBox!.height).toBe(viewport.height);

  const isCoveringChat = await page.evaluate(() => {
    const el = document.elementFromPoint(100, 200);
    const overlayEl = document.querySelector('[data-testid="document-viewer-expanded"]');
    return overlayEl !== null && (el === overlayEl || overlayEl.contains(el));
  });
  expect(isCoveringChat).toBe(true);

  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await expect(chatDock).toBeVisible();
});

test('fullscreen and close controls for knowledge view in the documents tab', async ({ page }) => {
  const documents = [{ name: 'contextspace-knowledge.md', kind: 'markdown', size: 2048, modifiedAt: '2026-10-04T10:00:00Z' }];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({
    json: {
      name: 'contextspace-knowledge.md',
      kind: 'markdown',
      content: '# Knowledge\n\n## Decisions\n\n### 2026-10-01 — test\n**Decision:** use portal\n',
    },
  }));
  await page.goto('/#/workspaces/demo/documents');
  await page.getByRole('button', { name: /^Knowledge/ }).click();

  const expandKnowledge = page.getByRole('button', { name: 'Expand knowledge' });
  await expect(expandKnowledge).toBeVisible();
  await expandKnowledge.click();

  const overlay = page.getByTestId('knowledge-expanded');
  await expect(overlay).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();

  await page.getByRole('button', { name: 'Close document' }).click();
  await expect(page.getByText('Select a document to open it here.')).toBeVisible();
});

/**
 * Deliberately a full document with a real <head>, because that is what an AI writes. DOMPurify
 * returns only the <body>, so head assets are hoisted by the viewer rather than sanitized in place;
 * a body-only fixture silently fails to cover that.
 */
const STYLED_PAGE = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report</title>',
  '<link rel="stylesheet" href="https://cdn.example.com/bootstrap.min.css">',
  '<link rel="preload" as="script" href="https://cdn.example.com/app.js">',
  '<script src="https://cdn.tailwindcss.com"></script>',
  '</head><body>',
  '<h1>Styled report</h1>',
  '<style>h1 { color: rebeccapurple; }</style>',
  '<svg width="16" height="16"><circle cx="8" cy="8" r="7" /></svg>',
  '<script>window.unsafe = true</script>',
  '<img src="https://cdn.example.com/hero.png" onerror="window.unsafe = true" onclick="window.unsafe = true">',
  '<a href="javascript:window.unsafe=true">bad link</a>',
  '<iframe src="https://evil.example.com"></iframe>',
  '<button onclick="window.unsafe=true">handler</button>',
  '</body></html>',
].join('');

async function openStyledPage(page: import('@playwright/test').Page) {
  const documents = [{ name: 'report.html', kind: 'html', size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' }];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({
    json: { name: 'report.html', kind: 'html', content: STYLED_PAGE },
  }));
  await page.goto('/#/workspaces/demo/documents');
  await page.getByRole('treeitem', { name: /report.html/ }).click();
  await expect(page.getByTitle('Preview of report.html')).toBeVisible();
  const srcdoc = () => page.getByTitle('Preview of report.html').evaluate((frame: HTMLIFrameElement) => frame.srcdoc);
  return { frame: page.getByTitle('Preview of report.html'), srcdoc };
}

test('keeps presentational markup and strips active content from agent HTML', async ({ page }) => {
  const { frame, srcdoc } = await openStyledPage(page);
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const html = await srcdoc();

  // Styling survives, hoisted from the source <head> into the head the viewer builds.
  expect(html).toContain('<link rel="stylesheet" href="https://cdn.example.com/bootstrap.min.css">');
  expect(html.indexOf('<link rel="stylesheet"')).toBeLessThan(html.indexOf('<body>'));
  expect(html).toContain('color: rebeccapurple');
  expect(html).toContain('<svg');
  expect(html).toContain('<circle');

  // Everything that can embed or run from the page's own markup is gone; only the script of the internet it asked for is in the head.
  expect(html).not.toContain('<iframe');
  expect(html).not.toContain('evil.example.com');
  expect(html).not.toContain('onclick');
  expect(html).not.toContain('onerror');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('rel="preload"');
  expect(html).not.toContain('app.js');
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).toContain("default-src 'none'");
  expect(html).toContain('style-src \'unsafe-inline\' https: http:');
  // No switch and no warning about scripts: the page just runs in its sandbox.
  await expect(page.getByText('Stop scripts', { exact: false })).toHaveCount(0);
  await expect(page.getByText('runs scripts', { exact: false })).toHaveCount(0);
});

test('runs the scripts of an HTML document by default, in an opaque-origin frame, with no prompt', async ({ page }) => {
  const { frame, srcdoc } = await openStyledPage(page);

  await expect(page.getByRole('button', { name: /^Trust/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop scripts', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Raw text', exact: true })).toHaveCount(0);
  const trusted = await srcdoc();
  // The URL is normalised through `new URL`, hence the trailing slash on a bare origin.
  expect(trusted).toMatch(/<script src="https:\/\/cdn\.tailwindcss\.com\/"><\/script>/);
  expect(trusted).toContain('script-src');
  // Scripts are allowed but the frame is never given the app's origin, and other escapes stay shut.
  expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(trusted).not.toContain('<iframe');
  expect(trusted).not.toContain('onclick');
  expect(trusted).not.toContain('javascript:');
  // The document's scripts of the internet run, never its inline ones.
  expect(trusted).not.toContain('window.unsafe = true');
  expect(trusted).toContain("default-src 'none'");
  await expect(page.getByText('This page runs scripts', { exact: false })).toHaveCount(0);
  await expect(page.getByText('This page loads styling from an external script, which is blocked.', { exact: false })).toHaveCount(0);
});

test('runs every HTML document in its own sandboxed frame, whichever is opened next', async ({ page }) => {
  const documents = [
    { name: 'report.html', kind: 'html', size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' },
    { name: 'other.html', kind: 'html', size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' },
  ];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name');
    return route.fulfill({ json: { name, kind: 'html', content: STYLED_PAGE } });
  });
  await page.goto('/#/workspaces/demo/documents');
  await page.getByRole('treeitem', { name: /report.html/ }).click();
  await expect(page.getByTitle('Preview of report.html')).toHaveAttribute('sandbox', 'allow-scripts');
  await page.getByRole('treeitem', { name: /other.html/ }).click();
  await expect(page.getByTitle('Preview of other.html')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await page.getByTitle('Preview of other.html').evaluate((node: HTMLIFrameElement) => node.srcdoc)).toContain('script-src');
  // The stylesheet is hoisted, because that is Q1.
  expect(await page.getByTitle('Preview of other.html').evaluate((node: HTMLIFrameElement) => node.srcdoc)).toContain('bootstrap.min.css');
  await expect(page.getByRole('button', { name: /Stop scripts|Run scripts|Raw text/ })).toHaveCount(0);
});

test('fits an HTML page that is wider than the frame to its width instead of scrolling sideways', async ({ page }) => {
  const documents = [{ name: 'wide.html', kind: 'html', size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' }];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({ json: {
    name: 'wide.html', kind: 'html',
    content: '<!doctype html><html><head><style>body { margin: 0; } .page { width: 1280px; height: 200px; background: #93c5fd; }</style></head><body><div class="page"><h1>A page made for 1280 px</h1></div></body></html>',
  } }));
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto('/#/workspaces/demo/documents');
  await page.getByRole('treeitem', { name: /wide.html/ }).click();
  const frameBox = page.getByTitle('Preview of wide.html');
  await expect(frameBox).toBeVisible();
  const frame = (await (await frameBox.elementHandle())!.contentFrame())!;
  const measure = () => frame.evaluate(() => ({ width: document.documentElement.scrollWidth, room: document.documentElement.clientWidth, zoom: Number(document.body.style.zoom || 1) }));
  // Wider than half of the page, so it can be scaled to fit, and narrower than the page.
  expect((await frameBox.boundingBox())!.width).toBeLessThan(1280);
  expect((await frameBox.boundingBox())!.width).toBeGreaterThan(660);
  // The Docs tab keeps its frame at a share of the screen's height, as before.
  expect(Math.abs((await frameBox.boundingBox())!.height - 800 * 0.65)).toBeLessThanOrEqual(2);
  await expect.poll(async () => { const now = await measure(); return now.width <= now.room && now.zoom < 1; }).toBe(true);
});

test('offers opening an HTML document in the real browser, and only for HTML', async ({ page }) => {
  const documents = [
    { name: 'page.html', kind: 'html', size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' },
    { name: 'notes.md', kind: 'markdown', size: 120, modifiedAt: '2026-09-22T00:00:00.000Z' },
  ];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name');
    return route.fulfill({ json: { name, kind: name?.endsWith('.html') ? 'html' : 'markdown', content: 'body' } });
  });
  await page.goto('/#/workspaces/demo/documents');

  await page.getByRole('treeitem', { name: /page.html/ }).click();
  await expect(page.getByTitle('Preview of page.html')).toBeVisible();
  const open = page.getByRole('link', { name: 'Open in browser', exact: true });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('href', /name=page.html&open=1/);
  // Renders in a new tab, and never hands the opener a handle on it.
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', /noopener/);
  await expect(open).toHaveAttribute('rel', /noreferrer/);

  // Markdown already renders in-app, so it does not get the escape hatch.
  await page.getByRole('treeitem', { name: /notes.md/ }).click();
  // Markdown renders through ChatMarkdown rather than a titled frame, so assert on its content.
  await expect(page.getByText('body', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in browser', exact: true })).toHaveCount(0);
});

test('recovers from list and preview failures and discovers newly created files on refresh', async ({ page }) => {
  let listFails = true;
  let previewFails = true;
  const documents: Array<{ name: string; kind: string; size: number; modifiedAt: string }> = [];
  await page.route('**/api/workspace/demo/documents', (route) => listFails
    ? route.fulfill({ status: 400, json: { error: 'Workspace is unavailable.' } })
    : route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => previewFails
    ? route.fulfill({ status: 400, json: { error: 'Document was removed.' } })
    : route.fulfill({ json: { name: 'report.txt', kind: 'text', content: 'Recovered report' } }));
  await page.goto('/#/workspaces/demo/documents');
  await expect(page.getByRole('alert')).toContainText('Workspace is unavailable');
  listFails = false;
  await page.getByRole('button', { name: 'Retry documents' }).click();
  await expect(page.getByText('No documents in the workspace root yet.', { exact: false })).toBeVisible();
  documents.push({ name: 'report.txt', kind: 'text', size: 20, modifiedAt: '2026-09-22T00:00:00.000Z' });
  await page.getByRole('button', { name: 'Refresh documents' }).click();
  await page.getByRole('treeitem', { name: /report.txt/ }).click();
  await expect(page.getByRole('alert')).toContainText('Document was removed');
  previewFails = false;
  await page.getByRole('button', { name: 'Retry preview' }).click();
  await expect(page.getByText('Recovered report')).toBeVisible();
});

test('links inside a document never leave the app', async ({ page }) => {
  const index = [
    '# Screenshot index',
    '',
    '- [Jump to limits](#evidence-limits)',
    '- [01 onboarding](/ws/demo/assessment/screenshots/01-onboarding.png)',
    '- [Relative notes](notes/day%201.md)',
    '- [Other workspace](/home/me/workspaces/other/shot.png)',
    '- [W3C labels](https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html)',
    '- [Script](javascript:window.unsafe=true)',
    '',
    '![inline capture](assessment/screenshots/01-onboarding.png)',
    '',
    ...Array.from({ length: 60 }, (_, line) => `Filler line ${line}.`),
    '',
    '## Evidence limits',
    '',
    'Screenshots alone do not establish conformance.',
  ].join('\n');
  const previews: Record<string, object> = {
    'index.md': { name: 'index.md', kind: 'markdown', content: index },
    'assessment/screenshots/01-onboarding.png': { name: 'assessment/screenshots/01-onboarding.png', kind: 'image' },
    'notes/day 1.md': { name: 'notes/day 1.md', kind: 'markdown', content: '# Day one notes\n\n[Back up](../index.md)' },
  };
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: [{ name: 'index.md', kind: 'markdown', size: 400, modifiedAt: '2026-09-22T00:00:00.000Z' }] } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const preview = previews[new URL(route.request().url()).searchParams.get('name') ?? ''];
    return preview ? route.fulfill({ json: preview }) : route.fulfill({ status: 400, json: { error: 'Not found.' } });
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.route('**/api/workspace/demo/documents/file?*', (route) => route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: png }));

  await page.goto('/#/workspaces/demo/documents');
  const appUrl = () => new URL(page.url());
  await page.getByRole('treeitem', { name: /index.md/ }).click();
  const preview = page.getByRole('article', { name: 'Document preview' });
  await expect(preview.getByRole('heading', { name: 'Screenshot index' })).toBeVisible();
  await expect(preview.getByRole('img', { name: 'inline capture' })).toHaveAttribute('src', /name=assessment%2Fscreenshots%2F01-onboarding.png/);

  // An in-document anchor scrolls instead of changing the hash route.
  await preview.getByRole('link', { name: 'Jump to limits' }).click();
  await expect(preview.getByRole('heading', { name: 'Evidence limits' })).toBeInViewport();
  expect(appUrl().hash).toBe('#/workspaces/demo/documents');

  // An absolute path inside the workspace opens in the viewer, with a way back.
  await preview.getByRole('link', { name: '01 onboarding' }).click();
  await expect(preview.getByRole('img', { name: 'assessment/screenshots/01-onboarding.png' })).toBeVisible();
  expect(appUrl().pathname).toBe('/');
  await preview.getByRole('button', { name: 'Back to index.md' }).click();

  // A relative link resolves against the document and chains back up.
  await preview.getByRole('link', { name: 'Relative notes' }).click();
  await expect(preview.getByRole('heading', { name: 'Day one notes' })).toBeVisible();
  await preview.getByRole('link', { name: 'Back up' }).click();
  await expect(preview.getByRole('heading', { name: 'Screenshot index' })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Back to day 1.md' })).toBeVisible();

  // A path outside the workspace and an unsafe scheme are inert, with the path copyable.
  await expect(preview.getByRole('link', { name: 'Other workspace' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: 'Copy path /home/me/workspaces/other/shot.png' })).toBeVisible();
  await expect(preview.getByRole('link', { name: 'Script' })).toHaveCount(0);

  // A web link opens outside the app window.
  const external = preview.getByRole('link', { name: /W3C labels/ });
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', /noopener/);
  expect(appUrl().pathname).toBe('/');
  expect(await page.evaluate(() => (window as unknown as { unsafe?: boolean }).unsafe)).toBeUndefined();
});

test('opens folders in the tree, previews nested documents, and searches every folder', async ({ page }) => {
  const rootDocs = [
    { name: 'root-readme.md', kind: 'markdown', size: 100, modifiedAt: '2026-09-22T00:00:00.000Z' },
  ];
  const docsFolderFiles = [
    { name: 'docs/architecture.md', kind: 'markdown', size: 250, modifiedAt: '2026-09-22T00:00:00.000Z' },
  ];

  await page.route('**/api/workspace/demo/documents*', (route) => {
    const url = new URL(route.request().url());
    const folder = url.searchParams.get('folder');
    const recursive = url.searchParams.get('recursive');
    if (recursive === '1') {
      return route.fulfill({
        json: {
          documents: [...rootDocs, ...docsFolderFiles],
          folders: ['docs'],
        },
      });
    }
    if (folder === 'docs') {
      return route.fulfill({
        json: {
          documents: docsFolderFiles,
          folders: [],
        },
      });
    }
    return route.fulfill({
      json: {
        documents: rootDocs,
        folders: ['docs'],
      },
    });
  });

  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name');
    if (name === 'docs/architecture.md') {
      return route.fulfill({
        json: { name: 'docs/architecture.md', kind: 'markdown', content: '# Architecture Overview\n\nModular design.' },
      });
    }
    return route.fulfill({
      json: { name: 'root-readme.md', kind: 'markdown', content: '# Root Readme' },
    });
  });

  await page.goto('/#/workspaces/demo/documents');
  const list = page.getByRole('complementary', { name: 'Documents to open' });
  const folder = list.getByRole('treeitem', { name: 'docs', exact: true });
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await expect(list.getByRole('treeitem', { name: /root-readme\.md/ })).toBeVisible();

  // A folder lists its documents in place when it is opened; the rest of the tree stays where it was.
  await folder.click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await list.getByRole('treeitem', { name: /architecture\.md/ }).click();

  const article = page.getByRole('article', { name: 'Document preview' });
  await expect(article.getByRole('heading', { name: 'Architecture Overview' })).toBeVisible();
  // The reader names the folder in its header, and the list is still there to pick the next one.
  await expect(article.getByRole('heading', { name: 'docs/architecture.md', exact: true })).toBeVisible();
  await expect(list.getByRole('treeitem', { name: /root-readme\.md/ })).toBeVisible();
  await list.getByRole('treeitem', { name: /root-readme\.md/ }).click();
  await expect(article.getByRole('heading', { name: 'Root Readme' })).toBeVisible();

  // Filtering searches every folder, not only the open ones.
  await folder.click();
  await list.getByLabel('Filter documents').fill('architecture');
  await expect(list.getByRole('treeitem', { name: /architecture\.md/ })).toBeVisible();
  await expect(list.getByRole('treeitem', { name: /root-readme\.md/ })).toHaveCount(0);

  // Closing the document leaves the list.
  await article.getByRole('button', { name: 'Close document' }).click();
  await expect(page.getByText('Select a document to open it here.')).toBeVisible();
});

test('beside the chat, a document takes the panel and the list opens over it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
  });

  const documents = [
    { name: 'findings.md', kind: 'markdown', size: 100, modifiedAt: '2026-09-22T00:00:00.000Z' },
    { name: 'summary.md', kind: 'markdown', size: 200, modifiedAt: '2026-09-22T00:00:00.000Z' },
    { name: 'report.html', kind: 'html', size: 300, modifiedAt: '2026-09-22T00:00:00.000Z' },
  ];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents, folders: [] } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name');
    if (name === 'findings.md') return route.fulfill({ json: { name: 'findings.md', kind: 'markdown', content: '# Findings content' } });
    if (name === 'summary.md') return route.fulfill({ json: { name: 'summary.md', kind: 'markdown', content: '# Summary content' } });
    return route.fulfill({ json: { name: 'report.html', kind: 'html', content: '<h1>Report</h1>' } });
  });

  await page.goto('/#/workspaces/demo/documents');
  const list = page.getByRole('complementary', { name: 'Documents to open' });
  await expect(list).toBeVisible();

  // Opening a document gives it the panel; the list is not stacked above it.
  await list.getByRole('treeitem', { name: /findings.md/ }).click();
  const article = page.getByRole('article', { name: 'Document preview' });
  await expect(article.getByRole('heading', { name: 'Findings content' })).toBeVisible();
  await expect(list).toBeHidden();

  // The reader's one row: previous and next, in the order the list shows, and the document's own actions.
  await article.getByRole('button', { name: 'Next document' }).click();
  await expect(page.getByTitle('Preview of report.html')).toBeVisible();
  await article.getByRole('button', { name: 'Next document' }).click();
  await expect(article.getByRole('heading', { name: 'Summary content' })).toBeVisible();
  await expect(article.getByRole('button', { name: 'Next document' })).toBeDisabled();

  // The list opens over the document, side by side with nothing, and closes once a document is chosen.
  const toolbar = page.getByRole('toolbar', { name: 'Documents' });
  await toolbar.getByRole('button', { name: 'Show the document list' }).click();
  await expect(list).toBeVisible();
  await list.getByRole('treeitem', { name: /findings.md/ }).click();
  await expect(list).toBeHidden();
  await expect(article.getByRole('heading', { name: 'Findings content' })).toBeVisible();
});

test('on a wide panel the list stays beside the document, and can be hidden', async ({ page }) => {
  const documents = [
    { name: 'findings.md', kind: 'markdown', size: 100, modifiedAt: '2026-09-22T00:00:00.000Z' },
  ];
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents, folders: [] } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({ json: { name: 'findings.md', kind: 'markdown', content: '# Desktop Findings' } }));

  await page.goto('/#/workspaces/demo/documents');
  await page.getByRole('treeitem', { name: /findings.md/ }).click();

  const list = page.getByRole('complementary', { name: 'Documents to open' });
  const article = page.getByRole('article', { name: 'Document preview' });
  await expect(list).toBeVisible();
  await expect(article.getByRole('heading', { name: 'Desktop Findings' })).toBeVisible();
  expect((await article.boundingBox())!.x).toBeGreaterThan((await list.boundingBox())!.x);

  const toolbar = page.getByRole('toolbar', { name: 'Documents' });
  await toolbar.getByRole('button', { name: 'Hide the document list' }).click();
  await expect(list).toBeHidden();
  await toolbar.getByRole('button', { name: 'Show the document list' }).click();
  await expect(list).toBeVisible();
});
