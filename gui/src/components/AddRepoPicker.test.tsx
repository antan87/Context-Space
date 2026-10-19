import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddRepoPicker, AddRepoPopupContent } from './AddRepoPicker.js';
import type { RepoInfo } from '../types.js';

describe('AddRepoPicker component', () => {
  const mockRepos: RepoInfo[] = [
    {
      name: 'alpha-service',
      path: '/home/dev/projects/alpha-service',
      defaultBranch: 'main',
    },
    {
      name: 'beta-ui',
      path: '/home/dev/projects/beta-ui',
      defaultBranch: 'develop',
    },
  ];

  afterEach(() => {
    // @ts-expect-error cleanup global mock
    delete (globalThis as any).window?.contextspaceBridge;
    // @ts-expect-error cleanup global mock
    delete (globalThis as any).window?.nexusBridge;
  });

  it('renders "Add repository" button even when repos list is empty', () => {
    const onAdd = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AddRepoPicker, {
        repos: [],
        disabled: false,
        onAdd,
      }),
    );

    expect(html).toContain('Add repository');
  });

  it('renders "Add repository" button when repos are available', () => {
    const onAdd = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AddRepoPicker, {
        repos: mockRepos,
        disabled: false,
        onAdd,
      }),
    );

    expect(html).toContain('Add repository');
  });

  it('disables the trigger button when disabled prop is true', () => {
    const onAdd = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AddRepoPicker, {
        repos: mockRepos,
        disabled: true,
        onAdd,
      }),
    );

    expect(html).toContain('disabled');
  });

  it('renders empty state guidance when popup content is open and repos list is empty', () => {
    const onAdd = vi.fn();
    const setQuery = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AddRepoPopupContent, {
        repos: [],
        query: '',
        setQuery,
        onAdd,
      }),
    );

    expect(html).toContain('No repositories scanned. Type a path above or browse to attach a repo.');
  });

  it('renders list of available repos when open', () => {
    const onAdd = vi.fn();
    const setQuery = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AddRepoPopupContent, {
        repos: mockRepos,
        query: '',
        setQuery,
        onAdd,
      }),
    );

    expect(html).toContain('alpha-service');
    expect(html).toContain('/home/dev/projects/alpha-service');
    expect(html).toContain('beta-ui');
  });

  it('renders custom path addition option when query does not match any existing repo', () => {
    const onAdd = vi.fn();
    const setQuery = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AddRepoPopupContent, {
        repos: mockRepos,
        query: '/opt/repos/new-microservice',
        setQuery,
        onAdd,
      }),
    );

    expect(html).toContain('Add repository at');
    expect(html).toContain('&quot;/opt/repos/new-microservice&quot;');
  });

  it('filters repos by query and hides custom option when query is an exact match', () => {
    const onAdd = vi.fn();
    const setQuery = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AddRepoPopupContent, {
        repos: mockRepos,
        query: 'alpha-service',
        setQuery,
        onAdd,
      }),
    );

    expect(html).toContain('alpha-service');
    expect(html).not.toContain('beta-ui');
    expect(html).not.toContain('Add repository at');
  });

  it('renders "Browse folder…" button when desktopFolderPicker is available via contextspaceBridge', () => {
    const mockPick = vi.fn().mockResolvedValue('/home/dev/projects/picked-repo');
    if (typeof (globalThis as any).window === 'undefined') {
      (globalThis as any).window = {};
    }
    (globalThis as any).window.contextspaceBridge = {
      pickDirectory: mockPick,
    };

    const onAdd = vi.fn();
    const setQuery = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AddRepoPopupContent, {
        repos: mockRepos,
        query: '',
        setQuery,
        onAdd,
      }),
    );

    expect(html).toContain('Browse folder…');
  });
});
