import { expect, it } from 'vitest';
import { isVersionAfter } from './versions.js';

it('orders versions by major, minor and patch', () => {
  expect(isVersionAfter('2.42.0', '2.39.0')).toBe(true);
  expect(isVersionAfter('2.39.0', '2.42.0')).toBe(false);
  expect(isVersionAfter('2.42.0', '2.42.0')).toBe(false);
  expect(isVersionAfter('3.0.0', '2.99.99')).toBe(true);
  expect(isVersionAfter('2.10.0', '2.9.0')).toBe(true);
  expect(isVersionAfter('v2.42.1', '2.42.0')).toBe(true);
});

it('puts a prerelease below its release', () => {
  expect(isVersionAfter('2.42.0', '2.42.0-rc.1')).toBe(true);
  expect(isVersionAfter('2.42.0-rc.1', '2.42.0')).toBe(false);
  expect(isVersionAfter('2.43.0-rc.1', '2.42.0')).toBe(true);
});

it('never calls an unreadable version newer, and reads anything over nothing', () => {
  expect(isVersionAfter(undefined, '2.42.0')).toBe(false);
  expect(isVersionAfter('unknown', '2.42.0')).toBe(false);
  expect(isVersionAfter('2.42.0', undefined)).toBe(true);
  expect(isVersionAfter('2.42.0', 'unknown')).toBe(true);
  expect(isVersionAfter(undefined, undefined)).toBe(false);
});
