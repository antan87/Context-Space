import { describe, expect, it, vi } from 'vitest';

import { chatPath, dockLandingAction, parseWorkspacePath, pathForSwitchingTo, showsChatFor, showsChatOf, workspacePath } from './chatRoute';

describe('chatPath', () => {
  it('names the chat section of a workspace, encoding its name', () => {
    expect(chatPath('alpha')).toBe('/workspaces/alpha/chat');
    expect(chatPath('feature/x y')).toBe('/workspaces/feature%2Fx%20y/chat');
  });
});

describe('showsChatOf', () => {
  it('is true for the chat section, with or without a trailing slash, and not for no section, which opens the plan', () => {
    expect(showsChatOf('/workspaces/alpha/chat', 'alpha')).toBe(true);
    expect(showsChatOf('/workspaces/alpha', 'alpha')).toBe(false);
    expect(showsChatOf('/workspaces/alpha/', 'alpha')).toBe(false);
    expect(showsChatOf('/workspaces/alpha/chat/', 'alpha')).toBe(true);
    expect(showsChatOf(chatPath('feature/x y'), 'feature/x y')).toBe(true);
  });

  it('is false for another section, another workspace, or another page', () => {
    expect(showsChatOf('/workspaces/alpha/plan', 'alpha')).toBe(false);
    expect(showsChatOf('/workspaces/alpha/sessions', 'alpha')).toBe(false);
    expect(showsChatOf('/workspaces/beta/chat', 'alpha')).toBe(false);
    expect(showsChatOf('/workspaces/alphabet', 'alpha')).toBe(false);
    expect(showsChatOf('/workspaces/alpha/chat/extra', 'alpha')).toBe(false);
    expect(showsChatOf('/overview', 'alpha')).toBe(false);
    expect(showsChatOf('/workspaces', 'alpha')).toBe(false);
  });
});

describe('dock navigation marks', () => {
  const fresh = async () => {
    vi.resetModules();
    return import('./chatRoute');
  };

  it('call the newest navigation the dock made current, once', async () => {
    const { dockNavigationState, judgeDockLanding } = await fresh();
    const mark = dockNavigationState();
    expect(judgeDockLanding(mark)).toBe('current');
    // The same landing seen again is no longer news.
    expect(judgeDockLanding(mark)).toBe('external');
  });

  it('call a navigation stale once a newer one has been made, so only the newest acts', async () => {
    const { dockNavigationState, judgeDockLanding } = await fresh();
    const first = dockNavigationState();
    const second = dockNavigationState();
    const third = dockNavigationState();
    // The router may apply them in turn, and each is judged against the newest one made.
    expect(judgeDockLanding(first)).toBe('stale');
    expect(judgeDockLanding(second)).toBe('stale');
    expect(judgeDockLanding(third)).toBe('current');
  });

  it('judge an older landing that arrives after a newer one as no longer news', async () => {
    const { dockNavigationState, judgeDockLanding } = await fresh();
    const first = dockNavigationState();
    const second = dockNavigationState();
    expect(judgeDockLanding(second)).toBe('current');
    expect(judgeDockLanding(first)).toBe('external');
  });

  it('call a landing current again when a newer navigation is made after an older one landed', async () => {
    const { dockNavigationState, judgeDockLanding } = await fresh();
    expect(judgeDockLanding(dockNavigationState())).toBe('current');
    expect(judgeDockLanding(dockNavigationState())).toBe('current');
  });

  it('never count an address the user reached another way', async () => {
    const { judgeDockLanding } = await fresh();
    for (const state of [undefined, null, {}, { chatDock: 'x' }, { chatDock: Number.NaN }, { chatDock: Number.POSITIVE_INFINITY }, { other: 1 }, 'text', 7]) {
      expect(judgeDockLanding(state), JSON.stringify(state)).toBe('external');
    }
  });

  it('treat a number left in history by an earlier visit, which Back returns to, as the user\'s own', async () => {
    const { judgeDockLanding } = await fresh();
    expect(judgeDockLanding({ chatDock: 1 })).toBe('external');
    expect(judgeDockLanding({ chatDock: Date.now() - 60_000 })).toBe('external');
  });

  it('go to a chat as the dock, numbered, with push by default and replace when asked', async () => {
    const { goToChat, judgeDockLanding } = await fresh();
    const calls: Array<[string, { replace?: boolean; state?: unknown }]> = [];
    const navigate = ((to: string, options: { replace?: boolean; state?: unknown }) => { calls.push([to, options]); }) as never;
    goToChat(navigate, 'alpha');
    goToChat(navigate, 'beta gamma', { replace: true });
    expect(calls[0]![0]).toBe('/workspaces/alpha/chat');
    expect(calls[0]![1].replace).toBe(false);
    expect(calls[1]![0]).toBe('/workspaces/beta%20gamma/chat');
    expect(calls[1]![1].replace).toBe(true);
    // The first is already replaced by the second.
    expect(judgeDockLanding(calls[0]![1].state)).toBe('stale');
    expect(judgeDockLanding(calls[1]![1].state)).toBe('current');
  });
});

describe('browserPath', () => {
  it('reads the path out of the address the browser is at, without the hash sign, query or later hash', async () => {
    const { browserPath } = await import('./chatRoute');
    expect(browserPath('#/workspaces/alpha/chat')).toBe('/workspaces/alpha/chat');
    expect(browserPath('#/workspaces/alpha?x=1')).toBe('/workspaces/alpha');
    expect(browserPath('#/workspaces/alpha#top')).toBe('/workspaces/alpha');
    expect(browserPath('')).toBe('');
    expect(browserPath('#')).toBe('');
  });

  it('agrees with showsChatOf about which address is a workspace\'s chat', async () => {
    const { browserPath, showsChatOf } = await import('./chatRoute');
    expect(showsChatOf(browserPath('#/workspaces/alpha'), 'alpha')).toBe(false);
    expect(showsChatOf(browserPath('#/workspaces/alpha/chat'), 'alpha')).toBe(true);
    expect(showsChatOf(browserPath('#/workspaces/beta/chat'), 'alpha')).toBe(false);
  });
});

describe('parseWorkspacePath', () => {
  it('names the workspace and the section, and a missing section is the plan, where a workspace opens', () => {
    expect(parseWorkspacePath('/workspaces/alpha')).toEqual({ workspace: 'alpha', section: 'plan' });
    expect(parseWorkspacePath('/workspaces/alpha/')).toEqual({ workspace: 'alpha', section: 'plan' });
    expect(parseWorkspacePath('/workspaces/alpha/plan')).toEqual({ workspace: 'alpha', section: 'plan' });
    expect(parseWorkspacePath('/workspaces/feature%2Fx%20y/changes')).toEqual({ workspace: 'feature/x y', section: 'changes' });
  });

  it('is null for any other address, and for one that cannot be decoded', () => {
    for (const path of ['', '/', '/overview', '/workspaces', '/workspaces/', '/workspaces/a/b/c', '/new?from=chat', '/workspaces/%E0%A4%A']) {
      expect(parseWorkspacePath(path), path).toBeNull();
    }
  });
});

describe('showsChatFor', () => {
  it('is true for the workspace\'s own chat, whether or not the chat is known to be on screen', () => {
    expect(showsChatFor('/workspaces/alpha/chat', 'alpha', false)).toBe(true);
    // No section opens the plan: the chat is there only when it shows beside it.
    expect(showsChatFor('/workspaces/alpha', 'alpha', false)).toBe(false);
    expect(showsChatFor('/workspaces/alpha', 'alpha', true)).toBe(true);
  });

  it('is true for another part of the same workspace only while the chat is showing beside it', () => {
    expect(showsChatFor('/workspaces/alpha/plan', 'alpha', true)).toBe(true);
    expect(showsChatFor('/workspaces/alpha/plan', 'alpha', false)).toBe(false);
  });

  it('is false for any other workspace or page, even when the chat is on screen', () => {
    expect(showsChatFor('/workspaces/beta/plan', 'alpha', true)).toBe(false);
    expect(showsChatFor('/workspaces/beta/chat', 'alpha', true)).toBe(false);
    expect(showsChatFor('/overview', 'alpha', true)).toBe(false);
  });

  it('agrees with showsChatOf about the chat section itself', () => {
    expect(showsChatOf('/workspaces/alpha/plan', 'alpha')).toBe(false);
    expect(showsChatOf('/workspaces/alpha/chat', 'alpha')).toBe(true);
  });
});

describe('dockLandingAction', () => {
  const open = ['alpha', 'beta'];

  it('opens the chat an address names when the user got there themselves, open or not', () => {
    expect(dockLandingAction('external', 'alpha', open, 'beta')).toBe('reveal');
    expect(dockLandingAction('external', 'gamma', open, 'beta')).toBe('reveal');
    expect(dockLandingAction('external', 'gamma', [], null)).toBe('reveal');
  });

  it('follows the dock\'s own newest navigation to a chat that is open', () => {
    expect(dockLandingAction('current', 'alpha', open, 'beta')).toBe('reveal');
  });

  it('does not reopen a chat the user closed after the dock navigated to it, and moves on to the chat they are on', () => {
    expect(dockLandingAction('current', 'gamma', open, 'beta')).toBe('redirect');
  });

  it('leaves the address alone when a closed chat is the dock\'s newest landing and no other chat is on screen', () => {
    expect(dockLandingAction('current', 'gamma', [], null)).toBe('ignore');
    expect(dockLandingAction('current', 'gamma', open, 'gamma')).toBe('ignore');
  });

  it('ignores a landing a newer navigation has replaced, open chat or not, so it can add no tab', () => {
    expect(dockLandingAction('stale', 'alpha', open, 'beta')).toBe('ignore');
    expect(dockLandingAction('stale', 'gamma', open, 'beta')).toBe('ignore');
    expect(dockLandingAction('stale', 'gamma', [], null)).toBe('ignore');
  });
});

describe('workspacePath', () => {
  it('gives the chat its own address and names every other part after it', () => {
    expect(workspacePath('alpha')).toBe('/workspaces/alpha/chat');
    expect(workspacePath('alpha', 'chat')).toBe('/workspaces/alpha/chat');
    expect(workspacePath('alpha', 'plan')).toBe('/workspaces/alpha/plan');
    expect(workspacePath('feature/x y', 'changes')).toBe('/workspaces/feature%2Fx%20y/changes');
  });
});

describe('pathForSwitchingTo', () => {
  it('keeps the part being read, for the other workspace', () => {
    expect(pathForSwitchingTo('beta', '/workspaces/alpha/plan')).toBe('/workspaces/beta/plan');
    expect(pathForSwitchingTo('beta', '/workspaces/alpha/changes')).toBe('/workspaces/beta/changes');
    expect(pathForSwitchingTo('beta', '/workspaces/alpha/chat')).toBe('/workspaces/beta/chat');
  });

  it('opens the plan from a page that is not a workspace, or a workspace with no part named', () => {
    expect(pathForSwitchingTo('beta', '/overview')).toBe('/workspaces/beta/plan');
    expect(pathForSwitchingTo('beta', '/workspaces/alpha')).toBe('/workspaces/beta/plan');
    expect(pathForSwitchingTo('beta', '/settings')).toBe('/workspaces/beta/plan');
  });

  it('is not fooled by a workspace whose name starts with chat', () => {
    // The old rule asked whether the address contained "/chat", which is true here though the user is reading the plan.
    expect(pathForSwitchingTo('beta', '/workspaces/chat-fix/plan')).toBe('/workspaces/beta/plan');
    expect(pathForSwitchingTo('chat-fix', '/workspaces/alpha/plan')).toBe('/workspaces/chat-fix/plan');
  });

  it('encodes the workspace it goes to', () => {
    expect(pathForSwitchingTo('feature/x y', '/workspaces/alpha/plan')).toBe('/workspaces/feature%2Fx%20y/plan');
  });
});
