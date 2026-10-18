import { describe, expect, it } from 'vitest';
import { isUnreadableDocument, workspaceDocumentName } from './documentReference.js';

describe('workspaceDocumentName', () => {
  const posix = '/home/me/workspaces/audit';
  const windows = 'C:\\Users\\me\\workspaces\\audit';

  describe('with the folder the session runs in', () => {
    const repo = `${posix}/api`;

    it('reads a relative path from that folder, so a README printed inside a repository is the repository\'s', () => {
      expect(workspaceDocumentName({ path: 'README.md' }, posix, [repo], repo)).toBeNull();
      expect(workspaceDocumentName({ path: 'docs/guide.md' }, posix, [repo], repo)).toBeNull();
      expect(workspaceDocumentName({ path: './README.md' }, posix, [repo], `${repo}/`)).toBeNull();
    });

    it('reaches a workspace document from a subfolder, and from the root itself', () => {
      expect(workspaceDocumentName({ path: '../../notes.md' }, posix, [repo], `${repo}/gui`)).toBe('notes.md');
      expect(workspaceDocumentName({ path: 'notes.md' }, posix, [repo], posix)).toBe('notes.md');
      expect(workspaceDocumentName({ path: './docs/report.md' }, posix, [repo], `${posix}/`)).toBe('docs/report.md');
    });

    it('is not a workspace document when the session runs outside the workspace', () => {
      expect(workspaceDocumentName({ path: 'notes.md' }, posix, [repo], '/tmp/elsewhere')).toBeNull();
      expect(workspaceDocumentName({ path: '../../../notes.md' }, posix, [repo], `${repo}/gui`)).toBeNull();
    });

    it('leaves an absolute path alone, and keeps the old reading when the folder is not known', () => {
      expect(workspaceDocumentName({ path: `${posix}/docs/report.md` }, posix, [repo], repo)).toBe('docs/report.md');
      expect(workspaceDocumentName({ path: 'notes.md' }, posix, [repo])).toBe('notes.md');
      expect(workspaceDocumentName({ path: 'notes.md' }, posix, [repo], undefined)).toBe('notes.md');
    });

    it('reads Windows folders the same way', () => {
      const winRepo = `${windows}\\api`;
      expect(workspaceDocumentName({ path: 'README.md' }, windows, [winRepo], winRepo)).toBeNull();
      expect(workspaceDocumentName({ path: '..\\notes.md' }, windows, [winRepo], winRepo)).toBe('notes.md');
      expect(workspaceDocumentName({ path: 'D:\\other\\notes.md' }, windows, [winRepo], winRepo)).toBeNull();
    });
  });

  it('keeps a bare file name', () => {
    expect(workspaceDocumentName({ path: 'notes.md' }, posix)).toBe('notes.md');
    expect(workspaceDocumentName({ path: './notes.md' }, posix)).toBe('notes.md');
  });

  it('names a document inside a folder of the workspace root', () => {
    // Agents create reports in folders; these used to skip the Documents inspector
    // because only paths without a "/" were considered.
    expect(workspaceDocumentName({ path: 'docs/report.md' }, posix)).toBe('docs/report.md');
    expect(workspaceDocumentName({ path: 'docs\\report.md' }, windows)).toBe('docs/report.md');
    expect(workspaceDocumentName({ path: '.\\docs\\q3\\report.md' }, windows)).toBe('docs/q3/report.md');
  });

  it('strips the workspace root from absolute paths', () => {
    expect(workspaceDocumentName({ path: `${posix}/docs/report.md` }, posix)).toBe('docs/report.md');
    expect(workspaceDocumentName({ path: `${posix}/notes.md` }, `${posix}/`)).toBe('notes.md');
    expect(workspaceDocumentName({ path: `${windows}\\docs\\report.md` }, windows)).toBe('docs/report.md');
  });

  it('matches Windows roots regardless of drive-letter or folder case', () => {
    expect(workspaceDocumentName({ path: 'c:/Users/me/workspaces/audit/docs/report.md' }, windows)).toBe('docs/report.md');
    expect(workspaceDocumentName({ path: 'C:\\users\\ME\\Workspaces\\Audit\\notes.md' }, windows)).toBe('notes.md');
    // The case of the document path itself is preserved.
    expect(workspaceDocumentName({ path: 'c:/users/me/workspaces/audit/Docs/Report.MD' }, windows)).toBe('Docs/Report.MD');
  });

  it('keeps POSIX roots case-sensitive', () => {
    expect(workspaceDocumentName({ path: '/Home/me/workspaces/audit/docs/report.md' }, posix)).toBeNull();
  });

  it('does not treat a sibling folder with the same prefix as inside the root', () => {
    expect(workspaceDocumentName({ path: `${posix}-old/docs/report.md` }, posix)).toBeNull();
    expect(workspaceDocumentName({ path: 'C:\\Users\\me\\workspaces\\audit-old\\a.md' }, windows)).toBeNull();
  });

  it('rejects paths outside the workspace', () => {
    expect(workspaceDocumentName({ path: '/etc/hosts.md' }, posix)).toBeNull();
    expect(workspaceDocumentName({ path: 'D:\\other\\report.md' }, windows)).toBeNull();
    expect(workspaceDocumentName({ path: '../escape.md' }, posix)).toBeNull();
    expect(workspaceDocumentName({ path: 'docs/../../escape.md' }, posix)).toBeNull();
    expect(workspaceDocumentName({ path: `${posix}/docs/../../escape.md` }, posix)).toBeNull();
  });

  it('resolves dot segments that stay inside the workspace', () => {
    expect(workspaceDocumentName({ path: 'docs/../notes.md' }, posix)).toBe('notes.md');
  });

  it('leaves absolute paths alone when the workspace root is unknown', () => {
    expect(workspaceDocumentName({ path: '/home/me/workspaces/audit/notes.md' }, undefined)).toBeNull();
    expect(workspaceDocumentName({ path: 'notes.md' }, undefined)).toBe('notes.md');
  });

  it('keeps nested references with a line number as code references', () => {
    // The document viewer cannot jump to a line, so `NexusFlow/README.md:12` stays in the code panel.
    expect(workspaceDocumentName({ path: 'NexusFlow/README.md', line: 12 }, posix)).toBeNull();
    // A bare file name has always opened as a document, line number or not.
    expect(workspaceDocumentName({ path: 'notes.md', line: 3 }, posix)).toBe('notes.md');
  });
});

describe('workspaceDocumentName with repositories under the workspace root', () => {
  const root = 'C:\\Users\\me\\workspaces\\audit';
  const repos = ['C:\\Users\\me\\workspaces\\audit\\NexusFlow', 'C:\\elsewhere\\api'];

  it('keeps files in a repository as code references', () => {
    // Worktrees sit under the workspace root, so these are inside it but belong in the code panel.
    expect(workspaceDocumentName({ path: 'NexusFlow/README.md' }, root, repos)).toBeNull();
    expect(workspaceDocumentName({ path: 'NexusFlow/docs/guide.md' }, root, repos)).toBeNull();
    expect(workspaceDocumentName({ path: `${root}\\NexusFlow\\docs\\guide.md` }, root, repos)).toBeNull();
    expect(workspaceDocumentName({ path: 'nexusflow/docs/guide.md' }, root, repos)).toBeNull();
  });

  it('still names documents beside a repository and in other folders', () => {
    expect(workspaceDocumentName({ path: 'docs/report.md' }, root, repos)).toBe('docs/report.md');
    expect(workspaceDocumentName({ path: 'NexusFlow-notes/plan.md' }, root, repos)).toBe('NexusFlow-notes/plan.md');
    expect(workspaceDocumentName({ path: 'notes.md' }, root, repos)).toBe('notes.md');
  });

  it('ignores repositories outside the workspace root', () => {
    expect(workspaceDocumentName({ path: 'api/readme.md' }, root, repos)).toBe('api/readme.md');
  });

  it('allows HTML files located inside repo folders to be recognized as workspace documents', () => {
    expect(workspaceDocumentName({ path: 'NexusFlow/docs/report.html' }, root, repos)).toBe('NexusFlow/docs/report.html');
    expect(workspaceDocumentName({ path: `${root}\\NexusFlow\\coverage\\index.htm` }, root, repos)).toBe('NexusFlow/coverage/index.htm');
  });
});

describe('isUnreadableDocument', () => {
  it('recognises a document the server found but cannot preview', () => {
    expect(isUnreadableDocument(new Error('This document exceeds the 1 MB preview limit.'))).toBe(true);
    expect(isUnreadableDocument(new Error('This document exceeds the 25 MB download limit.'))).toBe(true);
    expect(isUnreadableDocument(new Error('The document grew beyond the size limit.'))).toBe(true);
    expect(isUnreadableDocument(new TypeError('The encoded data was not valid for encoding utf-8'))).toBe(true);
  });

  it('keeps every other failure in the code panel', () => {
    expect(isUnreadableDocument(new Error("ENOENT: no such file or directory, open 'C:\\ws\\docs\\guide.md'"))).toBe(false);
    expect(isUnreadableDocument(new Error('ENOTDIR: not a directory, open'))).toBe(false);
    expect(isUnreadableDocument(new Error(".ts files can't be opened here. Open it from the workspace folder instead."))).toBe(false);
    expect(isUnreadableDocument(new Error('Choose a document inside this workspace.'))).toBe(false);
    expect(isUnreadableDocument(new TypeError('Failed to fetch'))).toBe(false);
    expect(isUnreadableDocument(new SyntaxError('Unexpected token < in JSON'))).toBe(false);
    expect(isUnreadableDocument('exceeds the 1 MB preview limit')).toBe(false);
  });
});

describe('workspaceDocumentName in the hidden folders Docs opens', () => {
  it('names a document in .claude, .agents or .github at the workspace root, and leaves one inside a repository to Code', () => {
    const root = '/home/dev/workspaces/feature-x';
    expect(workspaceDocumentName({ path: `${root}/.claude/skills/plan/SKILL.md` }, root, [`${root}/repo`])).toBe('.claude/skills/plan/SKILL.md');
    expect(workspaceDocumentName({ path: '.agents/skills/plan/SKILL.md' }, root, [`${root}/repo`])).toBe('.agents/skills/plan/SKILL.md');
    expect(workspaceDocumentName({ path: '.github/PULL_REQUEST_TEMPLATE.md' }, root, [`${root}/repo`], root)).toBe('.github/PULL_REQUEST_TEMPLATE.md');
    expect(workspaceDocumentName({ path: `${root}/repo/.github/workflows/ci.yml` }, root, [`${root}/repo`])).toBeNull();
  });
});
