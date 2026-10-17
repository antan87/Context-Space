import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultTool, rankTools, readToolUse, rememberToolStarted } from './toolPrefs.js';

describe('session tool preferences', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    (globalThis as { window?: unknown }).window = { localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    } };
  });
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it('ranks the most used tools first, then the usual order, and leaves the shell out', () => {
    expect(rankTools(['shell', 'pi', 'codex', 'claude'], { counts: {} })).toEqual(['claude', 'codex', 'pi']);
    expect(rankTools(['pi', 'codex', 'claude'], { counts: { pi: 3, codex: 1 } })).toEqual(['pi', 'codex', 'claude']);
  });

  it('starts the last used tool while it is available', () => {
    rememberToolStarted('codex');
    rememberToolStarted('pi');
    expect(readToolUse()).toEqual({ last: 'pi', counts: { codex: 1, pi: 1 } });
    expect(defaultTool(['claude', 'codex', 'pi'], readToolUse())).toBe('pi');
    expect(defaultTool(['claude', 'codex'], readToolUse())).toBe('codex');
    expect(defaultTool([], readToolUse())).toBeUndefined();
  });

  it('copes with storage that is broken or unavailable', () => {
    store.set('contextspace.session-tools', '{not json');
    expect(readToolUse()).toEqual({ counts: {} });
    (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } };
    expect(rememberToolStarted('claude')).toEqual({ last: 'claude', counts: { claude: 1 } });
    expect(readToolUse()).toEqual({ counts: {} });
  });

});
