/**
 * Pure indexing, filtering, layout docking math, and safe localStorage helpers for the Board index sidebar.
 *
 * Provides category-based and area-based navigation models over the workspace's board areas, aligning
 * exact node IDs with areaBoardLayout for seamless one-click jump from overview or across areas.
 */

import type { ReaderTarget } from './boardActions.js';
import { stepsText, waitingText, type BoardArea } from './boardAreas.js';
import { cardOrder, fileTypeOf, uniqueId, type FileType } from './boardLayout.js';

export type NavCategory = 'waiting' | 'areas' | 'pictures' | 'documents' | 'notes' | 'commits';
export type NavMode = 'category' | 'area';

export const SIDEBAR = { width: 248, railWidth: 40, minStage: 712 } as const;

export interface SidebarDock {
  overlays: boolean;
  width: number;
}

/**
 * Calculates sidebar width and overlay behavior based on the section's pixel width.
 * When sectionWidth - SIDEBAR.width < SIDEBAR.minStage (960px total), the sidebar floats as an overlay drawer.
 */
export function sidebarDock(sectionWidth: number): SidebarDock {
  if (sectionWidth > 0 && sectionWidth - SIDEBAR.width < SIDEBAR.minStage) {
    return {
      overlays: true,
      width: Math.min(SIDEBAR.width, Math.max(200, sectionWidth - 48)),
    };
  }
  return { overlays: false, width: SIDEBAR.width };
}

export const NAV_OPEN_KEY = 'contextspace_board_nav_open_v1';
export const NAV_MODE_KEY = 'contextspace_board_nav_mode_v1';

/**
 * Reads whether the sidebar was open from localStorage. Defaults to true (open on desktop)
 * unless explicitly saved as 'closed'.
 */
export function readNavOpen(): boolean {
  try {
    return window.localStorage.getItem(NAV_OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export function writeNavOpen(open: boolean): void {
  try {
    window.localStorage.setItem(NAV_OPEN_KEY, open ? 'open' : 'closed');
  } catch {
    /* Holds for this visit only */
  }
}

/**
 * Reads the preferred grouping mode ('category' or 'area') from localStorage. Defaults to 'category'.
 */
export function readNavMode(): NavMode {
  try {
    return window.localStorage.getItem(NAV_MODE_KEY) === 'area' ? 'area' : 'category';
  } catch {
    return 'category';
  }
}

export function writeNavMode(mode: NavMode): void {
  try {
    window.localStorage.setItem(NAV_MODE_KEY, mode);
  } catch {
    /* Holds for this visit only */
  }
}

export interface NavBadge {
  text: string;
  variant: 'default' | 'secondary' | 'outline' | 'success' | 'warning';
}

export interface NavItem {
  id: string;
  category: NavCategory;
  areaId: string;
  areaTitle: string;
  /** Null for area-entry cards or empty-area fallbacks; exact React Flow node ID for cards/documents/commits/checkpoints. */
  nodeId: string | null;
  fileType?: FileType;
  title: string;
  subtitle: string;
  badge?: NavBadge;
  readerTarget?: ReaderTarget;
  searchText: string;
}

export interface NavSection {
  id: string;
  title: string;
  items: NavItem[];
  areaId?: string;
  waiting?: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  requirements: 'Requirements',
  design: 'Design',
  evidence: 'Evidence',
  reference: 'Reference',
};

function noteSnippet(body?: string): string {
  if (!body) return 'Note';
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? '';
  const collapsed = firstLine.trim().replace(/\s+/g, ' ');
  if (!collapsed) return 'Note';
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed;
}

export interface BuildBoardNavOptions {
  mode: NavMode;
  query?: string;
}

export function totalBoardWaiting(areas: BoardArea[]): number {
  return areas.reduce((sum, a) => sum + (a.data.waitingCount || 0), 0);
}

/**
 * Indexes everything on the board into categorized or area-grouped sections with fast multi-token search filtering.
 */
export function buildBoardNav(areas: BoardArea[], options: BuildBoardNavOptions): NavSection[] {
  const mode = options.mode;
  const rawQuery = (options.query ?? '').trim().toLowerCase();
  const tokens = rawQuery.length > 0 ? rawQuery.split(/\s+/).filter(Boolean) : [];
  const matches = (text: string) => tokens.length === 0 || tokens.every((token) => text.includes(token));

  // Collect items per category or per area
  const waitingItems: NavItem[] = [];
  const areaItems: NavItem[] = [];
  const pictureItems: NavItem[] = [];
  const docItems: NavItem[] = [];
  const noteItems: NavItem[] = [];
  const commitItems: NavItem[] = [];

  interface AreaBucket {
    area: BoardArea;
    areaEntry: NavItem;
    waiting: NavItem[];
    docs: NavItem[];
    pictures: NavItem[];
    notes: NavItem[];
    commits: NavItem[];
  }

  const areaBuckets: AreaBucket[] = [];

  for (const area of areas) {
    const bucket: AreaBucket = {
      area,
      areaEntry: {
        id: `area:${area.id}`,
        category: 'areas',
        areaId: area.id,
        areaTitle: area.data.title,
        nodeId: null,
        title: area.data.title,
        subtitle: area.data.kind === 'work' ? 'Current work' : stepsText(area.data),
        badge:
          area.data.waitingCount > 0
            ? { text: waitingText(area.data.waitingCount), variant: 'warning' }
            : area.data.done
              ? { text: 'Done', variant: 'success' }
              : area.data.current
                ? { text: 'Current', variant: 'default' }
                : area.data.kind === 'plan'
                  ? { text: 'Plan', variant: 'outline' }
                  : undefined,
        searchText: [area.data.title, ...(area.planItems?.steps ?? []).map((s) => s.text)].join(' ').toLowerCase(),
      },
      waiting: [],
      docs: [],
      pictures: [],
      notes: [],
      commits: [],
    };

    areaItems.push(bucket.areaEntry);

    // 1. Waiting decisions
    const waitingSet = new Set(area.planItems?.waitingKeys ?? []);
    for (const decision of area.planItems?.decisions ?? []) {
      if (waitingSet.has(decision.key)) {
        const suggestedText = Array.isArray(decision.suggested)
          ? decision.suggested.join(' ')
          : String(decision.suggested ?? '');
        const item: NavItem = {
          id: `waiting:${area.id}:${decision.key}`,
          category: 'waiting',
          areaId: area.id,
          areaTitle: area.data.title,
          nodeId: area.id,
          title: decision.question,
          subtitle: mode === 'category' ? area.data.title : 'Waits for your answer',
          badge: { text: 'Waiting', variant: 'warning' },
          searchText: [decision.question, suggestedText, area.data.title].filter(Boolean).join(' ').toLowerCase(),
        };
        waitingItems.push(item);
        bucket.waiting.push(item);
      }
    }

    // 2. Source Documents (exact node ID alignment via per-area docTaken)
    const docTaken = new Set<string>();
    for (const doc of area.documents) {
      const docNodeId = uniqueId(`document:${doc.id}`, docTaken);
      const item: NavItem = {
        id: `doc:${area.id}:${docNodeId}`,
        category: 'documents',
        areaId: area.id,
        areaTitle: area.data.title,
        nodeId: docNodeId,
        title: doc.title,
        subtitle: mode === 'category' ? area.data.title : doc.filename ?? (ROLE_LABEL[doc.role] ?? doc.role),
        badge:
          doc.status === 'superseded'
            ? { text: 'Superseded', variant: 'secondary' }
            : doc.status === 'draft'
              ? { text: 'Draft', variant: 'warning' }
              : undefined,
        readerTarget: doc.filename
          ? { path: doc.filename, title: doc.title, card: docNodeId, source: doc.id }
          : undefined,
        searchText: [doc.title, doc.summary, doc.role, doc.status, doc.filename ?? '', area.data.title]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      };
      docItems.push(item);
      bucket.docs.push(item);
    }

    // 3. Board Cards (cardOrder)
    for (const card of cardOrder(area.cards)) {
      if (card.kind === 'file') {
        const ft = fileTypeOf(card.path);
        const isPic = ft === 'image' || ft === 'html' || ft === 'pdf';
        const category: NavCategory = isPic ? 'pictures' : 'documents';
        const item: NavItem = {
          id: `card:${card.id}`,
          category,
          areaId: area.id,
          areaTitle: area.data.title,
          nodeId: card.id,
          fileType: ft,
          title: card.title,
          subtitle: mode === 'category' ? `${card.path} · ${area.data.title}` : card.path,
          badge: card.archived
            ? { text: 'Archived', variant: 'secondary' }
            : ft === 'image'
              ? { text: 'Picture', variant: 'outline' }
              : ft === 'html'
                ? { text: 'HTML', variant: 'outline' }
                : ft === 'pdf'
                  ? { text: 'PDF', variant: 'outline' }
                  : undefined,
          readerTarget: { path: card.path, title: card.title, card: card.id },
          searchText: [card.title, card.description, card.path, ft, area.data.title].join(' ').toLowerCase(),
        };
        if (isPic) {
          pictureItems.push(item);
          bucket.pictures.push(item);
        } else {
          docItems.push(item);
          bucket.docs.push(item);
        }
      } else if (card.kind === 'note') {
        const item: NavItem = {
          id: `card:${card.id}`,
          category: 'notes',
          areaId: area.id,
          areaTitle: area.data.title,
          nodeId: card.id,
          title: card.title,
          subtitle: mode === 'category' ? area.data.title : noteSnippet(card.body),
          badge: card.archived ? { text: 'Archived', variant: 'secondary' } : undefined,
          searchText: [card.title, card.body, area.data.title].join(' ').toLowerCase(),
        };
        noteItems.push(item);
        bucket.notes.push(item);
      }
    }

    // 4. Commits
    for (const repoEntry of area.repos) {
      repoEntry.commits.forEach((commit, index) => {
        const commitNodeId = repoEntry.cards[index]?.id ?? `commit:${repoEntry.repo.repo}:${commit.sha}`;
        const item: NavItem = {
          id: `commit:${area.id}:${commitNodeId}`,
          category: 'commits',
          areaId: area.id,
          areaTitle: area.data.title,
          nodeId: commitNodeId,
          title: commit.subject,
          subtitle: mode === 'category' ? `${repoEntry.repo.repo} · ${area.data.title}` : `${repoEntry.repo.repo} · ${commit.author}`,
          badge: { text: commit.sha.slice(0, 7), variant: 'outline' },
          searchText: [commit.sha, commit.subject, commit.author, repoEntry.repo.repo, area.data.title].join(' ').toLowerCase(),
        };
        commitItems.push(item);
        bucket.commits.push(item);
      });
    }

    areaBuckets.push(bucket);
  }

  if (mode === 'category') {
    const CATEGORIES: Array<{ category: NavCategory; title: string; items: NavItem[]; waiting?: boolean }> = [
      { category: 'waiting', title: 'Waiting for you', items: waitingItems, waiting: true },
      { category: 'areas', title: 'Areas', items: areaItems },
      { category: 'pictures', title: 'Pictures & pages', items: pictureItems },
      { category: 'documents', title: 'Documents', items: docItems },
      { category: 'notes', title: 'Notes', items: noteItems },
      { category: 'commits', title: 'Commits', items: commitItems },
    ];

    const sections: NavSection[] = [];
    for (const cat of CATEGORIES) {
      const filtered = cat.items.filter((item) => matches(item.searchText));
      if (filtered.length > 0) {
        sections.push({
          id: `category:${cat.category}`,
          title: cat.title,
          items: filtered,
          waiting: cat.waiting,
        });
      }
    }
    return sections;
  }

  // mode === 'area'
  const sections: NavSection[] = [];
  for (const b of areaBuckets) {
    const rawChildItems = [...b.waiting, ...b.docs, ...b.pictures, ...b.notes, ...b.commits];
    const filteredChildItems = rawChildItems.filter((item) => matches(item.searchText));

    let finalItems = filteredChildItems;
    if (tokens.length === 0 && rawChildItems.length === 0) {
      finalItems = [
        {
          id: `stepin:${b.area.id}`,
          category: 'areas',
          areaId: b.area.id,
          areaTitle: b.area.data.title,
          nodeId: null,
          title: b.area.data.kind === 'work' ? 'Current work' : stepsText(b.area.data),
          subtitle: 'Step into area',
          searchText: b.areaEntry.searchText,
        },
      ];
    } else if (tokens.length > 0 && filteredChildItems.length === 0) {
      if (matches(b.areaEntry.searchText)) {
        finalItems = [
          {
            id: `stepin:${b.area.id}`,
            category: 'areas',
            areaId: b.area.id,
            areaTitle: b.area.data.title,
            nodeId: null,
            title: b.area.data.kind === 'work' ? 'Current work' : stepsText(b.area.data),
            subtitle: 'Step into area',
            searchText: b.areaEntry.searchText,
          },
        ];
      }
    }

    if (finalItems.length > 0) {
      sections.push({
        id: `area:${b.area.id}`,
        title: b.area.data.title,
        areaId: b.area.id,
        items: finalItems,
        waiting: (b.area.data.waitingCount ?? 0) > 0,
      });
    }
  }

  return sections;
}
