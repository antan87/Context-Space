import { describe, expect, it } from 'vitest';
import { findThreadChain } from './boardThread.js';
import type { BoardCard, BoardLink } from './boardData.js';
import type { BoardNode } from './boardLayout.js';

describe('findThreadChain', () => {
  it('returns empty set if selectedId is empty', () => {
    expect(findThreadChain({ selectedId: '' })).toEqual(new Set());
  });

  it('always includes the selected node itself', () => {
    const chain = findThreadChain({ selectedId: 'card-1' });
    expect(chain.has('card-1')).toBe(true);
    expect(chain.size).toBe(1);
  });

  it('includes directly linked cards in both directions', () => {
    const links: BoardLink[] = [
      { id: 'l1', from: 'card-1', to: 'card-2' },
      { id: 'l2', from: 'card-0', to: 'card-1' },
    ];
    const chain = findThreadChain({ selectedId: 'card-1', links });
    expect(chain.has('card-0')).toBe(true);
    expect(chain.has('card-1')).toBe(true);
    expect(chain.has('card-2')).toBe(true);
    expect(chain.size).toBe(3);
  });

  it('follows transitive link chains', () => {
    const links: BoardLink[] = [
      { id: 'l1', from: 'card-1', to: 'card-2' },
      { id: 'l2', from: 'card-2', to: 'card-3' },
      { id: 'l3', from: 'card-3', to: 'card-4' },
      { id: 'unrelated', from: 'other-a', to: 'other-b' },
    ];
    const chain = findThreadChain({ selectedId: 'card-1', links });
    expect(chain.has('card-1')).toBe(true);
    expect(chain.has('card-2')).toBe(true);
    expect(chain.has('card-3')).toBe(true);
    expect(chain.has('card-4')).toBe(true);
    expect(chain.has('other-a')).toBe(false);
    expect(chain.has('other-b')).toBe(false);
  });

  it('groups cards sharing the same plan step', () => {
    const cards: BoardCard[] = [
      {
        id: 'card-1',
        kind: 'note',
        title: 'Step note',
        body: 'Notes',
        pinned: false,
        archived: false,
        by: 'user',
        at: '2026-10-24T00:00:00Z',
        updatedBy: 'user',
        updatedAt: '2026-10-24T00:00:00Z',
        step: 'step-export',
      },
      {
        id: 'card-file',
        kind: 'file',
        path: 'diagram.png',
        title: 'Diagram',
        pinned: false,
        archived: false,
        by: 'user',
        at: '2026-10-24T00:00:00Z',
        updatedBy: 'user',
        updatedAt: '2026-10-24T00:00:00Z',
        step: 'step-export',
      },
      {
        id: 'card-unrelated',
        kind: 'note',
        title: 'Other',
        body: 'Other',
        pinned: false,
        archived: false,
        by: 'user',
        at: '2026-10-24T00:00:00Z',
        updatedBy: 'user',
        updatedAt: '2026-10-24T00:00:00Z',
        step: 'step-other',
      },
    ];

    const chain = findThreadChain({ selectedId: 'card-1', cards });
    expect(chain.has('card-1')).toBe(true);
    expect(chain.has('card-file')).toBe(true);
    expect(chain.has('card-unrelated')).toBe(false);
  });

  it('connects commit nodes matching short or long SHAs in the chain', () => {
    const nodes: BoardNode[] = [
      {
        id: 'commit:billing:a91f2e0',
        type: 'commit',
        position: { x: 0, y: 0 },
        data: { sha: 'a91f2e0', subject: 'Subject', author: 'Anna', at: '2026-10-24' },
      } as BoardNode,
    ];
    const links: BoardLink[] = [
      { id: 'l1', from: 'card-1', to: 'commit:billing:a91f2e0' },
    ];
    const chain = findThreadChain({ selectedId: 'card-1', nodes, links });
    expect(chain.has('card-1')).toBe(true);
    expect(chain.has('commit:billing:a91f2e0')).toBe(true);
  });
});
