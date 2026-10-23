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
  "positions": { "<card id>": { "x": 120, "y": 40 }, "checkpoint:reports-export-to-csv": { "x": 400, "y": 0 } }
}
```

- **Cards** are what someone put on the board. A `note` has a title (up to 200 characters) and a body (up to 4000). A `file` card shows a file in the workspace, with a title and a description (up to 4000); it is how an AI shows a picture, an HTML page, a PDF, a Markdown document or a deck it made. `pinned` keeps a card in front; `archived` puts it away without losing it. `by` is `user` for a person at the app, or the name of the AI tool, written in lower case with letters, digits, `.`, `_` and `-` only (anything else becomes a dash, so no name can pass for `user`).
- **Links** are lines between two things, with an optional label (up to 200 characters). The same two ends can be linked once in each direction.
- **Positions** remember where a thing was put on the canvas, for cards and for the board's own checkpoints, documents and commits alike. Each is a finite `x` and `y` between minus and plus 1,000,000. The board remembers at most 2000 places, so a place can be forgotten (see `move`).
- **`revision`** counts the change requests applied. A request of several changes counts once.

### Node ids

A line or a position names a thing by its node id:

| Thing | Node id |
| --- | --- |
| A card | the card's `id` (a uuid) |
| A plan checkpoint | `checkpoint:<plan key>`, the key `PLAN.md` gives it (its title in lower case, with dashes) |
| A source document | `document:<source document id>` |
| A commit | `commit:<repository folder name>:<commit hash>` (7 characters or more) |

Only the shape is checked for the generated things, because they come and go: a commit leaves the recent ones, a checkpoint is renamed. A line or a position naming a thing that is no longer there is kept as it is. A card end, by contrast, must be a card that is on the board.

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
| `move` | `nodes`: a list of `{id, x, y}`; give `x` and `y` as `null` to forget a node's place | Remembers where each node is, or forgets it. Forgetting frees room when a commit or checkpoint has left the board; nodes are applied in order, so a request can forget some and place others at the limit |
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

On the Board tab you drag a card, a checkpoint, a document or a commit where you want it, out of its lane too, or focus it and press Shift with an arrow key (24 units a press; a run of presses is saved once, a moment after the last). The place is saved as a `move` of that one node, sent without a `revision` so that a live AI change cannot make it fail, and it is there after a reload and for everyone else. Undo is offered for about eight seconds (Control or Command and Z does the same, and the offer waits while the pointer or the keyboard is on it): it puts the node back at the place it had saved, or forgets the place so the node returns to where the board puts it. A move that is refused puts the node back and says why.

## MCP tools

Offered to `developer`, `interactive` and `full` sessions, like the screen tools; `board_read` is offered to `readonly` and `review` sessions too. Each takes an optional `harness` (the name of the AI tool, recorded as who made the change in the plain form above; `user` becomes `ai`). Every tool but `board_read` also takes an optional `revision`. Answers are compact JSON.

| Tool | Use it to |
| --- | --- |
| `board_read` | Read the board, and what a card or line can point at: the plan's checkpoints and the source documents with their node ids, and the id formats. Call it before changing the board. A note's body and a file card's description longer than 300 characters are cut and the card says `"truncated": true`; pass `cardId` to read one card in full with its lines and place |
| `board_add_card` | Put a note on the board, or show a file you made (a picture, an HTML page, a PDF, a deck) as a file card. Returns the card |
| `board_update_card` | Change a card's title, text, description, pinned or archived |
| `board_remove_card` | Delete a card that was a mistake (archive one that is only done) |
| `board_move` | Place cards and the board's own checkpoints, documents and commits on the canvas, or forget a place with `null` |
| `board_link` | Draw a line between two things, with a short label |
| `board_unlink` | Remove a line, by its id or by both ends |
