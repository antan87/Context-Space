/**
 * Level 1 of the Board, inside an Area: a list of rows by plan step, laid out for the canvas as it is, at a readable zoom.
 *
 * From the top down: the decisions that wait for you (compact), the current step ("Now", or "Next" in an Area that is not the
 * current one), the other open steps that have cards, the cards that are tied to no step, the documents, the commits of each
 * repository, then one line for the open steps that have no cards and one for the finished steps. A row is a header (one line)
 * with its things under it, in lines across the whole width. Every thing is drawn in a compact variant of its card, which has a
 * natural height of its own and is never made smaller: the whole card is one press away from the reader: a card has no buttons to read, its title is the one. Pinned things come
 * first, then the newest. A row shows as many lines as the room allows, and "+N more" is on the line of its header. When the rows are too tall
 * the least important fold into one line each; one row can be opened, and then it takes the room that is left, in pages when its
 * things do not fit even then. Pure: the same input always gives the same nodes. The view is fixed (READABLE_ZOOM), so nothing
 * here ever needs the view to move.
 */

import { plainText } from '../../lib/plainText.js';
import type { PlanFileStep, PlanProof } from '../plan/planFile.js';
import { type WhatsNewView } from '../plan/whatsNew.js';
import type { BoardCard } from './boardData.js';
import {
  FILES_AREA_ID,
  WORKSPACE_FILE_ROW_IDS,
  stepWorkspaceFileNodeId,
  workspaceFileNodeId,
  workspaceFileToLaneCard,
  type WorkspaceFileGroup,
} from './workspaceFilesArea.js';
import { filesChangedText, plusMinusText, type RepoChangeSummary } from '../changes/changeSummary.js';
import { extractFreshSets, textEm, type BoardArea, type Size, type Viewport } from './boardAreas.js';
import {
  BOARD_SIZE,
  cardPlan,
  commitsSince,
  documentsSummary,
  moreText,
  uniqueId,
  type BoardDecision,
  type BoardNode,
  type CheckpointNode,
  type LaneCard,
  type RowHeadData,
} from './boardLayout.js';

/** Inside an Area nothing is shown smaller than this, so the text can be read. It is also never larger than life size. */
export const READABLE_ZOOM = 0.9;

/** The sizes of Level 1, in canvas units (the screen's pixels are these times the zoom). */
export const ROW_SIZE = {
  /** The least width of a thing in a row, the most it is drawn at, the space between things, and between the lines of an open row. Things stretch to fill the line. */
  card: 300,
  maxCard: 420,
  gap: 12,
  lineGap: 8,
  /** Between rows, and when the rows are made smaller to fit. */
  rowGap: 8,
  compactGap: 4,
  /** A row folded to one line, and when the rows are made smaller to fit. */
  fold: 48,
  compactFold: 36,
  /** The header of a row, and the header of the current step, which says all it can of the step. */
  header: 32,
  current: 72,
  /** Between a header and its things. */
  stackGap: 4,
  /** The width of the "+N more" button, at the right of the line of a row's header. */
  more: 108,
  /** The width of the page buttons ("‹ 1–4 of 12 ›"), at the right of the line of an opened row's header. */
  pager: 148,
  /** The least an opened row may have: its header and one line of the tallest things. */
  minOpen: 200,
  /** Room from the edges of the canvas, on the screen. */
  padX: 16,
  top: 12,
  bottom: 36,
  /** The decisions that wait for you. */
  waitingHead: 32,
  /** One waiting decision: its card (82) and the space under it (8). The card never scrolls, so this is what it is drawn at. */
  decision: 90,
  decisionCard: 82,
  /** The most a waiting decision is as wide as, so that its question and answers read as a line. */
  decisionWidth: 720,
  waitingMore: 28,
  waitingPad: 8,
  waitingShown: 2,
  waitingOpen: 6,
  /** The footer of a frame with a check: its border, 6 + 24 + 6 px of padding and button. */
  waitingCheck: 37,
} as const;

/** The frame's own border, top and bottom. */
const WAITING_BORDER = 2;

/** How high each kind of thing is, whatever the room: a compact card is never drawn shorter, nor taller. */
export const ITEM_HEIGHT = { note: 96, file: 96, document: 96, commit: 80, uncommitted: 80, placeholder: 56, step: 40 } as const;

/** Sizing for items inside the Workspace files Area so Documents, Pages, and Pictures all fit on one screen. */
export const WORKSPACE_FILE_SIZE = {
  documentHeight: 36,
  documentGap: 4,
  pageHeight: 40,
  pageMinWidth: 340,
  pageMaxWidth: 540,
  pageGap: 6,
  pictureHeight: 120,
  pictureMinWidth: 200,
  pictureMaxWidth: 270,
  pictureGap: 8,
} as const;

function workspaceFileHeight(group: WorkspaceFileGroup): number {
  if (group === 'documents') return WORKSPACE_FILE_SIZE.documentHeight;
  if (group === 'pages') return WORKSPACE_FILE_SIZE.pageHeight;
  return WORKSPACE_FILE_SIZE.pictureHeight;
}

const CARD_W = ROW_SIZE.card;
const FIXED = { draggable: false, selectable: false, connectable: false, deletable: false } as const;
/** What the canvas is taken to be when it is not known (a test, the index). */
const DEFAULT_SIZE: Size = { width: 1280, height: 800 };

/** The view of Level 1: always the readable zoom, with the rows starting at the top left. Nothing moves it. */
export function areaView(): Viewport {
  return { x: ROW_SIZE.padX, y: ROW_SIZE.top, zoom: READABLE_ZOOM };
}

export interface AreaStage {
  /** What the rows may fill, in canvas units at the readable zoom. */
  width: number;
  height: number;
  /** How many things stand side by side in a line, and how wide each is (they fill the line). */
  columns: number;
  cardWidth: number;
}

/** The canvas the rows are laid out for: its size on the screen, taken at the readable zoom. */
export function areaStage(size: Size = DEFAULT_SIZE): AreaStage {
  const width = Math.max(CARD_W, Math.floor((size.width - 2 * ROW_SIZE.padX) / READABLE_ZOOM));
  const height = Math.max(ROW_SIZE.fold, Math.floor((size.height - ROW_SIZE.top - ROW_SIZE.bottom) / READABLE_ZOOM));
  const columns = Math.max(1, Math.floor((width + ROW_SIZE.gap) / (CARD_W + ROW_SIZE.gap)));
  const cardWidth = Math.min(ROW_SIZE.maxCard, Math.floor((width - (columns - 1) * ROW_SIZE.gap) / columns));
  return { width, height, columns, cardWidth };
}

export interface AreaBoardLayoutOptions {
  news?: WhatsNewView;
  now?: number;
  /** The canvas the Area is drawn on, as it is (without a reader docked beside it); the layout is made for it. */
  size?: Size;
  /** The id of the row that is opened (`AreaRow.id`, or `row:waiting`), if any. One row is open at a time. */
  openRow?: string | null;
  /** Which page of the opened row, from 0. */
  page?: number;
  /** Which tab of the row that is not tied to a step is shown (when it has tabs); the one holding the newest card when not given. */
  tab?: LooseTab;
}

/** The two tabs of the row of cards that are tied to no step: every file card, and everything else. */
export type LooseTab = 'media' | 'notes';
export interface LooseTabs { media: LaneCard[]; notes: LaneCard[]; /** The tab that holds the newest card. */ first: LooseTab }

export type AreaRowKind = 'step' | 'loose' | 'documents' | 'pages' | 'pictures' | 'commits' | 'more-steps' | 'done';

export interface StepGroup { key: string; text: string; items: LaneCard[] }

export interface AreaRow {
  id: string;
  /** The heading the step is nested under, when it has one: it is only said quietly beside "Now". */
  heading?: string;
  kind: AreaRowKind;
  title: string;
  /** The text of a step. */
  text?: string;
  caption?: string;
  state: RowHeadData['state'];
  /** What the row holds. For the rows that stand for steps (`groups`), the cards of all of them. */
  items: LaneCard[];
  /** The steps the row stands for, for the line of open steps with no cards and the line of finished steps. */
  groups?: StepGroup[];
  summary: string;
  warning?: string;
  /** Word shown in "+N <moreLabel>" overflow button (default "more"; workspace file rows use "earlier"). */
  moreLabel?: string;
  /** Optional per-row column/width/line-gap overrides (used by Workspace files rows). */
  columns?: number;
  cardWidth?: number;
  lineGap?: number;
  /** Only the row of cards tied to no step, and only when it holds both kinds: `items` is then all of them, and the tabs say which is which. */
  tabs?: LooseTabs;
  /** In the row as it is drawn (`viewOf`): the tab that shows, and the ids of the things of the other tab, which are not drawn. */
  activeTab?: LooseTab;
  elsewhere?: string[];
}

export const WAITING_ROW = 'row:waiting';

interface Waiting {
  areaId: string;
  kind: 'checkpoint' | 'plan';
  title: string;
  done: boolean;
  stepsDone: number;
  stepsTotal: number;
  decisions: Array<BoardDecision>;
  check?: string | null;
  proof?: PlanProof;
  checkpointKey?: string;
}
interface Model { waiting: Waiting | null; rows: AreaRow[] }

const cardsText = (count: number) => (count === 0 ? 'No cards' : `${count} ${count === 1 ? 'card' : 'cards'}`);

/** Pinned cards first, then the newest. */
function shownOrder(cards: BoardCard[]): BoardCard[] {
  return cards.map((card, index) => ({ card, index, at: Date.parse(card.at) || 0 }))
    .sort((a, b) => Number(b.card.pinned) - Number(a.card.pinned) || b.at - a.at || a.index - b.index)
    .map(({ card }) => card);
}

/** A thing as it is drawn inside an Area: its compact variant, at the height that variant has. */
/** The card of a repository's uncommitted work, at the commit card's size. */
function uncommittedItem(changes: RepoChangeSummary, taken: Set<string>): LaneCard {
  return compact({
    id: uniqueId(`uncommitted:${changes.repoName}`, taken), type: 'uncommitted', height: BOARD_SIZE.commit,
    data: { repoName: changes.repoName, repoPath: changes.repoPath, title: filesChangedText(changes.files), numbers: plusMinusText(changes.additions, changes.deletions), names: changes.names, firstFile: changes.firstFile },
  });
}

function compact(item: LaneCard): LaneCard {
  return { ...item, height: ITEM_HEIGHT[item.type as keyof typeof ITEM_HEIGHT] ?? item.height, data: { ...item.data, compact: true } as LaneCard['data'] };
}

/** The type of the answer buttons on a waiting decision's card, in px, and what a button adds to the width of its words (its padding and border). */
const ANSWER = { size: 13, pad: 22, gap: 6, ghostPad: 16, ghostSize: 12.5, margin: 1.12 } as const;
/** What the card of a waiting decision keeps for itself on the width of its node: the frame's padding, the card's border and padding. */
const DECISION_SIDES = 44;

/** Scripts whose letters are about 1 em wide, and emoji: `textEm` takes them for the width of an ordinary letter (0.54 em), which is far too narrow for them. */
const WIDE_SCRIPT = /[\u1100-\u11FF\u2E80-\uD7FF\uF900-\uFAFF\uFF00-\uFFEF]|\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
/** Latin letters with accents or marks (Latin-1 Supplement to Latin Extended-B) run as wide as a capital, not as the plain letter. */
const ACCENTED = /[\u00C0-\u024F]/;
/** The width of a button's words in em: `textEm`, with the wide scripts at 1 em and the accented Latin letters as capitals. */
function answerEm(text: string): number {
  let em = 0;
  for (const letter of text) em += WIDE_SCRIPT.test(letter) ? 1 : ACCENTED.test(letter) ? 0.68 : textEm(letter);
  return em;
}

/** Which of a decision's suggested answers are drawn as buttons on its card, and whether the rest (or a free answer) are behind the ghost button. */
export interface AnswersFit { shown: string[]; hidden: number; ghost: string }

/**
 * The suggested answers that fit whole on the one line of a waiting decision's card of `width`, in order, with the ghost button at the end
 * of the line ("All answers…" when some did not fit, else "Other answer…"). An answer that could not fit even alone goes only in the dialog;
 * the first one that does not fit in what is left ends the line, so the order is never changed. A guess made without the browser, with a margin
 * on the width of the words (`textEm`, as the cards of the overview do).
 */
export function answersThatFit(options: ReadonlyArray<string>, width: number): AnswersFit {
  const line = width - DECISION_SIDES;
  const wide = (text: string, size: number, pad: number) => Math.ceil(answerEm(text) * size * ANSWER.margin) + pad;
  const ghost = (label: string) => wide(label, ANSWER.ghostSize, ANSWER.ghostPad);
  const room = line - ghost('All answers…') - ANSWER.gap;
  const shown: string[] = [];
  let used = 0;
  let ended = false;
  for (const option of options) {
    const button = wide(option, ANSWER.size, ANSWER.pad);
    if (button > room) continue;
    if (ended || used + (shown.length > 0 ? ANSWER.gap : 0) + button > room) { ended = true; continue; }
    used += (shown.length > 0 ? ANSWER.gap : 0) + button;
    shown.push(option);
  }
  const hidden = options.length - shown.length;
  return { shown, hidden, ghost: hidden > 0 ? 'All answers…' : 'Other answer…' };
}

/** How tall the waiting frame is for `shown` decision cards, with a footer for "+N more" or "Show fewer" and one for the check: what the frame draws. */
export const waitingHeight = (shown: number, footer: boolean, hasCheck = false) =>
  WAITING_BORDER + ROW_SIZE.waitingHead + shown * ROW_SIZE.decision + (footer ? ROW_SIZE.waitingMore : 0) + ROW_SIZE.waitingPad + (hasCheck ? ROW_SIZE.waitingCheck : 0);
const isCurrent = (row: AreaRow) => row.state === 'current' || row.state === 'next';
const headerHeight = (row: AreaRow) => (isCurrent(row) ? ROW_SIZE.current : ROW_SIZE.header);

function groupsRow(id: string, kind: 'more-steps' | 'done', title: string, groups: StepGroup[], state: RowHeadData['state']): AreaRow {
  const items = groups.flatMap((group) => group.items);
  return { id, kind, title, state, items, groups, summary: items.length ? cardsText(items.length) : kind === 'done' ? 'Nothing attached' : 'No cards' };
}

type PlanStep = PlanFileStep;

/** The keys of the open steps that have open steps under them, however deep: headings, not steps to work on. A step whose children are all done is a real step. */
export function headingKeys(steps: ReadonlyArray<PlanFileStep>): Set<string> {
  const byKey = new Map(steps.map((entry) => [entry.key, entry]));
  const headings = new Set<string>();
  for (const entry of steps) {
    if (entry.done) continue;
    // Each open step marks the open steps above it; a step nested under a done step still reaches the open ones further up
    const seen = new Set<string>();
    for (let up = entry.parent ? byKey.get(entry.parent) : undefined; up && !seen.has(up.key); up = up.parent ? byKey.get(up.parent) : undefined) {
      seen.add(up.key);
      if (!up.done) headings.add(up.key);
    }
  }
  return headings;
}

/** The rows of an Area and its waiting decisions, for `stage`: some open steps may be put in the line of "more open steps" when the canvas is small. */
function modelOf(area: BoardArea, options: Pick<AreaBoardLayoutOptions, 'news' | 'now'>, stage: AreaStage): Model {
  const now = options.now ?? Date.now();
  if (area.kind === 'files' || area.id === FILES_AREA_ID) {
    const groups = area.workspaceFiles;
    if (!groups) return { waiting: null, rows: [] };
    const nowDate = new Date(now);
    const gridForGroup = (group: WorkspaceFileGroup): { columns: number; cardWidth: number; lineGap: number; height: number } => {
      if (group === 'documents') {
        return {
          columns: 1,
          cardWidth: stage.width,
          lineGap: WORKSPACE_FILE_SIZE.documentGap,
          height: WORKSPACE_FILE_SIZE.documentHeight,
        };
      }
      if (group === 'pages') {
        const columns = Math.max(1, Math.floor((stage.width + ROW_SIZE.gap) / (WORKSPACE_FILE_SIZE.pageMinWidth + ROW_SIZE.gap)));
        const cardWidth = Math.min(WORKSPACE_FILE_SIZE.pageMaxWidth, Math.floor((stage.width - (columns - 1) * ROW_SIZE.gap) / columns));
        return { columns, cardWidth, lineGap: WORKSPACE_FILE_SIZE.pageGap, height: WORKSPACE_FILE_SIZE.pageHeight };
      }
      const columns = Math.max(1, Math.floor((stage.width + ROW_SIZE.gap) / (WORKSPACE_FILE_SIZE.pictureMinWidth + ROW_SIZE.gap)));
      const cardWidth = Math.min(WORKSPACE_FILE_SIZE.pictureMaxWidth, Math.floor((stage.width - (columns - 1) * ROW_SIZE.gap) / columns));
      return { columns, cardWidth, lineGap: WORKSPACE_FILE_SIZE.pictureGap, height: WORKSPACE_FILE_SIZE.pictureHeight };
    };
    const meta: ReadonlyArray<{ group: WorkspaceFileGroup; title: string; singular: string; plural: string }> = [
      { group: 'documents', title: 'Documents', singular: 'document', plural: 'documents' },
      { group: 'pages', title: 'Pages', singular: 'page', plural: 'pages' },
      { group: 'pictures', title: 'Pictures', singular: 'picture', plural: 'pictures' },
    ];
    const rows: AreaRow[] = [];
    for (const entry of meta) {
      const files = groups[entry.group];
      if (!files.length) continue;
      const grid = gridForGroup(entry.group);
      rows.push({
        id: WORKSPACE_FILE_ROW_IDS[entry.group],
        kind: entry.group,
        title: entry.title,
        state: 'plain',
        moreLabel: 'earlier',
        columns: grid.columns,
        cardWidth: grid.cardWidth,
        lineGap: grid.lineGap,
        items: files.map((file) => workspaceFileToLaneCard(file, { id: workspaceFileNodeId(file.path), height: grid.height, nowDate })),
        summary: `${files.length} ${files.length === 1 ? entry.singular : entry.plural}`,
      });
    }
    return { waiting: null, rows };
  }
  const taken = new Set<string>();
  const steps = area.kind === 'work' ? [] : (area.planItems?.steps ?? []);
  const stepKeys = new Set(steps.map((entry) => entry.key));

  const byStep = new Map<string, BoardCard[]>();
  const loose: BoardCard[] = [];
  for (const card of shownOrder(area.cards)) {
    if (card.step && stepKeys.has(card.step)) byStep.set(card.step, [...(byStep.get(card.step) ?? []), card]);
    else loose.push(card);
  }
  const plans = (cards: BoardCard[]): LaneCard[] => cards.map((card) => compact(cardPlan(card, now)));
  const stepNowDate = new Date(now);
  const stepItems = (stepKey: string): LaneCard[] => [
    ...plans(byStep.get(stepKey) ?? []),
    ...(area.stepFiles?.[stepKey] ?? []).map((file) =>
      workspaceFileToLaneCard(file, {
        id: stepWorkspaceFileNodeId(stepKey, file.path),
        height: workspaceFileHeight(file.group),
        nowDate: stepNowDate,
      }),
    ),
  ];

  const open = steps.filter((entry) => !entry.done);
  const finished = steps.filter((entry) => entry.done);
  // A step with open steps under it (at any depth) is a heading for them: the work is on those, so it is never the Now or Next row.
  const headings = headingKeys(steps);
  const leaves = open.filter((entry) => !headings.has(entry.key));
  // The head is the focus step in the focus Area (the step someone said they work on, else the plan's first open step), and the first open step in every other Area
  const head = (area.data.current && area.data.focusStep ? leaves.find((entry) => entry.key === area.data.focusStep) : undefined) ?? leaves[0];
  const rows: AreaRow[] = [];
  if (head) {
    const items = stepItems(head.key);
    const above = head.parent ? steps.find((entry) => entry.key === head!.parent)?.text : undefined;
    rows.push({ id: `row:step:${head.key}`, kind: 'step', title: area.data.nowSet ? 'Now' : area.data.current ? 'Next up' : 'Next', text: head.text, ...(above ? { heading: above } : {}), state: area.data.nowSet ? 'current' : 'next', items, summary: items.length ? cardsText(items.length) : '' });
  }
  const others = open.filter((entry) => entry !== head);
  let withCards = others.filter((entry) => (byStep.get(entry.key)?.length ?? 0) > 0 || (area.stepFiles?.[entry.key]?.length ?? 0) > 0);
  const stepRow = (entry: PlanStep): AreaRow => {
    const items = stepItems(entry.key);
    return { id: `row:step:${entry.key}`, kind: 'step', title: 'Step', text: entry.text, state: 'open', items, summary: cardsText(items.length) };
  };

  const rest: AreaRow[] = [];
  if (loose.length > 0) {
    const items = plans(loose);
    const row: AreaRow = { id: 'lane:board', kind: 'loose', title: 'Not tied to a step', caption: 'Notes and files from you and the AI', state: 'plain', items, summary: cardsText(items.length) };
    const mediaCards = loose.filter((card) => card.kind === 'file');
    const noteCards = loose.filter((card) => card.kind !== 'file');
    if (mediaCards.length > 0 && noteCards.length > 0) {
      const newest = (cards: BoardCard[]) => Math.max(...cards.map((card) => Date.parse(card.at) || 0));
      const media = plans(mediaCards);
      const notes = plans(noteCards);
      row.tabs = { media, notes, first: newest(noteCards) > newest(mediaCards) ? 'notes' : 'media' };
      row.summary = `${media.length} ${media.length === 1 ? 'picture or file' : 'pictures and files'} · ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
    }
    rest.push(row);
  }
  const { isDocFresh } = extractFreshSets(options.news);
  if (area.documents.length > 0) {
    const items: LaneCard[] = area.documents.map((doc) => compact({
      id: uniqueId(`document:${doc.id}`, taken), type: 'document' as const, height: BOARD_SIZE.document,
      data: {
        title: doc.title, role: doc.role, status: doc.status, summary: doc.summary, dimmed: doc.status === 'superseded', sourceId: doc.id,
        ...(doc.filename ? { filename: doc.filename } : {}), ...(doc.url ? { url: doc.url } : {}),
        fresh: isDocFresh(doc),
      },
    }));
    rest.push({ id: 'lane:documents', kind: 'documents', title: 'Documents', caption: 'Source documents', state: 'plain', items, summary: documentsSummary(area.documents).headline });
  }
  const news = options.news;
  const since = news ? commitsSince(news) : { caption: 'New since you last looked', none: () => 'No new commits.', count: (n: number) => `${n} commits` };
  const laneTaken = new Set<string>();
  // The work not committed yet is the current Area's: one card at the top of its repository's commits row. It is not a commit, so the row's count leaves it out.
  const pending = new Map((area.data.current ? (area.uncommitted ?? []) : []).map((entry) => [entry.repoName, entry]));
  for (const r of area.repos) {
    const more = r.repo.more;
    const total = r.commits.length + more;
    const changes = pending.get(r.repo.repo);
    pending.delete(r.repo.repo);
    const countText = r.repo.problem && total === 0 ? `Could not be read: ${r.repo.problem}` : total > 0 ? since.count(total, r.repo.moreAtLeast) : '0 commits';
    rest.push({
      id: r.laneId, kind: 'commits', title: r.repo.repo, state: 'plain', items: [...(changes ? [uncommittedItem(changes, taken)] : []), ...r.cards.map(compact)],
      caption: [since.caption, more ? moreText(more, r.repo.moreAtLeast) : '', r.repo.problem ? `Could not be read: ${r.repo.problem}` : ''].filter(Boolean).join(' · '),
      // Folded to one line, the row still says there is work to commit
      summary: changes ? (total > 0 ? `${filesChangedText(changes.files)} · ${countText}` : filesChangedText(changes.files)) : countText,
      ...(r.repo.problem ? { warning: 'Could not read everything' } : {}),
    });
    laneTaken.add(r.laneId);
  }
  // A repository with changes but no commits in this Area still gets its row, so the work to commit is never hidden.
  for (const changes of pending.values()) {
    rest.push({
      id: uniqueId(`lane:commits:${changes.repoName}`, laneTaken), kind: 'commits', title: changes.repoName, state: 'plain', caption: since.caption,
      items: [uncommittedItem(changes, taken)], summary: filesChangedText(changes.files),
    });
  }
  // The placeholder rule: only on the current Area, when no repository has commits and there is other content or a problem.
  if (news && area.data.current) {
    const problems = news.commits.filter((repo) => !repo.commits.length && repo.problem);
    const unreadable = problems.length > 0 && problems.length === news.commits.length;
    if (!news.commits.some((repo) => repo.commits.length) && (area.kind !== 'work' || rows.length + rest.length > 0 || problems.length > 0) && !unreadable) {
      rest.push({
        id: uniqueId('lane:commits', laneTaken), kind: 'commits', title: 'Commits', caption: since.caption, state: 'plain',
        items: [compact({ id: uniqueId('placeholder:commits', taken), type: 'placeholder', height: BOARD_SIZE.placeholder, data: { text: since.none(problems.length > 0) } })],
        summary: 'No new commits',
      });
    }
  }

  let waiting: Waiting | null = null;
  const waitingKeys = new Set(area.planItems?.waitingKeys ?? []);
  const hasDecisions = waitingKeys.size > 0;
  const hasCheck = area.kind === 'checkpoint' && area.check !== undefined && !area.data.done;
  if ((area.kind === 'checkpoint' || area.kind === 'plan') && (hasDecisions || hasCheck)) {
    waiting = {
      areaId: area.id, kind: area.kind, title: area.data.title, done: area.data.done, stepsDone: area.data.stepsDone, stepsTotal: area.data.stepsTotal,
      check: area.check, proof: area.proof, checkpointKey: area.checkpointKey,
      decisions: (area.planItems?.decisions ?? []).filter((decision) => waitingKeys.has(decision.key)).map(({ key, question, suggested, detail }) => ({
        key,
        question,
        ...(suggested && suggested.length > 0 ? { suggested } : {}),
        ...(detail ? { detail } : {}),
      })),
    };
  }

  // The open steps with no cards are one line. On a canvas too small to hold every row folded, the steps at the bottom join them.
  const noCards = others.filter((entry) => !withCards.includes(entry));
  let demoted: PlanStep[] = [];
  const minTotal = () => {
    const count = (waiting ? 1 : 0) + (head ? 1 : 0) + withCards.length - demoted.length + rest.length + (noCards.length + demoted.length > 0 ? 1 : 0) + (finished.length > 0 ? 1 : 0);
    const folded = count - (waiting ? 1 : 0) - (head ? 1 : 0);
    return (waiting ? waitingHeight(1, waiting.decisions.length > 1, Boolean(waiting.check && !waiting.done)) : 0) + (head ? ROW_SIZE.current : 0) + folded * ROW_SIZE.compactFold + Math.max(0, count - 1) * ROW_SIZE.compactGap;
  };
  const kept = [...withCards];
  while (kept.length > 0 && minTotal() + (ROW_SIZE.minOpen - ROW_SIZE.compactFold) > stage.height) {
    demoted = [kept.pop()!, ...demoted];
  }
  withCards = kept;
  for (const entry of withCards) rows.push(stepRow(entry));
  rows.push(...rest);

  const aggregated = [...others.filter((entry) => noCards.includes(entry) || demoted.includes(entry))];
  if (aggregated.length > 0) {
    const groups = aggregated.map((entry): StepGroup => ({ key: entry.key, text: entry.text, items: stepItems(entry.key) }));
    rows.push(groupsRow('row:more-steps', 'more-steps', `${aggregated.length} more open ${aggregated.length === 1 ? 'step' : 'steps'}`, groups, 'open'));
  }
  if (finished.length > 0) {
    const groups = finished.map((entry): StepGroup => ({ key: entry.key, text: entry.text, items: stepItems(entry.key) }));
    rows.push(groupsRow('row:done', 'done', `✓ ${finished.length} done ${finished.length === 1 ? 'step' : 'steps'}`, groups, 'done'));
  }
  return { waiting, rows };
}

/** The rows of an Area, from the top down, apart from the decisions that wait. The canvas decides which open steps are rows of their own. */
export function areaRows(area: BoardArea, options: Pick<AreaBoardLayoutOptions, 'news' | 'now' | 'size'> = {}): AreaRow[] {
  return modelOf(area, options, areaStage(options.size)).rows;
}

/** The ids of the rows that can be opened, with the waiting decisions when there is more than the compact frame shows. */
export function areaRowIds(area: BoardArea, options: Pick<AreaBoardLayoutOptions, 'news' | 'now' | 'size'> = {}): string[] {
  const model = modelOf(area, options, areaStage(options.size));
  const waitingOpens = model.waiting !== null && (model.waiting.decisions.length > 1 || waitingFoldedAtRest(area, options));
  return [...(waitingOpens ? [WAITING_ROW] : []), ...model.rows.map((row) => row.id)];
}

/** Whether the canvas is too small to draw the waiting decisions as cards, so that they stand as one line that opens them. */
function waitingFoldedAtRest(area: BoardArea, options: Pick<AreaBoardLayoutOptions, 'news' | 'now' | 'size'>): boolean {
  return areaLayout(area, { ...options, openRow: null, page: 0 }).nodes.some((entry) => entry.id === area.id && entry.type === 'fold');
}

/** The id of the row that holds a node (a card, a document, a commit), so a jump to it can open the row. Null for what is not in a row. */
export function areaRowOf(area: BoardArea, options: Pick<AreaBoardLayoutOptions, 'news' | 'now' | 'size'>, nodeId: string): string | null {
  const rows = areaRows(area, options);
  const itemRow = rows.find((row) => row.items.some((item) => item.id === nodeId));
  if (itemRow) return itemRow.id;
  const directRow = rows.find((row) => row.id === nodeId);
  if (directRow) return directRow.id;
  const groupRow = rows.find((row) =>
    row.groups?.some((group) =>
      `${row.id}:step:${group.key}` === nodeId ||
      `row:step:${group.key}` === nodeId ||
      group.key === nodeId ||
      group.items.some((item) => item.id === nodeId)
    )
  );
  if (groupRow) return groupRow.id;
  return null;
}

/**
 * What it takes to draw a node: nothing when it is drawn in the default layout, else the row to open and the page of it. Null when the
 * Area has no such node.
 */
export function areaPlace(area: BoardArea, options: Pick<AreaBoardLayoutOptions, 'news' | 'now' | 'size'>, nodeId: string): { row: string | null; page: number; tab?: LooseTab } | null {
  const row = areaRowOf(area, options, nodeId);
  const isMatch = (node: BoardNode) =>
    node.id === nodeId ||
    nodeId.endsWith(`:${node.id}`) ||
    node.id.endsWith(`:${nodeId}`) ||
    (node.id.includes(':step:') && nodeId.includes(':step:') && node.id.split(':step:')[1] === nodeId.split(':step:')[1]);
  if (row === null) return area.id === nodeId && areaBoardLayout(area, options).some((node) => node.id === nodeId) ? { row: null, page: 0 } : null;
  // A row with tabs also says which tab holds the node, and is laid out with that tab
  const tabs = areaRows(area, options).find((entry) => entry.id === row)?.tabs;
  const tab: LooseTab | undefined = tabs ? (tabs.media.some((item) => item.id === nodeId) ? 'media' : 'notes') : undefined;
  const drawn = { ...options, ...(tab ? { tab } : {}) };
  const named = tab ? { tab } : {};
  if (areaBoardLayout(area, drawn).some(isMatch)) return { row: null, page: 0, ...named };
  const first = areaLayout(area, { ...drawn, openRow: row, page: 0 });
  const pages = first.open?.pages ?? 1;
  for (let page = 0; page < pages; page += 1) {
    const nodes = page === 0 ? first.nodes : areaLayout(area, { ...drawn, openRow: row, page }).nodes;
    if (nodes.some(isMatch)) return { row, page, ...named };
  }
  return { row, page: 0, ...named };
}

/** A row as it is drawn: a row with tabs holds only the things of the tab that shows, and remembers those of the other one. */
function viewOf(row: AreaRow, tab: LooseTab | undefined): AreaRow {
  if (!row.tabs) return row;
  const active = tab ?? row.tabs.first;
  const other = active === 'media' ? 'notes' : 'media';
  return { ...row, items: row.tabs[active], activeTab: active, elsewhere: row.tabs[other].map((item) => item.id) };
}

// ─── Drawing ────────────────────────────────────────────────────────────────

type Piece = { height: number; nodes: (y: number) => BoardNode[] };
/** `waitingShown` is how many waiting decisions are drawn as cards; 0 folds them to one line. */
interface Sizing { fold: number; gap: number; waitingShown: number }
const COMFY: Sizing = { fold: ROW_SIZE.fold, gap: ROW_SIZE.rowGap, waitingShown: ROW_SIZE.waitingShown };
const COMPACT: Sizing = { fold: ROW_SIZE.compactFold, gap: ROW_SIZE.compactGap, waitingShown: 1 };
/** The last resort, for a canvas on which not one card would show: the waiting decisions are one line (which still says what the question is). */
const FOLDED: Sizing = { fold: ROW_SIZE.compactFold, gap: ROW_SIZE.compactGap, waitingShown: 0 };

function node(item: LaneCard, x: number, y: number, width: number): BoardNode {
  return { id: item.id, type: item.type, position: { x, y }, width, height: item.height, data: item.data, ...FIXED } as BoardNode;
}

function waitingPiece(waiting: Waiting, stage: AreaStage, shown: number, expanded: boolean, page = 0): Piece & { info?: OpenInfo } {
  const total = waiting.decisions.length;
  // Opened, the decisions are in pages when they do not all fit (the row rule); "Show fewer" is always there to close them
  const count = Math.max(0, Math.min(total, expanded ? Math.max(1, shown) : shown));
  const pages = expanded && count > 0 ? Math.ceil(total / count) : 1;
  const at = Math.max(0, Math.min(page, pages - 1));
  const first = expanded ? at * count : 0;
  const footer = expanded ? true : total > count;
  const hasCheck = Boolean(waiting.check && !waiting.done);
  const height = waitingHeight(count, footer, hasCheck);
  const width = Math.min(stage.width, ROW_SIZE.decisionWidth);
  return {
    height,
    ...(expanded ? { info: { rowId: WAITING_ROW, page: at, pages } } : {}),
    nodes: (y) => [{
      id: waiting.areaId, type: 'checkpoint', position: { x: 0, y }, width, height, ...FIXED,
      data: {
        kind: waiting.kind, open: true, openHeight: height, title: waiting.title, done: waiting.done, stepsDone: waiting.stepsDone, stepsTotal: waiting.stepsTotal,
        steps: [], moreSteps: 0, waiting: waiting.decisions.slice(first, first + count), moreWaiting: total - count, collapsible: false, waitingOnly: true, rowId: WAITING_ROW, waitingExpanded: expanded,
        ...(waiting.check !== undefined ? { check: waiting.check } : {}),
        ...(waiting.proof ? { proof: waiting.proof } : {}),
        ...(waiting.checkpointKey ? { checkpointKey: waiting.checkpointKey } : {}),
      },
    } as CheckpointNode, ...(pages > 1 ? [{
      id: `${WAITING_ROW}:pager`, type: 'pager', position: { x: width - ROW_SIZE.pager - ROW_SIZE.gap, y }, width: ROW_SIZE.pager, height: ROW_SIZE.header, ...FIXED,
      data: { rowId: WAITING_ROW, title: 'questions waiting for you', what: 'questions', page: at, pages, from: first + 1, to: first + Math.min(count, total - first), total, holds: [] },
    } as BoardNode] : [])],
  };
}

/** The waiting decisions folded to one line, while another row is open. */
function waitingFold(waiting: Waiting, stage: AreaStage, fold: number): Piece {
  const total = waiting.decisions.length;
  const title = total > 0 ? 'Waits for you' : 'Check';
  const summary = total === 1 ? '' : total > 1 ? `${total} questions` : (waiting.check ? 'Check configured' : '');
  return {
    height: fold,
    nodes: (y) => [{
      id: waiting.areaId, type: 'fold', position: { x: 0, y }, width: stage.width, height: fold,
      data: { rowId: WAITING_ROW, title, summary, current: false, note: waiting.decisions[0] ? plainText(waiting.decisions[0].question) : undefined, holds: [] },
      ...FIXED,
    }],
  };
}

function headNode(row: AreaRow, y: number, width: number, expanded: boolean, empty: boolean): BoardNode {
  const prominent = isCurrent(row);
  const stepKey = row.kind === 'step' ? row.id.replace(/^row:step:/, '') : undefined;
  return {
    id: row.id, type: 'step', position: { x: 0, y }, width, height: headerHeight(row),
    data: {
      rowId: row.id, title: row.title, ...(row.text !== undefined ? { text: row.text } : {}), ...(row.heading ? { heading: row.heading } : {}), ...(row.caption && !row.tabs ? { caption: row.caption } : {}),
      summary: row.tabs ? '' : row.summary, state: row.state, expanded, prominent, empty,
      ...(row.elsewhere?.length ? { holds: row.elsewhere } : {}),
      ...(row.tabs && row.activeTab ? { tabs: { active: row.activeTab, media: row.tabs.media.length, notes: row.tabs.notes.length } } : {}),
      ...(stepKey ? { stepKey } : {}),
    },
    ...FIXED,
  };
}

/** The first things a row holds, in words, for its folded line: the steps of a line of steps, the shas of commits, else the titles of the cards. */
function previewOf(row: AreaRow): string {
  const parts = row.groups
    ? row.groups.map((group) => plainText(group.text))
    : row.items.filter((item) => item.type !== 'uncommitted').map((item) => (item.type === 'commit' ? (item.data as { sha: string }).sha : (item.data as { title?: string }).title ?? ''));
  return parts.filter(Boolean).slice(0, 8).join(' · ');
}

function foldPiece(row: AreaRow, stage: AreaStage, fold: number): Piece {
  return {
    height: fold,
    nodes: (y) => [{
      id: row.id, type: 'fold', position: { x: 0, y }, width: stage.width, height: fold,
      data: { rowId: row.id, title: row.kind === 'step' ? `${row.title}: ${plainText(row.text ?? '')}` : row.title, summary: row.summary, current: row.state === 'current', ...(previewOf(row) ? { preview: previewOf(row) } : {}), holds: [...row.items.map((item) => item.id), ...(row.elsewhere ?? [])], ...(row.warning ? { warning: row.warning } : {}) },
      ...FIXED,
    }],
  };
}

/** The tallest of a line of things. */
const lineHeight = (line: LaneCard[]) => Math.max(...line.map((item) => item.height));
const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
};

/** Column count, card width, and inter-line gap for a row (falls back to stage defaults). */
function rowGrid(row: AreaRow, stage: AreaStage): { columns: number; cardWidth: number; lineGap: number } {
  return {
    columns: row.columns ?? stage.columns,
    cardWidth: row.cardWidth ?? stage.cardWidth,
    lineGap: row.lineGap ?? ROW_SIZE.lineGap,
  };
}

/** How many lines a row needs to show everything it holds. */
const linesNeeded = (row: AreaRow, stage: AreaStage) => Math.ceil(row.items.length / rowGrid(row, stage).columns);

/** A row as a header and `lines` lines of its things (as many as asked, the rest behind "+N more"). */
function linesPiece(row: AreaRow, stage: AreaStage, lines: number): Piece {
  const grid = rowGrid(row, stage);
  const shown = row.items.slice(0, Math.max(0, lines) * grid.columns);
  const hidden = row.items.length - shown.length;
  const rows = chunk(shown, grid.columns);
  const head = headerHeight(row);
  const body = rows.reduce((sum, line, index) => sum + lineHeight(line) + (index > 0 ? grid.lineGap : 0), 0);
  const height = head + (rows.length > 0 ? ROW_SIZE.stackGap + body : 0);
  const headerW = hidden > 0 ? stage.width - ROW_SIZE.more - ROW_SIZE.gap : stage.width;
  return {
    height,
    nodes: (y) => {
      const out: BoardNode[] = [headNode(row, y, headerW, false, row.items.length === 0)];
      // The button on the line of the header comes right after it, so the keyboard reaches it before the things
      if (hidden > 0) {
        out.push({
          id: `${row.id}:more`, type: 'more', position: { x: stage.width - ROW_SIZE.more, y: y + (head - ROW_SIZE.header) / 2 }, width: ROW_SIZE.more, height: ROW_SIZE.header,
          data: { rowId: row.id, title: `+${hidden} ${row.moreLabel ?? 'more'}`, count: hidden, rowTitle: plainText(row.text ?? row.title), holds: [...row.items.slice(shown.length).map((item) => item.id), ...(row.elsewhere ?? [])] }, ...FIXED,
        });
      }
      let lineY = y + head + ROW_SIZE.stackGap;
      for (const line of rows) {
        line.forEach((item, index) => out.push(node(item, index * (grid.cardWidth + ROW_SIZE.gap), lineY, grid.cardWidth)));
        lineY += lineHeight(line) + grid.lineGap;
      }
      return out;
    },
  };
}

type Cell = LaneCard & { /** A step that heads the cards that follow it: not counted as a thing of its own. */ lead?: boolean };

/** What an opened row holds, in lines: the things in lines of `columns`; for a row of steps, each step with cards is a line (or more) of its own, and the steps with none are listed. */
function linesOf(row: AreaRow, columns: number): Cell[][] {
  if (!row.groups) return chunk<Cell>(row.items, columns);
  const tile = (group: StepGroup, lead: boolean): Cell => ({
    id: `${row.id}:step:${group.key}`, type: 'step' as never, height: ITEM_HEIGHT.step, lead,
    data: { rowId: row.id, title: row.kind === 'done' ? 'Done' : 'Step', text: group.text, summary: '', state: row.kind === 'done' ? 'done' : 'open', expanded: true, prominent: false, empty: false, static: true, stepKey: group.key } as never,
  });
  const lines: Cell[][] = [];
  let listed: Cell[] = [];
  const flush = () => { lines.push(...chunk(listed, columns)); listed = []; };
  for (const group of row.groups) {
    if (group.items.length === 0) { listed.push(tile(group, false)); continue; }
    flush();
    lines.push(...chunk<Cell>([tile(group, true), ...group.items], columns));
  }
  flush();
  return lines;
}

/** The least an opened row needs: its header and one line of the tallest things it holds (the page buttons are on the line of the header). */
function openNeed(row: AreaRow, stage: AreaStage): number {
  const lines = linesOf(row, rowGrid(row, stage).columns);
  const tallest = Math.max(0, ...lines.map(lineHeight));
  return headerHeight(row) + ROW_SIZE.stackGap + tallest;
}

export interface OpenInfo { rowId: string; page: number; pages: number }
type OpenPiece = Piece & { info: OpenInfo };

/** A row opened: its things in lines, one page of them when all do not fit in `room`, with the buttons for the other pages. */
function openPiece(row: AreaRow, stage: AreaStage, room: number, requested: number): OpenPiece {
  const grid = rowGrid(row, stage);
  const lines = linesOf(row, grid.columns);
  const head = headerHeight(row);
  const top = head + ROW_SIZE.stackGap;
  const natural = lines.reduce((sum, line, index) => sum + lineHeight(line) + (index > 0 ? grid.lineGap : 0), 0);
  const pager = top + natural > room;
  const avail = room - top;
  const pages: Cell[][][] = [];
  let current: Cell[][] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + (current.length ? grid.lineGap : 0) + lineHeight(line);
    if (current.length > 0 && next > avail) { pages.push(current); current = []; used = 0; }
    used += (current.length ? grid.lineGap : 0) + lineHeight(line);
    current.push(line);
  }
  if (current.length > 0 || pages.length === 0) pages.push(current);
  const page = Math.max(0, Math.min(requested, pages.length - 1));
  const shown = pages[page]!;
  const things = (cells: Cell[]) => cells.filter((cell) => !cell.lead).length;
  const before = pages.slice(0, page).reduce((sum, p) => sum + p.reduce((s, line) => s + things(line), 0), 0);
  const inPage = shown.reduce((sum, line) => sum + things(line), 0);
  const total = lines.reduce((sum, line) => sum + things(line), 0);
  const onPage = new Set(shown.flat().map((cell) => cell.id));
  const gridH = shown.reduce((sum, line, index) => sum + lineHeight(line) + (index > 0 ? grid.lineGap : 0), 0);
  const height = top + gridH;
  return {
    height,
    info: { rowId: row.id, page, pages: pages.length },
    nodes: (y) => {
      const out: BoardNode[] = [headNode(row, y, pager ? stage.width - ROW_SIZE.pager - ROW_SIZE.gap : stage.width, true, false)];
      if (pager) {
        out.push({
          id: `${row.id}:pager`, type: 'pager', position: { x: stage.width - ROW_SIZE.pager, y: y + (head - ROW_SIZE.header) / 2 }, width: ROW_SIZE.pager, height: ROW_SIZE.header,
          data: { rowId: row.id, title: row.text ?? row.title, page, pages: pages.length, from: before + 1, to: before + inPage, total, holds: [...row.items.filter((item) => !onPage.has(item.id)).map((item) => item.id), ...(row.elsewhere ?? [])] }, ...FIXED,
        });
      }
      let lineY = y + top;
      for (const line of shown) {
        line.forEach((cell, index) => out.push(node(cell, index * (grid.cardWidth + ROW_SIZE.gap), lineY, grid.cardWidth)));
        lineY += lineHeight(line) + grid.lineGap;
      }
      return out;
    },
  };
}

export interface LayoutResult { nodes: BoardNode[]; open: OpenInfo | null }

/** The nodes of Level 1 and which row is open, with its page. */
export function areaLayout(area: BoardArea, options: AreaBoardLayoutOptions = {}): LayoutResult {
  const stage = areaStage(options.size ?? DEFAULT_SIZE);
  const model = modelOf(area, options, stage);
  const waiting = model.waiting;
  const rows = model.rows.map((row) => viewOf(row, options.tab));
  const H = stage.height;
  const openAsked = options.openRow ?? null;
  const openRow = openAsked && rows.some((row) => row.id === openAsked) ? openAsked : null;
  const hasCheck = Boolean(waiting?.check && !waiting.done);
  // The waiting decisions can be opened when there is more than the frame shows, and when the canvas is too small for them and folds them to one line
  const waitingOpen = openAsked === WAITING_ROW && waiting !== null && (waiting.decisions.length > 1 || waitingFoldedAtRest(area, options));
  const head = rows.find((row) => row.kind === 'step' && isCurrent(row));
  const isAggregate = (row: AreaRow) => row.kind === 'more-steps' || row.kind === 'done';
  const content = rows.filter((row) => !isAggregate(row));

  const assemble = (pieces: Piece[], gap: number): BoardNode[] => {
    const nodes: BoardNode[] = [];
    let y = 0;
    for (const piece of pieces) { nodes.push(...piece.nodes(y)); y += piece.height + gap; }
    return nodes;
  };
  const sum = (pieces: Piece[], gap: number) => pieces.reduce((total, piece) => total + piece.height, 0) + Math.max(0, pieces.length - 1) * gap;

  if (openRow || waitingOpen) {
    const target = openRow ? rows.find((row) => row.id === openRow)! : null;
    // The comfortable and the compact sizing are both tried, and the one that shows more things on its page wins (the comfortable one on a tie)
    const thingsOf = (nodes: BoardNode[]) => nodes.filter((entry) => entry.type === 'note' || entry.type === 'file' || entry.type === 'document' || entry.type === 'commit' || entry.type === 'uncommitted' || entry.type === 'placeholder').length;
    const attempt = (sizing: Sizing, page: number): { result: LayoutResult; score: number } | null => {
      const last = sizing === COMPACT;
      // Everything but the opened row: the waiting decisions folded to one line (unless they are the opened row), the current step as one line, the other rows folded
      const build = (headLines: number) => {
        const pieces: Piece[] = [];
        let waitSlot = -1;
        if (waiting) {
          if (waitingOpen) { waitSlot = pieces.length; pieces.push({ height: 0, nodes: () => [] }); } else pieces.push(waitingFold(waiting, stage, sizing.fold));
        }
        let slot = -1;
        for (const row of rows) {
          if (row === target) { slot = pieces.length; pieces.push({ height: 0, nodes: () => [] }); continue; }
          pieces.push(row === head ? linesPiece(row, stage, headLines) : foldPiece(row, stage, sizing.fold));
        }
        return { pieces, slot, waitSlot, room: H - sum(pieces, sizing.gap) };
      };
      let built = build(1);
      if (!target) {
        // The waiting decisions are the opened row: they take the room that is left, in pages when they do not all fit
        const need = waitingOpen ? waitingHeight(1, true, hasCheck) : 0;
        if (built.room < need && !last) return null;
        if (built.room < need) built = build(0);
        if (waitingOpen && waiting) {
          const count = Math.max(1, Math.min(ROW_SIZE.waitingOpen, waiting.decisions.length, Math.floor((Math.max(built.room, need) - waitingHeight(0, true, hasCheck)) / ROW_SIZE.decision)));
          const piece = waitingPiece(waiting, stage, count, true, page);
          built.pieces[built.waitSlot] = piece;
          return { result: { nodes: assemble(built.pieces, sizing.gap), open: piece.info ?? null }, score: count };
        }
        const nodes = assemble(built.pieces, sizing.gap);
        return { result: { nodes, open: null }, score: Math.min(waiting?.decisions.length ?? 0, sizing.waitingShown) };
      }
      const need = openNeed(target, stage);
      if (built.room < need && !last) return null;
      // As a last resort the current step shows its header alone, so that the opened row has its least
      if (built.room < need && head && target !== head) built = build(0);
      const piece = openPiece(target, stage, Math.max(built.room, need), page);
      built.pieces[built.slot] = piece;
      const nodes = assemble(built.pieces, sizing.gap);
      return { result: { nodes, open: piece.info }, score: thingsOf(nodes) };
    };
    // The sizing is chosen on the first page, so that the pages are the same whichever one is shown
    const first = [COMFY, COMPACT].map((sizing) => ({ sizing, tried: attempt(sizing, 0) })).filter((entry) => entry.tried);
    const chosen = first.reduce((best, entry) => (entry.tried!.score > best.tried!.score ? entry : best));
    return attempt(chosen.sizing, options.page ?? 0)!.result;
  }

  // Nothing is open. The rows begin as the least that can be drawn: the current step with one line of things, every other row folded to
  // one line. If even that is too tall, the sizes are made smaller (the waiting decisions, the gaps, the folds), and then the current step
  // shows its header alone. What room is left goes to the rows from the top down, in order of priority (the current step, the steps with
  // cards, what is tied to no step, the documents, the commits): each is given as many lines of things as fit, with the rest behind "+N
  // more", and a folded row is unfolded to one line, until a row cannot have all it wants. The smaller sizes are used when they show more.
  const defaultLayout = (sizing: Sizing): { nodes: BoardNode[]; score: number; fits: boolean } | null => {
    const last = sizing !== COMFY;
    /** Lines shown by each row; -1 is folded. */
    const modes = new Map<string, number>();
    const isFilesArea = area.kind === 'files' || area.id === FILES_AREA_ID;
    const pieceOf = (row: AreaRow): Piece => {
      const mode = modes.get(row.id)!;
      return mode < 0 ? foldPiece(row, stage, sizing.fold) : linesPiece(row, stage, mode);
    };
    const pieces = (): Piece[] => [...(waiting ? [waitingShown === 0 ? waitingFold(waiting, stage, sizing.fold) : waitingPiece(waiting, stage, waitingShown, false)] : []), ...rows.map(pieceOf)];
    const fits = () => sum(pieces(), sizing.gap) <= H;
    let waitingShown: number = sizing.waitingShown;

    if (isFilesArea) {
      // Guarantee every non-empty kind (Documents, Pages, Pictures) starts open with at least 1 line.
      for (const row of rows) modes.set(row.id, 1);
      if (!fits()) {
        if (!last) return null;
        for (let i = rows.length - 1; i >= 0 && !fits(); i -= 1) {
          modes.set(rows[i]!.id, -1);
        }
      }
      const growRow = (rowId: string, maxLines: number) => {
        const row = rows.find((entry) => entry.id === rowId);
        if (!row) return;
        const wanted = Math.min(maxLines, linesNeeded(row, stage));
        for (;;) {
          const mode = modes.get(row.id)!;
          if (mode < 0 || mode >= wanted) break;
          modes.set(row.id, mode + 1);
          if (!fits()) {
            modes.set(row.id, mode);
            break;
          }
        }
      };
      // Balanced budget: 4 compact doc lines first, up to 2 picture rows, up to 2 page rows, then up to 6 doc lines.
      growRow(WORKSPACE_FILE_ROW_IDS.documents, 4);
      growRow(WORKSPACE_FILE_ROW_IDS.pictures, 2);
      growRow(WORKSPACE_FILE_ROW_IDS.pages, 2);
      growRow(WORKSPACE_FILE_ROW_IDS.documents, 6);
      const nodes = assemble(pieces(), sizing.gap);
      return { nodes, fits: fits(), score: nodes.filter((entry) => entry.type === 'file').length };
    }

    for (const row of rows) modes.set(row.id, row === head ? 1 : -1);
    if (!fits()) {
      if (!last) return null;
      if (head) modes.set(head.id, 0);
    }
    // The rows get their lines in order of priority: when one cannot have all it wants, the ones after it keep what they have
    for (const row of content) {
      const wanted = row === head ? Math.min(linesNeeded(row, stage), 2) : linesNeeded(row, stage);
      let stopped = false;
      for (;;) {
        const mode = modes.get(row.id)!;
        if (mode >= wanted && mode >= 0) break;
        modes.set(row.id, mode < 0 ? 1 : mode + 1);
        if (!fits()) { modes.set(row.id, mode); stopped = true; break; }
      }
      if (stopped) break;
    }
    // Every row has what it can have, and a card of a waiting decision costs as much as a line of things: a second decision is shown only with the room that is left
    if (waiting && waitingShown > 0 && waitingShown < ROW_SIZE.waitingShown && waiting.decisions.length > waitingShown) {
      const was = waitingShown;
      waitingShown = ROW_SIZE.waitingShown;
      if (!fits()) waitingShown = was;
    }
    const nodes = assemble(pieces(), sizing.gap);
    return { nodes, fits: fits(), score: nodes.filter((entry) => entry.type === 'note' || entry.type === 'file' || entry.type === 'document' || entry.type === 'commit' || entry.type === 'uncommitted' || entry.type === 'placeholder').length };
  };
  const comfy = defaultLayout(COMFY);
  const small = defaultLayout(COMPACT);
  let best = comfy && (!small || comfy.score >= small.score) ? comfy : small;
  // Not one card shows with the waiting decisions as cards, or on a window so low that the rows do not fit at all: they go to their one line
  // first, so that the cards of the rows can be seen and the rows stay on the stage
  if (waiting && (!best?.fits || ((best?.score ?? 0) === 0 && rows.some((row) => row.items.length > 0)))) {
    const folded = defaultLayout(FOLDED);
    if (folded && (folded.score > (best?.score ?? 0) || (folded.fits && !best?.fits))) best = folded;
  }
  return { nodes: best?.nodes ?? [], open: null };
}

/**
 * Pure 2D layout for Level 1 (inside an Area), for the canvas as it is, at `READABLE_ZOOM`: the rows from the top down, as the top of
 * this file says. `openRow` opens one row, with `page`.
 */
export function areaBoardLayout(area: BoardArea, options: AreaBoardLayoutOptions = {}): BoardNode[] {
  return areaLayout(area, options).nodes;
}

/** Which row is open in the layout, and how many pages it has: what the buttons need to page through it. */
export function areaOpenInfo(area: BoardArea, options: AreaBoardLayoutOptions = {}): OpenInfo | null {
  return areaLayout(area, options).open;
}
