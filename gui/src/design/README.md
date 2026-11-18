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

Decided 17 Nov 2026 (`design/ux/look-decision-2026-11-17.md`). Precision for everything you use (1 px hairlines, 8 px corners, no resting shadows), Editorial's reading text for everything you read (14 px at 1.55, 72 characters, no bubbles). The main colour is the calm blue `#0966d3` (light) and `#58a6ff` (dark); orange stays in the logo and the Context Ring, and means "Waits for you". The look is **not applied yet**: it arrives with the restyle (R1) and `tokens.css` (slice 11). Until then, today's tokens in `src/index.css` are the truth.

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
| `CardFrame` (the card's `<article>`) | planned | 2b |
| `Pill` (a kind tag or state word, with tones `neutral`, `accent`, `ai`, `needs`, `done`, `reopened`, `warning`), `Mark` (who made a card: "AI" in the AI's tone or "you"), `FreshDot` (the "New since you looked" dot, block or inline) | **Exist** (DS4), with the legacy look (today's classes) until the restyle; `look="hairline"` is the target look of `Pill` | 4 |
| `MetaLine` | planned | with the rows (5) or the restyle |
| `StepCheck`, `RowSurface`, `ListRow` | planned | 5 |
| `Composer` (growing text field) | planned | 6 |
| `reference/DesignPage` (live page `#/design`) | planned | 7 |
| `tokens.css` (moved from `index.css`) | planned | 11 |
| The Hairline look applied | planned | R1 |

## Do not hand-build

If the piece exists here, use it. Do not write these again in a screen:

- a button, icon button, badge, input, textarea, checkbox, switch, menu, popover, tooltip, dialog or tab bar (use the export; icon-only controls need `IconButton` for its label and tooltip);
- a card surface (border, radius, padding, hover, focus ring, archived/pinned/reading states): `CardFrame` once it exists;
- a kind tag, a you/AI mark, a fresh dot: `Pill` (kind of a card, a state in a word), `Mark` (who made it), `FreshDot` (new since you looked); a count pill is not one of them yet;
- a step checkbox or a Now/Next row surface: `StepCheck` and `RowSurface` once they exist;
- text below 12 px, a raw palette colour (`text-violet-600`, `bg-red-500/10`), a hex value, or an arbitrary `rounded-[..]` / `shadow-[..]`: use the tokens (`text-xs`, `text-muted-foreground`, `bg-primary`, `--state-*`, `rounded-lg`, `shadow-xs`). If a token is missing, add it to the tokens, not to the component.

## Add a card kind

A card kind is a Board node type. Today they live in `features/board/BoardNodes.tsx`; they move to `features/board/cards/` in slices 3 to 8.

1. Add its node type (data shape) to `features/board/boardLayout.ts` and place it in the layout code that builds the overview or Area.
2. Write the component with `CardFrame` (once it exists) and design pieces only. No hand-built surface, tag or mark. Board passes React Flow's `Anchors` in as a child; `design/` never imports React Flow.
3. Register it in `OVERVIEW_NODE_TYPES` or `AREA_NODE_TYPES` (`BoardSection.tsx`, later `nodeTypes.ts`).
4. Add it to `features/board/cards/cardMarkup.test.tsx` with fixture data. That test reads the registered node types and fails until the new kind has a golden snapshot.
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
- (c) outside `design/` and `components/ui/`: no new `components/ui/*` imports, in any relative spelling (`../../components/ui/button.js`, the barrel `../components/ui`, `./ui/button.js` from inside `components/`). Files that already import them are on `LEGACY_UI_IMPORTERS` in the config (72 today). That list may only get shorter: when you touch such a file, switch it to `design/index` and remove it from the list. `designLint.test.ts` fails if the list and the real importers differ.

**The golden markup test** (`features/board/cards/cardMarkup.test.tsx`) renders every Board node kind from fixtures and compares it with committed snapshots. A move into the module must leave the snapshots byte for byte the same. Only a restyle slice may update them, and it says so.

**`affected-e2e.mjs`.** `design/index.ts` is app-wide (all of `gui/e2e`). A change to only this README, the guard test or the baseline runs no browser spec, only unit tests.
