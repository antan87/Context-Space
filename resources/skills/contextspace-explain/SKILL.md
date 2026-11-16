---
name: contextspace-explain
description: Answer "how does this work?" questions as a file in explain/ that the ContextSpace Board draws as cards, with the real code copied and checked. Use whenever someone asks how something works in this project (security, saving, sign-in, a release), or when an answer would save the next AI from researching the same thing again. Also use when you change code that an existing answer points at.
metadata:
  contextspace:
    title: Explain on the Board
    category: workflows
    tags: [contextspace, explain, board, documentation]
---

# Explain on the Board

A person cannot read all the code an AI writes. So answer how-it-works questions in a file the Board draws as cards, with the real code next to your words. The app checks every copied block against the real file.

Read `explain/` first (`ctxspace explain`, or `questions` in MCP `board_read`). If an answer already covers the question, read it and use it. Do not research the same thing again.

## The file

One answer is one file: `explain/<short-kebab-slug-of-the-question>.md`, directly in the workspace folder (no subfolders). Write only under `explain/`.

- `# <the question>`, on the first line after the optional front matter.
- A short answer (1 to 3 plain sentences) before the first `##`. The Board shows it as "In short".
- One `## <part>` per idea: plain words first, then the code that proves them.
- Code: a fence whose info string is `<language> <Repo>/<path>:<start>-<end>`, with those lines copied exactly. The repo name is the folder name from the workspace's Repos table. The lines are 1-based and inclusive.
- Pictures: `![what you see](../board-pictures/name.png)` on a line of its own, relative to the file.
- Diagrams: a fence of language `mermaid`.
- Optional front matter, only to place the answer beside the Board Area it is about: `area: checkpoint:<plan key>` or `area: plan:own`.

````markdown
---
area: checkpoint:the-board-shows-the-work
---
# How does the Board check for others' commits?

It fetches the branch quietly, at most every 5 minutes, and never asks for a password.

## When it fetches

The check runs only when someone looks, and never twice within 5 minutes.

```ts NexusFlow/src/core/incoming.ts:41-44
const FETCH_EVERY_MS = 5 * 60_000;
export function shouldFetch(lastAt: number, now: number): boolean {
  return now - lastAt >= FETCH_EVERY_MS;
}
```

## What is not covered

Pushing and merging: the AI does those.
````

## Writing a good answer

- Plain words first. Someone new to the project should follow the short answer.
- Every claim about code gets a code block pointing at the real lines. Never invent code and never write a claim you did not check in the file.
- Copy short pieces, about 5 to 30 lines. Copy them from the file, do not retype them from memory: a copy that differs by one space says "Changed since".
- One idea per part. Say what is not covered, in a last part.
- Never copy secrets, keys or passwords. Show the line that reads them, not their values.

## Where it goes

Put `area:` only when the question is clearly about that Area's work. Take the id from `ctxspace explain --areas`, or `areas.items` in MCP `board_read`. Leave it out when unsure: the answer then stands in the Questions group.

A follow-up on the same topic goes in the same file: add or rewrite `##` parts and update the short answer. A new topic gets a new file.

## Before you say done

Run `ctxspace explain` (or `board_read`; if `ctxspace` is not on PATH, use `./.contextspace/bin/ctxspace`). It lists every copy that does not match, with the status it found:

- `moved` (Board: "Moved"): the same lines are now elsewhere in the file. Write the new range, which it prints, in the fence.
- `changed` (Board: "Changed since"): the lines differ. Read the file again, then rewrite the copy and the words around it.
- `gone` (Board: "File gone"): the file no longer exists. Point at where the code lives now, or remove the part.
- `not-in-workspace` (Board: "Not in this workspace"): the path is not in this workspace's repositories. Use a path that is, or remove the block.
- `unreadable` (Board: "Could not be checked"): the file is binary or too large. Copy from a smaller file.

Repeat until it says "All copies match".

## Keeping it true

When you change code that an answer points at, update that answer's copies and words in the same piece of work. Find them with `ctxspace explain`, which lists every copy that no longer matches.

This skill is on by default and can be turned off per workspace on the Skills screen.
