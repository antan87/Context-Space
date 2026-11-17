import { existsSync, readFileSync } from 'node:fs';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';
import {
  BoardAnswerCard,
  BoardArea,
  BoardAreaFold,
  BoardAreaMini,
  BoardAreaRow,
  BoardCheckpoint,
  BoardCommit,
  BoardDocument,
  BoardFile,
  BoardFoldRow,
  BoardLane,
  BoardMoreTile,
  BoardNote,
  BoardPager,
  BoardPlaceholder,
  BoardRowHead,
  BoardUncommitted,
} from '../BoardNodes.js';
import {
  BoardActionsContext,
  BoardReadingContext,
  type BoardActions,
} from '../boardActions.js';
import { CommitNotesContext, type CommitNoteEntry } from '../commitNotes.js';
import type {
  AreaFoldNode,
  AreaMiniNode,
  AreaNode,
  AreaRowNode,
} from '../boardAreas.js';
import type {
  AnswerNode,
  CheckpointNode,
  CommitNode,
  DocumentNode,
  FileNode,
  FoldNode,
  LaneNode,
  MoreNode,
  NoteNode,
  PagerNode,
  PlaceholderNode,
  RowHeadNode,
  UncommittedNode,
} from '../boardLayout.js';

/**
 * Golden markup snapshots for every node kind registered in BoardSection.tsx:
 *
 * OVERVIEW_NODE_TYPES: area, areaRow, areaMini, areaFold, checkpoint
 * AREA_NODE_TYPES: lane, checkpoint, document, commit, placeholder, uncommitted,
 *   note, file, answer, step, fold, more, pager
 *
 * Move slices must leave these snapshots byte-for-byte unchanged; only an explicit
 * restyle slice may update them.
 */

const FIXED_NOW = new Date('2026-11-17T12:00:00.000Z');
const CREATED_AT = '2026-11-17T11:50:00.000Z';
const UPDATED_AT = '2026-11-17T11:55:00.000Z';
const COMMIT_AT = '2026-11-17T11:58:00.000Z';

const ACTIONS: BoardActions = {
  workspaceId: 'ws-snap',
  workspacePath: '/workspace/demo',
  openInReader: () => {},
  openCode: () => {},
  toggleGroup: () => {},
  keepFocus: () => {},
  toggleRow: () => {},
  setRowPage: () => {},
  setRowTab: () => {},
  openArea: () => {},
  openStep: () => {},
  openCount: () => {},
  selectThread: () => {},
  answerDecision: async () => true,
  toggleStep: async () => true,
  setNow: async () => true,
  nowKeys: new Set(['step-now', 'step-open']),
  nowKey: 'step-now',
  runCheck: async () => true,
  updateNote: async () => true,
  askInCLI: () => {},
  activeAreaTitle: 'Safety net',
  availableAreas: [{ id: 'checkpoint:cp-1', title: 'Safety net' }],
};

const COMMIT_NOTES: CommitNoteEntry[] = [
  {
    id: 'note-on-commit',
    repo: 'NexusFlow',
    sha: 'abc1234',
    title: 'Verified snapshot determinism',
    body: 'Checked with fake timers.',
    by: 'claude',
    at: CREATED_AT,
  },
];

function nodeProps<TNode extends Node>(
  id: string,
  type: TNode['type'],
  data: TNode['data'],
  size?: { width?: number; height?: number },
): NodeProps<TNode> {
  return {
    id,
    data,
    type: (type ?? '') as NonNullable<TNode['type']>,
    selected: false,
    zIndex: 1,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    draggable: false,
    selectable: false,
    deletable: false,
    ...size,
  } as NodeProps<TNode>;
}

function renderNode<TNode extends Node>(
  Component: ComponentType<NodeProps<TNode>>,
  props: NodeProps<TNode>,
  readingId: string | null = null,
): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ReactFlowProvider,
        null,
        createElement(
          BoardActionsContext.Provider,
          { value: ACTIONS },
          createElement(
            BoardReadingContext.Provider,
            { value: readingId },
            createElement(
              CommitNotesContext.Provider,
              { value: COMMIT_NOTES },
              createElement(Component, props),
            ),
          ),
        ),
      ),
    ),
  );
}

describe('board node golden markup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    vi.stubGlobal('document', {
      documentElement: {
        classList: {
          contains: () => false,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('covers all 17 node types registered by OVERVIEW_NODE_TYPES and AREA_NODE_TYPES', () => {
    const overviewKinds = ['area', 'areaRow', 'areaMini', 'areaFold', 'checkpoint'] as const;
    const areaKinds = [
      'lane',
      'checkpoint',
      'document',
      'commit',
      'placeholder',
      'uncommitted',
      'note',
      'file',
      'answer',
      'step',
      'fold',
      'more',
      'pager',
    ] as const;
    const distinct = new Set<string>([...overviewKinds, ...areaKinds]);
    expect(distinct.size).toBe(17);

    // Cross-check against the live OVERVIEW_NODE_TYPES / AREA_NODE_TYPES definitions so new node kinds cannot go unpinned.
    const nodeTypesPath = new URL('../nodeTypes.ts', import.meta.url);
    const sectionPath = new URL('../BoardSection.tsx', import.meta.url);
    const source = readFileSync(existsSync(nodeTypesPath) ? nodeTypesPath : sectionPath, 'utf8');
    const parseKeys = (name: string) => {
      const match = source.match(new RegExp(`const ${name}\\b[^=]*=\\s*\\{([^}]+)\\}`));
      expect(match, name).toBeTruthy();
      return Array.from(match![1]!.matchAll(/\b([a-zA-Z0-9_]+)\s*:/g), (m) => m[1]!);
    };
    const registered = new Set([...parseKeys('OVERVIEW_NODE_TYPES'), ...parseKeys('AREA_NODE_TYPES')]);
    expect(registered).toEqual(distinct);
  });

  it('area: BoardArea overview card', () => {
    const html = renderNode(
      BoardArea,
      nodeProps<AreaNode>('checkpoint:cp-1', 'area', {
        kind: 'checkpoint',
        title: 'DS1: the test safety net',
        done: false,
        current: true,
        nowSet: true,
        focusSource: 'set',
        focusStep: 'step-now',
        openSteps: [
          { key: 'step-now', text: 'Pin **every card** markup', done: false },
          { key: 'step-next', text: 'Add fix-specs helper', done: false },
        ],
        stepsDone: 1,
        stepsTotal: 3,
        waitingCount: 1,
        noteCount: 2,
        fileCount: 1,
        pictureCount: 1,
        documentCount: 1,
        commitCount: 2,
        archivedCount: 0,
        pictures: [{ path: 'board-pictures/preview.png', alt: 'Board preview' }],
        fresh: true,
        freshKey: 'cp-1-fresh',
      }),
    );
    expect(html).toMatchSnapshot();
  });

  it('areaRow: BoardAreaRow overview row', () => {
    const html = renderNode(
      BoardAreaRow,
      nodeProps<AreaRowNode>(
        'checkpoint:cp-2',
        'areaRow',
        {
          kind: 'checkpoint',
          title: 'Design module',
          done: false,
          current: false,
          nowSet: false,
          tier: 3,
          stepsDone: 2,
          stepsTotal: 4,
          waitingCount: 0,
          noteCount: 1,
          fileCount: 0,
          pictureCount: 0,
          documentCount: 0,
          commitCount: 2,
          archivedCount: 0,
          pictures: [],
          newsSummary: '2 commits, 1 note',
          newsItems: [
            { kind: 'commits', label: '2 commits', actionLabel: 'Open 2 new commits' },
            { kind: 'notes', label: '1 note', actionLabel: 'Open 1 new note' },
          ],
          questionItem: { kind: 'question', label: '1 question', actionLabel: 'Open 1 question' },
          questionTarget: 'question:q1.md',
          fresh: true,
          freshKey: 'cp-2-fresh',
        },
        { width: 480 },
      ),
    );
    expect(html).toMatchSnapshot();
  });

  it('areaMini: BoardAreaMini checkpoint and questions variants', () => {
    const checkpointMini = renderNode(
      BoardAreaMini,
      nodeProps<AreaMiniNode>(
        'checkpoint:cp-3',
        'areaMini',
        {
          kind: 'checkpoint',
          title: 'Card frame extraction',
          done: false,
          current: true,
          nowSet: false,
          focusSource: 'plan',
          tier: 4,
          nextOpenStep: 'Extract CardFrame component',
          stepsDone: 1,
          stepsTotal: 4,
          waitingCount: 1,
          waitingQuestion: 'Keep shadow on compact cards?',
          noteCount: 1,
          fileCount: 0,
          pictureCount: 1,
          documentCount: 0,
          commitCount: 0,
          archivedCount: 0,
          pictures: [{ path: 'board-pictures/mini.png', alt: 'Mini preview' }],
          fresh: false,
        },
        { width: 240, height: 100 },
      ),
    );
    const questionsMini = renderNode(
      BoardAreaMini,
      nodeProps<AreaMiniNode>(
        'question:how-cards-render.md',
        'areaMini',
        {
          kind: 'questions',
          title: 'How do cards render?',
          done: false,
          current: false,
          nowSet: false,
          stepsDone: 0,
          stepsTotal: 0,
          waitingCount: 0,
          noteCount: 0,
          fileCount: 0,
          pictureCount: 0,
          documentCount: 0,
          commitCount: 0,
          archivedCount: 0,
          pictures: [],
          preview: 'With renderToStaticMarkup and fixed snapshots.',
          answerCounts: { parts: 3, code: 2, pictures: 0, changed: 1 },
          fresh: true,
          freshKey: 'q-fresh',
        },
        { width: 240, height: 100 },
      ),
    );
    expect({ checkpointMini, questionsMini }).toMatchSnapshot();
  });

  it('areaMini and area extra variants: Tier 3 news overlay, Workspace files mini, and done/plan BoardArea', () => {
    const newsMini = renderNode(
      BoardAreaMini,
      nodeProps<AreaMiniNode>(
        'checkpoint:cp-news',
        'areaMini',
        {
          kind: 'checkpoint',
          title: 'Recent fixes',
          done: false,
          current: false,
          nowSet: false,
          tier: 3,
          stepsDone: 2,
          stepsTotal: 3,
          waitingCount: 0,
          noteCount: 1,
          fileCount: 0,
          pictureCount: 0,
          documentCount: 0,
          commitCount: 2,
          archivedCount: 0,
          pictures: [],
          newsSummary: '2 commits, 1 note',
          newsItems: [
            { kind: 'commits', label: '2 commits', actionLabel: 'Open 2 new commits' },
            { kind: 'notes', label: '1 note', actionLabel: 'Open 1 new note' },
          ],
          questionItem: { kind: 'question', label: '1 question', actionLabel: 'Open 1 question' },
          questionTarget: 'question:q1.md',
          fresh: true,
          freshKey: 'cp-news-fresh',
        },
        { width: 260, height: 100 },
      ),
    );
    const filesMini = renderNode(
      BoardAreaMini,
      nodeProps<AreaMiniNode>(
        'files:workspace',
        'areaMini',
        {
          kind: 'files',
          title: 'Workspace files',
          done: false,
          current: false,
          nowSet: false,
          stepsDone: 0,
          stepsTotal: 0,
          waitingCount: 0,
          noteCount: 0,
          fileCount: 3,
          pictureCount: 2,
          pageCount: 1,
          documentCount: 3,
          commitCount: 0,
          archivedCount: 0,
          pictures: [{ path: 'board-pictures/thumb-1.png', alt: 'First preview' }],
          fresh: false,
        },
        { width: 260, height: 108 },
      ),
    );
    const doneArea = renderNode(
      BoardArea,
      nodeProps<AreaNode>('checkpoint:cp-done', 'area', {
        kind: 'checkpoint',
        title: 'Completed milestone',
        done: true,
        current: false,
        nowSet: false,
        stepsDone: 3,
        stepsTotal: 3,
        waitingCount: 0,
        noteCount: 0,
        fileCount: 0,
        pictureCount: 0,
        documentCount: 0,
        commitCount: 1,
        archivedCount: 0,
        pictures: [],
        preview: 'Everything checked cleanly.',
        fresh: false,
      }),
    );
    const planArea = renderNode(
      BoardArea,
      nodeProps<AreaNode>('plan:own', 'area', {
        kind: 'plan',
        title: 'Loose plan items',
        done: false,
        current: false,
        nowSet: false,
        stepsDone: 1,
        stepsTotal: 2,
        waitingCount: 0,
        noteCount: 1,
        fileCount: 0,
        pictureCount: 0,
        documentCount: 0,
        commitCount: 0,
        archivedCount: 0,
        pictures: [],
        fresh: false,
      }),
    );
    expect({ newsMini, filesMini, doneArea, planArea }).toMatchSnapshot();
  });

  it('areaFold: BoardAreaFold collapsed and expanded', () => {
    const collapsed = renderNode(
      BoardAreaFold,
      nodeProps<AreaFoldNode>('area:fold', 'areaFold', {
        count: 5,
        kind: 'done',
        waitingCount: 1,
        moreCount: 1,
        doneCount: 3,
        expanded: false,
      }),
    );
    const expanded = renderNode(
      BoardAreaFold,
      nodeProps<AreaFoldNode>('area:fold', 'areaFold', {
        count: 3,
        kind: 'done',
        expanded: true,
      }),
    );
    expect({ collapsed, expanded }).toMatchSnapshot();
  });

  it('checkpoint: BoardCheckpoint open, folded, plan, and waitingOnly', () => {
    const open = renderNode(
      BoardCheckpoint,
      nodeProps<CheckpointNode>('checkpoint:cp-1', 'checkpoint', {
        kind: 'checkpoint',
        open: true,
        openHeight: 320,
        title: 'Safety net checkpoint',
        done: false,
        stepsDone: 1,
        stepsTotal: 3,
        steps: [
          { key: 'step-1', text: 'Update `affected-e2e.mjs`', done: true },
          { key: 'step-2', text: 'Snapshot **every** node kind', done: false },
        ],
        moreSteps: 1,
        waiting: [
          {
            key: 'dec-1',
            question: 'Which card style?',
            suggested: ['Precision', 'Soft'],
            detail: 'Suggested answers: Precision · Soft',
          },
        ],
        moreWaiting: 1,
        check: 'npm test',
        proof: { canProgress: true, lastVerificationSha: '9d75c15abcdef' },
        checkpointKey: 'cp-1',
      }),
    );
    const folded = renderNode(
      BoardCheckpoint,
      nodeProps<CheckpointNode>('checkpoint:cp-2', 'checkpoint', {
        kind: 'checkpoint',
        open: false,
        openHeight: 240,
        title: 'Folded checkpoint',
        done: true,
        stepsDone: 2,
        stepsTotal: 2,
        steps: [],
        moreSteps: 0,
        waiting: [],
        moreWaiting: 0,
      }),
    );
    const waitingFrame = renderNode(
      BoardCheckpoint,
      nodeProps<CheckpointNode>(
        'area:checkpoint:cp-1',
        'checkpoint',
        {
          kind: 'checkpoint',
          open: true,
          openHeight: 220,
          waitingOnly: true,
          rowId: 'row:waiting',
          waitingExpanded: false,
          title: 'Safety net checkpoint',
          done: false,
          stepsDone: 1,
          stepsTotal: 2,
          steps: [],
          moreSteps: 0,
          waiting: [
            {
              key: 'dec-compact',
              question: 'Keep 12 px minimum?',
              suggested: ['Yes', 'No'],
            },
          ],
          moreWaiting: 2,
          check: 'npm test',
          checkpointKey: 'cp-1',
        },
        { width: 420 },
      ),
    );
    const planFrame = renderNode(
      BoardCheckpoint,
      nodeProps<CheckpointNode>('checkpoint:plan:own', 'checkpoint', {
        kind: 'plan',
        open: true,
        openHeight: 240,
        title: 'Loose plan items',
        done: false,
        stepsDone: 0,
        stepsTotal: 1,
        steps: [{ key: 'step-own-1', text: 'Outside any checkpoint', done: false }],
        moreSteps: 0,
        waiting: [],
        moreWaiting: 0,
      }),
    );
    expect({ open, folded, waitingFrame, planFrame }).toMatchSnapshot();
  });

  it('lane: BoardLane open and folded', () => {
    const open = renderNode(
      BoardLane,
      nodeProps<LaneNode>('lane:commits:NexusFlow', 'lane', {
        title: 'Commits · NexusFlow',
        caption: 'feat/NexusFlow-new-canvas-interaction',
        note: 'History capped at 12',
        more: 3,
        moreAtLeast: true,
        group: {
          open: true,
          openHeight: 400,
          holds: [],
          summary: { headline: '3 commits' },
        },
      }),
    );
    const folded = renderNode(
      BoardLane,
      nodeProps<LaneNode>('lane:docs', 'lane', {
        title: 'Documents',
        caption: 'Source documents',
        more: 0,
        group: {
          open: false,
          openHeight: 300,
          holds: ['doc:spec'],
          summary: {
            headline: '2 documents',
            detail: 'Design System Joint Plan',
            byline: 'Opus',
            warning: '1 draft',
          },
        },
      }),
    );
    expect({ open, folded }).toMatchSnapshot();
  });

  it('document: BoardDocument full (reading) and compact (external dimmed)', () => {
    const full = renderNode(
      BoardDocument,
      nodeProps<DocumentNode>('doc:spec', 'document', {
        title: 'Design System Joint Plan',
        role: 'design',
        status: 'approved',
        summary: 'Defines the design module boundaries and golden markup snapshots.',
        dimmed: false,
        sourceId: 'src-doc-1',
        filename: 'design-system-joint-plan.md',
        fresh: true,
      }),
      'doc:spec',
    );
    const compact = renderNode(
      BoardDocument,
      nodeProps<DocumentNode>('doc:ext', 'document', {
        title: 'External Reference Spec',
        role: 'reference',
        status: 'superseded',
        summary: 'Previous layout exploration.',
        dimmed: true,
        sourceId: 'src-doc-2',
        url: 'https://example.com/spec',
        compact: true,
      }),
    );
    expect({ full, compact }).toMatchSnapshot();
  });

  it('commit: BoardCommit full and compact with pictures and commit note marker', () => {
    const full = renderNode(
      BoardCommit,
      nodeProps<CommitNode>('commit:NexusFlow:abc1234', 'commit', {
        sha: 'abc1234',
        subject: 'feat(board): pin markup snapshots for every node kind',
        author: 'Anton',
        at: COMMIT_AT,
        fresh: true,
        pictures: [{ path: 'board-pictures/commit-shot.png', title: 'Commit shot' }],
      }),
    );
    const compact = renderNode(
      BoardCommit,
      nodeProps<CommitNode>('commit:NexusFlow:abc1234#2', 'commit', {
        sha: 'abc1234',
        subject: 'feat(board): pin markup snapshots for every node kind',
        author: 'Anton',
        at: COMMIT_AT,
        compact: true,
        fresh: true,
        pictures: [{ path: 'board-pictures/commit-shot.png', title: 'Commit shot' }],
      }),
    );
    expect({ full, compact }).toMatchSnapshot();
  });

  it('placeholder: BoardPlaceholder full and compact', () => {
    const full = renderNode(
      BoardPlaceholder,
      nodeProps<PlaceholderNode>('placeholder:empty', 'placeholder', {
        text: 'No commits in this checkpoint yet.',
      }),
    );
    const compact = renderNode(
      BoardPlaceholder,
      nodeProps<PlaceholderNode>('placeholder:empty-compact', 'placeholder', {
        text: 'Nothing attached yet.',
        compact: true,
      }),
    );
    expect({ full, compact }).toMatchSnapshot();
  });

  it('uncommitted: BoardUncommitted card', () => {
    const html = renderNode(
      BoardUncommitted,
      nodeProps<UncommittedNode>('uncommitted:NexusFlow', 'uncommitted', {
        repoName: 'NexusFlow',
        repoPath: '/workspace/NexusFlow',
        title: '2 uncommitted files',
        numbers: '+48 -12',
        names: ['affected-e2e.mjs', 'cardMarkup.test.tsx'],
        firstFile: 'gui/scripts/affected-e2e.mjs',
        compact: true,
      }),
    );
    expect(html).toMatchSnapshot();
  });

  it('note: BoardNote full (pinned fresh), compact, and archived', () => {
    const full = renderNode(
      BoardNote,
      nodeProps<NoteNode>('note:1', 'note', {
        title: 'Retry disk save cleanly',
        text: 'Check **disk full** handling and `writeFile` error recovery.',
        pinned: true,
        archived: false,
        by: 'claude',
        at: CREATED_AT,
        updatedBy: 'user',
        updatedAt: UPDATED_AT,
        fresh: true,
        area: 'checkpoint:cp-1',
        step: 'step-1',
      }),
    );
    const compact = renderNode(
      BoardNote,
      nodeProps<NoteNode>('note:2', 'note', {
        title: 'Compact note title',
        text: 'A short markdown line with `inline code`.',
        pinned: false,
        archived: false,
        by: 'user',
        at: CREATED_AT,
        updatedBy: 'user',
        updatedAt: CREATED_AT,
        fresh: false,
        compact: true,
      }),
    );
    const archived = renderNode(
      BoardNote,
      nodeProps<NoteNode>('note:3', 'note', {
        title: 'Archived exploration note',
        text: 'No longer active.',
        pinned: false,
        archived: true,
        by: 'codex',
        at: CREATED_AT,
        updatedBy: 'codex',
        updatedAt: CREATED_AT,
        fresh: false,
      }),
    );
    expect({ full, compact, archived }).toMatchSnapshot();
  });

  it('file: BoardFile full image, full markdown, compact picture, compact doc row, and compact card', () => {
    const fullImage = renderNode(
      BoardFile,
      nodeProps<FileNode>('file:pic-full', 'file', {
        title: 'Board layout overview',
        text: 'Captured at 1440x900.',
        path: 'board-pictures/overview.png',
        fileType: 'image',
        pinned: true,
        archived: false,
        by: 'claude',
        at: CREATED_AT,
        updatedBy: 'claude',
        updatedAt: UPDATED_AT,
        fresh: true,
      }),
    );
    const fullDoc = renderNode(
      BoardFile,
      nodeProps<FileNode>('file:md-full', 'file', {
        title: 'Joint Plan',
        text: 'Read-only workspace file.',
        path: 'design/plans/joint-plan.md',
        fileType: 'markdown',
        readOnly: true,
        age: '2 h ago',
        pinned: false,
        archived: false,
        by: 'user',
        at: CREATED_AT,
        updatedBy: 'user',
        updatedAt: CREATED_AT,
        fresh: false,
      }),
    );
    const compactPicture = renderNode(
      BoardFile,
      nodeProps<FileNode>('file:pic-compact', 'file', {
        title: 'Split screenshot',
        text: 'Split view picture.',
        path: 'board-pictures/split.png',
        fileType: 'image',
        group: 'pictures',
        readOnly: true,
        age: '10 min ago',
        pinned: false,
        archived: false,
        by: 'user',
        at: CREATED_AT,
        updatedBy: 'user',
        updatedAt: CREATED_AT,
        fresh: false,
        compact: true,
      }),
    );
    const compactDocumentRow = renderNode(
      BoardFile,
      nodeProps<FileNode>('file:doc-row', 'file', {
        title: 'safety-net.md',
        text: '',
        path: 'design/packets/safety-net.md',
        folder: 'design/packets',
        fileType: 'markdown',
        group: 'documents',
        readOnly: true,
        age: '1 h ago',
        pinned: false,
        archived: false,
        by: 'user',
        at: CREATED_AT,
        updatedBy: 'user',
        updatedAt: CREATED_AT,
        fresh: false,
        compact: true,
      }),
    );
    const compactGeneric = renderNode(
      BoardFile,
      nodeProps<FileNode>('file:pdf-compact', 'file', {
        title: 'Architecture brief',
        text: 'Summary PDF attached to the checkpoint.',
        path: 'docs/architecture.pdf',
        fileType: 'pdf',
        pinned: false,
        archived: false,
        by: 'claude',
        at: CREATED_AT,
        updatedBy: 'claude',
        updatedAt: CREATED_AT,
        fresh: true,
        compact: true,
      }),
    );
    expect({
      fullImage,
      fullDoc,
      compactPicture,
      compactDocumentRow,
      compactGeneric,
    }).toMatchSnapshot();
  });

  it('answer: BoardAnswerCard text, code (matches and changed), picture, and diagram variants', () => {
    const text = renderNode(
      BoardAnswerCard,
      nodeProps<AnswerNode>('qcard:q1.md#1', 'answer', {
        variant: 'text',
        title: 'Short answer',
        path: 'explain/q1.md',
        question: 'How does selection work?',
        heading: null,
        text: 'By mapping **exact** paths before fallback.',
      }),
    );
    const codeMatches = renderNode(
      BoardAnswerCard,
      nodeProps<AnswerNode>('qcard:q1.md#2', 'answer', {
        variant: 'code',
        title: 'NexusFlow/gui/scripts/affected-e2e.mjs · 1–3',
        path: 'explain/q1.md',
        question: 'How does selection work?',
        heading: 'Details',
        language: 'ts',
        copy: 'export function getAffectedSpecs() {\n  return [];\n}',
        where: 'NexusFlow/gui/scripts/affected-e2e.mjs',
        file: 'gui/scripts/affected-e2e.mjs',
        start: 1,
        end: 3,
        check: { status: 'matches' },
      }),
    );
    const codeChanged = renderNode(
      BoardAnswerCard,
      nodeProps<AnswerNode>('qcard:q1.md#3', 'answer', {
        variant: 'code',
        title: 'NexusFlow/gui/src/index.css · 10–12',
        path: 'explain/q1.md',
        question: 'How does selection work?',
        heading: 'Details',
        language: 'css',
        copy: ':root {\n  --radius: 8px;\n}',
        where: 'NexusFlow/gui/src/index.css',
        file: 'gui/src/index.css',
        start: 10,
        end: 12,
        check: { status: 'changed', current: ':root {\n  --radius: 12px;\n}' },
      }),
    );
    const picture = renderNode(
      BoardAnswerCard,
      nodeProps<AnswerNode>('qcard:q1.md#4', 'answer', {
        variant: 'picture',
        title: 'Diagram screenshot',
        path: 'explain/q1.md',
        question: 'How does selection work?',
        heading: 'Pictures',
        alt: 'Diagram screenshot',
        src: 'board-pictures/answer.png',
        rawPath: 'board-pictures/answer.png',
      }),
    );
    const pictureMissing = renderNode(
      BoardAnswerCard,
      nodeProps<AnswerNode>('qcard:q1.md#4b', 'answer', {
        variant: 'picture',
        title: 'Missing picture',
        path: 'explain/q1.md',
        question: 'How does selection work?',
        heading: 'Pictures',
        alt: 'Missing picture',
        src: null,
        rawPath: 'board-pictures/missing.png',
      }),
    );
    const diagram = renderNode(
      BoardAnswerCard,
      nodeProps<AnswerNode>('qcard:q1.md#5', 'answer', {
        variant: 'diagram',
        title: 'Flow diagram',
        path: 'explain/q1.md',
        question: 'How does selection work?',
        heading: 'Diagram',
        source: 'flowchart TD\n  A["Start"] --> B["End"]',
      }),
    );
    expect({ text, codeMatches, codeChanged, picture, pictureMissing, diagram }).toMatchSnapshot();
  });

  it('step: BoardRowHead prominent, regular step, static done step, and tabbed row', () => {
    const prominent = renderNode(
      BoardRowHead,
      nodeProps<RowHeadNode>('rowhead:now', 'step', {
        rowId: 'row:step-now',
        title: 'Now',
        text: 'Pin every card markup before splitting `BoardNodes.tsx`',
        heading: '## Slice 1',
        state: 'current',
        expanded: true,
        summary: '2 cards',
        empty: false,
        prominent: true,
        stepKey: 'step-now',
      }),
    );
    const regular = renderNode(
      BoardRowHead,
      nodeProps<RowHeadNode>('rowhead:open', 'step', {
        rowId: 'row:step-open',
        title: 'Step',
        text: 'Add fix-specs helper',
        state: 'open',
        expanded: false,
        summary: '1 card',
        empty: false,
        prominent: false,
        stepKey: 'step-open',
      }),
    );
    const staticDone = renderNode(
      BoardRowHead,
      nodeProps<RowHeadNode>('rowhead:done', 'step', {
        rowId: 'row:done',
        title: 'Done',
        text: 'Update affected-e2e rules',
        state: 'done',
        expanded: true,
        summary: '',
        empty: false,
        prominent: false,
        static: true,
        stepKey: 'step-done',
      }),
    );
    const tabbed = renderNode(
      BoardRowHead,
      nodeProps<RowHeadNode>('rowhead:loose', 'step', {
        rowId: 'row:loose',
        title: 'Unassigned cards',
        state: 'plain',
        expanded: true,
        summary: '',
        empty: false,
        prominent: false,
        tabs: { active: 'media', media: 2, notes: 3 },
      }),
    );
    expect({ prominent, regular, staticDone, tabbed }).toMatchSnapshot();
  });

  it('fold: BoardFoldRow folded step row', () => {
    const html = renderNode(
      BoardFoldRow,
      nodeProps<FoldNode>('fold:row-1', 'fold', {
        rowId: 'row:step-1',
        title: 'Setup safety net',
        summary: '3 cards · 1 changed since',
        current: true,
        preview: 'Retry disk save cleanly',
        warning: '1 repo warning',
        holds: ['note:1'],
      }),
    );
    expect(html).toMatchSnapshot();
  });

  it('more: BoardMoreTile overflow button', () => {
    const html = renderNode(
      BoardMoreTile,
      nodeProps<MoreNode>('more:row-1', 'more', {
        rowId: 'row:commits',
        title: '+4 more',
        count: 4,
        rowTitle: 'Commits',
        holds: ['commit:NexusFlow:def5678'],
      }),
    );
    expect(html).toMatchSnapshot();
  });

  it('pager: BoardPager row pagination controls', () => {
    const html = renderNode(
      BoardPager,
      nodeProps<PagerNode>('pager:row-1', 'pager', {
        rowId: 'row:commits',
        title: 'Commits',
        page: 1,
        pages: 3,
        from: 5,
        to: 8,
        total: 12,
        holds: ['commit:NexusFlow:1112223'],
      }),
    );
    expect(html).toMatchSnapshot();
  });
});
