import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { BoardArea } from '../BoardNodes.js';
import type { AreaNode } from '../boardAreas.js';

/**
 * The "New since you looked" dot in the title of the Area overview card (BoardArea). The golden markup does not draw a
 * fresh Area card that is not the current one, so this pins that spot on its own (DS4): the dot in front of the title,
 * its class, title and aria-hidden, byte for byte.
 */
describe('fresh dot in the Area card title', () => {
  it('is the inline dot with its title, in front of the title text', () => {
    const data = {
      kind: 'checkpoint', title: 'Fresh area', done: false, current: false, nowSet: false, stepsDone: 0, stepsTotal: 2,
      waitingCount: 0, noteCount: 0, fileCount: 0, pictureCount: 0, documentCount: 0, commitCount: 0, archivedCount: 0,
      pictures: [], fresh: true, freshKey: 'k',
    } as AreaNode['data'];
    const props = { id: 'checkpoint:x', data, type: 'area', selected: false, zIndex: 1, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0, dragging: false, draggable: false, selectable: false, deletable: false } as unknown as NodeProps<AreaNode>;
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ReactFlowProvider, null, createElement(BoardArea, props))));
    expect(html).toContain('<span class="mr-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary align-middle" title="New since you looked" aria-hidden="true"></span>Fresh area</span>');
  });
});
