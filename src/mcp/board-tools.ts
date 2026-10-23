/**
 * @module mcp/board-tools
 * Tools that let the AI work on the workspace board: put notes and the files it made on it, move things, and draw
 * lines between them. The user sees the board in the app and reviews it; the AI is expected to keep it in order itself.
 * The rules, limits and the file are core/board, which the app's board routes use as well.
 */

import { z } from 'zod';

import { readPlanFile } from '../core/plan-file-store.js';
import {
  BOARD_LIMITS, BOARD_NODE_ID_FORMATS, boardActorName, boardFields, changeBoard, readBoard,
  type Board, type BoardCard, type BoardChange,
} from '../core/board.js';
import { loadWorkGuidance } from '../core/work-guidance.js';
import { findWorkspaceRoot, loadFeatureConfig } from '../core/workspace.js';
import type { NexusFlowTool } from './tools.js';

const harness = z.string().max(40).optional().describe('Optional name of the assistant calling this, for example "claude" or "codex". The board shows it as the one who made the change.');
const revision = z.number().int().nonnegative().optional().describe('Optional. The board revision you read. If the board has changed since, nothing is changed and you are told to read it again. Leave it out to apply the change to the board as it is now.');
const x = z.number().min(-BOARD_LIMITS.coordinate).max(BOARD_LIMITS.coordinate);
const y = x;
const cardId = boardFields.uuid.describe('The id of a card, as board_read shows it.');
const nodeId = boardFields.nodeId.describe(`A card id, or checkpoint:<plan key>, document:<document id> or commit:<repository>:<hash>, as board_read shows them.`);

interface BoardToolContext { root: string; by: string }

function friendly(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` : 'The input is not valid.';
  }
  return error instanceof Error ? error.message : String(error);
}

/** The name a change is logged under: the tool's own, never `user`, which is the person at the app. */
function actorOf(name: string | undefined): string {
  const actor = boardActorName(name);
  return !actor || actor === 'user' ? 'ai' : actor;
}

function boardTool<T extends z.ZodObject>(
  name: string,
  description: string,
  schema: T,
  action: (input: z.output<T>, ctx: BoardToolContext) => Promise<unknown>,
  hints: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean } = {},
): NexusFlowTool {
  const inputSchema = z.toJSONSchema(schema, { io: 'input' });
  return {
    name,
    description,
    annotations: { readOnlyHint: hints.readOnly ?? false, destructiveHint: hints.destructive ?? false, idempotentHint: hints.idempotent ?? false, openWorldHint: false },
    inputSchema: {
      ...inputSchema,
      additionalProperties: false,
      properties: {
        ...inputSchema.properties,
        workspaceId: { type: 'string', description: 'Optional ID/branchName of the workspace. Defaults to the workspace this server is bound to (or the current directory). Interactive and full sessions may name another workspace; other roles get an error for a different workspace.' },
      },
    },
    handler: async (args, ctx) => {
      try {
        const { workspaceId: _workspaceId, ...input } = args;
        z.string().optional().parse(_workspaceId);
        const validated = schema.strict().parse(input) as z.output<T>;
        if (!(await loadFeatureConfig(ctx.workspacePath))) throw new Error('Workspace not found.');
        // This server can be started below the workspace root; the board lives at the root.
        const root = (await findWorkspaceRoot(ctx.workspacePath)) ?? ctx.workspacePath;
        const result = await action(validated, { root, by: actorOf((validated as { harness?: string }).harness) });
        // Compact: a board read can be large, and the one reading it is a model.
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: friendly(error) }] };
      }
    },
  };
}

/** Makes one change and says what the board is now. */
async function change(ctx: BoardToolContext, input: { revision?: number }, make: BoardChange) {
  return changeBoard(ctx.root, [make], { by: ctx.by, revision: input.revision });
}

const cardOf = (board: Board, id: string | undefined): BoardCard | undefined => board.cards.find((card) => card.id === id);

const addCardSchema = z.object({
  kind: z.enum(['note', 'file']).describe('note for a short piece of text, file for a file you made that the user should see.'),
  title: boardFields.title.optional().describe(`The card's heading, up to ${BOARD_LIMITS.title} characters. Needed for a note. A file card is headed by its file name when you leave it out.`),
  body: boardFields.body.optional().describe(`Notes only. The text of the note, up to ${BOARD_LIMITS.body} characters.`),
  path: boardFields.path.optional().describe('File cards only. The file, relative to the workspace folder, such as docs/overview.html. It must already exist.'),
  description: boardFields.description.optional().describe(`File cards only. One or two sentences on what the file is and what to look at, up to ${BOARD_LIMITS.description} characters.`),
  pinned: z.boolean().optional().describe('Keep the card in front of the user. Default false.'),
  x: x.optional().describe('Where to put it on the canvas, with y. Leave both out and the board places it.'),
  y: y.optional(),
  revision,
  harness,
});

const updateCardSchema = z.object({
  id: cardId,
  title: boardFields.title.optional(),
  body: boardFields.body.optional().describe('Notes only. Replaces the text of the note.'),
  description: boardFields.description.optional().describe('File cards only. Replaces the description.'),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional().describe('true to put the card away without losing it, false to bring it back.'),
  revision,
  harness,
});

const removeCardSchema = z.object({ id: cardId, revision, harness });

const moveSchema = z.object({
  nodes: z.array(z.object({ id: nodeId, x: x.nullable(), y: y.nullable() }).strict()).min(1).max(BOARD_LIMITS.nodes)
    .describe(`What to place, up to ${BOARD_LIMITS.nodes} at a time: each one's id and its x and y on the canvas. Give x and y as null to forget a node's place, for example a commit or checkpoint that has gone from the board.`),
  revision,
  harness,
});

const linkSchema = z.object({
  from: nodeId.describe('Where the line starts.'),
  to: nodeId.describe('Where the line ends.'),
  label: boardFields.label.optional().describe(`A few words on how they relate, such as "explains" or "blocked by", up to ${BOARD_LIMITS.label} characters.`),
  revision,
  harness,
});

const unlinkSchema = z.object({
  id: boardFields.uuid.optional().describe('The id of the link, from board_read. Or give from and to instead.'),
  from: nodeId.optional(),
  to: nodeId.optional(),
  revision,
  harness,
});

const readSchema = z.object({
  cardId: boardFields.uuid.optional().describe('Optional. The id of one card, to read it in full with its lines and place instead of the whole board.'),
  harness,
});

/** A note's body or a file card's description, as much as board_read shows of it for every card at once. */
const PREVIEW_CHARS = 300;

/** The card with a long body or description cut, and `truncated` saying so. */
function previewOf(card: BoardCard): BoardCard & { truncated?: true } {
  const text = card.kind === 'note' ? card.body : card.description;
  if (text.length <= PREVIEW_CHARS) return card;
  // Not in the middle of a character that takes two code units.
  const cut = text.slice(0, PREVIEW_CHARS).replace(/[\ud800-\udbff]$/, '');
  return { ...card, ...(card.kind === 'note' ? { body: cut } : { description: cut }), truncated: true };
}

/** What a link or a position can name that is not a card: the plan's checkpoints and the source documents. */
async function linkTargets(root: string) {
  const problems: string[] = [];
  const checkpoints = await readPlanFile(root)
    .then(({ plan }) => plan.checkpoints.map((checkpoint) => ({ id: `checkpoint:${checkpoint.key}`, title: checkpoint.title })))
    .catch((error) => { problems.push(`The plan could not be read: ${friendly(error)}`); return []; });
  const documents = await loadWorkGuidance(root)
    .then(({ documents }) => documents.map((document) => ({ id: `document:${document.id}`, title: document.title })))
    .catch((error) => { problems.push(`The source documents could not be read: ${friendly(error)}`); return []; });
  return { checkpoints, documents, problems };
}

export const boardTools: NexusFlowTool[] = [
  boardTool(
    'board_read',
    `Read the workspace board: the cards people and AIs put on it, the lines between things, where things were moved to, and the board's revision. Also lists what a card or line can point at: the plan's checkpoints and the source documents, each with the node id to use, and the node id formats. Call it before you change the board, so you do not add what is already there. The board tab also draws the plan's checkpoints, the source documents and the new commits by itself; this lists only what was added or arranged by hand. To keep the answer small, a note's body and a file card's description longer than ${PREVIEW_CHARS} characters are cut and the card says "truncated": true; pass cardId to read that one card in full, with its lines and place.`,
    readSchema,
    async ({ cardId }, { root }) => {
      const board = await readBoard(root);
      if (cardId !== undefined) {
        const card = cardOf(board, cardId);
        if (!card) throw new Error(`There is no card with id ${cardId} on the board. Read the board again.`);
        return {
          revision: board.revision, card,
          links: board.links.filter((link) => link.from === cardId || link.to === cardId),
          ...(board.positions[cardId] ? { position: board.positions[cardId] } : {}),
        };
      }
      const { problems, ...canLinkTo } = await linkTargets(root);
      return {
        board: { ...board, cards: board.cards.map(previewOf) },
        canLinkTo: { ...canLinkTo, commits: `Not listed. Name one as ${BOARD_NODE_ID_FORMATS.commit}, with the hash as git log shows it (7 characters or more).` },
        nodeIds: BOARD_NODE_ID_FORMATS,
        limits: { cards: BOARD_LIMITS.cards, links: BOARD_LIMITS.links, positions: BOARD_LIMITS.positions },
        ...(problems.length ? { problems } : {}),
      };
    },
    { readOnly: true, idempotent: true },
  ),

  boardTool(
    'board_add_card',
    `Put a card on the board where the user sees it. Use kind "note" for something worth keeping in view: a finding, a question, a summary, a risk. Use kind "file" to SHOW something you made instead of describing it: a picture (png, jpg, gif or webp), an HTML page, a PDF, a Markdown document, a deck or a spreadsheet (an SVG opens as its source text, not as a picture). Write the file inside the workspace first, then give its path relative to the workspace folder; the card opens that file for the user. The file must exist, and only files the app can open are accepted (not links, hidden folders other than .claude, .agents and .github, or anything outside the workspace). Add a short description saying what to look at. To tie the card to the plan or a document, call board_link next with the id this returns.`,
    addCardSchema,
    async ({ kind, title, body, path, description, pinned, x, y, revision }, ctx) => {
      if ((x === undefined) !== (y === undefined)) throw new Error('Give both x and y to place the card, or neither.');
      const { board, results } = await change(ctx, { revision }, {
        op: 'add_card', kind, title, body, path, description, pinned,
        ...(x !== undefined && y !== undefined ? { position: { x, y } } : {}),
      });
      return { revision: board.revision, card: cardOf(board, results[0]?.id) };
    },
  ),

  boardTool(
    'board_update_card',
    `Change a card you or someone else put on the board: its title, the text of a note (body), the description of a file card, whether it is pinned, or whether it is archived. Only what you give changes. Archive a card that is done but worth keeping; use board_remove_card only for a card that was a mistake.`,
    updateCardSchema,
    async ({ id, title, body, description, pinned, archived, revision }, ctx) => {
      const { board } = await change(ctx, { revision }, { op: 'update_card', id, title, body, description, pinned, archived });
      return { revision: board.revision, card: cardOf(board, id) };
    },
    { idempotent: true },
  ),

  boardTool(
    'board_remove_card',
    `Delete a card for good, together with its lines and its place on the canvas. Use it for a card that was a mistake or a duplicate. To put a finished card away without losing it, use board_update_card with archived true instead. The file a file card shows is not touched.`,
    removeCardSchema,
    async ({ id, revision }, ctx) => {
      const { board } = await change(ctx, { revision }, { op: 'remove_card', id });
      return { revision: board.revision, removed: id };
    },
    { destructive: true },
  ),

  boardTool(
    'board_move',
    `Place cards, and the board's own checkpoints, documents and commits, on the canvas, by node id with x and y (pixels; y grows downward). The board remembers the places and keeps them. Move several in one call to lay a group out together, for example the cards about one checkpoint in a row beneath it. Give x and y as null to make the board forget a node's place, which frees room when a commit or checkpoint has left the board (the board remembers at most ${BOARD_LIMITS.positions} places).`,
    moveSchema,
    async ({ nodes, revision }, ctx) => {
      const { board } = await change(ctx, { revision }, { op: 'move', nodes });
      const forgotten = nodes.filter((node) => node.x === null).length;
      return { revision: board.revision, moved: nodes.length - forgotten, forgotten };
    },
    { idempotent: true },
  ),

  boardTool(
    'board_link',
    `Draw a line between two things on the board, with an optional short label saying how they relate. Use it to tie a card to the checkpoint or document it is about, or one card to another. The ends are node ids from board_read: a card id, checkpoint:<plan key>, document:<document id> or commit:<repository>:<hash>. A card must be on the board; the other kinds are only checked for their shape, because the board's own checkpoints, documents and commits come and go. The same two ends can be linked once in each direction.`,
    linkSchema,
    async ({ from, to, label, revision }, ctx) => {
      const { board, results } = await change(ctx, { revision }, { op: 'link', from, to, label });
      return { revision: board.revision, link: board.links.find((link) => link.id === results[0]?.id) };
    },
  ),

  boardTool(
    'board_unlink',
    `Remove a line from the board, by the link's id (from board_read) or by both of its ends. The things it joined stay.`,
    unlinkSchema,
    async ({ id, from, to, revision }, ctx) => {
      const { board, results } = await change(ctx, { revision }, { op: 'unlink', id, from, to });
      return { revision: board.revision, unlinked: results[0]?.id };
    },
    { destructive: true },
  ),
];
