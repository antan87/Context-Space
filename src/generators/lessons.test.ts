import { describe, it, expect } from 'vitest';

import { buildContextContent } from './base.js';
import { LESSONS_HEADING, LESSONS_MAX, renderLessonsSection, withLessonsSection } from './lessons.js';
import type { KnowledgeLesson } from '../core/knowledge.js';
import type { WorkspaceContext } from '../types.js';

const lesson = (title: string, type: KnowledgeLesson['type'] = 'gotcha'): KnowledgeLesson => ({ title, type });

function contextWith(lessons?: KnowledgeLesson[]): WorkspaceContext {
  return {
    feature: {
      id: 'feat',
      branchName: 'feat',
      description: 'add a discount code to checkout',
      repos: ['/repos/api'],
      assistants: ['claude'],
      workspacePath: '/ws',
      createdAt: '2026-07-17T00:00:00.000Z',
    },
    repos: [{ name: 'api', path: '/repos/api', defaultBranch: 'main' }],
    ...(lessons ? { lessons } : {}),
  };
}

describe('renderLessonsSection', () => {
  it('is empty when there is nothing to list', () => {
    expect(renderLessonsSection([])).toBe('');
  });

  it('lists one line per entry, in the order given, with its type and title', () => {
    const section = renderLessonsSection([lesson('Second one', 'decision'), lesson('First one')]);

    expect(section).toBe([
      LESSONS_HEADING,
      '',
      'Newest first. Read an entry in full with `ctxspace knowledge search <words>`.',
      '',
      '- decision: Second one',
      '- gotcha: First one',
      '',
      '',
    ].join('\n'));
  });

  it('labels a lesson from a repo with the repo, after the workspace\'s own, and says so in the line above the list', () => {
    const section = renderLessonsSection([lesson('Own entry'), { title: 'Port clash', type: 'decision', repo: 'api' }]);

    expect(section).toContain('Newest first, the workspace\'s own before the repos\'. Read an entry in full');
    expect(section).toContain('- gotcha: Own entry\n- decision (api): Port clash\n');
    expect(renderLessonsSection([lesson('Own entry')])).not.toContain('repos');
  });

  it('cuts a long repo name, so the label cannot crowd out the title', () => {
    expect(renderLessonsSection([{ title: 'Port clash', type: 'gotcha', repo: 'a-very-long-repository-name-indeed' }]))
      .toContain('- gotcha (a-very-long-reposit…): Port clash\n');
  });

  it('shares one cap of 25 between the workspace\'s own lessons and the repos\'', () => {
    const own = Array.from({ length: 20 }, (_, i) => lesson(`Own ${i + 1}`));
    const repo = Array.from({ length: 10 }, (_, i): KnowledgeLesson => ({ title: `Repo ${i + 1}`, type: 'gotcha', repo: 'api' }));

    const section = renderLessonsSection([...own, ...repo]);

    expect(section.split('\n').filter((line) => line.startsWith('- gotcha'))).toHaveLength(25);
    expect(section).toContain('- gotcha (api): Repo 5\n');
    expect(section).not.toContain('Repo 6');
    expect(section).toContain('- …and 5 older ones.');
  });

  it('lists at most the newest 25 and counts the older ones', () => {
    const lessons = Array.from({ length: LESSONS_MAX + 1 }, (_, i) => lesson(`Entry ${i + 1}`));

    const section = renderLessonsSection(lessons);

    expect(section.split('\n').filter((line) => line.startsWith('- gotcha:'))).toHaveLength(LESSONS_MAX);
    expect(section).toContain('- …and 1 older one.');
    expect(renderLessonsSection(lessons.slice(0, LESSONS_MAX))).not.toContain('older');
  });

  it('keeps a title to one line, however it was written', () => {
    expect(renderLessonsSection([lesson('Two\n  lines\there')])).toContain('- gotcha: Two lines here\n');
  });
});

describe('withLessonsSection', () => {
  const lessons = [lesson('Plan md has its own lock'), lesson('The plan is plan md', 'decision')];

  it('gives the same text as generating the file with those lessons', async () => {
    const without = await buildContextContent(contextWith());
    const generated = await buildContextContent(contextWith(lessons));

    expect(withLessonsSection(without, lessons)).toBe(generated);
  });

  it('gives the same text as generating the file with lessons from repos too', async () => {
    const mixed = [lesson('Own entry'), { title: 'Port clash', type: 'gotcha' as const, repo: 'api' }];

    expect(withLessonsSection(await buildContextContent(contextWith()), mixed)).toBe(await buildContextContent(contextWith(mixed)));
  });

  it('puts a changed list right, and removes the section when no entry is left', async () => {
    const generated = await buildContextContent(contextWith(lessons));
    const more = [lesson('A newer entry'), ...lessons];

    expect(withLessonsSection(generated, more)).toBe(await buildContextContent(contextWith(more)));
    expect(withLessonsSection(generated, [])).toBe(await buildContextContent(contextWith()));
  });

  it('changes nothing when the list is already right', async () => {
    const generated = await buildContextContent(contextWith(lessons));

    expect(withLessonsSection(generated, lessons)).toBe(generated);
  });

  it('keeps everything around the section as it was, including a stale banner', async () => {
    const generated = await buildContextContent(contextWith());
    const banner = '<!-- CONTEXTSPACE:FRESHNESS:START -->\n> **STALE**\n<!-- CONTEXTSPACE:FRESHNESS:END -->\n\n';

    const updated = withLessonsSection(`${banner}${generated}`, lessons);

    expect(updated.startsWith(banner)).toBe(true);
    expect(updated.replace(renderLessonsSection(lessons), '')).toBe(`${banner}${generated}`);
  });

  it('keeps the line endings of a file checked out with CRLF', async () => {
    const generated = (await buildContextContent(contextWith())).replace(/\n/g, '\r\n');

    const updated = withLessonsSection(generated, lessons);

    expect(updated).toContain(`${LESSONS_HEADING}\r\n`);
    expect(/[^\r]\n/.test(updated)).toBe(false);
  });

  it('leaves text that is not AGENTS.md as it is', () => {
    const notes = '# My notes\n\nNothing about where to look.\n';

    expect(withLessonsSection(notes, lessons)).toBe(notes);
    expect(withLessonsSection(notes, [])).toBe(notes);
  });
});
