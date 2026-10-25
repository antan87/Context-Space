import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDelegatedRowClick, handleDelegatedRowKeyDown } from './delegatedRowClick.js';
import type React from 'react';

type MockElement = {
  tagName?: string;
  closest?: (selector: string) => unknown;
};

const makeMockElement = (tagName: string, matchesClosest: (selector: string) => unknown = () => null): MockElement => ({
  tagName,
  closest: matchesClosest,
});

describe('handleDelegatedRowClick', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('triggers action when clicked directly on the row', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');
    const event = {
      target: row,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(event, action);
    expect(action).toHaveBeenCalledOnce();
  });

  it('triggers action when clicked on a non-interactive child', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');
    const span = makeMockElement('SPAN');

    const event = {
      target: span,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(event, action);
    expect(action).toHaveBeenCalledOnce();
  });

  it('does NOT trigger action when text is selected', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');
    // Mock global window getSelection
    vi.stubGlobal('window', {
      getSelection: () => ({
        toString: () => 'some highlighted text',
      }),
    });

    const event = {
      target: row,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(event, action);
    expect(action).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does NOT trigger action when clicked on a child button', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');
    const button = makeMockElement('BUTTON');
    const icon = makeMockElement('SVG', (selector) => {
      if (selector.includes('button')) return button;
      return null;
    });

    const event = {
      target: icon,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(event, action);
    expect(action).not.toHaveBeenCalled();
  });

  it('does NOT trigger action when clicked on a child link or element with data-no-row-click', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');
    const link = makeMockElement('A', (selector) => (selector.includes('a') ? link : null));

    const linkEvent = {
      target: link,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(linkEvent, action);
    expect(action).not.toHaveBeenCalled();

    const ignoredDiv = makeMockElement('DIV', (selector) =>
      selector.includes('[data-no-row-click]') ? ignoredDiv : null
    );

    const divEvent = {
      target: ignoredDiv,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(divEvent, action);
    expect(action).not.toHaveBeenCalled();

    const preventDiv = makeMockElement('DIV', (selector) =>
      selector.includes('[data-prevent-row-click]') ? preventDiv : null
    );

    const preventEvent = {
      target: preventDiv,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(preventEvent, action);
    expect(action).not.toHaveBeenCalled();
  });

  it('does NOT trigger action on secondary or middle mouse click (e.button !== 0)', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');

    const rightClickEvent = {
      button: 2,
      target: row,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(rightClickEvent, action);
    expect(action).not.toHaveBeenCalled();

    const middleClickEvent = {
      button: 1,
      target: row,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(middleClickEvent, action);
    expect(action).not.toHaveBeenCalled();
  });

  it('handles target when target is a Text node without .closest', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');
    const parentSpan = makeMockElement('SPAN');
    const textNode = {
      nodeType: 3,
      parentElement: parentSpan,
    };

    const event = {
      button: 0,
      target: textNode,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(event, action);
    expect(action).toHaveBeenCalledOnce();
  });

  it('allows click if text is selected outside this row', () => {
    const action = vi.fn();
    const outsideNode = { name: 'outside' };
    const row = {
      tagName: 'DIV',
      contains: vi.fn((node) => node !== outsideNode),
      closest: () => null,
    };

    vi.stubGlobal('window', {
      getSelection: () => ({
        toString: () => 'some text elsewhere',
        anchorNode: outsideNode,
        focusNode: outsideNode,
      }),
    });

    const event = {
      button: 0,
      target: row,
      currentTarget: row,
    } as unknown as React.MouseEvent<HTMLElement>;

    handleDelegatedRowClick(event, action);
    expect(action).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe('handleDelegatedRowKeyDown', () => {
  it('triggers action on Enter or Space when focused on currentTarget', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');

    const enterEvent = {
      key: 'Enter',
      target: row,
      currentTarget: row,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;

    handleDelegatedRowKeyDown(enterEvent, action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(enterEvent.preventDefault).toHaveBeenCalled();

    const spaceEvent = {
      key: ' ',
      target: row,
      currentTarget: row,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;

    handleDelegatedRowKeyDown(spaceEvent, action);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('does not trigger on other keys, modifier combinations, or when target is inner element', () => {
    const action = vi.fn();
    const row = makeMockElement('DIV');
    const inner = makeMockElement('SPAN');

    const tabEvent = {
      key: 'Tab',
      target: row,
      currentTarget: row,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;

    handleDelegatedRowKeyDown(tabEvent, action);
    expect(action).not.toHaveBeenCalled();

    const ctrlEnterEvent = {
      key: 'Enter',
      ctrlKey: true,
      target: row,
      currentTarget: row,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;

    handleDelegatedRowKeyDown(ctrlEnterEvent, action);
    expect(action).not.toHaveBeenCalled();

    const innerEvent = {
      key: 'Enter',
      target: inner,
      currentTarget: row,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;

    handleDelegatedRowKeyDown(innerEvent, action);
    expect(action).not.toHaveBeenCalled();
  });
});
