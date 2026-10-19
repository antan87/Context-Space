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
