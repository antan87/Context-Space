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
