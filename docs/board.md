# The board

The Board tab draws the workspace's plan checkpoints, its source documents and the commits that are new since you last looked. This page is about the other half: what people and AIs **put on the board** and how they **arrange** it. The AI does most of this from its own session, through MCP tools, and keeps the board in order. You look at it and change what you like.

Everything the board keeps is in one file, `contextspace-board.json`, in the workspace folder. It is committed with the workspace's other artifacts. A workspace with no such file has an empty board.

## What it holds

```json
{
  "version": 1,
  "revision": 12,
  "cards": [
    { "id": "<uuid>", "kind": "note", "title": "Export leaks memory", "body": "Seen in the CSV writer.",
      "pinned": false, "archived": false, "area": "checkpoint:reports-export-to-csv", "by": "claude", "at": "2026-10-23T09:00:00.000Z",
      "updatedBy": "user", "updatedAt": "2026-10-23T09:05:00.000Z" },
    { "id": "<uuid>", "kind": "file", "path": "docs/overview.html", "title": "Overview page", "description": "Start with the diagram.",
      "pinned": true, "archived": false, "by": "codex", "at": "…", "updatedBy": "codex", "updatedAt": "…" }
  ],
  "links": [
    { "id": "<uuid>", "from": "<card id>", "to": "checkpoint:reports-export-to-csv", "label": "found while", "by": "claude", "at": "…" }
  ],
  "positions": { "<card id>": { "x": 120, "y": 40 } }
}
```

- **Cards** are what someone put on the board. A `note` has a title (up to 200 characters) and a body (up to 4000). A `file` card shows a file in the workspace, with a title and a description (up to 4000); it is how an AI shows a picture, an HTML page, a PDF, a Markdown document or a deck it made. A card may name an `area` it belongs to (`checkpoint:<plan key>` or `plan:own`); cards without one or naming an area that is no longer on the board go to a linked area or the current checkpoint. `pinned` keeps a card in front; `archived` puts it away without losing it. `by` is `user` for a person at the app, or the name of the AI tool, written in lower case with letters, digits, `.`, `_` and `-` only (anything else becomes a dash, so no name can pass for `user`).
- **Links** are lines between two things, with an optional label (up to 200 characters). The same two ends can be linked once in each direction.
- **Positions** remember where a card was put on the canvas. Each is a finite `x` and `y` between minus and plus 1,000,000. The board remembers at most 2000 places, so a place can be forgotten (see `move`). The file and the API still accept a place for a checkpoint, a document or a commit, but for now the app places those itself and **ignores** a saved place for them (see "In the app").
- **`revision`** counts the change requests applied. A request of several changes counts once.

### Node ids

A line or a position names a thing by its node id:

| Thing | Node id |
| --- | --- |
| A card | the card's `id` (a uuid) |
| A plan checkpoint | `checkpoint:<plan key>`, the key `PLAN.md` gives it (its title in lower case, with dashes) |
| A source document | `document:<source document id>` |
| A commit | `commit:<repository folder name>:<commit hash>` (7 characters or more) |

Only the shape is checked for the generated things, because they come and go: a commit leaves the recent ones, a checkpoint is renamed. A line or a position naming a thing that is no longer there is kept as it is. A card end, by contrast, must be a card that is on the board. On the overview, links between items in different areas are drawn between their areas, while inside an area, links are drawn directly between the items in that area.

### Limits

At most 500 cards, 1000 links and 2000 positions; 100 changes in one request, and 100 nodes in one move. A request over a limit is refused with a message saying which.

### File cards

A file card names a file by its path relative to the workspace folder (`docs/overview.html`). The file must exist when the card is made. The path follows the rules of the documents panel, so what a card accepts is what the panel can open: not absolute, no `..`, no empty or `.` part, no hidden folder except `.claude`, `.agents` and `.github`, nothing outside the workspace, no link (symlink) in the path, and only kinds of file the panel can open (images, HTML, PDF, Markdown and text, office documents). A PNG, JPG, GIF or WebP is shown as a picture; an SVG opens as its source text. Removing a card never touches its file, and a card stays when its file has gone; only making a card needs the file.

## Changing the board

Changes are small operations. A request is a list of them, applied **in order, all or none**, to the board as it is when the lock is taken, so two writers who change different things both keep their change.

| `op` | Fields | Does |
| --- | --- | --- |
| `add_card` | `kind` `note`: `title`, `body?`. `kind` `file`: `path`, `title?` (the file name by default), `description?`. Both: `area?`, `pinned?`, `position?` `{x, y}`, `id?` (a uuid of your own, so the same request can link or move it) | Adds a card |
| `update_card` | `id`, and any of `title`, `body` (notes), `description` (file cards), `pinned`, `archived`, `area` (or `null` to clear) | Changes only what is given |
| `remove_card` | `id` | Deletes the card, its links and its position |
| `move` | `nodes`: a list of `{id, x, y}`; give `x` and `y` as `null` to forget a node's place | Remembers where each node is, or forgets it. Forgetting frees room when a card has left the board or a place is no longer wanted; nodes are applied in order, so a request can forget some and place others at the limit. The app only uses the places of cards |
| `link` | `from`, `to`, `label?` | Draws a line |
| `unlink` | `id`, or `from` and `to` | Removes a line |

An optional `revision` is the one the caller read. If it is given and the board has moved on, nothing is changed and the caller is told to read the board again (409 over HTTP). Without it the change is applied to whatever the board is now.

Each operation is recorded with who made it (`user` from the app, the tool's name from an AI) in `.contextspace/board-changes.jsonl`, which keeps the last 300 changes. After a change, a `board` event (with the new revision) is added to the live feed so open screens read the board again. It is written as made by `human` when `user` made the change, and by `agent` otherwise. A screen that does not know the event ignores it.

Board events have a ledger of their own, `.contextspace/board-events.jsonl`, beside `screen-events.jsonl` (what the AI told the screen). The board is the busiest source there is, and a long run of its events must not push the AI's earlier notes and suggestions out of the part of the ledger the feed reads, or out of the replay. The feed reads both ledgers and sends a board event the moment it is written. A screen that connects is not replayed board events, because it reads the board itself. Like the other ledger, the file is read at its end only, a line older than a day is not sent, and it starts a new file (keeping one earlier) when it passes half a megabyte; a line that cannot be read is skipped.

The file is read through the storage port and rebuilt field by field: a card, line or position that is not usable is dropped. A file that is not a board at all (not JSON, no `version`, a newer version) is reported as an error and **never overwritten**; fix or remove it. So is a board file that cannot be read at all (a folder in its place, no permission). Archived workspaces refuse changes and still read.

## HTTP

Both routes are behind the app's local-origin boundary.

| Route | |
| --- | --- |
| `GET /api/workspace/:id/board` | The board |
| `POST /api/workspace/:id/board/changes` | Body `{ "revision"?: 3, "changes": [ … ] }` (at most 1 MB). Changes are applied as `user`. Returns the new board and `results`, one entry for each change with the `id` it made or touched |

Statuses: `200`; `400` for input that is not valid (the message names the change and field, such as `Change 2, title: …`) or a change this board cannot take (no such card, a limit reached, a file that is not there or may not be shown); `404` for an unknown workspace, or one that has gone while the request was in flight; `409` for a stale `revision`, a busy board or an archived workspace; `413` for a request that is too large; `500` when the stored board is not usable (not JSON, a newer version, a folder or an unreadable file in its place) and when something fails that the request did not cause (a write, the lock, the disk). A `500` leaves the board as it was.

## In the app

The Board tab shows the big picture first: where the work stands, what changed, and what needs you. Work is grouped into **Areas**, and stepping into an area shows its full details.

- **Areas.** The board groups work into areas: one area per checkpoint of the plan, a **Plan** area for steps and decisions that sit outside the checkpoints (when there are any), or a single **Current work** area when the workspace has cards, documents or commits but no plan. Each area holds its related steps, waiting decisions, source documents, commits, and cards. A card belongs to its chosen area (`card.area`), falls back to an area it is linked to, or belongs to the current checkpoint under way; source documents route first by their `scope.milestoneId` when set, then by `board.links`, and otherwise to the current area; commits route to their linked area or the current checkpoint. Every level is proportioned in a 2D grid and fitted to the screen, so you do not scroll or pan to find things.
- **Stepping in and out.** At Level 0, each area is one card showing its status (`Current`, `Done`, `Not done`, or `Plan`), step progress, what waits for you, previews of pictures or recent changes, and item counts. Press an area (click, Enter, or Space) to step into it: the overview recedes behind a dimmed scrim while the area surface grows smoothly to fill the stage. Inside, its steps, waiting decisions, documents, commits, and cards are arranged in an open 2D layout that fits the screen. Pressing **Board ›** in the area header, pressing **Escape** (when no dialog or reader is open), or clicking the dimmed board behind steps out and returns keyboard focus to that area card.
- **Moving things.** Only the cards (notes and files) are arranged by people, so only a card can be dragged: out of the "From the board" band too, or focused and moved with Shift and an arrow key (24 units a press; a run of presses is saved once, a moment after the last). The app places checkpoints, documents and commits itself, in their group and order, and ignores any saved place for them for now; they cannot be dragged and are not stops for moving.
- **Saving a place.** A drop is saved as a `move` of that one card, sent without a `revision` so that a live AI change cannot make it fail, and it is there after a reload and for everyone else. Undo is offered for about eight seconds (Control or Command and Z does the same, and the offer waits while the pointer or the keyboard is on it): it puts the card back at the place it had saved, or forgets the place so the card returns to where the board puts it. A move that is refused puts the card back and says why.
- **Opening things.** A document, a file and a link open beside or over the board, so you do not lose your place. Opening a file or source document shows it in a large window over the board (about 92% wide and 88% high, the board dimmed but in sight all round it), which Escape, "Back to board" and a click on the board behind close; or, as the viewer chooses ("Side by side", kept in this browser), in a reader docked to the right of the canvas (about 45% of the section and at least 360 px). The reader is the app's document viewer: Markdown, HTML in its sandboxed frame (a page's HTML and scripts never reach the board's own page), PDFs and pictures, with their downloads. Where the section is too narrow for both (under about 720 px) the docked reader covers the canvas and has a Close that gives it back. The card that is open has a ring. The keyboard moves into the reader when it opens and goes back to the card's button when it closes. A source document that is a link opens on the web in a new tab (`http` and `https` only); one that is neither a file nor a link has nothing to open.
- **Links in text.** A note's body and a file card's description are Markdown (the app's own renderer, with the same line clamp and "Read all", which shows the same text with the same links). A link to `http` or `https` opens in a new tab (`rel="noopener noreferrer"`); a link to a file of the workspace (a relative path such as `docs/spec.md`, a full path inside the workspace folder, or a `file://` address of one) opens in the reader, read from the workspace folder and not from the card. Any other link (`javascript:`, `data:`, `mailto:`, `ftp:`, an in-page `#anchor`, a path out of the workspace) is plain text. A heading shows as a bold line. Pictures in the text are not drawn yet: each shows as `[image: alt]`. A press on a link is a press, not the start of a drag or a pan. When a card shows only the start of its text, its links (and the copy button of a code block) are not stops for the keyboard, since some may be in the part that is cut off; "Read all" shows the whole text with every link a stop.

## MCP tools

Offered to `developer`, `interactive` and `full` sessions, like the screen tools; `board_read` is offered to `readonly` and `review` sessions too. Each takes an optional `harness` (the name of the AI tool, recorded as who made the change in the plain form above; `user` becomes `ai`). Every tool but `board_read` also takes an optional `revision`. Answers are compact JSON.

| Tool | Use it to |
| --- | --- |
| `board_read` | Read the board, the areas cards can belong to (with `current` showing the checkpoint under way), and what a card or line can point at: the plan's checkpoints and the source documents with their node ids, and the id formats. Call it before changing the board. A note's body and a file card's description longer than 300 characters are cut and the card says `"truncated": true`; pass `cardId` to read one card in full with its lines and place |
| `board_add_card` | Put a note on the board, or show a file you made (a picture, an HTML page, a PDF, a deck) as a file card, optionally placed in an `area`. Returns the card |
| `board_update_card` | Change a card's title, text, description, pinned, archived, or `area` (or `null` to clear) |
| `board_remove_card` | Delete a card that was a mistake (archive one that is only done) |
| `board_move` | Place cards on the canvas, or forget a place with `null`. A place given to a checkpoint, a document or a commit is saved but not used for now |
| `board_link` | Draw a line between two things, with a short label |
| `board_unlink` | Remove a line, by its id or by both ends |
