import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOLDS_LIMIT, cleanFolds, foldsKey, groupOpen, readFolds, withFold, writeFolds } from './boardFolds.js';

/** A storage the spec holds, standing in for the browser's. */
function stubStorage(initial: Record<string, string> = {}, fails = false) {
  const data = new Map(Object.entries(initial));
  const refuse = () => { throw new Error('Storage is not available.'); };
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => (fails ? refuse() : data.get(key) ?? null),
    setItem: (key: string, value: string) => (fails ? refuse() : void data.set(key, value)),
    removeItem: (key: string) => (fails ? refuse() : void data.delete(key)),
  } });
  return data;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('groupOpen', () => {
  it('opens only the group the work is on, by default', () => {
    expect(groupOpen('checkpoint:two', 'checkpoint:two', undefined)).toBe(true);
    expect(groupOpen('checkpoint:one', 'checkpoint:two', {})).toBe(false);
    expect(groupOpen('lane:documents', 'checkpoint:two', {})).toBe(false);
    expect(groupOpen('lane:documents', undefined, {})).toBe(false);
  });

  it('is what the user chose, whichever way the default goes', () => {
    expect(groupOpen('checkpoint:one', 'checkpoint:two', { 'checkpoint:one': true })).toBe(true);
    expect(groupOpen('checkpoint:two', 'checkpoint:two', { 'checkpoint:two': false })).toBe(false);
  });

  it('opens the checkpoint the work moves on to, unless the user folded it', () => {
    const folds = { 'checkpoint:three': false };
    expect(groupOpen('checkpoint:two', 'checkpoint:two', folds)).toBe(true);
    // The work moves on: the new one opens by itself, the one before folds, and the one the user folded stays folded.
    expect(groupOpen('checkpoint:two', 'checkpoint:three', folds)).toBe(false);
    expect(groupOpen('checkpoint:three', 'checkpoint:three', folds)).toBe(false);
    expect(groupOpen('checkpoint:three', 'checkpoint:three', {})).toBe(true);
  });

  it('is not fooled by an id that is a name on every object', () => {
    expect(groupOpen('constructor', undefined, {})).toBe(false);
    expect(groupOpen('toString', 'toString', {})).toBe(true);
  });
});

describe('withFold', () => {
  it('keeps what the user changed from the default', () => {
    expect(withFold({}, 'lane:documents', true, 'checkpoint:two')).toEqual({ 'lane:documents': true });
    expect(withFold({}, 'checkpoint:two', false, 'checkpoint:two')).toEqual({ 'checkpoint:two': false });
  });

  it('keeps nothing for a choice that is the default, so what was changed back is forgotten', () => {
    expect(withFold({ 'checkpoint:two': false }, 'checkpoint:two', true, 'checkpoint:two')).toEqual({});
    expect(withFold({ 'lane:documents': true }, 'lane:documents', false, 'checkpoint:two')).toEqual({});
  });

  it('leaves the other groups\' choices as they are, and does not change the choices it was given', () => {
    const before = { 'lane:documents': true, 'checkpoint:one': true };
    const after = withFold(before, 'checkpoint:three', true, 'checkpoint:two');
    expect(after).toEqual({ 'lane:documents': true, 'checkpoint:one': true, 'checkpoint:three': true });
    expect(before).toEqual({ 'lane:documents': true, 'checkpoint:one': true });
  });

  it('forgets the oldest choices past the limit', () => {
    let folds = {};
    for (let n = 0; n < FOLDS_LIMIT + 5; n += 1) folds = withFold(folds, `checkpoint:c${n}`, true, undefined);
    const ids = Object.keys(folds);
    expect(ids).toHaveLength(FOLDS_LIMIT);
    expect(ids[0]).toBe('checkpoint:c5');
    expect(ids.at(-1)).toBe(`checkpoint:c${FOLDS_LIMIT + 4}`);
  });
});

describe('cleanFolds', () => {
  it('keeps only ids with a true or a false', () => {
    expect(cleanFolds({ a: true, b: false, c: 1, d: 'yes', e: null, f: {} })).toEqual({ a: true, b: false });
  });

  it('is nothing for what is not an object', () => {
    for (const raw of [null, undefined, 'x', 3, [true], true]) expect(cleanFolds(raw), String(raw)).toEqual({});
  });

  it('drops ids that are too long, and stops at the limit', () => {
    expect(cleanFolds({ [`x${'y'.repeat(400)}`]: true, ok: true })).toEqual({ ok: true });
    const many = Object.fromEntries(Array.from({ length: FOLDS_LIMIT + 20 }, (_, n) => [`g${n}`, true]));
    expect(Object.keys(cleanFolds(many))).toHaveLength(FOLDS_LIMIT);
  });
});

describe('what is remembered', () => {
  it('is kept per workspace, and read back', () => {
    const data = stubStorage();
    writeFolds('demo', { 'lane:documents': true });
    writeFolds('other', { 'checkpoint:one': false });
    expect(foldsKey('demo')).not.toBe(foldsKey('other'));
    expect(JSON.parse(data.get(foldsKey('demo'))!)).toEqual({ 'lane:documents': true });
    expect(readFolds('demo')).toEqual({ 'lane:documents': true });
    expect(readFolds('other')).toEqual({ 'checkpoint:one': false });
    expect(readFolds('third')).toEqual({});
  });

  it('is removed when nothing is left of it', () => {
    const data = stubStorage();
    writeFolds('demo', { 'lane:documents': true });
    writeFolds('demo', {});
    expect(data.has(foldsKey('demo'))).toBe(false);
  });

  it('is the defaults when what is stored is not usable', () => {
    for (const stored of ['not json', '[1,2]', '"x"', 'null', '{"a":"yes"}']) {
      stubStorage({ [foldsKey('demo')]: stored });
      expect(readFolds('demo'), stored).toEqual({});
    }
  });

  it('is the defaults, and does not fail, when the storage is not there', () => {
    stubStorage({}, true);
    expect(readFolds('demo')).toEqual({});
    expect(() => writeFolds('demo', { a: true })).not.toThrow();
    vi.unstubAllGlobals();
    // No browser storage at all, as in a private window with it blocked.
    vi.stubGlobal('window', {});
    expect(readFolds('demo')).toEqual({});
    expect(() => writeFolds('demo', { a: true })).not.toThrow();
  });
});
