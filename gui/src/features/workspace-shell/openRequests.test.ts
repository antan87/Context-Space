import { describe, expect, it } from 'vitest';
import { codeRequests, documentRequests, codeWindowRequests, invalidateReferenceIntent, referenceIntentIsCurrent } from './openRequests.js';
import { openReferenceTarget } from './useOpenFileReference.js';

describe('open requests', () => {
  it('keeps the latest request per workspace, numbered so a repeat still counts as new', () => {
    const seen: number[] = [];
    const unsubscribe = codeRequests.subscribe(() => seen.push(codeRequests.get('ws-a')?.id ?? 0));
    const first = codeRequests.open('ws-a', { kind: 'locating', path: 'src/app.ts' });
    const second = codeRequests.open('ws-a', { kind: 'locating', path: 'src/app.ts' });
    codeRequests.open('ws-b', { kind: 'locating', path: 'other.ts' });
    unsubscribe();
    expect(second).toBeGreaterThan(first);
    expect(codeRequests.get('ws-a')).toEqual({ id: second, request: { kind: 'locating', path: 'src/app.ts' } });
    expect(seen.slice(0, 2)).toEqual([first, second]);
    expect(codeRequests.get('missing')).toBeNull();
  });

  it('acknowledges only the matching workspace and request, including repeated paths', () => {
    const first = documentRequests.open('ack-a', { name: 'docs/guide.md' });
    const second = documentRequests.open('ack-a', { name: 'docs/guide.md' });
    const other = documentRequests.open('ack-b', { name: 'docs/guide.md' });
    documentRequests.acknowledge('ack-a', first);
    expect(documentRequests.get('ack-a')?.id).toBe(second);
    documentRequests.acknowledge('ack-a', second);
    expect(documentRequests.get('ack-a')).toBeNull();
    expect(documentRequests.get('ack-b')?.id).toBe(other);
    documentRequests.acknowledge('ack-b', other);
  });

  it('keeps document and code requests apart', () => {
    documentRequests.open('ws-c', { name: 'docs/guide.md' });
    expect(documentRequests.get('ws-c')?.request).toEqual({ name: 'docs/guide.md' });
    expect(codeRequests.get('ws-c')).toBeNull();
  });
});

describe('reference routing', () => {
  it('keeps workspace code identity and line, including repeated requests', () => {
    const target = { origin: { kind: 'workspace' as const, workspacePath: '/w' }, file: 'notes.md', viewer: 'reader' as const };
    openReferenceTarget('route-w', target, 7, null);
    const first = codeWindowRequests.get('route-w')!;
    expect(first.request.workspaceFile).toEqual({ workspaceId: 'route-w', file: 'notes.md', line: 7 });
    openReferenceTarget('route-w', target, 7, null);
    expect(codeWindowRequests.get('route-w')!.id).toBeGreaterThan(first.id);
  });
  it('keeps repository identity for reader targets', () => {
    openReferenceTarget('route-r', { origin: { kind: 'repository', repoName: 'api', repoPath: '/w/api' }, file: 'docs/a.html', viewer: 'reader' }, undefined, null);
    expect(documentRequests.get('route-r')?.request).toEqual({ name: 'docs/a.html', repo: { name: 'api', path: '/w/api' }, opener: null, intent: expect.any(Number) });
  });
  it('invalidates an earlier asynchronous lookup', () => {
    const first = invalidateReferenceIntent();
    expect(referenceIntentIsCurrent(first)).toBe(true);
    invalidateReferenceIntent();
    expect(referenceIntentIsCurrent(first)).toBe(false);
  });
});

describe('queued reference delivery', () => {
  it('rejects code and window results already queued when newer form work begins', async () => {
    const { referenceRequestIsCurrent } = await import('./openRequests.js');
    openReferenceTarget('queued-form', { origin: { kind: 'repository', repoName: 'api', repoPath: '/w/api' }, file: 'src/late.ts', viewer: 'code' }, 35, null);
    const code = codeRequests.get('queued-form')!.request;
    const window = codeWindowRequests.get('queued-form')!.request;
    expect(referenceRequestIsCurrent(code)).toBe(true);
    expect(referenceRequestIsCurrent(window)).toBe(true);
    invalidateReferenceIntent();
    expect(referenceRequestIsCurrent(code)).toBe(false);
    expect(referenceRequestIsCurrent(window)).toBe(false);
  });
});

interface MockNode {
  tagName: string;
  isConnected: boolean;
  textContent: string;
  attrs: Record<string, string>;
  parent?: MockNode;
  children: MockNode[];
  matchesSelector: (selector: string) => boolean;
  closest: (selector: string) => MockNode | null;
  querySelector: <T extends Element = HTMLElement>(selector: string) => T | null;
  querySelectorAll: <T extends Element = HTMLElement>(selector: string) => T[];
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
}

function makeNode(tagName: string, attrs: Record<string, string> = {}, textContent = '', connected = true): MockNode {
  const node: MockNode = {
    tagName: tagName.toUpperCase(),
    isConnected: connected,
    textContent,
    attrs,
    children: [],
    matchesSelector(selector: string) {
      return selector.split(',').some((part) => {
        const s = part.trim();
        if (s === '[data-board-reader][data-reader-doc]') return 'data-board-reader' in node.attrs && 'data-reader-doc' in node.attrs;
        if (s === '[data-board-reader] h2') return node.tagName === 'H2' && Boolean(node.closest('[data-board-reader]'));
        if (s === '[data-board-reader]') return 'data-board-reader' in node.attrs;
        if (s === '#board-reader-note') return node.attrs.id === 'board-reader-note';
        if (s === '[inert]') return 'inert' in node.attrs;
        if (s === '[hidden]') return 'hidden' in node.attrs;
        if (s === '[data-testid="board-code-button"]') return node.attrs['data-testid'] === 'board-code-button';
        if (s === '[data-testid]') return 'data-testid' in node.attrs;
        return node.tagName.toLowerCase() === s.toLowerCase();
      });
    },
    closest(selector: string) {
      let cur: MockNode | undefined = node;
      while (cur) {
        if (cur.matchesSelector(selector)) return cur;
        cur = cur.parent;
      }
      return null;
    },
    querySelector<T extends Element = HTMLElement>(selector: string) {
      return (node.querySelectorAll<T>(selector)[0] ?? null);
    },
    querySelectorAll<T extends Element = HTMLElement>(selector: string) {
      const found: MockNode[] = [];
      const visit = (cur: MockNode) => {
        for (const child of cur.children) {
          if (child.matchesSelector(selector)) found.push(child);
          visit(child);
        }
      };
      visit(node);
      return found as unknown as T[];
    },
    getAttribute: (name: string) => (name in node.attrs ? node.attrs[name]! : null),
    hasAttribute: (name: string) => name in node.attrs,
  };
  return node;
}

function append(parent: MockNode, child: MockNode): MockNode {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

describe('code window opener resolution', () => {
  it('returns the live non-inert opener when connected', async () => {
    const { resolveCodeWindowOpener } = await import('./openRequests.js');
    const root = makeNode('div');
    const reader = append(root, makeNode('section', { 'data-board-reader': '', 'data-reader-doc': 'file:api:docs/guide.md' }));
    const link = append(reader, makeNode('a', { href: '/api/workspace/demo/documents/file?name=src/shared.ts' }, 'Open code'));
    expect(resolveCodeWindowOpener(link as unknown as HTMLElement, null, root)).toBe(link);
  });

  it('finds the replacement link in the same document when the original node detached', async () => {
    const { resolveCodeWindowOpener } = await import('./openRequests.js');
    const href = '/api/workspace/demo/documents/file?name=src/shared.ts';
    const stale = makeNode('a', { href }, 'Open code', false);

    const root = makeNode('div');
    const reader = append(root, makeNode('section', { 'data-board-reader': '', 'data-reader-doc': 'file:api:docs/guide.md' }));
    append(reader, makeNode('a', { href }, 'Open code'));
    const second = append(reader, makeNode('a', { href }, 'Open code'));

    const resolved = resolveCodeWindowOpener(
      stale as unknown as HTMLElement,
      { kind: 'reader', scope: 'file:api:docs/guide.md', inNote: false, tag: 'a', href, text: 'Open code', ariaLabel: null, occurrence: 1 },
      root,
    );
    expect(resolved).toBe(second);
  });

  it('does not focus a link from a different document and prefers a non-inert Code button or reader heading fallback', async () => {
    const { resolveCodeWindowOpener } = await import('./openRequests.js');
    const href = '/api/workspace/demo/documents/file?name=src/shared.ts';
    const stale = makeNode('a', { href }, 'Open code', false);

    const root = makeNode('div');
    const otherReader = append(root, makeNode('section', { 'data-board-reader': '', 'data-reader-doc': 'file:api:docs/other.md' }));
    const heading = append(otherReader, makeNode('h2', {}, 'other.md'));
    append(otherReader, makeNode('a', { href }, 'Open code'));
    const inertPane = append(root, makeNode('div', { inert: '' }));
    append(inertPane, makeNode('button', { 'data-testid': 'board-code-button' }, 'Code'));
    const liveButton = append(root, makeNode('button', { 'data-testid': 'board-code-button' }, 'Code'));

    const target = { kind: 'reader' as const, scope: 'file:api:docs/guide.md', inNote: false, tag: 'a', href, text: 'Open code', ariaLabel: null, occurrence: 0 };
    expect(resolveCodeWindowOpener(stale as unknown as HTMLElement, target, root)).toBe(liveButton);

    liveButton.attrs.inert = '';
    expect(resolveCodeWindowOpener(stale as unknown as HTMLElement, target, root)).toBe(heading);
  });

  it('finds the matching link if React reused the original connected DOM node for a shifted sibling link', async () => {
    const { resolveCodeWindowOpener } = await import('./openRequests.js');
    const keepHref = '/api/workspace/demo/documents/file?name=other.md';
    const openHref = '/api/workspace/demo/documents/file?name=src/shared.ts';

    const root = makeNode('div');
    const reader = append(root, makeNode('section', { 'data-board-reader': '', 'data-reader-doc': 'file:api:docs/guide.md' }));
    const reusedKeep = append(reader, makeNode('a', { href: keepHref }, 'Keep'));
    const shiftedOpen = append(reader, makeNode('a', { href: openHref }, 'Open code'));

    const target = { kind: 'reader' as const, scope: 'file:api:docs/guide.md', inNote: false, tag: 'a', href: openHref, text: 'Open code', ariaLabel: null, occurrence: 0 };
    expect(resolveCodeWindowOpener(reusedKeep as unknown as HTMLElement, target, root)).toBe(shiftedOpen);
  });
});
