import { renderDiagramFrame } from './diagramFrame.js';
import { diagramResourceReason } from './diagramSafety.js';

/** Mermaid is loaded on the first drawing only. Its mutable parser/configuration is serialized here. */
export type DiagramTheme = 'light' | 'dark';
export type DiagramDrawing = { url: string; fontSize?: number } | { error: string } | null;
type RenderSvg = (source: string, theme: DiagramTheme, id: string) => Promise<string | null>;
let nextId = 0;

const DEFAULT_SVG_FONT_PX = 16;
const READABLE_TEXT_PX = 12;
const MAX_READER_UPSCALE = 1.5;

export type DiagramFullScreenState = 'none' | 'available' | 'fullscreen';

/** Reader hints offer full screen only when the host explicitly exposes that control and is not already full screen. */
export function diagramScrollHint(fullScreen: DiagramFullScreenState): string {
  if (fullScreen === 'available') return 'Wider than the reader: scroll sideways, or open full screen';
  if (fullScreen === 'fullscreen') return 'Wider than the reader: scroll sideways';
  return 'Wider than the space here: scroll sideways';
}

type FontSizeSpec = { unit: 'px' | 'rem' | 'em'; value: number };

function matchVarCall(raw: string): [string, string | undefined] | null {
  if (raw.length < 6 || raw.slice(0, 4).toLowerCase() !== 'var(') return null;
  let depth = 0;
  let quote: string | null = null;
  let commaAt = -1;
  for (let i = 3; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        if (i !== raw.length - 1) return null;
        if (commaAt < 0) return [raw.slice(4, i).trim(), undefined];
        return [raw.slice(4, commaAt).trim(), raw.slice(commaAt + 1, i).trim()];
      }
    } else if (ch === ',' && depth === 1 && commaAt < 0) {
      commaAt = i;
    }
  }
  return null;
}

function parseFontSizeSpec(
  raw: string | undefined | null,
  getVar?: (name: string) => string | undefined,
  seenVars = new Set<string>(),
): FontSizeSpec | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const varCall = matchVarCall(trimmed);
  if (varCall) {
    const [varName, fallback] = varCall;
    if (/^--[^\s(),]+$/.test(varName) && getVar && !seenVars.has(varName)) {
      const defined = getVar(varName);
      if (defined !== undefined) {
        const nextSeen = new Set(seenVars);
        nextSeen.add(varName);
        const resolved = parseFontSizeSpec(defined, getVar, nextSeen);
        if (resolved !== null) return resolved;
      }
    }
    return fallback !== undefined ? parseFontSizeSpec(fallback, getVar, seenVars) : null;
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?|\.\d+)\s*(px|pt|rem|em|%)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2]?.toLowerCase();
  if (unit === 'pt') return { unit: 'px', value: value * (4 / 3) };
  if (unit === 'rem') return { unit: 'rem', value };
  if (unit === 'em') return { unit: 'em', value };
  if (unit === '%') return { unit: 'em', value: value / 100 };
  return { unit: 'px', value };
}

function resolveFontSize(spec: FontSizeSpec, parentFontPx: number, rootFontPx: number): number {
  if (spec.unit === 'rem') return spec.value * rootFontPx;
  if (spec.unit === 'em') return spec.value * parentFontPx;
  return spec.value;
}

interface ParsedDecl {
  value: string;
  important: boolean;
}

interface DeclarationBlock {
  fontSize?: ParsedDecl;
  display?: string;
  visibility?: string;
  vars: Map<string, ParsedDecl>;
}

function splitCssDeclarations(style: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let paren = 0;
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      paren += 1;
    } else if (ch === ')') {
      paren = Math.max(0, paren - 1);
    } else if (ch === ';' && paren === 0) {
      result.push(style.slice(start, i));
      start = i + 1;
    }
  }
  result.push(style.slice(start));
  return result;
}

function parseDeclarations(style: string): DeclarationBlock {
  const block: DeclarationBlock = { vars: new Map() };
  let displayImportant = false;
  let visibilityImportant = false;
  for (const rawDecl of splitCssDeclarations(style)) {
    const trimmed = rawDecl.trim();
    if (!trimmed) continue;
    let colonIdx = -1;
    let quote: string | null = null;
    let paren = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(') {
        paren += 1;
      } else if (ch === ')') {
        paren = Math.max(0, paren - 1);
      } else if (ch === ':' && paren === 0) {
        colonIdx = i;
        break;
      }
    }
    if (colonIdx <= 0) continue;
    const rawProp = trimmed.slice(0, colonIdx).trim();
    const rawVal = trimmed.slice(colonIdx + 1).trim();
    const impMatch = rawVal.match(/!\s*important\s*$/i);
    const important = Boolean(impMatch);
    const value = impMatch ? rawVal.slice(0, impMatch.index).trim() : rawVal;
    if (rawProp.startsWith('--')) {
      const prev = block.vars.get(rawProp);
      if (!prev || important || !prev.important) block.vars.set(rawProp, { value, important });
      continue;
    }
    const prop = rawProp.toLowerCase();
    if (prop === 'font-size') {
      if (!block.fontSize || important || !block.fontSize.important) block.fontSize = { value, important };
    } else if (prop === 'display') {
      if (block.display === undefined || important || !displayImportant) {
        block.display = value.toLowerCase();
        displayImportant = important;
      }
    } else if (prop === 'visibility') {
      if (block.visibility === undefined || important || !visibilityImportant) {
        block.visibility = value.toLowerCase();
        visibilityImportant = important;
      }
    }
  }
  return block;
}

interface SelectorPart {
  combinator: ' ' | '>';
  tag?: string;
  id?: string;
  classes: string[];
}

interface StyleFontRule {
  parts: SelectorPart[];
  specificity: [number, number, number];
  order: number;
  fontSize?: ParsedDecl;
  vars?: Map<string, ParsedDecl>;
}

function parseSelectorChain(raw: string): { parts: SelectorPart[]; specificity: [number, number, number] } | null {
  const trimmed = raw.trim();
  if (!trimmed || /[:[\]*+~]/.test(trimmed)) return null;
  const tokens = trimmed.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
  const parts: SelectorPart[] = [];
  let combinator: ' ' | '>' = ' ';
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const token of tokens) {
    if (token === '>') {
      if (parts.length === 0 || combinator === '>') return null;
      combinator = '>';
      continue;
    }
    const part: SelectorPart = { combinator, classes: [] };
    let rest = token;
    const tagMatch = rest.match(/^[A-Za-z_][\w-]*/);
    if (tagMatch) {
      part.tag = tagMatch[0].toLowerCase();
      tags += 1;
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length > 0) {
      const sub = rest.match(/^([#.])([A-Za-z_][\w-]*)/);
      if (!sub) return null;
      if (sub[1] === '#') {
        part.id = sub[2];
        ids += 1;
      } else {
        part.classes.push(sub[2]!);
        classes += 1;
      }
      rest = rest.slice(sub[0].length);
    }
    if (!part.tag && !part.id && part.classes.length === 0) return null;
    parts.push(part);
    combinator = ' ';
  }
  if (parts.length === 0 || combinator === '>') return null;
  return { parts, specificity: [ids, classes, tags] };
}

function splitSelectors(selectorText: string): string[] {
  const result: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === ',' && paren === 0 && bracket === 0) {
      result.push(selectorText.slice(start, i));
      start = i + 1;
    }
  }
  result.push(selectorText.slice(start));
  return result;
}

const XML_ENTITIES: Record<string, string> = { gt: '>', lt: '<', amp: '&', quot: '"', apos: "'" };

function decodeStyleEntities(raw: string): string {
  return raw.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+|<(?!!\[CDATA\[))/g,
    (_, cdata: string | undefined, text: string | undefined) =>
      cdata !== undefined
        ? cdata
        : (text ?? '').replace(/&(gt|lt|amp|quot|apos);/g, (full, name: string) => XML_ENTITIES[name] ?? full),
  );
}

function decodeXmlEntities(raw: string): string {
  return raw.replace(/&(gt|lt|amp|quot|apos);/g, (full, name: string) => XML_ENTITIES[name] ?? full);
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]!.toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

function parseStyleRules(svg: string, svgId: string): { rootFontSize: number; rootVars: Map<string, string>; rules: StyleFontRule[] } {
  const rootVarDecls = new Map<string, ParsedDecl>();
  let rootFontDecl: ParsedDecl | undefined;
  const rules: StyleFontRule[] = [];
  let order = 0;
  for (const styleMatch of svg.matchAll(/<style\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/style>/gi)) {
    const css = decodeStyleEntities(styleMatch[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    let i = 0;
    let depth = 0;
    let quote: string | null = null;
    let selectorStart = 0;
    let bodyStart = 0;
    let selectorText = '';
    let skipAtRule = false;
    while (i < css.length) {
      const ch = css[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '{') {
        if (depth === 0) {
          selectorText = css.slice(selectorStart, i).trim();
          skipAtRule = selectorText.startsWith('@');
          bodyStart = i + 1;
        }
        depth += 1;
      } else if (ch === '}') {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0) {
            if (!skipAtRule) {
              const body = css.slice(bodyStart, i);
              const decls = parseDeclarations(body);
              if (decls.fontSize || decls.vars.size > 0) {
                for (const rawSel of splitSelectors(selectorText)) {
                  const sel = rawSel.trim();
                  if (!sel) continue;
                  if (/^:root$/i.test(sel)) {
                    for (const [name, entry] of decls.vars) {
                      const prev = rootVarDecls.get(name);
                      if (!prev || entry.important || !prev.important) rootVarDecls.set(name, entry);
                    }
                    if (decls.fontSize && (!rootFontDecl || decls.fontSize.important || !rootFontDecl.important)) {
                      rootFontDecl = decls.fontSize;
                    }
                    continue;
                  }
                  const normalizedSel = svgId && sel === `#${svgId} svg` ? 'svg' : sel;
                  const parsed = parseSelectorChain(normalizedSel);
                  if (parsed) {
                    rules.push({
                      ...parsed,
                      order: order++,
                      fontSize: decls.fontSize,
                      vars: decls.vars.size > 0 ? decls.vars : undefined,
                    });
                  }
                }
              }
            }
            selectorStart = i + 1;
          }
        }
      }
      i += 1;
    }
  }
  const rootVars = new Map<string, string>();
  for (const [name, entry] of rootVarDecls) rootVars.set(name, entry.value);
  const rootSpec = rootFontDecl ? parseFontSizeSpec(rootFontDecl.value, (name) => rootVars.get(name)) : null;
  const rootFontSize = rootSpec ? resolveFontSize(rootSpec, DEFAULT_SVG_FONT_PX, DEFAULT_SVG_FONT_PX) : DEFAULT_SVG_FONT_PX;
  return { rootFontSize, rootVars, rules };
}

interface SvgStackNode {
  tag: string;
  id: string;
  classes: string[];
  fontSize: number | null;
  vars: Map<string, string>;
  displayHidden: boolean;
  visibilityHidden: boolean;
  isSequenceNumber: boolean;
}

function matchesPart(part: SelectorPart, node: SvgStackNode): boolean {
  if (part.tag && part.tag !== node.tag) return false;
  if (part.id && part.id !== node.id) return false;
  for (const cls of part.classes) {
    if (!node.classes.includes(cls)) return false;
  }
  return true;
}

function matchesSelector(parts: SelectorPart[], stack: SvgStackNode[]): boolean {
  let stackIdx = stack.length - 1;
  if (stackIdx < 0 || !matchesPart(parts[parts.length - 1]!, stack[stackIdx]!)) return false;
  for (let partIdx = parts.length - 2; partIdx >= 0; partIdx--) {
    const childCombinator = parts[partIdx + 1]!.combinator;
    const part = parts[partIdx]!;
    if (childCombinator === '>') {
      stackIdx -= 1;
      if (stackIdx < 0 || !matchesPart(part, stack[stackIdx]!)) return false;
    } else {
      stackIdx -= 1;
      while (stackIdx >= 0 && !matchesPart(part, stack[stackIdx]!)) stackIdx -= 1;
      if (stackIdx < 0) return false;
    }
  }
  return true;
}

function compareRulePrecedence(a: StyleFontRule, b: StyleFontRule): number {
  for (let i = 0; i < 3; i++) {
    if (a.specificity[i]! !== b.specificity[i]!) return a.specificity[i]! - b.specificity[i]!;
  }
  return a.order - b.order;
}

/**
 * Reads the smallest rendered diagram label font size in CSS px, setting scale by the smallest meaningful label rather than the most common one.
 * Excluded intentionally:
 * - Sequence diagram `autonumber` step badge digits (`.sequenceNumber`, 12 px inside r=6 circles).
 * - Mermaid's unused CSS tooltip rules (e.g. `div.mermaidTooltip`) and non-matching or hidden rules/elements.
 */
export function diagramSvgFontSize(svg: string): number {
  const svgOpen = svg.match(/<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i);
  const svgId = svgOpen ? parseAttrs(svgOpen[1] ?? '').id ?? '' : '';
  const { rootFontSize, rootVars, rules } = parseStyleRules(svg, svgId);
  const stack: SvgStackNode[] = [];
  const ignoredTags = new Set(['style', 'defs', 'title', 'desc', 'marker', 'clippath', 'mask', 'pattern', 'symbol', 'metadata', 'script']);
  let ignoredDepth = 0;
  let minFont = Infinity;
  let sawText = false;
  let rootElementFont: number | null = null;

  const inheritedFont = (upto = stack.length - 1) => {
    for (let i = upto; i >= 0; i--) {
      if (stack[i]!.fontSize !== null) return stack[i]!.fontSize!;
    }
    return rootFontSize;
  };

  const recordTextIfVisible = (textChunk: string) => {
    if (ignoredDepth > 0 || !textChunk.trim() || stack.length === 0) return;
    const top = stack[stack.length - 1]!;
    if ((top.tag !== 'text' && top.tag !== 'tspan') || top.displayHidden || top.visibilityHidden || top.isSequenceNumber) return;
    const resolved = inheritedFont();
    sawText = true;
    if (resolved < minFont) minFont = resolved;
  };

  const tagRe = /<!--[\s\S]*?-->|<\/?([A-Za-z_:][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let lastIndex = 0;
  for (const m of svg.matchAll(tagRe)) {
    const index = m.index ?? 0;
    if (index > lastIndex) recordTextIfVisible(svg.slice(lastIndex, index));
    lastIndex = index + m[0].length;

    const full = m[0];
    if (full.startsWith('<!--')) continue;
    const isClosing = full.startsWith('</');
    const isSelfClosing = !isClosing && full.endsWith('/>');
    const tag = (m[1] ?? '').toLowerCase();

    if (isClosing) {
      if (ignoredTags.has(tag)) {
        ignoredDepth = Math.max(0, ignoredDepth - 1);
      } else if (ignoredDepth === 0) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]!.tag === tag) {
            stack.length = i;
            break;
          }
        }
      }
      continue;
    }

    if (ignoredTags.has(tag)) {
      if (!isSelfClosing) ignoredDepth += 1;
      continue;
    }
    if (ignoredDepth > 0 || isSelfClosing) continue;

    const attrs = parseAttrs(m[2] ?? '');
    const styleDecls = parseDeclarations(attrs.style ?? '');
    const parent = stack[stack.length - 1];
    const parentFont = inheritedFont();
    const parentVars = parent?.vars ?? rootVars;
    const classes = (attrs.class ?? '').split(/\s+/).filter(Boolean);
    const display = (styleDecls.display ?? attrs.display)?.trim().toLowerCase();
    const visibility = (styleDecls.visibility ?? attrs.visibility)?.trim().toLowerCase();
    const displayHidden = Boolean(parent?.displayHidden) || display === 'none';
    const visibilityHidden = visibility === 'hidden' ? true : visibility === 'visible' ? false : Boolean(parent?.visibilityHidden);
    // Mermaid sequenceDiagram autonumber draws 12px step numbers inside r=6 circles; scaling decisions follow label text instead.
    const isSequenceNumber = Boolean(parent?.isSequenceNumber) || classes.includes('sequenceNumber');
    const node: SvgStackNode = {
      tag,
      id: attrs.id ?? '',
      classes,
      fontSize: null,
      vars: parentVars,
      displayHidden,
      visibilityHidden,
      isSequenceNumber,
    };
    stack.push(node);

    const matched = rules.length > 0 ? rules.filter((rule) => matchesSelector(rule.parts, stack)) : [];
    if (matched.length > 1) matched.sort(compareRulePrecedence);

    // Resolve CSS custom properties inherited from ancestors + matched <style> rules + inline style.
    let nextVars: Map<string, string> | null = null;
    const importantVars = new Set<string>();
    for (const rule of matched) {
      if (!rule.vars) continue;
      for (const [name, entry] of rule.vars) {
        if (entry.important || !importantVars.has(name)) {
          nextVars ??= new Map(parentVars);
          nextVars.set(name, entry.value);
          if (entry.important) importantVars.add(name);
        }
      }
    }
    for (const [name, entry] of styleDecls.vars) {
      if (entry.important || !importantVars.has(name)) {
        nextVars ??= new Map(parentVars);
        nextVars.set(name, entry.value);
      }
    }
    if (nextVars) node.vars = nextVars;

    const getVar = (name: string) => node.vars.get(name);
    const rootPx = rootElementFont ?? rootFontSize;
    let winningSpec: FontSizeSpec | null = null;

    if (styleDecls.fontSize?.important) {
      winningSpec = parseFontSizeSpec(styleDecls.fontSize.value, getVar);
    } else {
      for (let i = matched.length - 1; i >= 0; i--) {
        const fs = matched[i]!.fontSize;
        if (!fs?.important) continue;
        const spec = parseFontSizeSpec(fs.value, getVar);
        if (spec) {
          winningSpec = spec;
          break;
        }
      }
      if (!winningSpec) {
        if (styleDecls.fontSize) {
          winningSpec = parseFontSizeSpec(styleDecls.fontSize.value, getVar);
        } else {
          for (let i = matched.length - 1; i >= 0; i--) {
            const fs = matched[i]!.fontSize;
            if (!fs || fs.important) continue;
            const spec = parseFontSizeSpec(fs.value, getVar);
            if (spec) {
              winningSpec = spec;
              break;
            }
          }
          if (!winningSpec && attrs['font-size']) {
            winningSpec = parseFontSizeSpec(attrs['font-size'], getVar);
          }
        }
      }
    }

    if (winningSpec) node.fontSize = resolveFontSize(winningSpec, parentFont, rootPx);
    if (tag === 'svg' && rootElementFont === null && node.fontSize !== null) {
      rootElementFont = node.fontSize;
    }
  }
  return sawText && Number.isFinite(minFont) ? minFont : (rootElementFont ?? rootFontSize);
}

/** Kept separate from the DOM renderer so deduplication and failure recovery can be tested directly. */
export function createDiagramCache(render: RenderSvg) {
  const cache = new Map<string, Promise<DiagramDrawing>>();
  const pending = new Set<Promise<DiagramDrawing>>();
  const trim = () => {
    for (const [key, drawing] of cache) {
      if (cache.size <= 100) break;
      if (!pending.has(drawing)) cache.delete(key);
    }
  };
  let tail: Promise<unknown> = Promise.resolve();
  return (source: string, theme: DiagramTheme): Promise<DiagramDrawing> => {
    const key = JSON.stringify([source, theme]);
    const cached = cache.get(key);
    if (cached) return cached;
    const drawing = tail.then(async (): Promise<DiagramDrawing> => {
      try {
        const refused = diagramResourceReason(source);
        if (refused) return { error: refused };
        const svg = await render(source, theme, `contextspace-diagram-${++nextId}`);
        if (svg === null) return null; // Unavailable loads are removed after their public promise settles.
        // Data URLs need no lifetime bookkeeping or revocation, and remain inert image documents.
        return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, fontSize: diagramSvgFontSize(svg) };
      } catch (error) {
        return { error: shortDiagramError(error) };
      }
    });
    pending.add(drawing);
    // The exposed promise must actually be settled before it becomes eligible for eviction.
    void drawing.then((result) => {
      if (result === null && cache.get(key) === drawing) cache.delete(key);
      pending.delete(drawing);
      trim();
    });
    tail = drawing;
    cache.set(key, drawing);
    // Bound settled results, while every pending request remains shared until it finishes.
    trim();
    return drawing;
  };
}

/** Keep Mermaid's useful diagnostic, never the echoed source excerpt or pointer. */
export function shortDiagramError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unable to draw this diagram');
  if (/No diagram type detected/i.test(message)) return 'No diagram type detected';
  const parse = message.match(/Parse error on line \d+:/i)?.[0];
  const expected = message.split(/\r?\n/).map((line) => line.trim()).find((line) => /^Expecting\b/.test(line));
  const summary = parse ? [parse, expected].filter(Boolean).join(' ') : message.split(/\r?\n/).find((line) => line.trim())?.trim() || 'Unable to draw this diagram';
  if (summary.length <= 200) return summary;
  const got = parse && expected?.match(/,?\s+got\s+.+$/)?.[0];
  return got && got.length < 100
    ? `${summary.slice(0, 197 - got.length).trimEnd()}...${got}`
    : `${summary.slice(0, 197)}...`;
}

/** Card measurements are CSS pixels; zoom converts them to the size a person actually sees. */
export function diagramCardLayout(natural: { width: number; height: number }, box: { width: number; height: number }, zoom = 1) {
  const scale = Math.max(0.75, Math.min(1, box.width * zoom / natural.width, box.height * zoom / natural.height));
  const width = natural.width * scale / zoom;
  const height = natural.height * scale / zoom;
  return { scale, width, height, cropRight: width > box.width + 0.01, cropBottom: height > box.height + 0.01 };
}

/** Reader measurements keep text at least 12 px on screen (upscaling up to 1.5x when needed); fit-to-width diagrams never upscale above 1 or scroll sideways. */
export function diagramReaderLayout(natural: { width: number; height: number }, availableWidth: number, fontSize = DEFAULT_SVG_FONT_PX) {
  if (!(natural.width > 0 && natural.height > 0 && availableWidth > 0 && Number.isFinite(availableWidth))) {
    const width = Number.isFinite(natural.width) && natural.width > 0 ? natural.width : 0;
    const height = Number.isFinite(natural.height) && natural.height > 0 ? natural.height : 0;
    return { scale: 1, width, height, scrolls: false };
  }
  const readableFont = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : DEFAULT_SVG_FONT_PX;
  const minScale = Math.min(MAX_READER_UPSCALE, READABLE_TEXT_PX / readableFont);
  const fitScale = Math.min(1, availableWidth / natural.width);
  const scale = Math.max(minScale, fitScale);
  const scrolls = natural.width * scale > availableWidth + 0.01;
  const width = !scrolls && scale < 1 ? availableWidth : natural.width * scale;
  const height = natural.height * scale;
  return { scale, width, height, scrolls };
}

/** The reader explains the mistake to a person; the original diagnostic still goes to the AI. */
export function diagramProblem(source: string, error: string): { message: string; sourceLine?: string; detail?: string } {
  const line = Number(error.match(/Parse error on line (\d+):/i)?.[1]);
  const lines = source.split(/\r?\n/);
  if (Number.isSafeInteger(line) && line > 0 && line <= lines.length) {
    return { message: `Can't draw this diagram: line ${line} has a mistake`, sourceLine: lines[line - 1] };
  }
  if (/No diagram type detected/i.test(error)) return { message: "Can't draw this diagram: Mermaid does not know this kind of diagram" };
  return { message: "Can't draw this diagram", detail: error };
}

export function diagramAlt(source: string): string {
  return source.match(/^[\t ]*accTitle[\t ]*:[\t ]*([^\r\n]*\S)[\t ]*\r?$/m)?.[1]?.trim() || 'Diagram';
}

async function renderSvg(source: string, theme: DiagramTheme, id: string): Promise<string | null> {
  const svg = await renderDiagramFrame(source, theme, id);
  if (svg === null) return null;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror, foreignObject')) throw new Error('Unsupported SVG');
  // Mermaid's responsive width=100% has no intrinsic image size. Use the viewBox for an
  // image that is natural-sized in the reader and object-contained on the card.
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    root.setAttribute('width', String(box[2]));
    root.setAttribute('height', String(box[3]));
    root.style.removeProperty('max-width');
    root.style.removeProperty('width');
  }
  return new XMLSerializer().serializeToString(root);
}

export const drawDiagram = createDiagramCache(renderSvg);
