import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { fork, type ChildProcess } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { buildPortableWorkroomPreview } from '../../src/workrooms/portable.js';
import { WorkroomManager } from '../../src/workrooms/manager.js';
import { decryptExport } from '../../src/workrooms/crypto.js';

let root: string | undefined;
let host: ChildProcess | undefined;
let peer: WorkroomManager | undefined;
afterEach(async () => {
  await peer?.stopOrLeave();
  if (host && host.exitCode === null) {
    const exited = new Promise<void>(resolve => host!.once('exit', () => resolve()));
    host.kill();
    await exited;
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

it('shares reviewed documents across two processes and retains host/export/peer copies after leaving', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-workroom-boundary-'));
  const workspace = path.join(root, 'workspace');
  const hostHome = path.join(root, 'host');
  const peerHome = path.join(root, 'peer');
  for (const dir of [workspace, hostHome, peerHome]) await fs.mkdir(dir);
  const privateCanary = 'PRIVATE_UNSELECTED_LOG_AND_CHAT';
  const plan = '# Reviewed plan\nA deliberately shared document.';
  await fs.writeFile(path.join(workspace, 'contextspace.json'), JSON.stringify({
    id: 'fixture', branchName: 'fixture', workspacePath: workspace, repos: [], createdAt: '2026-01-01T00:00:00Z',
  }));
  await fs.writeFile(path.join(workspace, 'PLAN.md'), plan);
  await fs.writeFile(path.join(workspace, 'contextspace-handoff.md'), '# Reviewed handoff');
  await fs.mkdir(path.join(workspace, '.contextspace'));
  await fs.writeFile(path.join(workspace, '.contextspace', 'chat.jsonl'), privateCanary);
  await fs.writeFile(path.join(hostHome, 'config.json'), JSON.stringify({ privateCanary }));
  const preview = await buildPortableWorkroomPreview(workspace);
  expect(preview.documents.plan).toBe(plan);
  expect(JSON.stringify(preview)).not.toContain(privateCanary);
  host = fork(path.resolve('tests/e2e/fixtures/data-workroom-host.mjs'), [hostHome], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
    env: { ...process.env, CONTEXTSPACE_HOME: hostHome, NEXUSFLOW_HOME: hostHome },
  });
  let sequence = 0;
  const rpc = (method: string, ...args: unknown[]): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const cleanup = () => { clearTimeout(timer); host!.off('message', received); host!.off('exit', exited); };
    const received = (message: any) => {
      if (message.id !== id) return;
      cleanup();
      message.error ? reject(new Error(message.error)) : resolve(message.result);
    };
    const exited = () => { cleanup(); reject(new Error('Host fixture exited before responding')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Host fixture timed out')); }, 15_000);
    host!.on('message', received); host!.once('exit', exited);
    host!.send({ id, method, args });
  });
  const password = 'synthetic room password';
  const started = await rpc('startHost', {
    name: 'Boundary fixture', workspaceId: 'fixture', address: '127.0.0.1', port: await freePort(),
    password, hostDisplayName: 'Host', bundle: preview.bundle, documents: preview.documents,
  });
  const invite = await rpc('createInvite');
  peer = new WorkroomManager(peerHome);
  const pending = await peer.join(invite.invite, password, 'Peer', 'peer-local-workspace');
  expect(pending.mode).toBe('guest');
  if (pending.mode !== 'guest') throw new Error('Expected guest');
  const hostSnapshot = await rpc('snapshot');
  expect(hostSnapshot.pendingJoins).toHaveLength(1);
  await rpc('decideJoin', hostSnapshot.pendingJoins[0].id, true);
  expect(await peer.pollJoin()).toMatchObject({ mode: 'guest', status: 'accepted' });
  const snapshot = await peer.snapshot();
  expect(snapshot.bundle).toEqual(preview.bundle);
  for (const name of ['plan', 'decisions', 'handoff'] as const) {
    expect(snapshot.documents[name].content).toBe(preview.documents[name]);
  }
  expect(JSON.stringify(snapshot)).not.toContain(privateCanary);
  const published = '# Explicit peer publication';
  await peer.updateDocument('handoff', published, snapshot.documents.handoff.revision);
  expect((await rpc('snapshot')).documents.handoff.content).toBe(published);
  const envelope = await rpc('exportRoom', 'synthetic export passphrase');
  const exported = await decryptExport(envelope, 'synthetic export passphrase');
  expect(exported.room.documents.handoff.content).toBe(published);
  expect(JSON.stringify(exported)).not.toContain(privateCanary);
  expect(JSON.stringify(exported)).not.toContain(password);
  expect(exported).not.toHaveProperty('credentials');
  const downloaded = path.join(peerHome, 'downloaded-snapshot.json');
  await fs.writeFile(downloaded, JSON.stringify(await peer.snapshot()));
  await peer.stopOrLeave();
  expect(await peer.status()).toEqual({ mode: 'idle' });
  expect((await fs.readdir(path.join(peerHome, 'workrooms', 'active'))).filter(name => name.endsWith('.json'))).toEqual([]);
  expect((await rpc('snapshot')).documents.handoff.content).toBe(published);
  await rpc('stopOrLeave');
  await fs.access(path.join(hostHome, 'workrooms', started.roomId, 'workroom.sqlite'));
  expect(await fs.readFile(downloaded, 'utf8')).toContain(published);
  expect(await fs.readFile(path.join(workspace, '.contextspace', 'chat.jsonl'), 'utf8')).toBe(privateCanary);
}, 30_000);
