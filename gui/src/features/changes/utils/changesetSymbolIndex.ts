/**
 * Changeset Symbol Index & Lightweight Language Feature Providers
 * Tokenizes symbols (classes, interfaces, functions, types, enums) across changeset files,
 * correlates them with diff hunks, and powers F12 (Go to Definition), Alt+F12 (Peek),
 * Shift+F12 (Find References), and Ctrl+Shift+O (Quick Outline) without language workers.
 * File: gui/src/features/changes/utils/changesetSymbolIndex.ts
 */
import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { useSyncExternalStore } from 'react';
import type { DiffHunkAction } from '../types.js';
import { getModifiedFileUri } from './changesetModelStore.js';

export type SymbolIndexListener = () => void;

export const MonacoSymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

export type SymbolKindLabel =
  | 'class'
  | 'interface'
  | 'constructor'
  | 'method'
  | 'function'
  | 'property'
  | 'type'
  | 'enum'
  | 'variable';

export interface RawAstSymbol {
  name: string;
  kind: number; // Monaco SymbolKind number
  kindLabel: SymbolKindLabel;
  lineNumber: number;
  endLineNumber?: number;
  column: number;
  containerName?: string;
}

export interface ChangesetSymbol {
  id: string;
  name: string;
  kind: number; // Monaco SymbolKind number
  kindLabel: SymbolKindLabel;
  repoName: string;
  repoPath?: string;
  filePath: string;
  uriString: string;
  lineNumber: number;
  endLineNumber?: number;
  column: number;
  containerName?: string;
  isModifiedInChangeset: boolean;
  changeType?: 'added' | 'modified' | 'context';
  hunkIndex?: number;
  hunkId?: string;
}

interface PatternDef {
  regex: RegExp;
  kind: number;
  label: SymbolKindLabel;
}

function getLanguageCategory(filePath: string): 'ts' | 'python' | 'go' | 'rust' | 'csharp' | 'other' {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'ts';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'cs':
      return 'csharp';
    default:
      return 'other';
  }
}

const CSHARP_PATTERNS: PatternDef[] = [
  // class Name
  {
    regex: /^\s*(?:(?:public|private|protected|internal|sealed|abstract|static|partial)\s+)*class\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Class,
    label: 'class',
  },
  // interface IName
  {
    regex: /^\s*(?:(?:public|private|protected|internal|partial)\s+)*interface\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Interface,
    label: 'interface',
  },
  // record Name or record class/struct Name
  {
    regex: /^\s*(?:(?:public|private|protected|internal|sealed|abstract|static|partial|readonly)\s+)*record(?:\s+(?:class|struct))?\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Class,
    label: 'class',
  },
  // struct Name
  {
    regex: /^\s*(?:(?:public|private|protected|internal|readonly|ref|partial)\s+)*struct\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Struct,
    label: 'class',
  },
  // enum Name
  {
    regex: /^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Enum,
    label: 'enum',
  },
  // Constructors: public/private/protected/internal ClassName(...)
  {
    regex: /^\s*(?:(?:public|private|protected|internal)\s+)+([A-Z][A-Za-z0-9_]*)\s*\(/,
    kind: MonacoSymbolKind.Constructor,
    label: 'constructor',
  },
  // Methods with access modifiers
  {
    regex: /^\s*(?:(?:public|private|protected|internal|static|async|virtual|override|abstract|sealed|new)\s+)+(?:void|[A-Za-z0-9_<>?[\]\s,]+)\s+([A-Za-z0-9_]+)\s*(?:<[^>]+>)?\s*\(/,
    kind: MonacoSymbolKind.Method,
    label: 'method',
  },
  // Test methods or methods with Task/void return type
  {
    regex: /^\s*(?:(?:async|static)\s+)?(?:void|Task(?:<[^>]+>)?|IActionResult|ActionResult(?:<[^>]+>)?)\s+([A-Za-z0-9_]+)\s*(?:<[^>]+>)?\s*\(/,
    kind: MonacoSymbolKind.Method,
    label: 'method',
  },
  // Properties: public/private/protected/internal Type Name { get; ... }
  {
    regex: /^\s*(?:(?:public|private|protected|internal|virtual|override|abstract|required|static)\s+)+[A-Za-z0-9_<>?[\]\s,]+\s+([A-Za-z0-9_]+)\s*\{\s*(?:get|set|init)/,
    kind: MonacoSymbolKind.Property,
    label: 'property',
  },
  // Expression-bodied properties or methods: public Type Name => ...
  {
    regex: /^\s*(?:(?:public|private|protected|internal|virtual|override|abstract|static)\s+)+[A-Za-z0-9_<>?[\]\s,]+\s+([A-Za-z0-9_]+)\s*=>/,
    kind: MonacoSymbolKind.Property,
    label: 'property',
  },
];

const TS_PATTERNS: PatternDef[] = [
  // function name()
  {
    regex: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*(?:\*\s*)?([A-Za-z0-9_$]+)/,
    kind: MonacoSymbolKind.Function,
    label: 'function',
  },
  // constructor(...)
  {
    regex: /^\s*(?:(?:public|private|protected)\s+)?(constructor)\s*\(/,
    kind: MonacoSymbolKind.Constructor,
    label: 'constructor',
  },
  // class method: public/private/protected/async/static methodName(...)
  {
    regex: /^\s*(?:(?:public|private|protected|static|abstract|override|async)\s+)+([A-Za-z0-9_$]+)\s*(?:<[^>]+>)?\s*\(/,
    kind: MonacoSymbolKind.Method,
    label: 'method',
  },
  // const name = () => ... or const name = async (): Type => ... or multiline arrow
  {
    regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+|\()(?:\s*:\s*[^=]+)?\s*(?:=>)?/,
    kind: MonacoSymbolKind.Function,
    label: 'function',
  },

  // const name = function() ...
  {
    regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?function/,
    kind: MonacoSymbolKind.Function,
    label: 'function',
  },
  // class Name
  {
    regex: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
    kind: MonacoSymbolKind.Class,
    label: 'class',
  },
  // interface Name
  {
    regex: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
    kind: MonacoSymbolKind.Interface,
    label: 'interface',
  },
  // type Name =
  {
    regex: /^\s*(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*=/,
    kind: MonacoSymbolKind.TypeParameter,
    label: 'type',
  },
  // enum Name
  {
    regex: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/,
    kind: MonacoSymbolKind.Enum,
    label: 'enum',
  },
  // const / let / var name = ...
  {
    regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=/,
    kind: MonacoSymbolKind.Variable,
    label: 'variable',
  },
];

const PYTHON_PATTERNS: PatternDef[] = [
  // def name():
  {
    regex: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/,
    kind: MonacoSymbolKind.Function,
    label: 'function',
  },
  // class Name:
  {
    regex: /^\s*class\s+([A-Za-z0-9_]+)(?:\s*\([^)]*\))?\s*:/,
    kind: MonacoSymbolKind.Class,
    label: 'class',
  },
];

const GO_PATTERNS: PatternDef[] = [
  // func (r Recv) name() or func name()
  {
    regex: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*\(/,
    kind: MonacoSymbolKind.Function,
    label: 'function',
  },
  // type Name struct / interface
  {
    regex: /^\s*type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/,
    kind: MonacoSymbolKind.Class,
    label: 'type',
  },
];

const RUST_PATTERNS: PatternDef[] = [
  // fn name()
  {
    regex: /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Function,
    label: 'function',
  },
  // struct Name
  {
    regex: /^\s*(?:pub(?:\([^)]+\))?\s+)?struct\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Class,
    label: 'class',
  },
  // enum Name
  {
    regex: /^\s*(?:pub(?:\([^)]+\))?\s+)?enum\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Enum,
    label: 'enum',
  },
  // trait Name
  {
    regex: /^\s*(?:pub(?:\([^)]+\))?\s+)?trait\s+([A-Za-z0-9_]+)/,
    kind: MonacoSymbolKind.Interface,
    label: 'interface',
  },
];

export class ChangesetSymbolIndex {
  private symbols: ChangesetSymbol[] = [];
  private symbolMap = new Map<string, ChangesetSymbol[]>();
  private listeners = new Set<SymbolIndexListener>();

  public subscribe(listener: SymbolIndexListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public onIndexUpdated(listener: SymbolIndexListener): () => void {
    return this.subscribe(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Error in changeset symbol index listener:', err);
      }
    }
  }

  public clear(): void {
    this.symbols = [];
    this.symbolMap.clear();
    this.notify();
  }

  public removeFile(repoName: string, filePath: string): void {
    const cleanPath = filePath.replace(/\\/g, '/').replace(/^\//, '');
    this.symbols = this.symbols.filter(
      (s) => !(s.repoName === repoName && s.filePath === cleanPath)
    );
    this.rebuildMap();
    this.notify();
  }

  public indexFile(
    repoName: string,
    filePath: string,
    content: string,
    hunks: DiffHunkAction[] = [],
    repoPath?: string,
    preExtractedSymbols?: RawAstSymbol[]
  ): ChangesetSymbol[] {
    const cleanPath = filePath.replace(/\\/g, '/').replace(/^\//, '');
    const cleanRepo = repoName.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
    // The URI of this file's editor model, which the outline provider matches on. It carries the
    // workspace scope, so it has to be built the way the adapter builds the model's URI.
    const uriString = getModifiedFileUri(repoName, filePath, undefined, repoPath).toString();

    // Remove any previously indexed symbols for this specific file
    const remainingSymbols = this.symbols.filter(
      (s) => !(s.repoName === repoName && s.filePath === cleanPath)
    );

    const langCategory = getLanguageCategory(cleanPath);
    let patterns = TS_PATTERNS;
    if (langCategory === 'python') patterns = PYTHON_PATTERNS;
    else if (langCategory === 'go') patterns = GO_PATTERNS;
    else if (langCategory === 'rust') patterns = RUST_PATTERNS;
    else if (langCategory === 'csharp') patterns = CSHARP_PATTERNS;
    else if (langCategory === 'other') patterns = [];

    // Build line-by-line mapping for hunk-based snippet buffers
    const hunkLinesInfo: Array<{ lineNum: number; hunk: DiffHunkAction; isAdded: boolean }> = [];
    if (hunks && hunks.length > 0) {
      for (const hunk of hunks) {
        let lineOffset = 0;
        for (const rawLine of hunk.lines || []) {
          if (rawLine.startsWith('-') || rawLine.startsWith('\\')) {
            continue;
          }
          const isAdded = rawLine.startsWith('+');
          hunkLinesInfo.push({
            lineNum: hunk.startLineModified + lineOffset,
            hunk,
            isAdded,
          });
          lineOffset++;
        }
      }
    }

    const lines = content.split(/\r?\n/);
    const isSnippetBuffer = hunkLinesInfo.length > 0 && lines.length === hunkLinesInfo.length;
    const newFileSymbols: ChangesetSymbol[] = [];

    if (preExtractedSymbols && preExtractedSymbols.length > 0) {
      for (const raw of preExtractedSymbols) {
        let lineNum: number = raw.lineNumber;
        let matchingHunk: DiffHunkAction | undefined;
        let isAdded = false;

        const symStart = raw.lineNumber;
        const symEnd = raw.endLineNumber || raw.lineNumber;

        if (isSnippetBuffer) {
          const info = hunkLinesInfo.find((h) => h.lineNum >= symStart && h.lineNum <= symEnd);
          if (info) {
            lineNum = info.lineNum;
            matchingHunk = info.hunk;
            isAdded = info.isAdded;
          } else {
            matchingHunk = hunks.find((h) => {
              const start = h.startLineModified;
              const end = h.startLineModified + Math.max(h.lineCountModified, 1) - 1;
              return start <= symEnd && end >= symStart;
            });
          }
        } else {
          matchingHunk = hunks.find((h) => {
            const start = h.startLineModified;
            const end = h.startLineModified + Math.max(h.lineCountModified, 1) - 1;
            return start <= symEnd && end >= symStart;
          });
        }

        let changeType: 'added' | 'modified' | 'context' = 'context';
        if (matchingHunk) {
          if (isSnippetBuffer) {
            changeType = isAdded ? 'added' : 'modified';
          } else {
            changeType = 'modified';
            const hunkStart = matchingHunk.startLineModified;
            const hunkEnd = hunkStart + Math.max(matchingHunk.lineCountModified, 1) - 1;
            if (
              (raw.lineNumber >= hunkStart &&
                raw.lineNumber <= hunkEnd &&
                matchingHunk.lines &&
                matchingHunk.lines.some((l) => l.startsWith('+') && l.includes(raw.name))) ||
              (matchingHunk.lines &&
                matchingHunk.lines.length > 0 &&
                matchingHunk.lines.every((l) => !l.startsWith('-') && !l.startsWith(' ')))
            ) {
              changeType = 'added';
            }
          }
        }

        const symbol: ChangesetSymbol = {
          id: `${cleanRepo}:${cleanPath}:${lineNum}:${raw.name}`,
          name: raw.name,
          kind: raw.kind,
          kindLabel: raw.kindLabel,
          repoName,
          repoPath: repoPath || (cleanRepo.includes('/') || cleanRepo.includes('\\') ? cleanRepo : undefined),
          filePath: cleanPath,
          uriString,
          lineNumber: lineNum,
          endLineNumber: raw.endLineNumber,
          column: raw.column || 1,
          containerName: raw.containerName,
          isModifiedInChangeset: !!matchingHunk,
          changeType: matchingHunk ? changeType : 'context',
          hunkIndex: matchingHunk?.hunkIndex,
          hunkId: matchingHunk?.id,
        };

        newFileSymbols.push(symbol);
      }
    } else {
      lines.forEach((line, index) => {
      let lineNum: number;
      let matchingHunk: DiffHunkAction | undefined;
      let isAdded = false;

      if (isSnippetBuffer) {
        const info = hunkLinesInfo[index]!;
        lineNum = info.lineNum;
        matchingHunk = info.hunk;
        isAdded = info.isAdded;
      } else {
        lineNum = index + 1;
        matchingHunk = hunks.find((h) => {
          const start = h.startLineModified;
          const end = h.startLineModified + Math.max(h.lineCountModified, 1) - 1;
          return lineNum >= start && lineNum <= end;
        });
      }

      for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match && match[1]) {
          const symbolName = match[1];
          const col = line.indexOf(symbolName) + 1;

          let changeType: 'added' | 'modified' | 'context' = 'context';
          if (matchingHunk) {
            if (isSnippetBuffer) {
              changeType = isAdded ? 'added' : 'modified';
            } else {
              changeType = 'modified';
              if (matchingHunk.lines && matchingHunk.lines.some((l) => l.startsWith('+') && l.includes(symbolName))) {
                changeType = 'added';
              }
            }
          }

          const symbol: ChangesetSymbol = {
            id: `${cleanRepo}:${cleanPath}:${lineNum}:${symbolName}`,
            name: symbolName,
            kind: pattern.kind,
            kindLabel: pattern.label,
            repoName,
            repoPath: repoPath || (cleanRepo.includes('/') || cleanRepo.includes('\\') ? cleanRepo : undefined),
            filePath: cleanPath,
            uriString,
            lineNumber: lineNum,
            column: col > 0 ? col : 1,
            isModifiedInChangeset: !!matchingHunk,
            changeType: matchingHunk ? changeType : 'context',
            hunkIndex: matchingHunk?.hunkIndex,
            hunkId: matchingHunk?.id,
          };

          newFileSymbols.push(symbol);
          break;
        }
      }
    });

    // In addition to scanning content, scan hunk.enclosingDeclaration (from git diff @@ headers)
    if (hunks && hunks.length > 0) {
      for (const hunk of hunks) {
        if (!hunk.enclosingDeclaration) continue;
        for (const pattern of patterns) {
          const match = hunk.enclosingDeclaration.match(pattern.regex);
          if (match && match[1]) {
            const symbolName = match[1];
            if (!newFileSymbols.some((s) => s.name === symbolName)) {
              newFileSymbols.push({
                id: `${cleanRepo}:${cleanPath}:${hunk.startLineModified}:${symbolName}`,
                name: symbolName,
                kind: pattern.kind,
                kindLabel: pattern.label,
                repoName,
                repoPath: repoPath || (cleanRepo.includes('/') || cleanRepo.includes('\\') ? cleanRepo : undefined),
                filePath: cleanPath,
                uriString,
                lineNumber: hunk.startLineModified,
                column: 1,
                isModifiedInChangeset: true,
                changeType: 'modified',
                hunkIndex: hunk.hunkIndex,
                hunkId: hunk.id,
              });
            }
            break;
          }
        }
      }
    }
  }

  // For any hunks with an enclosingDeclaration, ensure matching symbols are marked modified
  if (hunks && hunks.length > 0) {
    for (const hunk of hunks) {
      if (!hunk.enclosingDeclaration) continue;
      for (const s of newFileSymbols) {
        if (hunk.enclosingDeclaration.includes(s.name) && !s.isModifiedInChangeset) {
          s.isModifiedInChangeset = true;
          s.changeType = 'modified';
          s.hunkIndex = hunk.hunkIndex;
          s.hunkId = hunk.id;
        }
      }
    }
  }

  this.symbols = [...remainingSymbols, ...newFileSymbols];
  this.rebuildMap();
  this.notify();
  return newFileSymbols;
}

  private rebuildMap(): void {
    this.symbolMap.clear();
    for (const s of this.symbols) {
      const list = this.symbolMap.get(s.name) || [];
      list.push(s);
      this.symbolMap.set(s.name, list);
    }
  }

  public getAllSymbols(): ChangesetSymbol[] {
    return this.symbols;
  }

  public getModifiedSymbols(): ChangesetSymbol[] {
    return this.symbols.filter((s) => s.isModifiedInChangeset);
  }

  public findDefinitions(symbolName: string): ChangesetSymbol[] {
    return this.symbolMap.get(symbolName) || [];
  }

  public findSymbolsInFile(filePath: string): ChangesetSymbol[] {
    const clean = filePath.replace(/\\/g, '/').replace(/^\//, '');
    return this.symbols.filter((s) => s.filePath === clean);
  }
}

export const globalChangesetSymbolIndex = new ChangesetSymbolIndex();

/**
 * React hook to reactively subscribe to changeset symbol store updates.
 */
export function useChangesetSymbolStore(
  index: ChangesetSymbolIndex = globalChangesetSymbolIndex
): ChangesetSymbol[] {
  return useSyncExternalStore(
    (callback) => index.subscribe(callback),
    () => index.getAllSymbols(),
    () => []
  );
}

export function findChangesetReferences(models: monaco.editor.ITextModel[], symbolName: string): monaco.languages.Location[] {
  const results: monaco.languages.Location[] = [];
  for (const model of models) {
    if (model.uri.scheme !== 'file') continue;
    const matches = model.findMatches(symbolName, true, false, true, ' `~!@#%^&*()-=+[{]}\\|;:\'",.<>/?', false);
    for (const match of matches) results.push({ uri: model.uri, range: match.range });
  }
  return results;
}

let providersRegistered = false;

/**
 * Registers lightweight Monaco Definition, Reference, and DocumentSymbol providers.
 * Universal for TypeScript, JavaScript, Python, Rust, and Go.
 */
export function registerLightweightNavigationProviders(
  monacoApi?: typeof monaco
): monaco.IDisposable {
  const m = monacoApi || (typeof window !== 'undefined' ? (window as unknown as { monaco?: typeof monaco }).monaco : undefined);
  if (!m || providersRegistered) {
    return { dispose: () => {} };
  }

  const supportedLanguages = ['typescript', 'javascript', 'python', 'rust', 'go', 'csharp'];
  const disposables: monaco.IDisposable[] = [];

  for (const lang of supportedLanguages) {
    // 1. Definition Provider (F12, Cmd+Click, Alt+F12 Peek Definition)
    disposables.push(
      m.languages.registerDefinitionProvider(lang, {
        provideDefinition(model: monaco.editor.ITextModel, position: monaco.Position) {
          const word = model.getWordAtPosition(position);
          if (!word) return null;

          const symbolName = word.word;
          const matches = globalChangesetSymbolIndex.findDefinitions(symbolName);
          if (matches.length === 0) return null;

          return matches.map((item) => ({
            uri: getModifiedFileUri(item.repoName, item.filePath, m, item.repoPath),
            range: {
              startLineNumber: item.lineNumber,
              startColumn: item.column,
              endLineNumber: item.lineNumber,
              endColumn: item.column + item.name.length,
            },
          }));
        },
      })
    );

    // 2. Reference Provider (Shift+F12 Find References)
    disposables.push(
      m.languages.registerReferenceProvider(lang, {
        provideReferences(model: monaco.editor.ITextModel, position: monaco.Position) {
          const word = model.getWordAtPosition(position);
          if (!word) return null;

          return findChangesetReferences(m.editor.getModels(), word.word);
        },
      })
    );

    // 3. Document Symbol Provider (Ctrl+Shift+O Quick Outline)
    disposables.push(
      m.languages.registerDocumentSymbolProvider(lang, {
        provideDocumentSymbols(model: monaco.editor.ITextModel) {
          const uriStr = model.uri.toString();
          const fileSymbols = globalChangesetSymbolIndex
            .getAllSymbols()
            .filter((s) => s.uriString === uriStr);


          return fileSymbols.map((s) => ({
            name: s.name,
            detail: s.kindLabel,
            kind: s.kind as monaco.languages.SymbolKind,
            tags: [],
            range: {
              startLineNumber: s.lineNumber,
              startColumn: 1,
              endLineNumber: s.lineNumber,
              endColumn: s.column + s.name.length,
            },
            selectionRange: {
              startLineNumber: s.lineNumber,
              startColumn: s.column,
              endLineNumber: s.lineNumber,
              endColumn: s.column + s.name.length,
            },
          }));
        },
      })
    );
  }

  providersRegistered = true;

  return {
    dispose() {
      disposables.forEach((d) => d.dispose());
      providersRegistered = false;
    },
  };
}
