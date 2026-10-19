import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddRepoPicker } from './AddRepoPicker.js';
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
});
