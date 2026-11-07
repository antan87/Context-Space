/**
 * The Now line: the one line above the Board that says what is happening and what waits for you. What it shows, and where each part
 * goes, is decided here from the plan's focus, the Areas and the news, so that it is tested without the screen.
 */

import { focusText, focusWord, type Focus } from '../plan/focus.js';
import { agoText, newsEntries, newsTotal, type NewsEntry, type WhatsNewView } from '../plan/whatsNew.js';
import type { BoardArea } from './boardAreas.js';
import { authorName } from './boardLayout.js';
import { buildBoardNav, type NavItem } from './boardNav.js';

export interface NowLineParts {
  /** "Now" when someone said which step is worked on, "Next up" for the plan's order, none when nothing is open. */
  word: 'Now' | 'Next up' | null;
  /** The step, else its checkpoint; the full words (the line cuts them with an ellipsis and keeps them in the title). */
  text: string;
  /** The Area the focus is in. */
  area?: string;
  /** "Claude · 5 min ago": only when someone said it. */
  who?: string;
  /** Questions that wait for the user, and what is new since they looked: each part shows only when it is more than zero. */
  waiting: number;
  news: number;
}

/** "claude" is "Claude", the user is "You". */
const nameOf = (by: string) => {
  if (by.toLowerCase() === 'ai') return 'AI';
  const name = authorName(by);
  return name === 'you' ? 'You' : name.charAt(0).toUpperCase() + name.slice(1);
};

export function nowLineParts(input: { focus: Focus | null; areas: BoardArea[]; news?: WhatsNewView; now?: Date }): NowLineParts {
  const { focus, areas } = input;
  const area = areas.find((candidate) => candidate.data.current);
  const waiting = areas.reduce((sum, candidate) => sum + candidate.data.waitingCount, 0);
  const news = newsTotal(input.news);
  if (!focus) return { word: null, text: '', waiting, news };
  const text = focusText(focus);
  const ago = focus.source === 'set' ? agoText(focus.at, input.now) : '';
  return {
    word: focusWord(focus),
    text,
    ...(area && area.data.kind !== 'work' ? { area: area.data.title } : {}),
    ...(focus.source === 'set' && focus.by ? { who: [nameOf(focus.by), ago].filter(Boolean).join(' · ') } : {}),
    waiting,
    news,
  };
}

/** Where a press on the Now part goes: the focus Area, and the row of the step in it when there is one. */
export function nowLineTarget(areas: BoardArea[], focus: Focus | null): { areaId: string; nodeId: string | null } | null {
  const area = areas.find((candidate) => candidate.data.current);
  if (!area) return null;
  return { areaId: area.id, nodeId: focus?.step && area.data.focusStep === focus.step.key ? `row:step:${focus.step.key}` : null };
}

/** The first question that waits, as the Board index jumps to it. */
export function firstWaiting(areas: BoardArea[]): NavItem | null {
  return buildBoardNav(areas, { mode: 'category' }).find((section) => section.waiting)?.items[0] ?? null;
}

export interface NewsLine {
  text: string;
  /** Where the line goes: an Area (node null) or a card, commit or step in it. None: the line only shows its text. */
  jump?: { areaId: string; nodeId: string | null; readerTarget?: NavItem['readerTarget'] };
}

/** How many of the newest things the list shows. */
export const NEWS_SHOWN = 8;

/** The newest things of the news list, newest first, each with where it can be found on the board. */
export function newsLines(news: WhatsNewView, areas: BoardArea[], now?: Date): NewsLine[] {
  const items = buildBoardNav(areas, { mode: 'category' }).flatMap((section) => section.items);
  const areaOfStep = (key: string) => areas.find((area) => area.planItems?.steps.some((step) => step.key === key));
  const jumpOf = (entry: NewsEntry): NewsLine['jump'] => {
    const ref = entry.ref;
    if (!ref) return undefined;
    if (ref.kind === 'commit') {
      const item = items.find((candidate) => candidate.category === 'commits' && candidate.readerTarget?.commit?.sha.startsWith(ref.sha.slice(0, 7)) && candidate.readerTarget.commit.repo === ref.repo);
      return item?.nodeId ? { areaId: item.areaId, nodeId: item.nodeId } : undefined;
    }
    if (ref.kind === 'document') {
      const item = items.find((candidate) => (candidate.category === 'documents' || candidate.category === 'pictures') && (candidate.readerTarget?.path === ref.name || candidate.title === ref.name));
      return item?.nodeId ? { areaId: item.areaId, nodeId: item.nodeId } : undefined;
    }
    if (ref.removed) return undefined;
    if (ref.item === 'checkpoint') {
      const area = areas.find((candidate) => candidate.checkpointKey === ref.key);
      return area ? { areaId: area.id, nodeId: null } : undefined;
    }
    if (ref.item === 'step') {
      const area = areaOfStep(ref.key);
      const step = area?.planItems?.steps.find((candidate) => candidate.key === ref.key);
      // An open step has a row of its own when it is the one in the Area's head; any other is found by stepping into its Area
      return area ? { areaId: area.id, nodeId: step && !step.done && area.data.focusStep === ref.key ? `row:step:${ref.key}` : null } : undefined;
    }
    const area = areas.find((candidate) => candidate.planItems?.decisions.some((decision) => decision.key === ref.key));
    return area ? { areaId: area.id, nodeId: null } : undefined;
  };
  const dated = newsEntries(news, now).filter((entry) => entry.at).sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
  const undated = newsEntries(news, now).filter((entry) => !entry.at);
  const shown = [...dated, ...undated].slice(0, NEWS_SHOWN);
  const lines = shown.map((entry): NewsLine => {
    const jump = jumpOf(entry);
    return { text: entry.text, ...(jump ? { jump } : {}) };
  });
  // The rest is said, not hidden: "and 11 more"
  const counted = shown.filter((entry) => !/^and \d/.test(entry.text)).length;
  const rest = newsTotal(news) - counted;
  return rest > 0 ? [...lines, { text: `and ${rest} more` }] : lines;
}
