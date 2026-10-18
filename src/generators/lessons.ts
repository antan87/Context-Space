/**
 * @module generators/lessons
 * The "Lessons from earlier sessions" section of AGENTS.md: the title of each recorded knowledge entry, newest first, the
 * workspace's own and then those its repos carry in their base knowledge, so every session starts knowing what was
 * learned, and still knows after its context is compacted. A title is a pointer; the entry itself is one
 * `knowledge search` away.
 */

import type { KnowledgeLesson } from '../core/knowledge.js';
import { CLI_NAME } from '../core/constants.js';

/** The heading AGENTS.md carries the lessons under. */
export const LESSONS_HEADING = '## Lessons from earlier sessions';
/** The heading the lessons are placed before when AGENTS.md has none yet. */
const NEXT_HEADING = '## Where to look';
/** Most titles listed. The older ones are one search away. */
export const LESSONS_MAX = 25;
/** Longest a title is listed; a longer one written by hand is cut. */
const TITLE_MAX = 60;
/** Longest a repo's name is listed. */
const REPO_MAX = 20;

function shortened(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** `gotcha: Title` for the workspace's own entry, `gotcha (api): Title` for one from a repo's base knowledge. */
function listedLesson(lesson: KnowledgeLesson): string {
  return `- ${lesson.type}${lesson.repo ? ` (${shortened(lesson.repo, REPO_MAX)})` : ''}: ${shortened(lesson.title, TITLE_MAX)}`;
}

/**
 * The section as AGENTS.md carries it, ending in a blank line so the next heading can follow it, or the empty string
 * when there is nothing to list. The lessons are listed in the order given, up to {@link LESSONS_MAX} of them: the
 * workspace's own, then those from its repos' base knowledge.
 */
export function renderLessonsSection(lessons: readonly KnowledgeLesson[]): string {
  if (!lessons.length) return '';
  const lines = lessons.slice(0, LESSONS_MAX).map(listedLesson);
  const cut = lessons.length - LESSONS_MAX;
  if (cut > 0) lines.push(`- …and ${cut} older ${cut === 1 ? 'one' : 'ones'}.`);
  const order = lessons.some((lesson) => lesson.repo) ? ", the workspace's own before the repos'" : '';
  return [
    LESSONS_HEADING,
    '',
    `Newest first${order}. Read an entry in full with \`${CLI_NAME} knowledge search <words>\`.`,
    '',
    ...lines,
    '',
    '',
  ].join('\n');
}

/**
 * AGENTS.md (or a view copied from it) with its lessons replaced by `lessons`: the section is put right, added before
 * "Where to look", or removed when there are none. Content with neither a lessons section nor "Where to look" is not
 * AGENTS.md text and is returned as it is.
 */
export function withLessonsSection(content: string, lessons: readonly KnowledgeLesson[]): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  // The section ends in a blank line, which the split leaves as a final empty element.
  const section = renderLessonsSection(lessons).split('\n').slice(0, -1);

  const start = lines.findIndex((line) => line.trimEnd() === LESSONS_HEADING);
  if (start >= 0) {
    const next = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line));
    const end = next < 0 ? lines.length : next;
    return [...lines.slice(0, start), ...section, ...lines.slice(end)].join(eol);
  }
  if (!section.length) return content;
  const anchor = lines.findIndex((line) => line.trimEnd() === NEXT_HEADING);
  if (anchor < 0) return content;
  return [...lines.slice(0, anchor), ...section, ...lines.slice(anchor)].join(eol);
}
