import { beforeEach, afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRootFolder, listRootDocuments, moveRootDocument, readRootDocument, writeRootDocument } from './root-documents.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'root-docs-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('discovers unregistered root documents and reads their current contents', async () => {
  await fs.writeFile(path.join(root, 'agent notes.md'), '# Findings');
  await fs.writeFile(path.join(root, 'brief.docx'), 'office');
  await fs.writeFile(path.join(root, '.private.md'), 'hidden');
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'other.md'), 'nested');
  expect((await listRootDocuments(root)).documents.map((doc) => doc.name)).toEqual(['agent notes.md', 'brief.docx']);
  expect(await readRootDocument(root, 'agent notes.md')).toMatchObject({ kind: 'markdown', content: '# Findings' });
  await fs.writeFile(path.join(root, 'agent notes.md'), '# Updated');
  expect((await readRootDocument(root, 'agent notes.md')).content).toBe('# Updated');
  expect(await readRootDocument(root, 'brief.docx')).toMatchObject({ kind: 'download' });
});

it('opens linked files in visible subfolders but never hidden, linked or escaping paths', async () => {
  await fs.mkdir(path.join(root, 'assessment', 'screenshots'), { recursive: true });
  await fs.writeFile(path.join(root, 'assessment', 'screenshots', '01.png'), 'png');
  expect(await readRootDocument(root, 'assessment/screenshots/01.png')).toMatchObject({ kind: 'image', name: 'assessment/screenshots/01.png' });
  // Nested files are reachable by link only; the root listing stays flat.
  expect((await listRootDocuments(root)).documents).toEqual([]);

  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.git', 'notes.md'), 'hidden');
  await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(root, 'outside', 'secret.md'), 'secret');
  await fs.symlink(path.join(root, 'outside'), path.join(root, 'linked-dir'));
  for (const name of ['.git/notes.md', 'assessment/../.git/notes.md', 'assessment//screenshots/01.png', 'linked-dir/secret.md', 'C:/escape.md', 'doc.md:stream']) {
    await expect(readRootDocument(root, name)).rejects.toThrow();
  }
  await expect(readRootDocument(root, 'assessment/evidence.exe')).rejects.toThrow("can't be opened here");
});

it('rejects traversal, linked files, unsupported files and nonregular paths', async () => {
  for (const name of ['../escape.md', '..\\escape.md', '/tmp/escape.md', '.private.md', 'nested/../../escape.md', 'keys.env', 'bad\nname.md']) {
    await expect(readRootDocument(root, name)).rejects.toThrow();
  }
  await fs.writeFile(path.join(root, 'real.md'), 'original');
  await fs.symlink(path.join(root, 'real.md'), path.join(root, 'linked.md'));
  await fs.mkdir(path.join(root, 'directory.md'));
  expect((await listRootDocuments(root)).documents.map((doc) => doc.name)).toEqual(['real.md']);
  await expect(readRootDocument(root, 'linked.md')).rejects.toThrow();
  await expect(readRootDocument(root, 'directory.md')).rejects.toThrow();
});

it('bounds previews and rejects invalid text, then recovers after the file is fixed', async () => {
  const target = path.join(root, 'large.md');
  await fs.writeFile(target, 'x'.repeat(1024 * 1024 + 1));
  await expect(readRootDocument(root, 'large.md')).rejects.toThrow('preview limit');
  expect((await readRootDocument(root, 'large.md', true)).bytes.length).toBe(1024 * 1024 + 1);
  await fs.writeFile(target, Buffer.from([0xff, 0xfe]));
  await expect(readRootDocument(root, 'large.md')).rejects.toThrow();
  await fs.writeFile(target, 'fixed');
  expect((await readRootDocument(root, 'large.md')).content).toBe('fixed');
});

it('discovers visible folders, lists documents within subfolders, and supports recursive scanning', async () => {
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide');
  await fs.mkdir(path.join(root, 'docs', 'specs'));
  await fs.writeFile(path.join(root, 'docs', 'specs', 'api.html'), '<h1>API</h1>');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.md'), 'ignore');

  const rootList = await listRootDocuments(root);
  expect(rootList.folders).toContain('docs');
  expect(rootList.folders).not.toContain('node_modules');

  const docsList = await listRootDocuments(root, 'docs');
  expect(docsList.documents.map((d) => d.name)).toEqual(['docs/guide.md']);
  expect(docsList.folders).toEqual(['docs/specs']);

  const docsTrailingSlash = await listRootDocuments(root, 'docs/');
  expect(docsTrailingSlash.documents.map((d) => d.name)).toEqual(['docs/guide.md']);

  const specsBackslash = await listRootDocuments(root, 'docs\\specs');
  expect(specsBackslash.documents.map((d) => d.name)).toEqual(['docs/specs/api.html']);

  const readBackslash = await readRootDocument(root, 'docs\\guide.md');
  expect(readBackslash.content).toBe('# Guide');

  const recursiveList = await listRootDocuments(root, '', true);
  expect(recursiveList.documents.map((d) => d.name)).toContain('docs/guide.md');
  expect(recursiveList.documents.map((d) => d.name)).toContain('docs/specs/api.html');
  expect(recursiveList.documents.map((d) => d.name)).not.toContain('node_modules/ignored.md');

  await expect(listRootDocuments(root, '../outside')).rejects.toThrow('Choose a folder inside this workspace.');
  await expect(listRootDocuments(root, '.git')).rejects.toThrow('Choose a folder inside this workspace.');
  await expect(listRootDocuments(root, 'nonexistent')).rejects.toThrow('Folder not found.');
});

it('opens plain-text data files the assistant writes, and still refuses files that are not documents', async () => {
  await fs.mkdir(path.join(root, 'assessment'));
  const written: Record<string, string> = {
    'spec.json': '{"openapi":"3.1.0"}', 'openapi.yaml': 'openapi: 3.1.0', 'ci.yml': 'on: push', 'config.toml': 'name = "x"',
    'feed.xml': '<feed/>', 'diagram.mmd': 'graph TD; A-->B', 'page.mdx': '# Page', 'assessment/evidence.json': '{"ok":true}',
  };
  for (const [name, text] of Object.entries(written)) await fs.writeFile(path.join(root, name), text);
  for (const [name, text] of Object.entries(written)) {
    expect(await readRootDocument(root, name)).toMatchObject({ name, content: text, kind: 'text', mime: 'text/plain; charset=utf-8' });
  }
  expect((await listRootDocuments(root)).documents.map((doc) => doc.name)).toEqual(['ci.yml', 'config.toml', 'diagram.mmd', 'feed.xml', 'openapi.yaml', 'page.mdx', 'spec.json']);

  await fs.writeFile(path.join(root, 'keys.env'), 'TOKEN=1');
  await fs.writeFile(path.join(root, 'tool.exe'), 'MZ');
  for (const name of ['keys.env', 'tool.exe', 'package.lock']) await expect(readRootDocument(root, name)).rejects.toThrow("can't be opened here");
  await fs.mkdir(path.join(root, '.config'));
  await fs.writeFile(path.join(root, '.config', 'app.json'), '{}');
  await expect(readRootDocument(root, '.config/app.json')).rejects.toThrow('Choose a document inside this workspace.');
});

it('lists data files outside the repositories only, and never ContextSpace\'s own store files', async () => {
  await fs.mkdir(path.join(root, 'api'));
  await fs.mkdir(path.join(root, 'services', 'web'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'));
  const files = [
    'spec.json', 'contextspace.json', 'contextspace-plan.json', 'contextspace-work.json', 'contextspace-plan.md',
    'api/package.json', 'api/README.md', 'services/web/tsconfig.json', 'services/web/notes.md', 'docs/openapi.yaml', 'apiary.json',
  ];
  for (const name of files) await fs.writeFile(path.join(root, name), 'x');
  const repoFolders = ['api', 'services/web'];

  expect((await listRootDocuments(root, '', true, { repoFolders })).documents.map((doc) => doc.name)).toEqual([
    'apiary.json', 'api/README.md', 'contextspace-plan.md', 'docs/openapi.yaml', 'services/web/notes.md', 'spec.json',
  ].sort((a, b) => a.localeCompare(b)));
  // A folder that only starts with a repository's name is not that repository.
  expect((await listRootDocuments(root, '', false, { repoFolders })).documents.map((doc) => doc.name)).toContain('apiary.json');
  // Browsing into a repository lists its documents but not its data files.
  expect((await listRootDocuments(root, 'api', false, { repoFolders })).documents.map((doc) => doc.name)).toEqual(['api/README.md']);
  // Without repositories nothing is held back, except ContextSpace's own files at the root.
  expect((await listRootDocuments(root, 'api')).documents.map((doc) => doc.name)).toEqual(['api/package.json', 'api/README.md']);
  expect((await listRootDocuments(root)).documents.map((doc) => doc.name)).toEqual(['apiary.json', 'contextspace-plan.md', 'spec.json']);
  // Left out of the listing, still readable by name: a link to one opens it.
  expect((await readRootDocument(root, 'api/package.json')).content).toBe('x');
});

it('bounds data files like other text, skips links, and recovers after a bad file is fixed', async () => {
  const target = path.join(root, 'big.json');
  await fs.writeFile(target, ' '.repeat(1024 * 1024 + 1));
  await expect(readRootDocument(root, 'big.json')).rejects.toThrow('preview limit');
  expect((await readRootDocument(root, 'big.json', true)).bytes.length).toBe(1024 * 1024 + 1);
  await fs.writeFile(target, Buffer.from([0xff, 0xfe]));
  await expect(readRootDocument(root, 'big.json')).rejects.toThrow();
  await fs.writeFile(target, '{"fixed":true}');
  expect((await readRootDocument(root, 'big.json')).content).toBe('{"fixed":true}');

  await fs.symlink(target, path.join(root, 'linked.json'));
  await fs.mkdir(path.join(root, 'folder.yaml'));
  expect((await listRootDocuments(root)).documents.map((doc) => doc.name)).toEqual(['big.json']);
  await expect(readRootDocument(root, 'linked.json')).rejects.toThrow();
  await expect(readRootDocument(root, 'folder.yaml')).rejects.toThrow();
});

it('opens documents in .claude, .agents and .github, and names the reason for every other hidden path', async () => {
  const written = ['.claude/skills/plan/SKILL.md', '.agents/skills/plan/SKILL.md', '.github/PULL_REQUEST_TEMPLATE.md', '.github/workflows/ci.yml', '.claude/settings.json'];
  for (const name of written) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), `# ${name}`); }
  for (const name of written) expect((await readRootDocument(root, name)).content).toBe(`# ${name}`);
  expect(await readRootDocument(root, '.claude\\skills\\plan\\SKILL.md')).toMatchObject({ name: '.claude/skills/plan/SKILL.md', kind: 'markdown' });

  for (const hidden of ['.git', '.contextspace', '.vscode', '.ssh', '.Claude', '.claude-old']) {
    await fs.mkdir(path.join(root, hidden), { recursive: true });
    await fs.writeFile(path.join(root, hidden, 'notes.md'), 'closed');
    await expect(readRootDocument(root, `${hidden}/notes.md`)).rejects.toThrow(/Choose a document inside this workspace\. Hidden files and folders can't be opened here, except the folders \.claude, \.agents and \.github\./);
    await expect(listRootDocuments(root, hidden)).rejects.toThrow(/Choose a folder inside this workspace\. Hidden files/);
  }
  // A hidden file, a hidden folder below an open one, and traversal through an open one stay closed.
  await fs.writeFile(path.join(root, '.claude', '.secret.md'), 'closed');
  await fs.mkdir(path.join(root, '.claude', '.cache'));
  await fs.writeFile(path.join(root, '.claude', '.cache', 'a.md'), 'closed');
  for (const name of ['.claude/.secret.md', '.claude/.cache/a.md', '.private.md', '.claude/../.git/notes.md', '.claude/../escape.md']) {
    await expect(readRootDocument(root, name)).rejects.toThrow('Choose a document inside this workspace.');
  }
});

it('lists what opens: the three hidden folders and their documents, and nothing else that is hidden', async () => {
  for (const name of ['.claude/skills/plan/SKILL.md', '.agents/skills/plan/SKILL.md', '.github/PULL_REQUEST_TEMPLATE.md', '.github/workflows/ci.yml', '.claude/settings.json', '.git/HEAD.md', '.vscode/notes.md', 'README.md']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), 'x');
  }
  const top = await listRootDocuments(root);
  expect(top.folders).toEqual(['.agents', '.claude', '.github']);
  expect(top.documents.map((doc) => doc.name)).toEqual(['README.md']);

  const github = await listRootDocuments(root, '.github');
  expect(github.documents.map((doc) => doc.name)).toEqual(['.github/PULL_REQUEST_TEMPLATE.md']);
  expect(github.folders).toEqual(['.github/workflows']);

  // Searching the whole workspace finds them, and a configuration file in a hidden folder is not a document in the list.
  const all = (await listRootDocuments(root, '', true)).documents.map((doc) => doc.name);
  expect(all).toEqual(['.agents/skills/plan/SKILL.md', '.claude/skills/plan/SKILL.md', '.github/PULL_REQUEST_TEMPLATE.md', 'README.md']);
  // Not listed, yet it opens when a link names it.
  expect((await readRootDocument(root, '.github/workflows/ci.yml')).content).toBe('x');
  // Every listed document opens, which is the point of one rule.
  for (const name of all) await expect(readRootDocument(root, name)).resolves.toMatchObject({ name });
});

it('does not enter the folders it is told to leave out, though it still names them', async () => {
  for (const name of ['notes.md', 'docs/spec.md', 'api/README.md', 'api/docs/design.md', 'repos/web/README.md', 'repos/shared.md']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), 'x');
  }
  const listing = await listRootDocuments(root, '', true, { leaveOut: ['api', '/repos/web/'] });
  expect(listing.documents.map((doc) => doc.name)).toEqual(['docs/spec.md', 'notes.md', 'repos/shared.md']);
  expect(listing.folders).toContain('api');
  expect(listing.folders).not.toContain('api/docs');
  expect((await listRootDocuments(root, '', true)).documents).toHaveLength(6);
});

it('writes, edits and updates root documents safely, rejecting unsupported formats and oversized content', async () => {
  const result = await writeRootDocument(root, 'notes.md', '# Initial content');
  expect(result).toMatchObject({ name: 'notes.md', kind: 'markdown', content: '# Initial content' });
  expect(await fs.readFile(path.join(root, 'notes.md'), 'utf-8')).toBe('# Initial content');

  // Updating existing file
  const updated = await writeRootDocument(root, 'notes.md', '# Modified content');
  expect(updated.content).toBe('# Modified content');
  expect(await fs.readFile(path.join(root, 'notes.md'), 'utf-8')).toBe('# Modified content');

  // Writing HTML document
  const htmlDoc = await writeRootDocument(root, 'page.html', '<!doctype html><h1>Hi</h1>');
  expect(htmlDoc).toMatchObject({ name: 'page.html', kind: 'html', content: '<!doctype html><h1>Hi</h1>' });

  // Writing into a nested folder that does not exist yet (auto-creates parents)
  const nested = await writeRootDocument(root, 'docs/reports/q1.html', '<p>Report</p>');
  expect(nested).toMatchObject({ name: 'docs/reports/q1.html', kind: 'html' });
  expect(await fs.readFile(path.join(root, 'docs', 'reports', 'q1.html'), 'utf-8')).toBe('<p>Report</p>');

  // Rejects unsupported extensions (e.g. binaries, exe, zip, no extension)
  await expect(writeRootDocument(root, 'app.exe', 'binary')).rejects.toThrow(".exe files can't be saved here. Open it from the workspace folder instead.");
  await expect(writeRootDocument(root, 'archive.zip', 'zip')).rejects.toThrow(".zip files can't be saved here. Open it from the workspace folder instead.");
  await expect(writeRootDocument(root, 'noextension', 'text')).rejects.toThrow("This files can't be saved here. Open it from the workspace folder instead.");
  // Rejects non-text document types (e.g. pdf)
  await expect(writeRootDocument(root, 'doc.pdf', 'pdf bytes')).rejects.toThrow('Only text, markdown, and HTML');

  // Rejects oversized content (> 1MB)
  await expect(writeRootDocument(root, 'huge.md', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow('preview limit');

  // Rejects path traversal and hidden files
  await expect(writeRootDocument(root, '../escape.md', 'bad')).rejects.toThrow('Choose a document inside this workspace');
  await expect(writeRootDocument(root, '.hidden.md', 'bad')).rejects.toThrow('Hidden files and folders');
});

it('creates root folders and moves documents into subfolders', async () => {
  // Creating folder
  const folderResult = await createRootFolder(root, 'docs/nested');
  expect(folderResult).toEqual({ folder: 'docs/nested' });
  expect((await fs.stat(path.join(root, 'docs', 'nested'))).isDirectory()).toBe(true);

  // Moving document
  await writeRootDocument(root, 'spec.md', '# Spec');
  const moveResult = await moveRootDocument(root, 'spec.md', 'docs/nested/spec.md');
  expect(moveResult).toEqual({ from: 'spec.md', to: 'docs/nested/spec.md' });

  // Original file removed, destination exists
  await expect(fs.access(path.join(root, 'spec.md'))).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'docs', 'nested', 'spec.md'), 'utf-8')).toBe('# Spec');

  // Rejects empty or invalid folders
  await expect(createRootFolder(root, '')).rejects.toThrow('Choose a folder inside this workspace');
  await expect(createRootFolder(root, '../escape')).rejects.toThrow('Choose a folder inside this workspace');
  await expect(createRootFolder(root, '.git')).rejects.toThrow('Hidden files and folders');

  // Rejects creating folder over existing file
  await expect(createRootFolder(root, 'docs/nested/spec.md')).rejects.toThrow('existing file');

  // Moving same path returns directly
  expect(await moveRootDocument(root, 'docs/nested/spec.md', 'docs/nested/spec.md')).toEqual({
    from: 'docs/nested/spec.md',
    to: 'docs/nested/spec.md',
  });

  // Rejects moving nonexistent source
  await expect(moveRootDocument(root, 'nonexistent.md', 'dest.md')).rejects.toThrow('Document not found');

  // Rejects overwriting existing destination
  await writeRootDocument(root, 'dest.md', 'existing');
  await expect(moveRootDocument(root, 'docs/nested/spec.md', 'dest.md')).rejects.toThrow('already exists');

  // Rejects writing over existing directory
  await fs.mkdir(path.join(root, 'docs', 'dir.md'), { recursive: true });
  await expect(writeRootDocument(root, 'docs/dir.md', 'bad')).rejects.toThrow('is a directory');

  // Verifies readRootDocument returns size and modifiedAt metadata
  const metaDoc = await readRootDocument(root, 'dest.md');
  expect(typeof metaDoc.size).toBe('number');
  expect(metaDoc.size).toBeGreaterThan(0);
  expect(typeof metaDoc.modifiedAt).toBe('string');
  expect(new Date(metaDoc.modifiedAt!).toISOString()).toBe(metaDoc.modifiedAt);
});
