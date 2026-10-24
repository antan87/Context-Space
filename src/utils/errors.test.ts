import { describe, expect, it } from 'vitest';
import { toErrorMessage, getErrorCode } from './errors.js';

describe('utils/errors', () => {
  describe('toErrorMessage', () => {
    it('extracts message from standard Error instance', () => {
      expect(toErrorMessage(new Error('something went wrong'))).toBe('something went wrong');
    });

    it('extracts message from custom Error subclass', () => {
      class CustomError extends Error {}
      expect(toErrorMessage(new CustomError('custom error'))).toBe('custom error');
    });

    it('falls back to Error name if message is empty', () => {
      expect(toErrorMessage(new Error(''))).toBe('Error');
      class SpecificError extends Error {
        constructor() {
          super('');
          this.name = 'SpecificError';
        }
      }
      expect(toErrorMessage(new SpecificError())).toBe('SpecificError');
    });

    it('returns string unchanged if error is string', () => {
      expect(toErrorMessage('raw error string')).toBe('raw error string');
    });

    it('extracts message from plain object with message property', () => {
      expect(toErrorMessage({ message: 'object error' })).toBe('object error');
      expect(toErrorMessage({ message: 404 })).toBe('404');
    });

    it('extracts error from object with string error property', () => {
      expect(toErrorMessage({ error: 'API rate limit exceeded' })).toBe('API rate limit exceeded');
    });

    it('extracts error from object with Error error property', () => {
      expect(toErrorMessage({ error: new Error('nested error') })).toBe('nested error');
    });

    it('serializes objects without message as JSON when possible', () => {
      expect(toErrorMessage({ code: 'ECONNREFUSED', port: 3000 })).toBe('{"code":"ECONNREFUSED","port":3000}');
    });

    it('falls back to String(error) for primitives and empty objects', () => {
      expect(toErrorMessage(null)).toBe('null');
      expect(toErrorMessage(undefined)).toBe('undefined');
      expect(toErrorMessage(123)).toBe('123');
      expect(toErrorMessage({})).toBe('[object Object]');
    });

    it('handles circular objects gracefully without throwing', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(toErrorMessage(circular)).toBe('[object Object]');
    });
  });

  describe('getErrorCode', () => {
    it('extracts code from error object', () => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      expect(getErrorCode(err)).toBe('ENOENT');
    });

    it('extracts code from plain object with code property', () => {
      expect(getErrorCode({ code: 'EPERM' })).toBe('EPERM');
      expect(getErrorCode({ code: 123 })).toBe('123');
    });

    it('returns undefined when code is undefined or null', () => {
      expect(getErrorCode({ code: undefined })).toBeUndefined();
      expect(getErrorCode({ code: null })).toBeUndefined();
    });

    it('returns undefined when code is missing or error is primitive', () => {
      expect(getErrorCode(new Error('no code'))).toBeUndefined();
      expect(getErrorCode(null)).toBeUndefined();
      expect(getErrorCode('ENOENT')).toBeUndefined();
      expect(getErrorCode(undefined)).toBeUndefined();
    });
  });
});
