/**
 * @module core/workspace-db/definitions
 * The one place that says what the workspace database holds. Every table and column has a one-line meaning here;
 * both the `CREATE` statements and `schemaText()` (what `ctxspace plan schema` will print) are made from it, so
 * what an AI reads about the structure cannot drift from the structure itself.
 */

export interface ColumnDef {
  name: string;
  /** SQL type and constraints. */
  sql: string;
  /** One line, written for an AI that has never seen the schema. */
  meaning: string;
  /**
   * Worked out from other columns after every change. It is recorded in history (a heading add changes the section of what follows),
   * but a change that only moves it does not count as touching the row.
   */
  derived?: boolean;
}

export interface TableDef {
  name: string;
  meaning: string;
  columns: ColumnDef[];
  /** The column that names one row, for history. Absent for tables that history does not record. */
  key?: string;
  /** Extra statements (indexes) created after the table. */
  indexes?: string[];
}

export const TABLES: readonly TableDef[] = [
  {
    name: 'meta',
    meaning: 'Settings. db_id names this database (a restored backup gets a new one), revision counts committed transactions.',
    columns: [
      { name: 'key', sql: 'TEXT PRIMARY KEY', meaning: 'Setting name: workspace (marker), db_id, revision, trailing_newline, eol, created_at, export_revision, export_hash, import_record.' },
      { name: 'value', sql: 'TEXT NOT NULL', meaning: 'Setting value, as text.' },
    ],
  },
  {
    name: 'blocks',
    meaning: 'The plan document as ordered blocks: headings, prose and items (checkpoint, step, decision). Every line of PLAN.md belongs to exactly one block. Read it in order of ord.',
    key: 'id',
    columns: [
      { name: 'id', sql: 'TEXT PRIMARY KEY', meaning: 'Stable id: a kind letter and 5 base-32 characters (c checkpoint, s step, d decision, h heading, p prose). Never changes, never reused.' },
      { name: 'kind', sql: "TEXT NOT NULL CHECK (kind IN ('heading','prose','checkpoint','step','decision'))", meaning: 'What it is.' },
      { name: 'parent_id', sql: 'TEXT REFERENCES blocks(id)', meaning: 'The item this one is nested under; NULL for headings, prose and top-level items.' },
      { name: 'ord', sql: 'INTEGER NOT NULL', meaning: 'Place in the document: smaller comes first. Gaps are normal; only compare them.' },
      { name: 'text', sql: 'TEXT NOT NULL', meaning: 'Verbatim markdown. An item: its own line ("  - [ ] words", no id comment). A heading: its line. Prose: its lines.' },
      { name: 'name', sql: 'TEXT', meaning: 'The readable words of an item or heading (a decision without "Decide:", a checkpoint without bold). NULL for prose.' },
      { name: 'detail', sql: "TEXT NOT NULL DEFAULT ''", meaning: 'The verbatim lines under an item: Suggested:, If no answer:, Answer:, Check:, Outcome: and any notes.' },
      { name: 'done', sql: 'INTEGER NOT NULL DEFAULT 0', meaning: '1 = ticked: a step or checkpoint finished, a decision answered.' },
      { name: 'section_id', sql: 'TEXT', meaning: 'The heading this block sits under.', derived: true },
      { name: 'checkpoint_id', sql: 'TEXT', meaning: 'The checkpoint this item sits in, however deep; NULL outside the Checkpoints list.', derived: true },
      { name: 'rev', sql: 'INTEGER NOT NULL DEFAULT 1', meaning: 'This row\'s revision. Send it as "rev" in an op to be refused when the row moved on.' },
      { name: 'created_at', sql: 'TEXT NOT NULL', meaning: 'When it was made (ISO time).' },
      { name: 'created_by', sql: 'TEXT NOT NULL', meaning: 'Who made it: user, an AI tool name, import.' },
      { name: 'updated_at', sql: 'TEXT NOT NULL', meaning: 'When it last changed.' },
      { name: 'updated_by', sql: 'TEXT NOT NULL', meaning: 'Who changed it last.' },
    ],
    indexes: ['CREATE INDEX blocks_ord ON blocks(ord)', 'CREATE INDEX blocks_parent ON blocks(parent_id)'],
  },
  {
    name: 'decisions',
    meaning: 'The question side of a decision item, read out of its detail lines. Rebuilt on every change; change the detail, not this table.',
    key: 'item_id',
    columns: [
      { name: 'item_id', sql: 'TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE', meaning: 'The decision block.' },
      { name: 'suggested', sql: "TEXT NOT NULL DEFAULT '[]'", meaning: 'JSON list of the answers the AI suggests (the Suggested: line).' },
      { name: 'if_no_answer', sql: 'TEXT', meaning: 'What the AI does when nobody answers (the If no answer: line).' },
      { name: 'answer', sql: 'TEXT', meaning: 'The answer (the Answer: line), once there is one.' },
    ],
  },
  {
    name: 'decision_meta',
    meaning: 'Who answered a decision and when. The text cannot say it, so it lives here.',
    key: 'item_id',
    columns: [
      { name: 'item_id', sql: 'TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE', meaning: 'The decision block.' },
      { name: 'answered_by', sql: 'TEXT NOT NULL', meaning: 'Who gave the answer.' },
      { name: 'answered_at', sql: 'TEXT NOT NULL', meaning: 'When.' },
    ],
  },
  {
    name: 'checks',
    meaning: "A checkpoint's proof, read out of its Check: and Outcome: lines. Rebuilt on every change; change the detail, not this table.",
    key: 'item_id',
    columns: [
      { name: 'item_id', sql: 'TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE', meaning: 'The checkpoint block.' },
      { name: 'kind', sql: "TEXT NOT NULL CHECK (kind IN ('none','workspace','command'))", meaning: 'none = no Check: line; workspace = "the workspace checks"; command = a shell command.' },
      { name: 'command', sql: 'TEXT', meaning: 'The command, for kind command.' },
      { name: 'outcome', sql: 'TEXT', meaning: 'The Outcome: line, as authored.' },
    ],
  },
  {
    name: 'check_runs',
    meaning: 'Every run of a checkpoint check. A row is written before the check runs; a checkpoint with a check can only be ticked while a passing run matches its current rev and check.',
    columns: [
      { name: 'id', sql: 'INTEGER PRIMARY KEY AUTOINCREMENT', meaning: 'Run number.' },
      { name: 'item_id', sql: 'TEXT NOT NULL', meaning: 'The checkpoint that was checked.' },
      { name: 'item_rev', sql: 'INTEGER NOT NULL', meaning: 'The checkpoint\'s rev when the run started. Only a run at the checkpoint\'s current rev counts.' },
      { name: 'content_hash', sql: 'TEXT NOT NULL', meaning: 'Hash of the checkpoint\'s words and detail (not its checkbox) when the run started: a run proves that content and no other.' },
      { name: 'db_id', sql: 'TEXT NOT NULL', meaning: 'The database this run belongs to (a restored backup changes it).' },
      { name: 'check_kind', sql: "TEXT NOT NULL CHECK (check_kind IN ('workspace','command'))", meaning: 'The check that was run: workspace or command.' },
      { name: 'command', sql: 'TEXT', meaning: 'The command, for check_kind command.' },
      { name: 'status', sql: "TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed','error'))", meaning: 'running until finished; passed means exit code 0.' },
      { name: 'exit_code', sql: 'INTEGER', meaning: 'The exit code, once finished.' },
      { name: 'sha', sql: 'TEXT', meaning: 'The commit the check ran on, when known.' },
      { name: 'started_at', sql: 'TEXT NOT NULL', meaning: 'When the run started.' },
      { name: 'finished_at', sql: 'TEXT', meaning: 'When it finished.' },
      { name: 'by', sql: 'TEXT NOT NULL', meaning: 'Who started it.' },
      { name: 'legacy', sql: 'INTEGER NOT NULL DEFAULT 0', meaning: '1 = imported from the old planChecks: evidence only, it never lets a checkpoint be ticked.' },
    ],
    indexes: ['CREATE INDEX check_runs_item ON check_runs(item_id, id)'],
  },
  {
    name: 'cards',
    meaning: 'A note or a file shown on the Board.',
    key: 'id',
    columns: [
      { name: 'id', sql: 'TEXT PRIMARY KEY', meaning: 'Card id: k and 5 base-32 characters.' },
      { name: 'legacy_id', sql: 'TEXT UNIQUE', meaning: 'The old uuid of a card made before ids were short. Old links and positions still resolve through it.' },
      { name: 'kind', sql: "TEXT NOT NULL CHECK (kind IN ('note','file'))", meaning: 'note has a body; file has a path.' },
      { name: 'title', sql: 'TEXT NOT NULL', meaning: 'The card title (200 characters at most).' },
      { name: 'body', sql: 'TEXT', meaning: 'The note text, markdown (4000 characters at most).' },
      { name: 'path', sql: 'TEXT', meaning: 'For a file card: the file inside the workspace, relative, with "/".' },
      { name: 'description', sql: 'TEXT', meaning: 'For a file card: one line on what the file shows.' },
      { name: 'area', sql: 'TEXT', meaning: "Where it sits on the Board: 'checkpoint:<checkpoint id>' or 'plan:own'; NULL = not placed." },
      { name: 'step_id', sql: 'TEXT REFERENCES blocks(id) ON DELETE SET NULL', meaning: 'The plan item it is about. A hint kept apart from area; NULL when none or when the item was removed.' },
      { name: 'about', sql: 'TEXT', meaning: 'A commit node this note is attached to, such as commit:NexusFlow:96ca286.' },
      { name: 'look', sql: 'TEXT', meaning: 'One line on why a person should look at this card now (140 characters at most).' },
      { name: 'look_at', sql: 'TEXT', meaning: 'When look was set.' },
      { name: 'pinned', sql: 'INTEGER NOT NULL DEFAULT 0', meaning: '1 = pinned.' },
      { name: 'archived', sql: 'INTEGER NOT NULL DEFAULT 0', meaning: '1 = archived, hidden.' },
      { name: 'by', sql: 'TEXT NOT NULL', meaning: 'Who made it.' },
      { name: 'at', sql: 'TEXT NOT NULL', meaning: 'When it was made.' },
      { name: 'updated_by', sql: 'TEXT NOT NULL', meaning: 'Who changed it last.' },
      { name: 'updated_at', sql: 'TEXT NOT NULL', meaning: 'When it last changed.' },
      { name: 'rev', sql: 'INTEGER NOT NULL DEFAULT 1', meaning: 'This row\'s revision. Send it as "rev" in an op to be refused when the card moved on.' },
    ],
    indexes: ['CREATE INDEX cards_step ON cards(step_id)', 'CREATE INDEX cards_area ON cards(area)'],
  },
  {
    name: 'links',
    meaning: 'A line between two nodes on the Board. A node is a card id, checkpoint:<id>, document:<uuid> or commit:<repo>:<sha>.',
    key: 'id',
    columns: [
      { name: 'id', sql: 'TEXT PRIMARY KEY', meaning: 'Link id (a uuid).' },
      { name: 'from_node', sql: 'TEXT NOT NULL', meaning: 'The node it starts at.' },
      { name: 'to_node', sql: 'TEXT NOT NULL', meaning: 'The node it ends at.' },
      { name: 'label', sql: 'TEXT', meaning: 'Optional words on the line (200 characters at most).' },
      { name: 'by', sql: 'TEXT NOT NULL', meaning: 'Who drew it.' },
      { name: 'at', sql: 'TEXT NOT NULL', meaning: 'When.' },
    ],
    indexes: ['CREATE UNIQUE INDEX links_pair ON links(from_node, to_node)'],
  },
  {
    name: 'positions',
    meaning: 'Where a node was moved to on the Board. Last move wins.',
    key: 'node_id',
    columns: [
      { name: 'node_id', sql: 'TEXT PRIMARY KEY', meaning: 'The node (a card id, checkpoint:<id>, ...).' },
      { name: 'x', sql: 'REAL NOT NULL', meaning: 'Horizontal place.' },
      { name: 'y', sql: 'REAL NOT NULL', meaning: 'Vertical place.' },
    ],
  },
  {
    name: 'now',
    meaning: 'The plan item someone said they are working on (at most one row).',
    key: 'id',
    columns: [
      { name: 'id', sql: 'INTEGER PRIMARY KEY CHECK (id = 1)', meaning: 'Always 1.' },
      { name: 'item_id', sql: 'TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE', meaning: 'The plan item.' },
      { name: 'by', sql: 'TEXT NOT NULL', meaning: 'Who said so.' },
      { name: 'at', sql: 'TEXT NOT NULL', meaning: 'When.' },
    ],
  },
  {
    name: 'seen',
    meaning: 'Per reader: what they have seen, and the News list waiting for them.',
    columns: [
      { name: 'reader', sql: 'TEXT PRIMARY KEY', meaning: 'Who reads: user or an AI tool name.' },
      { name: 'at', sql: 'TEXT NOT NULL', meaning: 'When they last looked.' },
      { name: 'seen', sql: "TEXT NOT NULL DEFAULT '{}'", meaning: 'JSON: what they have seen.' },
      { name: 'pending', sql: "TEXT NOT NULL DEFAULT '[]'", meaning: 'JSON: what is waiting for them.' },
    ],
  },
  {
    name: 'changes',
    meaning: 'One row per transaction: who, what, and each changed row before and after (what Undo uses).',
    columns: [
      { name: 'seq', sql: 'INTEGER PRIMARY KEY AUTOINCREMENT', meaning: 'Order of changes.' },
      { name: 'revision', sql: 'INTEGER NOT NULL UNIQUE', meaning: 'The workspace revision this transaction produced.' },
      { name: 'kind', sql: "TEXT NOT NULL DEFAULT 'batch' CHECK (kind IN ('batch','undo','import','restore','legacy'))", meaning: 'batch = an apply; undo; import = the first load; restore = a restored backup; legacy = an old history entry kept as a summary.' },
      { name: 'request_id', sql: 'TEXT', meaning: 'The requestId the caller gave, if any.' },
      { name: 'at', sql: 'TEXT NOT NULL', meaning: 'When (ISO time).' },
      { name: 'by', sql: 'TEXT NOT NULL', meaning: 'Who: user, an AI tool name, import.' },
      { name: 'summary', sql: 'TEXT NOT NULL', meaning: 'One line saying what changed.' },
      { name: 'rows', sql: 'TEXT', meaning: 'JSON [{table,id,before,after}] for every changed row. NULL for a summary-only entry, which cannot be undone.' },
      { name: 'undoes', sql: 'INTEGER', meaning: 'For an undo: the seq of the change it reversed.' },
      { name: 'undone_by', sql: 'INTEGER', meaning: 'The seq of the undo that reversed this change.' },
    ],
    indexes: ['CREATE INDEX changes_at ON changes(at)'],
  },
  {
    name: 'requests',
    meaning: 'Request ids already applied (kept 7 days), so a retried batch returns its first result instead of applying twice.',
    columns: [
      { name: 'request_id', sql: 'TEXT PRIMARY KEY', meaning: 'The id the caller chose.' },
      { name: 'payload_hash', sql: 'TEXT NOT NULL', meaning: 'Hash of the batch, to refuse a reused id with other ops.' },
      { name: 'result', sql: 'TEXT NOT NULL', meaning: 'JSON of the first result.' },
      { name: 'revision', sql: 'INTEGER NOT NULL', meaning: 'The revision that batch produced.' },
      { name: 'at', sql: 'TEXT NOT NULL', meaning: 'When.' },
    ],
  },
  {
    name: 'exports',
    meaning: 'Every PLAN.md and snapshot export written (the last 5 per file): the base a hand edit is merged against.',
    columns: [
      { name: 'file', sql: 'TEXT NOT NULL', meaning: 'File name, such as PLAN.md.' },
      { name: 'revision', sql: 'INTEGER NOT NULL', meaning: 'The workspace revision that was exported.' },
      { name: 'db_id', sql: 'TEXT NOT NULL', meaning: 'The database identity, as in the file header.' },
      { name: 'digest', sql: 'TEXT NOT NULL', meaning: 'Hash of the export text without its header line.' },
      { name: 'text', sql: 'TEXT NOT NULL', meaning: 'The published text including its header.' },
    ],
    indexes: ['CREATE UNIQUE INDEX exports_key ON exports(file, db_id, revision, digest)', 'CREATE INDEX exports_digest ON exports(file, digest)'],
  },
  {
    name: 'drafts',
    meaning: 'File content that was not a known export (a hand edit, a stale save): kept until imported or discarded.',
    columns: [
      { name: 'digest', sql: 'TEXT PRIMARY KEY', meaning: 'SHA-256 of all the original draft bytes.' },
      { name: 'file', sql: 'TEXT NOT NULL', meaning: 'The file it came from.' },
      { name: 'path', sql: 'TEXT NOT NULL', meaning: 'Where the copy is kept.' },
      { name: 'at', sql: 'TEXT NOT NULL', meaning: 'When it was noticed.' },
      { name: 'by', sql: 'TEXT', meaning: 'Who saved it, when known.' },
      { name: 'base_revision', sql: 'INTEGER', meaning: 'The revision its header names, if it has one.' },
      { name: 'status', sql: "TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','imported','discarded'))", meaning: 'pending until imported or discarded.' },
    ],
  },
  {
    name: 'ids_used',
    meaning: 'Every id ever issued, so an id is never reused, even after its row is removed or a backup is restored.',
    columns: [{ name: 'id', sql: 'TEXT PRIMARY KEY', meaning: 'The id.' }],
  },
] as const;

export function tableDef(name: string): TableDef {
  const table = TABLES.find((t) => t.name === name);
  if (!table) throw new Error(`Unknown table ${name}`);
  return table;
}

/** The CREATE statements for a fresh database, in an order that foreign keys allow. */
export function createStatements(): string[] {
  const out: string[] = [];
  for (const table of TABLES) {
    out.push(`CREATE TABLE ${table.name} (\n  ${table.columns.map((c) => `${c.name} ${c.sql}`).join(',\n  ')}\n)`);
    out.push(...(table.indexes ?? []));
  }
  return out;
}

/** The columns history records for a table: all of them, derived ones included, so a cascade's section changes are on record. */
export function snapshotColumns(table: string): string[] {
  return tableDef(table).columns.map((c) => c.name);
}

/** The columns that say whether a row was really changed: everything except the derived ones. */
export function identityColumns(table: string): string[] {
  return tableDef(table).columns.filter((c) => !c.derived).map((c) => c.name);
}

/** True when two recorded rows are the same apart from derived columns. */
export function sameIdentity(table: string, a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  if (a === null || b === null) return a === b;
  return identityColumns(table).every((c) => a[c] === b[c]);
}

/** What `ctxspace plan schema` prints: each table, then each column with its meaning. */
export function schemaText(): string {
  const lines: string[] = [];
  for (const table of TABLES) {
    lines.push(`${table.name}: ${table.meaning}`);
    for (const column of table.columns) {
      const type = column.sql.split(' ')[0];
      lines.push(`  ${column.name} ${type}${column.derived ? ' (derived)' : ''} - ${column.meaning}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Every place one row names another, so "what depends on this row" is read from here and not worked out case by case.
 * `form` says how the name is written: `id` (the column holds the id), or `checkpoint` (`checkpoint:<id>`, optionally with a `#n` copy suffix).
 */
export interface Reference { table: string; key: string; column: string; target: string; form: 'id' | 'checkpoint' }

export const REFERENCES: readonly Reference[] = [
  { table: 'blocks', key: 'id', column: 'parent_id', target: 'blocks', form: 'id' },
  { table: 'cards', key: 'id', column: 'step_id', target: 'blocks', form: 'id' },
  { table: 'cards', key: 'id', column: 'area', target: 'blocks', form: 'checkpoint' },
  { table: 'links', key: 'id', column: 'from_node', target: 'cards', form: 'id' },
  { table: 'links', key: 'id', column: 'to_node', target: 'cards', form: 'id' },
  { table: 'links', key: 'id', column: 'from_node', target: 'blocks', form: 'checkpoint' },
  { table: 'links', key: 'id', column: 'to_node', target: 'blocks', form: 'checkpoint' },
  { table: 'positions', key: 'node_id', column: 'node_id', target: 'cards', form: 'id' },
  { table: 'positions', key: 'node_id', column: 'node_id', target: 'blocks', form: 'checkpoint' },
  { table: 'now', key: 'id', column: 'item_id', target: 'blocks', form: 'id' },
  { table: 'decisions', key: 'item_id', column: 'item_id', target: 'blocks', form: 'id' },
  { table: 'decision_meta', key: 'item_id', column: 'item_id', target: 'blocks', form: 'id' },
  { table: 'checks', key: 'item_id', column: 'item_id', target: 'blocks', form: 'id' },
  { table: 'check_runs', key: 'id', column: 'item_id', target: 'blocks', form: 'id' },
];
