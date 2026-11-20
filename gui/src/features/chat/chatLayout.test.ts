import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'contextspace_chat_layout_v1';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, api: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } } };
}
async function load(initial: Record<string, string> = {}) {
  const storage = fakeStorage(initial);
  vi.stubGlobal('localStorage', storage.api);
  vi.resetModules();
  return { ...(await import('./chatLayout')), storage };
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('chatLayout', () => {
  it('starts with the chat shown at its default width', async () => {
    const { chatLayout, CHAT_LAYOUT } = await load();
    expect(chatLayout.get()).toEqual({ hidden: false, percent: CHAT_LAYOUT.defaultPercent });
  });

  it('keeps the width within its limits, and ignores a width that is not a number', async () => {
    const { chatLayout, CHAT_LAYOUT, clampChatPercent } = await load();
    chatLayout.setPercent(5);
    expect(chatLayout.get().percent).toBe(CHAT_LAYOUT.minPercent);
    chatLayout.setPercent(99);
    expect(chatLayout.get().percent).toBe(CHAT_LAYOUT.maxPercent);
    chatLayout.setPercent(51.6);
    expect(chatLayout.get().percent).toBe(52);
    // The chat splits the screen equally by default.
    expect(CHAT_LAYOUT.defaultPercent).toBe(50);
    expect(clampChatPercent(Number.NaN)).toBe(CHAT_LAYOUT.defaultPercent);
    expect(clampChatPercent(Number.POSITIVE_INFINITY)).toBe(CHAT_LAYOUT.defaultPercent);
  });

  it('hides and shows the chat, and remembers both choices', async () => {
    const first = await load();
    first.chatLayout.toggleHidden();
    first.chatLayout.setPercent(55);
    expect(first.chatLayout.get()).toEqual({ hidden: true, percent: 55 });
    const second = await load({ [KEY]: first.storage.data.get(KEY)! });
    expect(second.chatLayout.get()).toEqual({ hidden: true, percent: 55 });
    second.chatLayout.setHidden(false);
    expect(second.chatLayout.get().hidden).toBe(false);
  });

  it('wakes nobody, and saves nothing, when a change changes nothing', async () => {
    const { chatLayout, storage } = await load();
    const listener = vi.fn();
    chatLayout.subscribe(listener);
    chatLayout.setHidden(false);
    chatLayout.setPercent(chatLayout.get().percent);
    expect(listener).not.toHaveBeenCalled();
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('starts from the default when what was saved is unreadable or out of range', async () => {
    expect((await load({ [KEY]: '{nope' })).chatLayout.get()).toEqual({ hidden: false, percent: 50 });
    expect((await load({ [KEY]: JSON.stringify({ hidden: 'yes', percent: 500 }) })).chatLayout.get()).toEqual({ hidden: false, percent: 75 });
    expect((await load({ [KEY]: JSON.stringify({ percent: 'wide' }) })).chatLayout.get().percent).toBe(50);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    vi.resetModules();
    const { chatLayout } = await import('./chatLayout');
    expect(() => chatLayout.setHidden(true)).not.toThrow();
    expect(chatLayout.get().hidden).toBe(true);
  });

  it('says whether a page is wide enough for a part beside the chat', async () => {
    const { hasRoomBeside, CHAT_LAYOUT } = await load();
    expect(hasRoomBeside(CHAT_LAYOUT.besideMinPx)).toBe(true);
    expect(hasRoomBeside(CHAT_LAYOUT.besideMinPx - 1)).toBe(false);
    expect(hasRoomBeside(0)).toBe(false);
  });
});

describe('fittingChatPercent', () => {
  it('holds the saved share back so the panel, divider and rail fit, and gives it back on a wider body', async () => {
    const { fittingChatPercent } = await load();
    expect(fittingChatPercent(75, 1044)).toBe(Math.floor(((1044 - 360 - 52) / 1044) * 100));
    expect(fittingChatPercent(75, 1044) * 1044 / 100 + 360 + 52).toBeLessThanOrEqual(1044);
    expect(fittingChatPercent(75, 2000)).toBe(75);
    expect(fittingChatPercent(50, 1044)).toBe(50);
    expect(fittingChatPercent(75, 0)).toBe(75);
    expect(fittingChatPercent(Number.NaN, 1044)).toBe(50);
  });
});
