import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as design from '../design/index.js';
import { cardFixtures, FIXED_NOW } from '../features/board/cards/cardFixtures.js';
import { CARD_KINDS } from './designPageLists.js';

const SOURCE = readFileSync(new URL('./DesignPieces.tsx', import.meta.url), 'utf8');

/** The design page (DS7) draws every piece `design/index` exports, and a section for every kind of card. */
describe('the design page', () => {
  it('has a section for each kind of card the fixtures have, and no other', () => {
    expect([...CARD_KINDS].sort()).toEqual([...new Set(cardFixtures(FIXED_NOW).map((fixture) => fixture.kind))].sort());
    expect(new Set(CARD_KINDS).size).toBe(CARD_KINDS.length);
  });

  it('draws every piece the design module exports, or says it does not', () => {
    /** Pieces drawn on the page; a name that starts with one of them is a part of it (`CardHeader` of `Card`). */
    const DRAWN = [
      'Alert', 'AlertDialog', 'Badge', 'Button', 'Card', 'CardFrame', 'Checkbox', 'Composer', 'ContextRing', 'Dialog', 'Empty', 'Field', 'FreshDot', 'IconButton',
      'Input', 'Kbd', 'KindLabel', 'Label', 'Mark', 'Menu', 'Pill', 'Popover', 'Radio', 'ScrollArea', 'Select', 'Separator', 'Sheet', 'Skeleton', 'Spinner', 'StatusBadge',
      'StepCheck', 'Switch', 'Tabs', 'Textarea', 'Tooltip',
    ];
    /** Not drawn, with the reason. Both only get shorter. */
    const NOT_DRAWN: Record<string, string> = {
      Sidebar: 'the app shell\'s own rail, which every page already draws on the left of this one',
      DropdownMenu: 'the old names of Menu',
      ScrollBar: 'the bar of ScrollArea',
    };
    const exported = Object.keys(design).filter((name) => /^[A-Z][a-z]/.test(name));
    for (const name of DRAWN) {
      expect(exported, `${name} is exported`).toContain(name);
      expect(SOURCE, `${name} is drawn`).toMatch(new RegExp(`<${name}\\b`));
    }
    for (const name of ['rowSurface', 'foldSurface', 'needsSurface', 'chipClass']) expect(SOURCE, `${name} is drawn`).toContain(`${name}(`);
    const loose = exported.filter((name) => !DRAWN.some((root) => name.startsWith(root)) && !Object.keys(NOT_DRAWN).some((root) => name.startsWith(root)));
    expect(loose, `exports with no place on the design page (draw them in DesignPieces.tsx or say why not in NOT_DRAWN)`).toEqual([]);
    for (const root of Object.keys(NOT_DRAWN)) expect(exported.some((name) => name.startsWith(root)), `${root} still exists`).toBe(true);
  });

  it('is reached only through its own lazy route', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(app).toContain("lazy(() => import('./pages/DesignPage.js')");
    expect(app).toContain('<Route path="/design" element={<DesignPage />} />');
    // Nothing links to it: no screen but the router names the address.
    const files = ['app/AppSidebar.tsx', 'pages/SettingsPage.tsx', 'pages/DashboardPage.tsx'];
    for (const file of files) expect(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).not.toMatch(/#\/design|['"]\/design['"]/);
  });
});
