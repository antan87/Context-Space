import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { BoardRowHead } from './BoardNodes.js';
import { BoardActionsContext } from './boardActions.js';
import type { RowHeadNode } from './boardLayout.js';

describe('BoardRowHead static step component', () => {
  const queryClient = new QueryClient();

  const renderRowHead = (data: RowHeadNode['data'], workspaceId = 'test-ws') => {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          ReactFlowProvider,
          null,
          createElement(
            BoardActionsContext.Provider,
            {
              value: {
                workspaceId,
                openInReader: () => {},
                toggleGroup: () => {},
                keepFocus: () => {},
                toggleStep: async () => true,
              },
            },
            createElement(BoardRowHead, {
              id: 'test-row-head',
              data,
              type: 'step',
              selected: false,
              zIndex: 1,
              isConnectable: false,
              positionAbsoluteX: 0,
              positionAbsoluteY: 0,
              dragging: false,
            } as any)
          )
        )
      )
    );
  };

  it('renders interactive step trigger button and separate checkbox for static step card', () => {
    const html = renderRowHead({
      rowId: 'row:done',
      title: 'Done',
      text: 'Background job queue for large exports with automatic retries and notification on completion',
      summary: '',
      state: 'done',
      expanded: true,
      prominent: false,
      empty: false,
      static: true,
      stepKey: 'job-queue',
    });

    // Checkbox is present
    expect(html).toContain('data-testid="step-checkbox-job-queue"');
    expect(html).toContain('aria-checked="true"');

    // Step trigger button is present with accessible label and data-card-main
    expect(html).toContain('data-testid="step-trigger-job-queue"');
    expect(html).toContain('data-card-main="true"');
    expect(html).toContain('aria-label="View step: Background job queue for large exports with automatic retries and notification on completion"');

    // Outer card container has drag/pan isolation and brick interaction classes
    expect(html).toContain('nodrag');
    expect(html).toContain('nopan');
    expect(html).toContain('board-brick');
    expect(html).toContain('has-[:focus-visible]:ring-2');

    // Displays STATE_LABEL and step text
    expect(html).toContain('Done');
    expect(html).toContain('Background job queue for large exports with automatic retries and notification on completion');
  });

  it('renders open static step with unchecked checkbox and proper state label', () => {
    const html = renderRowHead({
      rowId: 'row:open',
      title: 'Step',
      text: 'Write the CSV writer unit tests',
      summary: '',
      state: 'open',
      expanded: true,
      prominent: false,
      empty: false,
      static: true,
      stepKey: 'csv-writer',
    });

    expect(html).toContain('data-testid="step-checkbox-csv-writer"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('data-testid="step-trigger-csv-writer"');
    expect(html).toContain('data-card-main="true"');
    expect(html).toContain('Write the CSV writer unit tests');
  });

  it('disables checkbox button when readOnly is true', () => {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          ReactFlowProvider,
          null,
          createElement(
            BoardActionsContext.Provider,
            {
              value: {
                workspaceId: 'test-ws',
                openInReader: () => {},
                toggleGroup: () => {},
                keepFocus: () => {},
                toggleStep: async () => true,
                readOnly: true,
              },
            },
            createElement(BoardRowHead, {
              id: 'test-row-head',
              data: {
                rowId: 'row:open',
                title: 'Step',
                text: 'Read-only step',
                summary: '',
                state: 'open',
                expanded: true,
                prominent: false,
                empty: false,
                static: true,
                stepKey: 'readonly-step',
              },
              type: 'step',
              selected: false,
              zIndex: 1,
              isConnectable: false,
              positionAbsoluteX: 0,
              positionAbsoluteY: 0,
              dragging: false,
            } as any)
          )
        )
      )
    );

    expect(html).toContain('data-testid="step-checkbox-readonly-step"');
    expect(html).toContain('disabled=""');
  });

  it('renders step error alert if stepErrors has an error for the stepKey', () => {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          ReactFlowProvider,
          null,
          createElement(
            BoardActionsContext.Provider,
            {
              value: {
                workspaceId: 'test-ws',
                openInReader: () => {},
                toggleGroup: () => {},
                keepFocus: () => {},
                stepErrors: { 'job-queue': 'Failed to save step' },
              },
            },
            createElement(BoardRowHead, {
              id: 'test-row-head',
              data: {
                rowId: 'row:done',
                title: 'Done',
                text: 'Background job queue',
                summary: '',
                state: 'done',
                expanded: true,
                prominent: false,
                empty: false,
                static: true,
                stepKey: 'job-queue',
              },
              type: 'step',
              selected: false,
              zIndex: 1,
              isConnectable: false,
              positionAbsoluteX: 0,
              positionAbsoluteY: 0,
              dragging: false,
            } as any)
          )
        )
      )
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Failed to save step');
  });
});

