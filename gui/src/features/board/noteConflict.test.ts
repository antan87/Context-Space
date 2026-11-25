import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client.js';
import {
  conflictCurrent,
  isNoteConflict,
  pickNoteEditChanges,
  type NoteConflictCurrent,
  type NoteField,
  type NoteFormValues,
} from './noteConflict.js';

describe('a note save refused because the note changed meanwhile', () => {
  const current = {
    id: 'k3m9a2',
    title: 'Export notes',
    body: 'The AI added a finding.',
    pinned: true,
    area: 'checkpoint:c2docs',
    step: 's1step',
    rev: 2,
    updatedBy: 'claude',
  };

  it('is told apart from every other failure, and carries the note as it is now', () => {
    const conflict = new ApiError('changed', 409, { error: 'changed', code: 'rev_conflict', current });
    expect(isNoteConflict(conflict)).toBe(true);
    expect(conflictCurrent(conflict)).toEqual(current);
    for (const other of [
      new ApiError('busy', 503, { error: 'Busy, try again', code: 'busy' }),
      new ApiError('moved', 409, { error: 'moved', code: 'moved' }),
      new ApiError('stale board', 409, { error: 'x', code: 'stale_revision' }),
      new Error('network'),
    ]) expect(isNoteConflict(other)).toBe(false);
  });

  it('a conflict without a usable current note still counts, with nothing to show', () => {
    const bare = new ApiError('changed', 409, { error: 'changed', code: 'rev_conflict', current: null });
    expect(isNoteConflict(bare)).toBe(true);
    expect(conflictCurrent(bare)).toBeNull();
    expect(conflictCurrent(new ApiError('changed', 409, { code: 'rev_conflict', current: { title: 'x' } }))).toBeNull();
  });
});

describe('pickNoteEditChanges', () => {
  const initial: NoteFormValues = {
    title: 'Original Title',
    body: 'Original body.',
    pinned: false,
    area: 'checkpoint:alpha',
    step: 'step-one',
  };

  const resolvingBase: NoteConflictCurrent = {
    title: 'Original Title',
    body: 'Original body.',
    pinned: false,
    area: 'checkpoint:alpha',
    step: 'step-one',
    rev: 2,
    updatedBy: 'claude',
  };

  const touched = (...fields: NoteField[]) => new Set<NoteField>(fields);

  it('normal save diffs against initial values and ignores touched fields reverted back to initial', () => {
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('title', 'body'),
      rev: 1,
    })).toBeNull();

    expect(pickNoteEditChanges({
      current: { ...initial, title: '  Original Title  ' },
      initial,
      touched: touched('title'),
      rev: 1,
    })).toBeNull();

    expect(pickNoteEditChanges({
      current: { ...initial, body: 'New body', area: '', step: '' },
      initial,
      touched: touched('body', 'area', 'step'),
      rev: 1,
    })).toEqual({
      rev: 1,
      body: 'New body',
      area: null,
      step: null,
    });

    // Switch-off workspace (no rev) omits rev
    expect(pickNoteEditChanges({
      current: { ...initial, pinned: true },
      initial,
      touched: touched('pinned'),
    })).toEqual({ pinned: true });
  });

  it('Save yours over theirs sends only touched fields differing from theirs across all 12 revert combinations', () => {
    // 1. body reverted; AI changed body only
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('body'),
      rev: 2,
      resolving: { ...resolvingBase, body: 'AI body' },
    })).toEqual({ rev: 2, body: 'Original body.' });

    // 2. title reverted; AI changed title + body -> keeps AI body untouched
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('title'),
      rev: 2,
      resolving: { ...resolvingBase, title: 'AI Title', body: 'AI body' },
    })).toEqual({ rev: 2, title: 'Original Title' });

    // 3. body reverted; AI changed title + body -> keeps AI title untouched
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('body'),
      rev: 2,
      resolving: { ...resolvingBase, title: 'AI Title', body: 'AI body' },
    })).toEqual({ rev: 2, body: 'Original body.' });

    // 4. area reverted; AI moved area -> sends area
    expect(pickNoteEditChanges({
      current: { ...initial, step: '' },
      initial: { ...initial, step: '' },
      touched: touched('area'),
      rev: 2,
      resolving: { ...resolvingBase, area: 'checkpoint:gamma', step: undefined },
    })).toEqual({ rev: 2, area: 'checkpoint:alpha' });

    // 5. area reverted; AI changed body + area -> sends only area, keeps AI body
    expect(pickNoteEditChanges({
      current: { ...initial, step: '' },
      initial: { ...initial, step: '' },
      touched: touched('area'),
      rev: 2,
      resolving: { ...resolvingBase, body: 'AI body', area: 'checkpoint:gamma', step: undefined },
    })).toEqual({ rev: 2, area: 'checkpoint:alpha' });

    // 6. step reverted; AI cleared step -> sends step
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('step'),
      rev: 2,
      resolving: { ...resolvingBase, step: undefined },
    })).toEqual({ rev: 2, step: 'step-one' });

    // 7. step reverted; AI changed body + cleared step -> sends only step, keeps AI body
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('step'),
      rev: 2,
      resolving: { ...resolvingBase, body: 'AI body', step: undefined },
    })).toEqual({ rev: 2, step: 'step-one' });

    // 8. pinned reverted; AI changed body + pinned -> sends only pinned, keeps AI body
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('pinned'),
      rev: 2,
      resolving: { ...resolvingBase, body: 'AI body', pinned: true },
    })).toEqual({ rev: 2, pinned: false });

    // 9. pinned reverted; AI changed title + pinned -> sends only pinned, keeps AI title
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('pinned'),
      rev: 2,
      resolving: { ...resolvingBase, title: 'AI Title', pinned: true },
    })).toEqual({ rev: 2, pinned: false });

    // 10. title + body edited (title reverted); AI changed title + body + pinned -> saves both, keeps AI pin
    expect(pickNoteEditChanges({
      current: { ...initial, body: 'New body' },
      initial,
      touched: touched('title', 'body'),
      rev: 2,
      resolving: { ...resolvingBase, title: 'AI Title', body: 'AI body', pinned: true },
    })).toEqual({ rev: 2, title: 'Original Title', body: 'New body' });

    // 11. title + body edited (body reverted); AI changed title + body -> saves both
    expect(pickNoteEditChanges({
      current: { ...initial, title: 'New Title' },
      initial,
      touched: touched('title', 'body'),
      rev: 2,
      resolving: { ...resolvingBase, title: 'AI Title', body: 'AI body' },
    })).toEqual({ rev: 2, title: 'New Title', body: 'Original body.' });

    // 12. body + pinned edited (body reverted); AI changed body + pinned -> saves both
    expect(pickNoteEditChanges({
      current: { ...initial, pinned: true },
      initial,
      touched: touched('body', 'pinned'),
      rev: 2,
      resolving: { ...resolvingBase, body: 'AI body', pinned: false },
    })).toEqual({ rev: 2, body: 'Original body.', pinned: true });
  });

  it('handles area change that cleared step and returns null when no touched field differs from theirs', () => {
    // Area changed (clearing step) while AI kept original area/step and edited body -> sends area + step: null, keeps AI body
    expect(pickNoteEditChanges({
      current: { ...initial, area: 'checkpoint:beta', step: '' },
      initial,
      touched: touched('area', 'step'),
      rev: 2,
      resolving: { ...resolvingBase, body: 'AI body' },
    })).toEqual({ rev: 2, area: 'checkpoint:beta', step: null });

    // User touched body and reverted it, AI changed only pinned -> no touched field differs -> null
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched('body'),
      rev: 2,
      resolving: { ...resolvingBase, pinned: true },
    })).toBeNull();

    // User touched title and typed the exact same trimmed title AI saved -> null
    expect(pickNoteEditChanges({
      current: { ...initial, title: '  AI Title  ' },
      initial,
      touched: touched('title'),
      rev: 2,
      resolving: { ...resolvingBase, title: 'AI Title', body: 'AI body' },
    })).toBeNull();

    // Nothing touched -> null even when AI changed fields
    expect(pickNoteEditChanges({
      current: { ...initial },
      initial,
      touched: touched(),
      rev: 2,
      resolving: { ...resolvingBase, title: 'AI Title', body: 'AI body', pinned: true },
    })).toBeNull();
  });
});
