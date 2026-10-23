import { describe, expect, it } from 'vitest';
import { classifyMarkdownLink, headingSlug } from './markdownLinks.js';

const context = { workspaceRoot: '/home/me/workspaces/audit', documentPath: 'contextspace-document-1.md' };

describe('classifyMarkdownLink', () => {
  it('keeps in-document anchors in the document', () => {
    expect(classifyMarkdownLink('#open-questions', context)).toEqual({ kind: 'anchor', id: 'open-questions' });
    expect(classifyMarkdownLink('#f08--complete%20setup')).toEqual({ kind: 'anchor', id: 'f08--complete setup' });
  });

  it('opens public web and mail links outside the app', () => {
    expect(classifyMarkdownLink('https://github.com/antan87/Context-Space/blob/main/README.md#L453', context))
      .toEqual({ kind: 'external', href: 'https://github.com/antan87/Context-Space/blob/main/README.md#L453' });
    expect(classifyMarkdownLink('https://github.com/antan87/NexusFlow/blob/main/README.md#L453', context))
      .toEqual({ kind: 'external', href: 'https://github.com/antan87/NexusFlow/blob/main/README.md#L453' });
    expect(classifyMarkdownLink('mailto:team@example.com')).toEqual({ kind: 'external', href: 'mailto:team@example.com' });
  });

  it('opens absolute paths inside the workspace in the viewer', () => {
    // The screenshot index links captures by absolute path; this used to load
    // http://localhost:<port>/home/... and replace the app with a 404.
    expect(classifyMarkdownLink('/home/me/workspaces/audit/assessment/screenshots/01-onboarding.jpeg', context))
      .toEqual({ kind: 'workspace-file', path: 'assessment/screenshots/01-onboarding.jpeg' });
    expect(classifyMarkdownLink('file:///home/me/workspaces/audit/report%20v2.html', context))
      .toEqual({ kind: 'workspace-file', path: 'report v2.html' });
  });

  it('resolves relative links against the document folder', () => {
    expect(classifyMarkdownLink('assessment/evidence/labels.json?raw=1#top', context))
      .toEqual({ kind: 'workspace-file', path: 'assessment/evidence/labels.json' });
    expect(classifyMarkdownLink('../shots/a.png', { ...context, documentPath: 'notes/day1/log.md' }))
      .toEqual({ kind: 'workspace-file', path: 'notes/shots/a.png' });
    expect(classifyMarkdownLink('./plan.md', context)).toEqual({ kind: 'workspace-file', path: 'plan.md' });
  });

  it('matches Windows workspace paths case-insensitively', () => {
    const windows = { workspaceRoot: 'C:\\Users\\me\\workspaces\\audit', documentPath: 'a.md' };
    expect(classifyMarkdownLink('c:\\users\\ME\\workspaces\\audit\\shots\\1.png', windows))
      .toEqual({ kind: 'workspace-file', path: 'shots/1.png' });
    expect(classifyMarkdownLink('file:///C:/Users/me/workspaces/audit/b.md', windows)).toEqual({ kind: 'workspace-file', path: 'b.md' });
  });

  it('makes paths it cannot open safely inert instead of navigating', () => {
    expect(classifyMarkdownLink('/home/me/workspaces/other/shot.png', context)).toEqual({ kind: 'inert', label: '/home/me/workspaces/other/shot.png' });
    expect(classifyMarkdownLink('/home/me/workspaces/audit-copy/x.md', context)).toMatchObject({ kind: 'inert' });
    expect(classifyMarkdownLink('../../escape.md', context)).toMatchObject({ kind: 'inert' });
    expect(classifyMarkdownLink('/home/me/workspaces/audit', context)).toMatchObject({ kind: 'inert' });
    expect(classifyMarkdownLink('notes/a.md')).toEqual({ kind: 'inert', label: 'notes/a.md' });
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vscode://file/x', '//evil.example/x', 'https://user:pw@example.com/', '']) {
      expect(classifyMarkdownLink(href, context).kind).toBe('inert');
    }
  });
});

describe('classifyMarkdownLink, schemes written another way', () => {
  it('reads a scheme in any case as the scheme it is', () => {
    for (const href of ['JaVaScRiPt:alert(1)', 'JAVASCRIPT:alert(1)', 'VBScript:x', 'DATA:text/html,hi', 'Ftp://example.com/x']) {
      expect(classifyMarkdownLink(href, context), href).toEqual({ kind: 'inert', label: href });
    }
    expect(classifyMarkdownLink('HTTPS://Example.com/a', context)).toEqual({ kind: 'external', href: 'https://example.com/a' });
    expect(classifyMarkdownLink('File:///home/me/workspaces/audit/a.md', context)).toEqual({ kind: 'workspace-file', path: 'a.md' });
    expect(classifyMarkdownLink('File:///etc/passwd', context)).toEqual({ kind: 'inert', label: '/etc/passwd' });
  });

  it('never makes a link of a scheme that is written with percent signs: it is a file name, whatever it spells', () => {
    // The page does not decode a link before it looks for its scheme, so these are paths of the workspace, never addresses.
    for (const href of ['%6Aavascript:alert(1)', 'javascript%3Aalert(1)', '%6a%61vascript:alert(1)']) {
      expect(classifyMarkdownLink(href, context), href).toEqual({ kind: 'workspace-file', path: 'javascript:alert(1)' });
      expect(classifyMarkdownLink(href), href).toEqual({ kind: 'inert', label: 'javascript:alert(1)' });
    }
  });

  it('reads the link a character reference spelled once the renderer has decoded it, and trims the spaces around it', () => {
    expect(classifyMarkdownLink('javascript:alert(1)', context)).toEqual({ kind: 'inert', label: 'javascript:alert(1)' });
    expect(classifyMarkdownLink('java\tscript:alert(1)', context)).toMatchObject({ kind: 'workspace-file' });
    expect(classifyMarkdownLink(' \tjavascript:alert(1)', context)).toEqual({ kind: 'inert', label: 'javascript:alert(1)' });
  });
});

describe('headingSlug', () => {
  it('matches GitHub anchors for typical headings', () => {
    expect(headingSlug('Open questions')).toBe('open-questions');
    expect(headingSlug('F08 — Complete first-run setup')).toBe('f08--complete-first-run-setup');
  });
});
