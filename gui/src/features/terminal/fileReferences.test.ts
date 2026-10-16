import { describe, expect, it } from 'vitest';
import { findFileReferences } from './fileReferences.js';

describe('terminal file references', () => {
  it('keeps quoted paths with spaces together and ignores URLs', () => {
    const found = findFileReferences('at ("src/my file.ts:12") https://example.com/file.ts src/next.ts:7:3');
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'src/my file.ts', line: 12 },
      { path: 'src/next.ts', line: 7 },
    ]);
  });

  it('recognizes parenthesized locations and does not link quoted fragments', () => {
    expect(findFileReferences("'src/other file.ts(42,3)'"))
      .toEqual([{ text: 'src/other file.ts(42,3)', path: 'src/other file.ts', line: 42, start: 1, end: 24 }]);
  });

  it('handles contractions, a suffix after the closing quote, and backtick paths', () => {
    const found = findFileReferences("I've updated src/next.ts:7 and `src/my file.ts`:12 plus \"src/other file.ts\":3");
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'src/next.ts', line: 7 },
      { path: 'src/my file.ts', line: 12 },
      { path: 'src/other file.ts', line: 3 },
    ]);
  });

  it('strips angle brackets and ignores angle-wrapped URLs', () => {
    const found = findFileReferences('check <src/app.ts:15> and <https://example.com/docs> and <http://localhost:3000>');
    expect(found.map(({ text, path, line }) => ({ text, path, line }))).toEqual([
      { text: 'src/app.ts:15', path: 'src/app.ts', line: 15 },
    ]);
  });

  it('strips markdown link syntax and ignores markdown web links', () => {
    const found = findFileReferences('refer to [guide](src/guide.md:20) and [docs](https://example.com) and [repo](github.com/foo/bar)');
    expect(found.map(({ text, path, line }) => ({ text, path, line }))).toEqual([
      { text: 'src/guide.md:20', path: 'src/guide.md', line: 20 },
    ]);
  });

  it('handles angle-wrapped URLs inside markdown link syntax', () => {
    const found = findFileReferences('see [source](<src/components/Header.tsx:42>) and [link](<https://foo.com>)');
    expect(found.map(({ text, path, line }) => ({ text, path, line }))).toEqual([
      { text: 'src/components/Header.tsx:42', path: 'src/components/Header.tsx', line: 42 },
    ]);
  });

  it('filters out web domains, localhost, IPs, and mailto', () => {
    const found = findFileReferences('links: github.com/mrpatronz/nexusflow example.com:8080 localhost:3000/api 127.0.0.1:8080/index.html mailto:dev@example.com README.md:5');
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'README.md', line: 5 },
    ]);
  });

  it('detects files with multiple dots and unusual extensions', () => {
    const found = findFileReferences('errors at index.test.ts:42 and app.spec.js:10 in vite.config.ts:5 plus build.log:99 nginx.conf:15 Main.kt:20 schema.graphql:30');
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'index.test.ts', line: 42 },
      { path: 'app.spec.js', line: 10 },
      { path: 'vite.config.ts', line: 5 },
      { path: 'build.log', line: 99 },
      { path: 'nginx.conf', line: 15 },
      { path: 'Main.kt', line: 20 },
      { path: 'schema.graphql', line: 30 },
    ]);
  });

  it('detects file:// scheme links in markdown and plaintext', () => {
    const found = findFileReferences('see [button](file:///home/user/repo/src/Button.tsx:10) and file:///home/user/repo/src/App.tsx:25');
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: '/home/user/repo/src/Button.tsx', line: 10 },
      { path: '/home/user/repo/src/App.tsx', line: 25 },
    ]);
  });

  it('detects GitHub #L<line> and #L<start>-L<end> line anchors in plaintext and markdown links', () => {
    const found = findFileReferences('see file.ts#L42 and file.ts#L10-L20 plus [header](src/Header.tsx#L99) and [nav](src/Nav.tsx#L5-L15)');
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'file.ts', line: 42 },
      { path: 'file.ts', line: 10 },
      { path: 'src/Header.tsx', line: 99 },
      { path: 'src/Nav.tsx', line: 5 },
    ]);
  });

  it('handles file:// URLs with GitHub #L anchors', () => {
    const found = findFileReferences('see file:///home/user/repo/src/Button.tsx#L42 and [app](file:///home/user/repo/src/App.tsx#L12-L24)');
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: '/home/user/repo/src/Button.tsx', line: 42 },
      { path: '/home/user/repo/src/App.tsx', line: 12 },
    ]);
  });

  it('strips section anchors without line numbers', () => {
    const found = findFileReferences('read docs/guide.md#installation and [readme](README.md#getting-started)');
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'docs/guide.md', line: undefined },
      { path: 'README.md', line: undefined },
    ]);
  });

  it('handles trailing colons, periods, parentheses, lowercase anchors, and #L10-20 format', () => {
    const found = findFileReferences(
      'at file.ts#L42: found bug, and file.ts:15: error, in file.ts#l99, see file.ts#L10-20. also [link](src/Header.tsx#L30-L40): and [nav](src/Nav.tsx#L50).'
    );
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'file.ts', line: 42 },
      { path: 'file.ts', line: 15 },
      { path: 'file.ts', line: 99 },
      { path: 'file.ts', line: 10 },
      { path: 'src/Header.tsx', line: 30 },
      { path: 'src/Nav.tsx', line: 50 },
    ]);
  });

  describe('what a CLI prints around a path', () => {
    const paths = (row: string) => findFileReferences(row).map(({ path, line }) => ({ path, line }));
    const underlined = (row: string) => findFileReferences(row).map(({ start, end }) => row.slice(start, end));

    it('reads the file of a tool-call line, not the tool name before it', () => {
      expect(paths('⏺ Update(gui/src/app/AppSidebar.tsx)')).toEqual([{ path: 'gui/src/app/AppSidebar.tsx', line: undefined }]);
      expect(paths('● Read(/home/anton-patron/Dev/workspaces/bugs-findings/NexusFlow/gui/src/index.css)'))
        .toEqual([{ path: '/home/anton-patron/Dev/workspaces/bugs-findings/NexusFlow/gui/src/index.css', line: undefined }]);
      expect(paths('● Write(contextspace-plan.md)')).toEqual([{ path: 'contextspace-plan.md', line: undefined }]);
      expect(paths('  Edit(src/server.ts:88)')).toEqual([{ path: 'src/server.ts', line: 88 }]);
    });

    it('underlines only the path of a tool call', () => {
      expect(underlined('⏺ Update(gui/src/app/AppSidebar.tsx)')).toEqual(['gui/src/app/AppSidebar.tsx']);
      expect(underlined('  Read(src/a.ts) then Write(src/b.ts)')).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('leaves calls with no path in them, and a command, as they were', () => {
      // Only the quoted path argument is a path; `Grep(pattern:` is not made into one.
      expect(paths('● Grep(pattern: "useState", path: "gui/src")')).toEqual([{ path: 'gui/src', line: undefined }]);
      expect(paths('● Bash(cat src/server.ts | head -5)')).toEqual([{ path: 'src/server.ts', line: undefined }]);
      expect(paths('● Bash(npm test)')).toEqual([]);
      expect(paths('see render(count) and parse(12)')).toEqual([]);
      // A location after the name is not a tool call.
      expect(paths('src/app.ts(12,3)')).toEqual([{ path: 'src/app.ts', line: 12 }]);
    });

    it('reads a path in bold or italics, also with a colon or comma after it', () => {
      expect(paths('- **gui/src/index.css** was changed')).toEqual([{ path: 'gui/src/index.css', line: undefined }]);
      expect(paths('**gui/src/index.css:** the ring')).toEqual([{ path: 'gui/src/index.css', line: undefined }]);
      expect(paths('see **src/app.ts**, then *src/next.ts*.')).toEqual([
        { path: 'src/app.ts', line: undefined },
        { path: 'src/next.ts', line: undefined },
      ]);
      expect(paths('**src/app.ts:12**')).toEqual([{ path: 'src/app.ts', line: 12 }]);
      expect(underlined('- **gui/src/index.css** was changed')).toEqual(['gui/src/index.css']);
    });

    it('does not take a glob for bold', () => {
      expect(paths('rg "x" src/**/*.ts')).toEqual([{ path: 'src/**/*.ts', line: undefined }]);
      expect(paths('**/*.ts')).toEqual([{ path: '**/*.ts', line: undefined }]);
    });

    it('drops the a/ and b/ side git puts in front of a path in a diff header', () => {
      expect(paths('--- a/gui/src/App.tsx')).toEqual([{ path: 'gui/src/App.tsx', line: undefined }]);
      expect(paths('+++ b/gui/src/App.tsx')).toEqual([{ path: 'gui/src/App.tsx', line: undefined }]);
      expect(paths('diff --git a/src/one.ts b/src/two.ts')).toEqual([
        { path: 'src/one.ts', line: undefined },
        { path: 'src/two.ts', line: undefined },
      ]);
      expect(underlined('+++ b/gui/src/App.tsx')).toEqual(['gui/src/App.tsx']);
    });

    it('does not take owner/repo#123, the name of a pull request or issue, for a file', () => {
      expect(paths('mrpatronz/nexusflow#123')).toEqual([]);
      expect(paths('PR mrpatronz/nexusflow#123, merged')).toEqual([]);
      expect(paths('(see my-org/my.repo#4567)')).toEqual([]);
      expect(paths('vercel/next.js#123')).toEqual([]);
      // A file with a numbered anchor, or a longer path, still is one.
      expect(paths('docs/guide.md#12')).toEqual([{ path: 'docs/guide.md', line: undefined }]);
      expect(paths('src/app.ts#12')).toEqual([{ path: 'src/app.ts', line: undefined }]);
      expect(paths('a/b/c#12')).toEqual([{ path: 'a/b/c', line: undefined }]);
    });

    it('keeps a/ and b/ when the row is not a diff header, since a real folder can be named that', () => {
      expect(paths('open a/notes.md and b/todo.md')).toEqual([
        { path: 'a/notes.md', line: undefined },
        { path: 'b/todo.md', line: undefined },
      ]);
    });
  });
});
