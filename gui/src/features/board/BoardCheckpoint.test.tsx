import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { BoardCheckpoint, AddStepInline } from './BoardNodes.js';
import { BoardActionsContext } from './boardActions.js';
import type { CheckpointData } from './boardLayout.js';

describe('BoardCheckpoint component', () => {
  const queryClient = new QueryClient();

  const mockData: CheckpointData = {
    kind: 'checkpoint',
    open: true,
    openHeight: 280,
    title: 'CSV Reports Feature',
    done: false,
    stepsDone: 1,
    stepsTotal: 2,
    steps: [
      { key: 'step-1', text: 'Create stream parser', done: true },
      { key: 'step-2', text: 'Buffer records to disk', done: false },
    ],
    moreSteps: 0,
    waiting: [],
    moreWaiting: 0,
    checkpointKey: 'csv-reports-feature',
  };

  const renderCheckpoint = (data: CheckpointData, workspaceId = 'test-ws') => {
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
              },
            },
            createElement(BoardCheckpoint, {
              id: 'checkpoint:csv-reports-feature',
              data,
              type: 'checkpoint',
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

  it('renders checkpoint title, steps, and "+ Add step" inline trigger', () => {
    const html = renderCheckpoint(mockData);

    expect(html).toContain('CSV Reports Feature');
    expect(html).toContain('Create stream parser');
    expect(html).toContain('Buffer records to disk');
    expect(html).toContain('Add step');
    expect(html).toContain('checkpoint-add-step-trigger-csv-reports-feature');
  });

  it('meets Calm Design constraints: font size text-[12.5px] and touch target min-h-[24px]', () => {
    const html = renderCheckpoint(mockData);

    expect(html).toContain('text-[12.5px]');
    expect(html).toContain('min-h-[24px]');
  });

  it('renders folded summary when open is false', () => {
    const foldedData: CheckpointData = {
      ...mockData,
      open: false,
    };
    const html = renderCheckpoint(foldedData);

    expect(html).toContain('CSV Reports Feature');
    expect(html).toContain('1 of 2 steps');
    // Steps and Add step trigger are hidden when folded
    expect(html).not.toContain('checkpoint-add-step-trigger');
  });

  it('renders expanded AddStepInline form with input, submit, cancel and Calm Design constraints', () => {
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
              },
            },
            createElement(AddStepInline, {
              checkpointKey: 'csv-reports-feature',
              workspaceId: 'test-ws',
              defaultOpen: true,
            })
          )
        )
      )
    );
    expect(html).toContain('checkpoint-add-step-form-csv-reports-feature');
    expect(html).toContain('checkpoint-add-step-input');
    expect(html).toContain('checkpoint-add-step-submit');
    expect(html).toContain('checkpoint-add-step-cancel');
    expect(html).toContain('text-[12.5px]');
    expect(html).toContain('min-h-[24px]');
  });
});
