import { describe, expect, it } from 'vitest';
import { toErrorMessage } from './errors.js';

describe('gui/lib/errors', () => {
  it('extracts message from Error instance', () => {
    expect(toErrorMessage(new Error('Network error'))).toBe('Network error');
  });

  it('falls back when Error message is empty', () => {
    expect(toErrorMessage(new Error(''), 'Default error')).toBe('Default error');
  });

  it('extracts non-empty string error', () => {
    expect(toErrorMessage('Failed to connect')).toBe('Failed to connect');
  });

  it('falls back when string error is whitespace only', () => {
    expect(toErrorMessage('   ', 'Default error')).toBe('Default error');
  });

  it('extracts message property from plain object', () => {
    expect(toErrorMessage({ message: 'Resource not found' })).toBe('Resource not found');
  });

  it('extracts error property from plain object', () => {
    expect(toErrorMessage({ error: 'Validation failed' })).toBe('Validation failed');
  });

  it('returns fallback for null, undefined, and non-error objects', () => {
    expect(toErrorMessage(null, 'Fallback')).toBe('Fallback');
    expect(toErrorMessage(undefined, 'Fallback')).toBe('Fallback');
    expect(toErrorMessage({}, 'Fallback')).toBe('Fallback');
    expect(toErrorMessage(42, 'Fallback')).toBe('Fallback');
  });
});
