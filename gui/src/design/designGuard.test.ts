import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The design style ratchet (see ./README.md, "The guard").
 *
 * It scans production `src/**\/*.ts` and `*.tsx` (not tests or `.d.ts`) for four
 * kinds of hand-built styling that the design module is meant to replace, counts
 * them per token and per folder, and compares the counts with `design-baseline.json`:
 *   - tiny:    text below 12 px (`text-[10px]`, `text-[length:10px]`, `text-[0.7rem]`,
 *              `fontSize: 10`, `fontSize: '11px'`, `font-size: 0.7rem`)
 *   - palette: raw Tailwind palette colours (`text-violet-600`, `bg-red-500/10`)
 *   - hex:     hex colour values (`#D97757`)
 *   - arbitrary: `rounded-[...]` and `shadow-[...]` values
 *
 * A new token or a bigger total fails. A smaller total passes and prints a hint
 * to lower the baseline. To rewrite the baseline after lowering the numbers:
 *   UPDATE_DESIGN_BASELINE=1 npx vitest run gui/src/design/designGuard.test.ts
 * An update refuses any new token, any token that grew and a bigger total. The one
 * time a baseline may grow is when the scanner itself changed: bump SCANNER_VERSION
 * in the same change, so the new rules show up in review. The update then accepts
 * the first write for the new version.
 */

/** Bump when the detection rules or the scanned files change (a reviewed event). */
export const SCANNER_VERSION = 2;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'design-baseline.json');

/**
 * Named content exceptions. Each one exempts only findings of the listed kinds on lines
 * that match `line`, never a whole file, so an ordinary label next to it still counts.
 * Every exception needs a reason and must still match something (a test checks both).
 */
export type Exception = { file: string; kinds: Kind[]; line: RegExp; reason: string };
export const EXCEPTIONS: Exception[] = [
  {
    file: 'app/ThemeProvider.tsx',
    kinds: ['palette'],
    line: /dotClass:/,
    reason: 'The palette picker draws each palette as a swatch of its own colours; those colours are the data.',
  },
  {
    file: 'pages/SkillsPage.tsx',
    kinds: ['hex'],
    line: /\bvalue:\s*'#/,
    reason: 'The skill colour choices people pick from are literal hex values stored with the skill.',
  },
  {
    file: 'features/terminal/TerminalPane.tsx',
    kinds: ['hex'],
    line: /theme:\s*\{|bg-\[#111b18\]/,
    reason: 'The terminal has its own fixed dark theme (xterm colours) and its backing surface; they do not follow the app palette.',
  },
];

const PALETTES =
  '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)';
const UTILITIES =
  '(?:text|bg|border|border-[xytblrse]|ring|ring-offset|fill|stroke|from|to|via|divide|outline|decoration|shadow|accent|caret)';

type Kind = 'tiny' | 'palette' | 'hex' | 'arbitrary';


const isBelowFloor = (value: string, unit: string) => (unit === 'px' ? Number(value) < 12 : Number(value) < 0.75);

/** A complete JS numeric literal: decimal with `_`, exponent, or 0x / 0b / 0o. */
const NUMBER = '0[xX][\\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\\d[\\d_]*\\.?[\\d_]*|\\.\\d[\\d_]*)(?:[eE][+-]?\\d+)?';

const PATTERNS: { kind: Kind; re: RegExp; keep?: (m: RegExpMatchArray) => boolean }[] = [
  {
    kind: 'tiny',
    re: /(?<![\w-])text-\[(?:length:)?(\d*\.?\d+)(px|rem|em)\]/g,
    keep: (m) => isBelowFloor(m[1]!, m[2]!),
  },
  {
    // fontSize: 10 (React px), 'fontSize': (10), fontSize: 1e1, fontSize: '11px', fontSize: ("0.7rem").
    // The numeric literal must be complete (1_6 is 16, not 1) and end the value.
    kind: 'tiny',
    re: new RegExp(
      `(?<![\\w-])['"\`]?fontSize['"\`]?\\s*:\\s*\\(*\\s*(?:(${NUMBER})(?=\\s*\\)*\\s*(?:[,}\\n\\r;]|$))|['"\`](\\d*\\.?\\d+)(px|rem|em)['"\`])`,
      'g',
    ),
    keep: (m) => (m[1] !== undefined ? Number(m[1].replace(/_/g, '')) < 12 : isBelowFloor(m[2]!, m[3]!)),
  },
  {
    // CSS written as text: font-size: 10px
    kind: 'tiny',
    re: /(?<![\w-])font-size\s*:\s*(\d*\.?\d+)(px|rem|em)/g,
    keep: (m) => isBelowFloor(m[1]!, m[2]!),
  },
  { kind: 'palette', re: new RegExp(`(?<![\\w-])${UTILITIES}-${PALETTES}-\\d{2,3}(?![\\w-])`, 'g') },
  { kind: 'hex', re: /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g },
  { kind: 'arbitrary', re: /(?<![\w-])(?:rounded|shadow)(?:-[a-z]+)?-\[[^\]\s]+\]/g },
];

export type Counts = {
  scanner: number;
  total: number;
  byKind: Record<string, number>;
  byToken: Record<string, number>;
  byFolder: Record<string, number>;
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** `features/board/cards/X.tsx` -> `features/board`; `pages/X.tsx` -> `pages`. */
export function folderOf(rel: string): string {
  const parts = rel.split('/');
  parts.pop();
  const depth = parts[0] === 'features' || parts[0] === 'components' ? 2 : 1;
  return parts.slice(0, depth).join('/') || '.';
}

export type Finding = { kind: Kind; token: string; line: string };

export function scanText(text: string): Finding[] {
  const found: Finding[] = [];
  for (const { kind, re, keep } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (keep && !keep(m)) continue;
      const at = m.index ?? 0;
      const start = text.lastIndexOf('\n', at) + 1;
      const end = text.indexOf('\n', at);
      // fontSize tokens are normalised so `fontSize: 10` and `fontSize:10` are one token.
      const token = kind === 'tiny' && /^['"`]?fontSize/.test(m[0]) ? m[0].replace(/\s+/g, ' ') : m[0];
      found.push({ kind, token, line: text.slice(start, end < 0 ? undefined : end) });
    }
  }
  return found;
}

export function isExempt(rel: string, finding: Finding): Exception | undefined {
  return EXCEPTIONS.find((ex) => ex.file === rel && ex.kinds.includes(finding.kind) && ex.line.test(finding.line));
}

export function scanSources(srcRoot = SRC): { counts: Counts; exemptHits: Map<Exception, number> } {
  const counts: Counts = { scanner: SCANNER_VERSION, total: 0, byKind: {}, byToken: {}, byFolder: {} };
  const exemptHits = new Map<Exception, number>();
  const bump = (bag: Record<string, number>, key: string) => {
    bag[key] = (bag[key] ?? 0) + 1;
  };
  for (const file of sourceFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    for (const finding of scanText(fs.readFileSync(file, 'utf8'))) {
      const ex = isExempt(rel, finding);
      if (ex) {
        exemptHits.set(ex, (exemptHits.get(ex) ?? 0) + 1);
        continue;
      }
      counts.total += 1;
      bump(counts.byKind, finding.kind);
      bump(counts.byToken, `${finding.kind}: ${finding.token}`);
      bump(counts.byFolder, folderOf(rel));
    }
  }
  const sorted = (bag: Record<string, number>) =>
    Object.fromEntries(Object.entries(bag).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  counts.byKind = sorted(counts.byKind);
  counts.byToken = sorted(counts.byToken);
  counts.byFolder = sorted(counts.byFolder);
  return { counts, exemptHits };
}

export type Verdict = { failures: string[]; hints: string[]; moves: string[] };

/** Growth of any token, a new token or a bigger total is a failure; used by the check AND by baseline updates. */
export function growth(now: Counts, baseline: Counts): string[] {
  const failures: string[] = [];
  for (const [token, n] of Object.entries(now.byToken)) {
    const was = baseline.byToken[token];
    if (was === undefined) failures.push(`new token ${token} (${n}x): use a design/index piece or a token instead`);
    else if (n > was) failures.push(`${token} went up: ${was} -> ${n}`);
  }
  if (now.total > baseline.total) failures.push(`total went up: ${baseline.total} -> ${now.total}`);
  return failures;
}

export function compare(now: Counts, baseline: Counts): Verdict {
  const hints: string[] = [];
  const moves: string[] = [];
  const failures = growth(now, baseline);
  if (now.total < baseline.total) hints.push(`total is down ${baseline.total} -> ${now.total}: lower the baseline (UPDATE_DESIGN_BASELINE=1)`);
  else if (Object.entries(baseline.byToken).some(([t, n]) => (now.byToken[t] ?? 0) < n)) {
    hints.push('some tokens went down while others went up or stayed: check the split below');
  }
  for (const folder of new Set([...Object.keys(now.byFolder), ...Object.keys(baseline.byFolder)])) {
    const a = baseline.byFolder[folder] ?? 0;
    const b = now.byFolder[folder] ?? 0;
    if (a !== b) moves.push(`${folder}: ${a} -> ${b}`);
  }
  return { failures, hints, moves };
}

/**
 * What stops a baseline rewrite. Growth is refused, unless the scanner version changed
 * (then the whole baseline is re-taken once, and the version bump is what a reviewer sees).
 */
export function updateRefusals(now: Counts, baseline: Counts): string[] {
  if (baseline.scanner !== now.scanner) return [];
  return growth(now, baseline);
}

describe('design guard (style ratchet)', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as Counts;
  const base = (byToken: Record<string, number>): Counts => {
    const total = Object.values(byToken).reduce((a, b) => a + b, 0);
    return { scanner: SCANNER_VERSION, total, byKind: {}, byToken, byFolder: {} };
  };

  it('keeps each exception narrow, reasoned and alive', () => {
    const { exemptHits } = scanSources();
    for (const ex of EXCEPTIONS) {
      expect(fs.existsSync(path.join(SRC, ex.file)), `exception ${ex.file} no longer exists: remove it`).toBe(true);
      expect(ex.reason.length, `exception ${ex.file} needs a reason`).toBeGreaterThan(20);
      expect(exemptHits.get(ex) ?? 0, `exception ${ex.file} ${ex.line} matches nothing any more: remove it`).toBeGreaterThan(0);
      expect(ex.kinds.includes('tiny'), 'text size is never excepted').toBe(false);
    }
  });

  it('exempts only the literals, not the file around them', () => {
    const ex = (file: string, text: string) => scanText(text).map((f) => isExempt(file, f) !== undefined);
    expect(ex('pages/SkillsPage.tsx', "{ label: 'Blue', value: '#3b82f6' },")).toEqual([true]);
    expect(ex('pages/SkillsPage.tsx', '<span className="text-[10px] bg-red-500 rounded-[3px]">x</span>')).toEqual([false, false, false]);
    expect(ex('pages/SkillsPage.tsx', "<i className=\"bg-[#abcdef]\" />")).toEqual([false]);
    expect(ex('app/ThemeProvider.tsx', "dotClass: 'bg-gradient-to-r from-amber-400 to-rose-500',")).toEqual([true, true]);
    expect(ex('app/ThemeProvider.tsx', '<b className="text-red-600 text-[9px]" />')).toEqual([false, false]);
    expect(ex('features/terminal/TerminalPane.tsx', "theme: { background: '#111b18' },")).toEqual([true]);
    expect(ex('features/terminal/TerminalPane.tsx', "'bg-emerald-500'")).toEqual([false]);
  });

  it('counts the four kinds the way the README says', () => {
    const kinds = (text: string) => scanText(text).map((f) => `${f.kind}:${f.token}`);
    expect(kinds('className="text-[10px] text-[11.5px] text-[12px] text-[0.7rem] text-[0.8rem]"')).toEqual([
      'tiny:text-[10px]',
      'tiny:text-[11.5px]',
      'tiny:text-[0.7rem]',
    ]);
    expect(kinds('text-violet-600 dark:bg-red-500/10 border-slate-200 text-primary bg-card')).toEqual([
      'palette:text-violet-600',
      'palette:bg-red-500',
      'palette:border-slate-200',
    ]);
    expect(kinds("color: '#D97757', bg-[#fff] href=\"#/design\" &#39;")).toEqual(['hex:#D97757', 'hex:#fff']);
    expect(kinds('rounded-[10px] shadow-[0_1px_2px_#000] rounded-lg shadow-xs')).toEqual([
      'arbitrary:rounded-[10px]',
      'arbitrary:shadow-[0_1px_2px_#000]',
    ]);
  });

  it('counts inline and length-typed small text', () => {
    const kinds = (text: string) => scanText(text).map((f) => `${f.kind}:${f.token}`);
    expect(kinds('style={{ fontSize: 10 }}')).toEqual(['tiny:fontSize: 10']);
    expect(kinds("style={{ fontSize:'11px' }}")).toEqual(["tiny:fontSize:'11px'"]);
    expect(kinds('style={{ fontSize: "0.7rem" }}')).toEqual(['tiny:fontSize: "0.7rem"']);
    expect(kinds('style={{ fontSize: 11.5 }}')).toEqual(['tiny:fontSize: 11.5']);
    expect(kinds('className="text-[length:10px]"')).toEqual(['tiny:text-[length:10px]']);
    expect(kinds('css = "font-size: 10px; color: red"')).toEqual(['tiny:font-size: 10px']);
    // at or above the floor, or not a literal size: not counted
    // escapes found in review 2: quoted keys, parentheses, exponent, underscore, other radixes
    expect(kinds("style={{ 'fontSize': 10 }}")).toEqual(["tiny:'fontSize': 10"]);
    expect(kinds('style={{ "fontSize": 10 }}')).toEqual(['tiny:"fontSize": 10']);
    expect(kinds('style={{ fontSize: (10) }}')).toEqual(['tiny:fontSize: (10']);
    expect(kinds('style={{ fontSize: ((10)) }}')).toEqual(['tiny:fontSize: ((10']);
    expect(kinds("style={{ fontSize: ('11px') }}")).toEqual(["tiny:fontSize: ('11px'"]);
    expect(kinds('style={{ fontSize: 1e1 }}')).toEqual(['tiny:fontSize: 1e1']);
    expect(kinds('style={{ fontSize: 1_0 }}')).toEqual(['tiny:fontSize: 1_0']);
    expect(kinds('style={{ fontSize: 0xA }}')).toEqual(['tiny:fontSize: 0xA']);
    expect(kinds('style={{ fontSize: 0b101 }}')).toEqual(['tiny:fontSize: 0b101']);
    expect(kinds('style={{ fontSize: .5e1 }}')).toEqual(['tiny:fontSize: .5e1']);
    expect(kinds('const s = { fontSize: 9 }')).toEqual(['tiny:fontSize: 9']);
    // valid sizes and non-literals: not counted
    expect(
      kinds(
        "fontSize: 12, fontSize: 13, fontSize: '12px', fontSize: '0.75rem', fontSize: size, fontSize, fontSize: 1_6, fontSize: (14), 'fontSize': 12, fontSize: 1.2e1, fontSize: 0xC, fontSize: 10 + 2, fontSize: size * 2",
      ),
    ).toEqual([]);
    expect(kinds('text-[length:12px] text-[length:var(--x)] font-size: 1rem')).toEqual([]);
  });

  it('scans production .ts files but not tests or declarations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-guard-'));
    try {
      fs.mkdirSync(path.join(root, 'features/board'), { recursive: true });
      fs.writeFileSync(path.join(root, 'features/board/helper.ts'), "export const c = 'text-[10px] bg-violet-500/20';\n");
      fs.writeFileSync(path.join(root, 'features/board/helper.test.ts'), "export const c = 'text-[10px]';\n");
      fs.writeFileSync(path.join(root, 'features/board/types.d.ts'), "export const c = 'text-[10px]';\n");
      const { counts } = scanSources(root);
      expect(counts.byToken).toEqual({ 'tiny: text-[10px]': 1, 'palette: bg-violet-500': 1 });
      expect(counts.byFolder).toEqual({ 'features/board': 2 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a baseline update that grows a token, adds one or raises the total', () => {
    const was = base({ 'tiny: text-[11px]': 7, 'tiny: text-[10px]': 3 });
    // same total, one token grew (the review's text-[11px] -> text-[8px] swap)
    expect(updateRefusals(base({ 'tiny: text-[11px]': 6, 'tiny: text-[10px]': 3, 'tiny: text-[8px]': 1 }), was)).toEqual([
      'new token tiny: text-[8px] (1x): use a design/index piece or a token instead',
    ]);
    expect(updateRefusals(base({ 'tiny: text-[11px]': 7, 'tiny: text-[10px]': 3 }), was)).toEqual([]);
    expect(updateRefusals(base({ 'tiny: text-[11px]': 7, 'tiny: text-[10px]': 4 }), was)).toContain('tiny: text-[10px] went up: 3 -> 4');
    expect(updateRefusals(base({ 'tiny: text-[11px]': 5, 'tiny: text-[10px]': 3 }), was)).toEqual([]);
    // only a new scanner version may re-take the baseline
    expect(updateRefusals({ ...base({ 'tiny: text-[8px]': 9 }), scanner: SCANNER_VERSION }, { ...was, scanner: SCANNER_VERSION - 1 })).toEqual([]);
  });

  it('does not grow past design-baseline.json', () => {
    const { counts: now } = scanSources();
    if (process.env.UPDATE_DESIGN_BASELINE) {
      const refusals = updateRefusals(now, baseline);
      if (refusals.length) throw new Error(`refusing to write a bigger baseline:\n${refusals.join('\n')}`);
      fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    expect(baseline.scanner, 'the scanner changed: re-take the baseline with UPDATE_DESIGN_BASELINE=1').toBe(SCANNER_VERSION);
    const verdict = compare(now, baseline);
    const top = Object.entries(now.byFolder).slice(0, 10).map(([f, n]) => `${f} ${n}`).join(', ');
    console.log(`design guard: total ${now.total} (baseline ${baseline.total}); top folders: ${top}`);
    for (const hint of verdict.hints) console.log(`design guard hint: ${hint}`);
    if (verdict.moves.length) console.log(`design guard split changes: ${verdict.moves.join('; ')}`);
    expect(verdict.failures, verdict.failures.join('\n')).toEqual([]);
  });
});
