import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown.js';

describe('ChatMarkdown - CodeBlock and copy functionality', () => {
  it('renders fenced code blocks with pre, code, and a copy button', () => {
    const markdown = '```js\nconsole.log("hello world");\n```';
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { content: markdown }));

    expect(html).toContain('<pre');
    expect(html).toContain('console.log(&quot;hello world&quot;)');
    expect(html).toContain('aria-label="Copy code block"');
    expect(html).toContain('title="Copy code"');
    expect(html).toContain('pr-9');
  });

  it('handles code blocks with CRLF (\\r\\n) carriage return endings correctly', () => {
    const markdown = '```python\r\ndef test():\r\n    return 42\r\n```';
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { content: markdown }));

    expect(html).toContain('<pre');
    expect(html).toContain('def test():');
    expect(html).toContain('return 42');
    expect(html).toContain('aria-label="Copy code block"');
  });

  it('renders inline code without adding a code block copy button', () => {
    const markdown = 'Use `npm test` to run tests.';
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { content: markdown }));

    expect(html).toContain('<code>npm test</code>');
    expect(html).not.toContain('aria-label="Copy code block"');
  });
});

describe('ChatMarkdown - text on a card of the board', () => {
  const links = { workspaceRoot: '/work/demo', fileUrl: (path: string) => `/file?name=${path}`, onOpenFile: () => {} };
  const card = (content: string, withLinks = links) => renderToStaticMarkup(createElement(ChatMarkdown, { content, links: withLinks, onCard: true }));

  it('opens http and https links in a new tab, without letting a press start a drag or a pan', () => {
    for (const href of ['https://example.com/a', 'http://example.com/b']) {
      const html = card(`[go](${href})`);
      expect(html).toMatch(new RegExp(`<a [^>]*class="[^"]*nodrag nopan[^"]*"`));
      expect(html).toContain(`href="${href}"`);
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    }
  });

  it('makes a link to a file of the workspace a link that carries the same classes', () => {
    for (const href of ['docs/spec.md', './docs/spec.md', '/work/demo/docs/spec.md', 'file:///work/demo/docs/spec.md']) {
      const html = card(`[spec](${href})`);
      expect(html, href).toMatch(/<a [^>]*class="[^"]*nodrag nopan/);
      expect(html, href).toContain('href="/file?name=docs/spec.md"');
      expect(html, href).not.toContain('target=');
    }
  });

  it('leaves every other link as the text it says', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/x', 'mailto:me@example.com', '#heading', '//example.com/x', '/etc/passwd', '../../outside.md', 'vbscript:x']) {
      const html = card(`[say](${href})`);
      expect(html, href).not.toContain('<a ');
      expect(html, href).not.toContain('<button');
      expect(html, href).toContain('say');
    }
  });

  it('does not let a scheme through by how it is written: in capitals, as character references, or with a percent sign', () => {
    const disguised = [
      'JaVaScRiPt:alert(1)', 'JAVASCRIPT:alert(1)', 'jAvAsCrIpT:alert(1)',
      'java&#115;cript:alert(1)', '&#106;avascript:alert(1)', '&#x6A;avascript:alert(1)', 'javascript&colon;alert(1)', 'java&Tab;script:alert(1)',
      '%6Aavascript:alert(1)', '%6a%61vascript:alert(1)', 'javascript%3Aalert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
      'VBScript:x', 'DATA:text/html,hi', 'File:///etc/passwd',
    ];
    for (const href of disguised) {
      for (const html of [card(`[say](<${href}>)`), renderToStaticMarkup(createElement(ChatMarkdown, { content: `[say](<${href}>)`, links }))]) {
        // Whatever it was taken for, no link of the page carries a script, a data address or another scheme.
        expect(html, href).not.toMatch(/href="\s*(javascript|vbscript|data|file):/i);
        expect(html, href).not.toMatch(/ on\w+=/i);
        expect(html, href).not.toContain('target=');
      }
    }
    // The ones that read as a scheme are text; the ones that do not are a path of the workspace, opened by the app and never run.
    for (const href of ['JaVaScRiPt:alert(1)', 'java&#115;cript:alert(1)', 'javascript&colon;alert(1)', 'DATA:text/html,hi', 'File:///etc/passwd']) {
      expect(card(`[say](<${href}>)`), href).not.toContain('<a ');
    }
    for (const href of ['%6Aavascript:alert(1)', 'javascript%3Aalert(1)']) {
      const html = card(`[say](<${href}>)`);
      expect(html, href).toContain('href="/file?name=javascript:alert(1)"');
    }
  });

  it('leaves a link to a file as text when there is no way to open it', () => {
    expect(renderToStaticMarkup(createElement(ChatMarkdown, { content: '[spec](docs/spec.md)', onCard: true }))).not.toContain('<a ');
  });

  it('does not load pictures, from the web or the workspace', () => {
    const html = card('![the chart](https://example.com/c.png) ![local](docs/c.png) ![](docs/d.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('[image: the chart]');
    expect(html).toContain('[image: local]');
    expect(html).toContain('[image]');
  });

  it('shows a heading as a bold line: no heading element, no id', () => {
    const html = card('# Title\n\n## Part two');
    expect(html).not.toMatch(/<h[1-6]/);
    expect(html).not.toContain(' id=');
    expect(html).toContain('<p class="font-semibold">Title</p>');
  });

  it('takes its links, and the copy button of a code block, out of the keyboard\'s way when the card cuts the text off', () => {
    const content = '[web](https://example.com/a) [file](docs/spec.md)\n\n```\ncode\n```';
    const whole = card(content);
    expect(whole).not.toContain('tabindex');
    const cut = renderToStaticMarkup(createElement(ChatMarkdown, { content, links, onCard: true, cut: true }));
    expect(cut.match(/tabindex="-1"/g)).toHaveLength(3);
    expect(cut).toMatch(/<a [^>]*tabindex="-1"[^>]*href="https:\/\/example.com\/a"/);
    expect(cut).toMatch(/<button [^>]*aria-label="Copy code block"[^>]*tabindex="-1"/);
  });

  it('keeps a press on the copy button of a code block from starting a drag or a pan, on a card only', () => {
    const content = '```\ncode\n```';
    expect(card(content)).toMatch(/<button [^>]*class="[^"]*nodrag nopan/);
    expect(renderToStaticMarkup(createElement(ChatMarkdown, { content }))).not.toContain('nodrag');
  });

  it('keeps the chat as it was: other links still behave as before', () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { content: '[a](#x) [m](mailto:me@example.com) [f](docs/spec.md) [h](https://example.com)', links }));
    expect(html).toContain('href="#x"');
    expect(html).toContain('href="mailto:me@example.com"');
    expect(html).toContain('href="/file?name=docs/spec.md"');
    expect(html).not.toContain('nodrag');
  });
});
