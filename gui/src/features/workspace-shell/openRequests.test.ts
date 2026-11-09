import { describe, expect, it } from 'vitest';
import { codeRequests, documentRequests } from './openRequests.js';
import { codeRequestFor } from './useOpenFileReference.js';

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

describe('codeRequestFor', () => {
  const file = { repoName: 'api', repoPath: '/w/api', file: 'src/app.ts' };

  it('opens a found file at the clicked line', () => {
    expect(codeRequestFor('src/app.ts', 12, { status: 'found', ...file })).toEqual({ kind: 'file', ...file, line: 12 });
  });

  it('offers every candidate when the path is ambiguous', () => {
    const other = { repoName: 'web', repoPath: '/w/web', file: 'src/app.ts' };
    expect(codeRequestFor('src/app.ts', undefined, { status: 'ambiguous', candidates: [file, other] }))
      .toEqual({ kind: 'ambiguous', path: 'src/app.ts', line: undefined, candidates: [file, other] });
  });

  it('says why nothing was found, keeping an absolute path to open elsewhere', () => {
    expect(codeRequestFor('/etc/hosts', 3, { status: 'not-found', reason: 'outside-repositories', absolutePath: '/etc/hosts' }))
      .toEqual({ kind: 'not-found', path: '/etc/hosts', line: 3, reason: 'outside-repositories', absolutePath: '/etc/hosts' });
  });
});
