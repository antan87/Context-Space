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
      "pinned": false, "archived": false, "by": "claude", "at": "2026-10-23T09:00:00.000Z",
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

- **Cards** are what someone put on the board. A `note` has a title (up to 200 characters) and a body (up to 4000). A `file` card shows a file in the workspace, with a title and a description (up to 4000); it is how an AI shows a picture, an HTML page, a PDF, a Markdown document or a deck it made. `pinned` keeps a card in front; `archived` puts it away without losing it. `by` is `user` for a person at the app, or the name of the AI tool, written in lower case with letters, digits, `.`, `_` and `-` only (anything else becomes a dash, so no name can pass for `user`).
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

Only the shape is checked for the generated things, because they come and go: a commit leaves the recent ones, a checkpoint is renamed. A line or a position naming a thing that is no longer there is kept as it is. A card end, by contrast, must be a card that is on the board. A line to a commit or a document inside a group that is folded (see "In the app") is drawn to the group's summary.

### Limits

At most 500 cards, 1000 links and 2000 positions; 100 changes in one request, and 100 nodes in one move. A request over a limit is refused with a message saying which.

### File cards

A file card names a file by its path relative to the workspace folder (`docs/overview.html`). The file must exist when the card is made. The path follows the rules of the documents panel, so what a card accepts is what the panel can open: not absolute, no `..`, no empty or `.` part, no hidden folder except `.claude`, `.agents` and `.github`, nothing outside the workspace, no link (symlink) in the path, and only kinds of file the panel can open (images, HTML, PDF, Markdown and text, office documents). A PNG, JPG, GIF or WebP is shown as a picture; an SVG opens as its source text. Removing a card never touches its file, and a card stays when its file has gone; only making a card needs the file.

## Changing the board

Changes are small operations. A request is a list of them, applied **in order, all or none**, to the board as it is when the lock is taken, so two writers who change different things both keep their change.

| `op` | Fields | Does |
| --- | --- | --- |
| `add_card` | `kind` `note`: `title`, `body?`. `kind` `file`: `path`, `title?` (the file name by default), `description?`. Both: `pinned?`, `position?` `{x, y}`, `id?` (a uuid of your own, so the same request can link or move it) | Adds a card |
| `update_card` | `id`, and any of `title`, `body` (notes), `description` (file cards), `pinned`, `archived` | Changes only what is given |
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

The Board tab shows the big picture first: where the work stands, what changed, and what needs you. Each **group** is one small summary, and you open a group when you want its details.

- **Groups** are a checkpoint, the plan's own steps (a frame for the steps and decisions that sit outside every checkpoint), the documents, and each repository's new commits. Folded, a checkpoint says its title, whether it is done, "x of y steps", a "Waits for you" badge when it has a decision open, and a thin progress bar; the plan's own frame says how many steps sit outside the checkpoints; the documents say how many there are and how many are drafts or superseded; a repository says how many commits are new and shows the newest one's subject and author. A group folded is always the same small height, and a group that waits for you shows its badge but stays folded.
- **Open and folded.** The checkpoint the work is on (the first that is not done, else the last) is open and every other group is folded. Press a summary (it is one button, named for what it holds and marked as not expanded: a click anywhere on it, or Enter or Space) and the group opens where it stands: its column grows, and nothing moves, no column and no card of the "From the board" band, which stands under the tallest a frame can be when it is open, however many are open or folded and wherever the work is. A card with a place of its own never stands over a group as it is when open, whether the group is open or folded: a drop or a nudge that would put it there puts it just below the group instead and saves that place, and a saved place that is over one (written by an AI, or saved earlier) is drawn just below it, so everyone sees a card in the same place whatever they have folded. If the group no longer fits in view, the view moves smoothly to show as much of it as fits, top first. Opening or folding does not count as taking the view, so the view still follows the work. The fold button in the header of an open group (marked as expanded) folds it again. A summary of a repository that could not be read in full says so, since its note is hidden while it is folded. A double click on the board does not zoom it.
- **Where it opens.** On a board whose groups, from the first column to the last, all fit the width of the view at a zoom of 0.7 or more, the board opens on all of them, side by side, centred, with the row at the top. A board that is wider opens on the work under way, with its neighbours, at a zoom that can be read; "Fit the board in view" shows everything.
- **Remembered.** What you open or fold is kept in this browser (local storage), for this workspace, as the difference from the default only, so when the work moves on to the next checkpoint it opens by itself, unless you folded it. It is not shared with other people, and the board works without storage.
- **Moving things.** Only the cards (notes and files) are arranged by people, so only a card can be dragged: out of the "From the board" band too, or focused and moved with Shift and an arrow key (24 units a press; a run of presses is saved once, a moment after the last). The app places checkpoints, documents and commits itself, in their group and order, and ignores any saved place for them for now; they cannot be dragged and are not stops for moving.
- **Saving a place.** A drop is saved as a `move` of that one card, sent without a `revision` so that a live AI change cannot make it fail, and it is there after a reload and for everyone else. Undo is offered for about eight seconds (Control or Command and Z does the same, and the offer waits while the pointer or the keyboard is on it): it puts the card back at the place it had saved, or forgets the place so the card returns to where the board puts it. A move that is refused puts the card back and says why.

## MCP tools

Offered to `developer`, `interactive` and `full` sessions, like the screen tools; `board_read` is offered to `readonly` and `review` sessions too. Each takes an optional `harness` (the name of the AI tool, recorded as who made the change in the plain form above; `user` becomes `ai`). Every tool but `board_read` also takes an optional `revision`. Answers are compact JSON.

| Tool | Use it to |
| --- | --- |
| `board_read` | Read the board, and what a card or line can point at: the plan's checkpoints and the source documents with their node ids, and the id formats. Call it before changing the board. A note's body and a file card's description longer than 300 characters are cut and the card says `"truncated": true`; pass `cardId` to read one card in full with its lines and place |
| `board_add_card` | Put a note on the board, or show a file you made (a picture, an HTML page, a PDF, a deck) as a file card. Returns the card |
| `board_update_card` | Change a card's title, text, description, pinned or archived |
| `board_remove_card` | Delete a card that was a mistake (archive one that is only done) |
| `board_move` | Place cards on the canvas, or forget a place with `null`. A place given to a checkpoint, a document or a commit is saved but not used for now |
| `board_link` | Draw a line between two things, with a short label |
| `board_unlink` | Remove a line, by its id or by both ends |
