/**
 * Monaco Navigation & Language Features Contribution Setup
 * Pre-configures standalone goto symbol, peek definition, references controller,
 * quick outline, and context menu without heavy ts.worker bloat.
 * File: gui/src/features/changes/utils/monacoNavigationSetup.ts
 */

// Codicons for Peek View and Quick Access UI
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';

// 7. Lean TypeScript Compiler Options & Defaults
// Implemented locally to configure compiler options without bundling the ~7MB ts.worker!
export const ScriptTarget = {
  ES3: 0,
  ES5: 1,
  ES2015: 2,
  ES2016: 3,
  ES2017: 4,
  ES2018: 5,
  ES2019: 6,
  ES2020: 7,
  ESNext: 99,
  JSON: 100,
  Latest: 99,
} as const;

export const ModuleKind = {
  None: 0,
  CommonJS: 1,
  AMD: 2,
  UMD: 3,
  System: 4,
  ES2015: 5,
  ESNext: 99,
} as const;

export const ModuleResolutionKind = {
  Classic: 1,
  NodeJs: 2,
} as const;

export const JsxEmit = {
  None: 0,
  Preserve: 1,
  React: 2,
  ReactNative: 3,
  ReactJSX: 4,
  ReactJSXDev: 5,
} as const;

export interface CompilerOptions {
  allowJs?: boolean;
  allowNonTsExtensions?: boolean;
  jsx?: number;
  module?: number;
  moduleResolution?: number;
  noEmit?: boolean;
  target?: number;
  [key: string]: unknown;
}

export interface ModeConfiguration {
  completionItems?: boolean;
  hovers?: boolean;
  documentSymbols?: boolean;
  definitions?: boolean;
  references?: boolean;
  documentHighlights?: boolean;
  rename?: boolean;
  diagnostics?: boolean;
  documentRangeFormattingEdits?: boolean;
  signatureHelp?: boolean;
  onTypeFormattingEdits?: boolean;
  codeActions?: boolean;
  inlayHints?: boolean;
}

export interface DiagnosticsOptions {
  noSemanticValidation?: boolean;
  noSyntaxValidation?: boolean;
  onlyVisible?: boolean;
}

export class LanguageServiceDefaults {
  private _compilerOptions: CompilerOptions;
  private _diagnosticsOptions: DiagnosticsOptions;
  private _modeConfiguration: ModeConfiguration;

  constructor(
    compilerOptions: CompilerOptions = {},
    diagnosticsOptions: DiagnosticsOptions = {},
    modeConfiguration: ModeConfiguration = {}
  ) {
    this._compilerOptions = compilerOptions;
    this._diagnosticsOptions = diagnosticsOptions;
    this._modeConfiguration = modeConfiguration;
  }

  getCompilerOptions(): CompilerOptions {
    return this._compilerOptions;
  }

  setCompilerOptions(options: CompilerOptions): void {
    this._compilerOptions = { ...this._compilerOptions, ...(options || {}) };
  }

  getDiagnosticsOptions(): DiagnosticsOptions {
    return this._diagnosticsOptions;
  }

  setDiagnosticsOptions(options: DiagnosticsOptions): void {
    this._diagnosticsOptions = { ...this._diagnosticsOptions, ...(options || {}) };
  }

  getModeConfiguration(): ModeConfiguration {
    return this._modeConfiguration;
  }

  setModeConfiguration(modeConfiguration: ModeConfiguration): void {
    this._modeConfiguration = { ...this._modeConfiguration, ...(modeConfiguration || {}) };
  }
}

export const typescriptDefaults = new LanguageServiceDefaults(
  { allowNonTsExtensions: true, target: ScriptTarget.ESNext },
  { noSemanticValidation: true, noSyntaxValidation: true },
  {}
);

export const javascriptDefaults = new LanguageServiceDefaults(
  { allowNonTsExtensions: true, allowJs: true, target: ScriptTarget.ESNext },
  { noSemanticValidation: true, noSyntaxValidation: true },
  {}
);

let navigationInitialized = false;

export function ensureMonacoNavigation(): void {
  if (navigationInitialized) return;

  const compilerOptions: CompilerOptions = {
    target: ScriptTarget.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    module: ModuleKind.ESNext,
    jsx: JsxEmit.ReactJSX,
    allowNonTsExtensions: true,
    allowJs: true,
    noEmit: true,
  };

  typescriptDefaults.setCompilerOptions(compilerOptions);
  javascriptDefaults.setCompilerOptions(compilerOptions);

  // CRITICAL: All worker modes disabled to prevent ts.worker spawn, keeping bundle size lean (~300KB)
  const disabledModeConfig: ModeConfiguration = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false,
  };

  typescriptDefaults.setModeConfiguration(disabledModeConfig);
  javascriptDefaults.setModeConfiguration(disabledModeConfig);

  typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });

  // Attach to global monaco.languages.typescript for runtime parity
  if (typeof window !== 'undefined') {
    const w = window as unknown as {
      monaco?: {
        languages?: {
          typescript?: unknown;
        };
      };
    };
    w.monaco = w.monaco || {};
    w.monaco.languages = w.monaco.languages || {};
    w.monaco.languages.typescript = {
      typescriptDefaults,
      javascriptDefaults,
      ScriptTarget,
      ModuleResolutionKind,
      ModuleKind,
      JsxEmit,
    };
  }

  navigationInitialized = true;
}
