import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocumentScopeInputError, resolveDocumentRoot } from './document-scope.js';

let temp: string;
let root: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'document-scope-'));
  root = path.join(temp, 'workspace');
  await fs.mkdir(root);
});
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
const manifest = (value: object) => fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify(value));

it('keeps default reads independent of configuration and rejects explicit missing scope', async () => {
  expect(await resolveDocumentRoot(root)).toBe(root);
  await expect(resolveDocumentRoot(root, 'api')).rejects.toBeInstanceOf(DocumentScopeInputError);
  await manifest({ repos: ['/source/api'], mode: 'worktree' });
  expect(await resolveDocumentRoot(root, 'api')).toBe(path.join(root, 'api'));
  await fs.writeFile(path.join(root, 'contextspace.json'), '{bad');
  expect(await resolveDocumentRoot(root)).toBe(root);
  await expect(resolveDocumentRoot(root, 'api')).rejects.toBeInstanceOf(DocumentScopeInputError);
});

it('prefers dynamic isolation over the source while preserving external references', async () => {
  const api = path.join(temp, 'isolated-api');
  const web = path.join(temp, 'reference/web');
  await manifest({ mode: 'in-place', repos: [path.join(temp, 'source/api'), web], isolatedRepos: { api: { worktreePath: api } } });
  expect(await resolveDocumentRoot(root, 'api')).toBe(api);
  expect(await resolveDocumentRoot(root, 'web')).toBe(web);
});

it('rejects unknown, empty, path-like and ambiguous selectors without fallback', async () => {
  await manifest({ repos: ['/first/api', '/second/api'], mode: 'worktree' });
  for (const repo of ['', ' ', ' api', 'api ', '.', '..', '../api', '/first/api', 'C:api', 'a\\api', 'missing', 'api', 'api\0', 'api\n']) {
    await expect(resolveDocumentRoot(root, repo)).rejects.toBeInstanceOf(DocumentScopeInputError);
  }
});

it('accepts ordinary digits in configured basenames', async () => {
  await manifest({ repos: ['/source/api0'], mode: 'worktree' });
  expect(await resolveDocumentRoot(root, 'api0')).toBe(path.join(root, 'api0'));
});
