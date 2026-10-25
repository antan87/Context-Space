#!/usr/bin/env node
/**
 * Mechanical CI check to enforce no dynamic `any` types in production code.
 *
 * Verifies:
 * 1. Zero `catch (...: any)` error handlers across all source trees (src/, gui/src/, extension/src/).
 * 2. Zero `null as any` bypasses across all source trees.
 * 3. Zero untyped `any` annotations or casts in frontend production files (gui/src/).
 * 4. Zero dynamic `any` regressions in migrated backend modules.
 *
 * Usage:
 *   node scripts/check-no-any.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..');

/** Files explicitly migrated to strong typing in checkpoints 1-6. */
export const MIGRATED_BACKEND_FILES = [
  'src/storage/db.ts',
  'src/utils/errors.ts',
  'src/utils/workflows.ts',
  'src/orchestration/runner.ts',
  'src/utils/terminal-launch.ts',
  'src/core/perf-counters.ts',
  'src/agent/NativeAgent.ts',
  'src/agent/NativeClaudeAgent.ts',
  'src/agent/NativeGoogleAgent.ts',
  'src/agent/orchestrator.ts',
  'src/utils/session-finder.ts',
  'src/utils/pi-sessions.ts',
  'src/harness/claude.ts',
  'src/core/plugins/loader.ts',
  'src/core/plugins/index.ts',
  'src/core/attention.ts',
  'src/commands/handoff.ts',
];

/**
 * Strips comments from JavaScript/TypeScript source code while preserving line counts
 * and character offsets so reported line numbers remain exact.
 */
export function stripComments(source) {
  // Replace block comments with spaces and newlines
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
  // Replace single-line comments with spaces
  return withoutBlock.replace(/\/\/.*$/gm, (match) => {
    return ' '.repeat(match.length);
  });
}

/**
 * Recursively collects files in a directory matching extensions, excluding tests and ignored dirs.
 */
export function collectSourceFiles(dir, extensions = ['.ts', '.tsx', '.js', '.jsx'], excludePatterns = [/\.test\./, /\.spec\./, /node_modules/, /dist/]) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');

      if (excludePatterns.some((pattern) => pattern.test(relPath))) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(relPath);
      }
    }
  }

  walk(dir);
  return results;
}

const CATCH_ANY_REGEX = /\bcatch\s*\(\s*\w+\s*:\s*any\s*\)/g;
const NULL_AS_ANY_REGEX = /\bnull\s+as\s+any\b/g;

// Type-level any patterns (must not match words in strings or comments)
const TYPE_ANY_PATTERNS = [
  { regex: /:\s*any\b/g, description: 'explicit `: any` type annotation' },
  { regex: /\bas\s+any\b/g, description: 'type bypass `as any`' },
  { regex: /<any\s*>/g, description: 'generic type argument `<any>`' },
  { regex: /<any\s*,/g, description: 'generic type argument `<any, ...>`' },
  { regex: /,\s*any\s*>/g, description: 'generic type argument `<..., any>`' },
  { regex: /,\s*any\s*,/g, description: 'generic type argument `<..., any, ...>`' },
  { regex: /\bany\s*\[\s*\]/g, description: 'array type `any[]`' },
  { regex: /\[\s*\w+\s*:\s*string\s*\]\s*:\s*any\b/g, description: 'index signature `[key: string]: any`' },
];

export function findViolationsInContent(content, relPath, checkTypes = false) {
  const violations = [];
  const cleanContent = stripComments(content);
  const lines = cleanContent.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    // 1. Check catch (err: any)
    if (CATCH_ANY_REGEX.test(line)) {
      CATCH_ANY_REGEX.lastIndex = 0;
      violations.push({
        file: relPath,
        line: lineNum,
        snippet: line.trim(),
        rule: 'no-catch-any',
        message: 'Avoid `catch (...: any)`. Use `catch (error: unknown)` and safe error extractors.',
      });
    }

    // 2. Check null as any
    if (NULL_AS_ANY_REGEX.test(line)) {
      NULL_AS_ANY_REGEX.lastIndex = 0;
      violations.push({
        file: relPath,
        line: lineNum,
        snippet: line.trim(),
        rule: 'no-null-as-any',
        message: 'Avoid `null as any`. Use explicit nullable union type or fallback instance.',
      });
    }

    // 3. Check full type-level any if requested
    if (checkTypes) {
      for (const pattern of TYPE_ANY_PATTERNS) {
        if (pattern.regex.test(line)) {
          pattern.regex.lastIndex = 0;
          violations.push({
            file: relPath,
            line: lineNum,
            snippet: line.trim(),
            rule: 'no-explicit-any',
            message: `Found ${pattern.description}.`,
          });
          break; // One violation per line is enough
        }
      }
    }
  }

  return violations;
}

export function runChecks(rootDir = repoRoot) {
  const violations = [];

  // Check 1 & 2: catch (...: any) and null as any across all source directories
  const allSourceFiles = [
    ...collectSourceFiles(path.join(rootDir, 'src')),
    ...collectSourceFiles(path.join(rootDir, 'gui/src')),
    ...collectSourceFiles(path.join(rootDir, 'extension/src')),
  ];

  for (const relPath of allSourceFiles) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const fileViolations = findViolationsInContent(content, relPath, false);
    violations.push(...fileViolations);
  }

  // Check 3: Full type any check in gui/src production files
  const guiSourceFiles = collectSourceFiles(path.join(rootDir, 'gui/src'));
  for (const relPath of guiSourceFiles) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const fileViolations = findViolationsInContent(content, relPath, true);
    // Filter out duplicates already caught by rule 1 or 2
    for (const v of fileViolations) {
      if (!violations.some((existing) => existing.file === v.file && existing.line === v.line)) {
        violations.push(v);
      }
    }
  }

  // Check 4: Full type any check in migrated backend files
  for (const relPath of MIGRATED_BACKEND_FILES) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const fileViolations = findViolationsInContent(content, relPath, true);
    for (const v of fileViolations) {
      if (!violations.some((existing) => existing.file === v.file && existing.line === v.line)) {
        violations.push(v);
      }
    }
  }

  return {
    scannedCount: allSourceFiles.length + MIGRATED_BACKEND_FILES.length,
    guiCount: guiSourceFiles.length,
    violations,
  };
}

export function main() {
  console.log('🔍 Checking codebase for dynamic any types and type bypasses...');
  const { scannedCount, guiCount, violations } = runChecks();

  if (violations.length > 0) {
    console.error(`\n❌ Found ${violations.length} dynamic any violation(s):`);
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line} [${v.rule}]: ${v.snippet}`);
      console.error(`    ${v.message}`);
    }
    console.error('\nEliminate untyped any annotations before merging.\n');
    process.exit(1);
  }

  console.log(`✅ All clear! Checked ${scannedCount} files (${guiCount} GUI production files). Zero dynamic any types found.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
