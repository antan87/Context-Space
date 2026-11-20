# The design module

`gui/src/design/` is the one place the GUI's look and reusable pieces live. Screens import from **`design/index`** only (`import { Button } from '../../design/index.js'`). Files inside the module import each other directly.

The module is new (slice DS2a). Today it re-exports the controls from `components/ui`. The Board's own pieces move in over the next slices, with the app looking exactly the same until the restyle.

## The calm rules

From the workspace's `design/calm-design-rules.md`:

1. **Options show up when you reach for them.** At rest a surface shows content (title, picture, text, state). Secondary actions appear on `:hover` or `:focus-within`, or sit in a `...` menu. The surface itself is the main action; no "Open" or "Read all" buttons on cards.
2. **One main action per surface.** At most one filled `bg-primary` button per screen; every other button is ghost or an `IconButton`.
3. **Metadata stays quiet.** Who and when shrinks to a mark (AI or you). Paths, SHAs and counts are 12 px muted text, mono for paths and SHAs, never in a bordered chip. Zero counts are not shown.
4. **Normal things carry no warnings.** `--destructive` and `--warning` only for what blocks work or loses it, always with the action that fixes it.
5. **Space, type, colour, motion.** A 4 px grid (4, 8, 12, 16, 24, 32). Inter and JetBrains Mono, weights 400, 500, 600, no all-caps. Neutrals carry the screen; `--state-*` carries meaning. Hover and menus 120-160 ms ease-out; nothing moves under `prefers-reduced-motion`.
6. **The AI is present without noise.** "Now" and "new since you looked" come from the plan, commits and files at no token cost. A card gets one reason, in one line. The board does not rearrange itself while you look.
7. **Accessibility stays.** Real `<button>` or `<a>` with a name; icon-only controls use `IconButton`. Hidden options stay in the tab order. Every focusable control keeps the 2 px `--ring` outline. Text contrast at least 4.5:1, and colour is never the only signal.

### The UX review's 8 principles

(`design/ux/ux-review-2026-11-17.md`, section 4)

1. **One fact, one place.** A decision, status or step shows at most once per screen, plus at most one count.
2. **The conversation is never covered.** At 1100 px and wider no reader, Code window or dialog hides the chat.
3. **12 and 24.** No text under 12 px on screen (zoom included), no target under 24 px.
4. **Same word, same thing.** The glossary words only; an action and its result use the same verb.
5. **Calm until blocked.** One filled button per screen. Warning colours only when work is blocked or lost, always with the fix.
6. **Every AI action has a trace, both ways.** A note links to its chat message and back; a tool call links to its diff.
7. **What waits is three keys away.** From page load a skip link reaches "Waits for you" in 3 key presses or fewer.
8. **Judge with real data at real sizes.** 1100, 1280, 1440 and the narrow pane, light and dark, with long titles.

## The target look: "Hairline"

Decided 17 Nov 2026 (`design/ux/look-decision-2026-11-17.md`). Precision for everything you use (1 px hairlines, 8 px corners, no resting shadows), Editorial's reading text for everything you read (14 px at 1.55, 72 characters, no bubbles). The main colour is the calm blue `#0966d3` (light) and `#58a6ff` (dark); orange stays in the logo and the Context Ring, and means "Waits for you". The look is applied one piece per slice (R1). **Applied so far: the tokens in the table below (all of them now exist in `tokens.css`) and `CardFrame` (R1a), `Pill` and `KindLabel` (R1b), `rowSurface` and `foldSurface` (R1c).** Every other piece still draws today's look.

The new tokens, in `tokens.css`: `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`, `--r-full`; `--shadow-hover`, `--shadow-raised`; `--border-hover`; `--divider`; the type scale as `--type-<name>-size|weight|leading` (names: `area-title`, `panel-title`, `card-title`, `ui`, `reading`, `meta`, `label`) and its Board version `--type-board-<name>-size|leading` (÷ 0.9). Tailwind utilities: `rounded-card` (8 px), `shadow-card-hover`, `border-border-hover`. The old `--radius-*` scale (`rounded-lg` and so on) is unchanged until the pieces that use it move.

**Where the tokens live (DS11).** All design tokens are in `design/tokens.css`: the semantic tokens (`:root` and `@theme inline`), the brand and state/progress tokens, the six palettes (every `:root[data-color-theme=…]` and `:root.dark[data-color-theme=…]` block) and, last on purpose, the dark progress tokens that must win over every palette. R1 changes the tokens there, and only there. `src/index.css` imports the file; the Board's own rules are in `features/board/board.css`, imported the same way. Keep the order inside `tokens.css` (semantic, brand/state, palettes, dark progress last): `paletteContrast.test.ts` reads the file the way the browser applies the cascade. `tokens.css` is APP_WIDE for `affected-e2e` (every screen reads it); `board.css` runs the Board's specs, not all of `gui/e2e`.

On the Board, sizes are written at x1/0.9 so they stay at least 12 px on screen at the Area's 0.9 zoom (12 px meta is written as 13.5 px).

| Token | Light | Dark | Used for |
|---|---|---|---|
| Radius `--r-sm` | 4 px | same | checkbox, small tag, code chip |
| `--r-md` | 6 px | same | buttons, inputs, option chips, segmented control |
| `--r-lg` | 8 px | same | cards, panels, tool cards, Code window frame, composer |
| `--r-xl` | 12 px | same | popovers, dialogs, the What's new panel |
| `--r-full` | 9999 px | same | status dots, avatars, number badges (only those) |
| Surfaces stage / card | `#f6f8fa` / `#ffffff` | `#090d13` / `#161b22` | Board canvas and page / cards and panels |
| Muted surface | `#f6f8fa` | `#1c2128` | your own chat message, code chips, hover rows |
| Border `--border` | `#d0d7de` | `#30363d` | every card, panel, input; 1 px solid |
| Divider | `--border` at 60 % | same | lines inside a card or panel |
| Border on hover | `#afb8c1` | `#484f58` | cards and rows on hover |
| Border selected or reading | `--primary` 1 px + 1 px inner ring | same | the open card, the selected thread |
| Text fg / muted | `#1f2328` / `#5f6771` (5.7:1) | `#f0f6fc` / `#8b949e` (5.6:1) | text / meta; muted never goes lighter |
| Shadow at rest | none | none | cards and panels |
| Shadow on hover | `0 1px 2px rgb(0 0 0 / .06)`, lift 1 px | `0 1px 2px rgb(0 0 0 / .4)`, lift 1 px | cards only, 120 ms ease-out |
| Shadow raised | `0 8px 24px rgb(0 0 0 / .12)` | `0 8px 24px rgb(0 0 0 / .5)` | popovers, menus, dialogs |
| Focus | 2 px solid `--ring` (= primary), 2 px offset | same | every focusable control, never removed |
| Type | Inter; JetBrains Mono for code | | weights 400, 500, 600 only; sentence case |
| Area / reader title | 18 / 600 / 24 | | Area header, document title |
| Panel title, Now step | 16 / 600 / 22 | | Now card, chat thread title, dialog titles |
| Card title | 14 / 600 / 20, up to 2 lines | | Board cards, tool card titles, decision questions |
| UI text | 13 / 400 / 20 | | buttons, menus, list rows, card summary |
| Reading body | 14 / 400 / 22 (1.55), max 72ch | | chat messages, reader, notes, decision bodies |
| Meta | 12 / 400 / 16, tabular figures | | times, counts, paths, SHAs (mono) |
| Label | 12 / 500 / 16 | | chips, pills, small buttons, tab labels |
| Code | 13 / 20 editor, 12 / 18 diffs in chat, 0.92 em inline | | Monaco, tool-call diffs, inline code |
| Space | 4, 8, 12, 16, 24, 32 | | nothing between the steps |
| Chips (suggested answers, filters) | height 28, `--r-md`, 1 px border, no fill; selected = primary border + 8 % primary tint | | they look like buttons because they are buttons |
| Tags (kind of card) | none; an icon + the word in meta | | "note", "commit" are no longer boxed |
| Number badges | height 20, `--r-full`, muted surface; the header's "?1" and "✦3" are 28 px buttons, not badges | | counts only |

State always shows as a word, never colour alone: Now (`--state-now` dot, "Now", 3 px left rule), Waits for you (`--state-needs` dot, "?n waiting", 3 px left rule), Fresh (6 px primary dot until opened, one soft glow, none under reduced motion), Pinned (pin icon in the meta line), Archived (muted, 70 % opacity, the word "Archived"), Done (`--state-done` check, muted title), AI (agent icon + name in `--state-ai`, no fill) and person ("You" at 600).

## The pieces

| Piece | Status | Comes in |
|---|---|---|
| Button, IconButton, Badge, StatusBadge, Dialog, AlertDialog, Sheet, Menu, Popover, Tooltip, Select, Input, Textarea, Checkbox, RadioGroup, Switch, Tabs, Label, Field, Card, Alert, Empty, Kbd, Separator, ScrollArea, Skeleton, Spinner, Sidebar, ContextRing | **Exist.** Exported from `design/index`; the files still live in `components/ui` | DS2a |
| `CardFrame` (the card's `<article>`) | **Exists**, drawn in the **Hairline** look (R1a): `rounded-card` (8 px), a 1 px `--border`, no shadow at rest; on hover (pointer only) `--border-hover`, `--shadow-hover` and a 1 px lift in 120 ms (the border only under reduced motion); pinned keeps `border-primary/50`; archived is the muted surface at 70 % with the dashed border; reading is a 1 px primary border and a 1 px inner ring; the keyboard ring and the fresh glow are unchanged | 2b, R1a |
| `Pill` (a state in a word, with tones `neutral`, `accent`, `ai`, `needs`, `done`, `reopened`, `warning`; the Hairline look: the tone's colours at 12 px), `KindLabel` (the kind of a card in its title row: a lucide icon, `aria-hidden`, and the word, muted, at the Board's meta size `--type-board-meta-size`, weight 400, no box; kinds `note`, `commit`, `picture`, `html`, `pdf`, `markdown`, `other`), `Mark` (who made a card: "AI" in the AI's tone or "you"), `FreshDot` (the "New since you looked" dot, block or inline) | **Exist** (DS4); `Pill` and `KindLabel` are in the Hairline look (R1b), the legacy boxed tag is gone | 4, R1b |
| `MetaLine` | planned | with the rows (5) or the restyle |
| `StepCheck` (the step checkbox: `checked`, `label`, `title`, `disabled`, `busy`, `pressable`, `testId`, `onToggle`, `className`; it takes plain values, never Board data), `rowSurface(...)` and `foldSurface(...)` in `RowSurface.tsx` (class helpers for the Now/Next step surface and the folded row) | **Exist** (DS5b); `rowSurface` and `foldSurface` are in the **Hairline** look (R1c): the Now or Next up row and the current fold are `rounded-card` (8 px) with a 1 px `--border`, the card surface and a 3 px `--state-now` rule (the only colour; no gradient; 13 px left padding so the text starts at 16 px as before), a folded row is the same hairline card with `--border-hover` on hover, a quiet step row is plain text. Real suggested-answer buttons come with R1. Use `StepCheck` for any step checkbox, `rowSurface` for a step row's surface | 5 |
| `ListRow` | planned | 5 |
| `Composer` (a controlled multi-line text field: `value`, `onChange` (gets the string), `mono`, `className` (drawn last), and `id`, `name`, `placeholder`, `maxLength`, `rows`, `disabled`, `autoFocus`, `onKeyDown`, `aria-*` and `ref` straight to the `<textarea>`) | **Exists** (DS6), drawn exactly as the note dialog's body was. Use it for any multi-line text the Board writes. It has no auto-grow, toolbar, saving or error state yet: the in-place note, paste and drop, Sticky and the Markdown writing add them when they need them, and R1 restyles it | 6 |
| The live design page `#/design` (`src/pages/DesignPage.tsx`, `DesignPieces.tsx`) | **Exists** (DS7). See "The design page" below | 7 |
| `tokens.css` (moved from `index.css`) | planned | 11 |
| The Hairline look applied | tokens and `CardFrame` done (R1a); `Pill` and `KindLabel` done (R1b); `rowSurface` and `foldSurface` done (R1c); the other pieces follow | R1 |

## The design page

Open **`#/design`** (for example `http://localhost:3100/#/design`). It is a hidden address: no link, menu item or Settings entry points to it, and it loads only when opened (its own chunk). It draws:

- **Every piece** `design/index` exports, each under its own heading and in each state it has: Button and the other controls, `CardFrame` (normal, fresh, pinned, archived, reading, compact, pressable), `Pill` (each tone), `KindLabel` (each kind), `Mark` (you and AI), `FreshDot` (block and inline), `StepCheck` (unchecked, checked, busy, disabled), `rowSurface` and `foldSurface` (Now, Next up, quiet, folded, current fold), and `Composer` (empty, typed, mono, disabled). The one piece it does not draw is `Sidebar`, the app shell's own rail.
- **Every kind of Board card** (all 17 the Board registers), in each state that applies: normal, fresh, pinned, archived, reading, compact and long text. Each card is a real node of its own React Flow at the Area's zoom (0.9), inside the Board's providers, so it looks as it does on the Board. The data is fixture data (`features/board/cards/cardFixtures.ts`, the same cards the golden markup test renders), the Board's actions are all no-ops, and the page makes no request that writes. Light and dark and the active palette follow the app.

It lives under `pages/` and not in `design/`: `design/` may not import from `features/`, and the page draws the real cards from `features/board`. It takes the pieces only through `design/index`.

**R1 checks each piece there.** When you change a piece, open `#/design` in light and dark and look at every state of it and at every card that draws it. `e2e/design-page.spec.ts` checks that each piece and card kind draws, that the page writes nothing, and that it has no text under 12 px on screen (zoom included) beyond `e2e/design-page-small-text.ts`, today's list. That list may only shrink: the spec fails on a new text and on a stale entry. R1 empties it.

When you add a piece, draw it in `pages/DesignPieces.tsx` (a unit test fails on a design export the page does not draw); when you add a card kind or a card state, add its fixture in `cardFixtures.ts`.

## Do not hand-build

If the piece exists here, use it. Do not write these again in a screen:

- a button, icon button, badge, input, textarea, checkbox, switch, menu, popover, tooltip, dialog or tab bar (use the export; icon-only controls need `IconButton` for its label and tooltip);
- a card surface (border, radius, padding, hover, focus ring, archived/pinned/reading states): `CardFrame` once it exists;
- a kind tag, a you/AI mark, a fresh dot: `KindLabel` (the kind of a card), `Pill` (a state in a word), `Mark` (who made it), `FreshDot` (new since you looked); a count pill is not one of them yet;
- a multi-line text field on the Board (a note body and what comes after it): `Composer`;
- a step checkbox or a Now/Next row surface: `StepCheck` (the box; pass `nodrag nopan` through `className` on the Board) and `rowSurface` / `foldSurface` (the surface classes);
- text below 12 px, a raw palette colour (`text-violet-600`, `bg-red-500/10`), a hex value, or an arbitrary `rounded-[..]` / `shadow-[..]`: use the tokens (`text-xs`, `text-muted-foreground`, `bg-primary`, `--state-*`, `rounded-lg`, `shadow-xs`). If a token is missing, add it to the tokens, not to the component.

## Add a card kind

A card kind is a Board node type. Today they live in `features/board/BoardNodes.tsx`; they move to `features/board/cards/` in slices 3 to 8.

1. Add its node type (data shape) to `features/board/boardLayout.ts` and place it in the layout code that builds the overview or Area.
2. Write the component with `CardFrame` (once it exists) and design pieces only. No hand-built surface, tag or mark. Board passes React Flow's `Anchors` in as a child; `design/` never imports React Flow.
3. Register it in `OVERVIEW_NODE_TYPES` or `AREA_NODE_TYPES` (`BoardSection.tsx`, later `nodeTypes.ts`).
4. Add its fixture data to `features/board/cards/cardFixtures.ts` and a case for it to `features/board/cards/cardMarkup.test.tsx`. That test reads the registered node types and fails until the new kind has a golden snapshot. Add the kind to `CARD_KINDS` (`pages/designPageLists.ts`) and its keys to `e2e/design-page.spec.ts`, so the design page draws it.
5. Add a row to `gui/scripts/affected-e2e.mjs` for the specs that draw it, with a mutation test in `scripts/affected-e2e.test.ts`.
6. Check the guard (below) did not go up, and look at it in the real app at 1100, 1280, 1440 and 420 px, light and dark.

## How the checks work

**The style ratchet** (`designGuard.test.ts` with `design-baseline.json`, runs in under a second as part of `npm test`). It scans production `src/**/*.ts` and `*.tsx` (not tests or `.d.ts`; a `.ts` helper can carry class strings too) for:

- text below 12 px: `text-[10px]`, `text-[11.5px]`, `text-[0.7rem]`, `text-[length:10px]`, and inline sizes such as `style={{ fontSize: 10 }}`, `fontSize: '11px'`, `font-size: 0.7rem`;
- raw Tailwind palette colours (`text-violet-600`, `dark:bg-red-500/10`);
- hex values (`#D97757`);
- arbitrary `rounded-[..]` and `shadow-[..]` values.

It counts them per token and per folder. **A new token, a token that grew, or a bigger total fails.** A smaller total passes and prints a hint to lower the baseline: run `UPDATE_DESIGN_BASELINE=1 npx vitest run gui/src/design/designGuard.test.ts` and commit the new `design-baseline.json`. The update refuses any new token, any token that grew and a bigger total, so it cannot be used to accept growth. The only time the baseline may grow is when the scanner itself changes: bump `SCANNER_VERSION` in `designGuard.test.ts` in the same change, so a reviewer sees the new rules. A move between folders keeps the total, and the test prints the split so a reviewer sees it (run it with `--reporter=verbose` to see the printed lines).

Named exceptions are for content, never for styling, and each covers only the colour literals on the lines it names, so an ordinary label in the same file still counts: the palette swatches (`dotClass:` lines in `ThemeProvider.tsx`), the skill colour choices (`value: '#...'` lines in `SkillsPage.tsx`) and the terminal's own theme (`TerminalPane.tsx`). Text size is never excepted. An exception that no longer matches anything fails the test, so the list cannot go stale. Add one only for content such as written text, syntax colours or diagrams.

**The import rules** (ESLint `no-restricted-imports`, in `gui/eslint.config.js`; `designLint.test.ts` proves each one on sample files):

- (a) inside `src/design/**`: no imports from `features/`, `@xyflow/react` or `@tanstack/react-query`;
- (b) everywhere else, including `components/ui/**`: no deep `design/*` imports, only `design/index`;
- (c) outside `design/` and `components/ui/`: no new `components/ui/*` imports, in any relative spelling (`../../components/ui/button.js`, the barrel `../components/ui`, `./ui/button.js` from inside `components/`). Files that already import them are on `LEGACY_UI_IMPORTERS` in the config (71 today). That list may only get shorter: when you touch such a file, switch it to `design/index` and remove it from the list. `designLint.test.ts` fails if the list and the real importers differ.

**The golden markup test** (`features/board/cards/cardMarkup.test.tsx`) renders every Board node kind from fixtures and compares it with committed snapshots. A move into the module must leave the snapshots byte for byte the same. Only a restyle slice may update them, and it says so.

**`affected-e2e.mjs`.** `design/index.ts` is app-wide (all of `gui/e2e`). A change to only this README, the guard test or the baseline runs no browser spec, only unit tests.
