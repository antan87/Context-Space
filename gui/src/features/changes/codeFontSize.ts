import { useCallback, useEffect, useState } from 'react';

export const DEFAULT_CODE_FONT_SIZE = 14;
export const MIN_CODE_FONT_SIZE = 11;
export const MAX_CODE_FONT_SIZE = 20;
export const CODE_FONT_SIZE_KEY = 'contextspace.code-panel.font-size';

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

const listeners = new Set<(size: number) => void>();

function notify(size: number) {
  for (const listener of listeners) {
    listener(size);
  }
}

export function clampCodeFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_CODE_FONT_SIZE;
  const rounded = Math.round(size);
  return Math.min(MAX_CODE_FONT_SIZE, Math.max(MIN_CODE_FONT_SIZE, rounded));
}

export function stepCodeFontSize(current: number, delta: number): number {
  const base = Number.isFinite(current) ? Math.round(current) : DEFAULT_CODE_FONT_SIZE;
  return clampCodeFontSize(base + delta);
}

export function readCodeFontSize(storage?: StorageReader | null): number {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return DEFAULT_CODE_FONT_SIZE;
    const raw = store.getItem(CODE_FONT_SIZE_KEY);
    if (raw === null || raw.trim() === '') return DEFAULT_CODE_FONT_SIZE;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < MIN_CODE_FONT_SIZE || parsed > MAX_CODE_FONT_SIZE) {
      return DEFAULT_CODE_FONT_SIZE;
    }
    return parsed;
  } catch {
    return DEFAULT_CODE_FONT_SIZE;
  }
}

let memoryFontSize: number | null = null;

export function getCodeFontSize(storage?: StorageReader | null): number {
  if (memoryFontSize === null) {
    memoryFontSize = readCodeFontSize(storage);
  }
  return memoryFontSize;
}

export function resetCodeFontSizeForTesting(size: number | null = null): void {
  memoryFontSize = size;
}

export function writeCodeFontSize(size: number, storage?: StorageWriter | null): number {
  const clamped = clampCodeFontSize(size);
  memoryFontSize = clamped;
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    store?.setItem(CODE_FONT_SIZE_KEY, String(clamped));
  } catch {
    // Storage write failures (quota exceeded, disabled) must not break the in-memory size
  }
  notify(clamped);
  return clamped;
}

export function subscribeCodeFontSize(listener: (size: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCodeFontSize(): [number, (next: number | ((prev: number) => number)) => void] {
  const [fontSize, setFontSizeState] = useState(() => getCodeFontSize());

  useEffect(() => {
    const unsubscribe = subscribeCodeFontSize(setFontSizeState);
    const onStorage = (event: StorageEvent) => {
      if (event.key === CODE_FONT_SIZE_KEY) {
        const next = readCodeFontSize();
        memoryFontSize = next;
        setFontSizeState(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setFontSize = useCallback((next: number | ((prev: number) => number)) => {
    const current = getCodeFontSize();
    const target = typeof next === 'function' ? next(current) : next;
    writeCodeFontSize(target);
  }, []);

  return [fontSize, setFontSize];
}
