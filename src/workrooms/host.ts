import { X509Certificate, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

import { getConnInfo } from '@hono/node-server/conninfo';
import { serve } from '@hono/node-server';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { generate } from 'selfsigned';

import { assertFileHandleMatchesPath, readFileHandleAtMost } from '../resources/fs-safety.js';
import { getErrorCode } from '../utils/errors.js';

import {
  WorkroomAuthorizationError,
  WORKROOM_MAX_RESOURCE_UPLOAD_BYTES,
  WorkroomRevisionError,
  WorkroomValidationError,
  type PortableFeatureBundleV1,
  type WorkroomDocumentName,
} from './contracts.js';
import { decryptExport, encryptExport, normalizeFingerprint, tokenDigest, verifyPassword, type EncryptedExportV1 } from './crypto.js';
import { createInitialWorkroomState, WorkroomService } from './service.js';
import { WorkroomSqliteStore } from './sqlite-store.js';

export interface WorkroomNetworkInterface {
  readonly name: string;
  readonly address: string;
  readonly family: 'IPv4' | 'IPv6';
  readonly internal: boolean;
}

export function listWorkroomNetworkInterfaces(): WorkroomNetworkInterface[] {
  const result: WorkroomNetworkInterface[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' && address.family !== 'IPv6') continue;
      result.push({ name, address: address.address, family: address.family, internal: address.internal });
    }
  }
  return result.sort((left, right) => Number(left.internal) - Number(right.internal) || left.name.localeCompare(right.name));
}

export function assertLocalInterface(address: string): void {
  if (!listWorkroomNetworkInterfaces().some((candidate) => candidate.address === address)) {
    throw new WorkroomValidationError('Select an address that belongs to this computer.');
  }
}

function bearerToken(header: string | undefined): string {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new WorkroomAuthorizationError('A Workroom device credential is required.');
  return match[1]!;
}

function remoteSourceKey(c: Parameters<typeof getConnInfo>[0]): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function workroomError(c: Context, error: unknown) {
  if (error instanceof WorkroomAuthorizationError) return c.json({ error: error.message }, 401);
  if (error instanceof WorkroomRevisionError) {
    return c.json({ error: error.message, expectedRevision: error.expected, actualRevision: error.actual }, 409);
  }
  if (error instanceof WorkroomValidationError) return c.json({ error: error.message }, 400);
  const message = error instanceof Error ? error.message : String(error);
  console.error('[workroom] request failed:', message);
  return c.json({ error: 'The Workroom request failed.' }, 500);
}

export function createWorkroomApp(service: WorkroomService): Hono {
  const app = new Hono();
  let activeJoinRequests = 0;
  const activeJoinRequestsBySource = new Map<string, number>();
  const joinRequestWindowsBySource = new Map<string, { readonly startedAt: number; readonly count: number }>();
  let activeResourceUploads = 0;
  let activeMutations = 0;
  let activeReads = 0;
  let activeEventStreams = 0;
  let activeProtectedRequests = 0;
  const activeProtectedRequestsBySource = new Map<string, number>();
  const protectedRequestWindowsBySource = new Map<string, { readonly startedAt: number; readonly count: number }>();
  const readsByPrincipal = new Map<string, number>();
  const eventStreamsByPrincipal = new Map<string, number>();
  const publicRoomId = service.store.read().then((state) => state.roomId);
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.header('origin')) return c.json({ error: 'Browser-originated remote requests are not allowed.' }, 403);
    await next();
  });
  const admitProtectedRequest = (sourceKey: string): { readonly release?: () => void; readonly error?: string } => {
    const now = Date.now();
    for (const [key, window] of protectedRequestWindowsBySource) {
      if (now - window.startedAt >= 60_000) protectedRequestWindowsBySource.delete(key);
    }
    const currentWindow = protectedRequestWindowsBySource.get(sourceKey);
    const liveWindow = currentWindow && now - currentWindow.startedAt < 60_000
      ? currentWindow
      : { startedAt: now, count: 0 };
    if (liveWindow.count >= 240) {
      return { error: 'Too many protected Workroom requests from this source. Try again shortly.' };
    }
    if (!currentWindow && protectedRequestWindowsBySource.size >= 4_096) {
      const oldest = protectedRequestWindowsBySource.keys().next().value as string | undefined;
      if (oldest) protectedRequestWindowsBySource.delete(oldest);
    }
    protectedRequestWindowsBySource.set(sourceKey, { startedAt: liveWindow.startedAt, count: liveWindow.count + 1 });
    const activeForSource = activeProtectedRequestsBySource.get(sourceKey) ?? 0;
    if (activeProtectedRequests >= 6 || activeForSource >= 2) {
      return { error: 'The Workroom is busy authenticating requests. Try again shortly.' };
    }
    activeProtectedRequests += 1;
    activeProtectedRequestsBySource.set(sourceKey, activeForSource + 1);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      activeProtectedRequests -= 1;
      const remaining = (activeProtectedRequestsBySource.get(sourceKey) ?? 1) - 1;
      if (remaining > 0) activeProtectedRequestsBySource.set(sourceKey, remaining);
      else activeProtectedRequestsBySource.delete(sourceKey);
    } };
  };
  app.use('/v1/*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === '/v1/health' || pathname === '/v1/events'
      || (pathname === '/v1/join' && c.req.method === 'POST')) {
      return next();
    }
    try {
      bearerToken(c.req.header('authorization'));
    } catch (error) {
      return workroomError(c, error);
    }
    const admission = admitProtectedRequest(remoteSourceKey(c));
    if (admission.error) return c.json({ error: admission.error }, 429);
    try {
      await next();
    } finally {
      admission.release?.();
    }
  });
  const mutationAdmission = (
    kind: 'human' | 'agent',
    roles?: readonly ('host' | 'publisher' | 'member')[],
  ): MiddlewareHandler => async (c, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) return next();
    try {
      const token = bearerToken(c.req.header('authorization'));
      if (kind === 'human') await service.authorizeHuman(token, roles);
      else await service.authorizeAgent(token);
      if (activeMutations >= 16) {
        return c.json({ error: 'The Workroom is busy processing changes. Try again shortly.' }, 429);
      }
      activeMutations += 1;
      try {
        await next();
      } finally {
        activeMutations -= 1;
      }
    } catch (error) {
      return workroomError(c, error);
    }
  };
  const readAdmission = (authorizeParticipant: boolean): MiddlewareHandler => async (c, next) => {
    if (c.req.method !== 'GET') return next();
    try {
      const token = bearerToken(c.req.header('authorization'));
      if (authorizeParticipant) await service.authorizeRead(token);
      const principalKey = tokenDigest(token);
      const principalReads = readsByPrincipal.get(principalKey) ?? 0;
      if (activeReads >= 4 || principalReads >= 2) {
        return c.json({ error: 'The Workroom is busy processing reads. Try again shortly.' }, 429);
      }
      activeReads += 1;
      readsByPrincipal.set(principalKey, principalReads + 1);
      try {
        await next();
      } finally {
        activeReads -= 1;
        const remaining = (readsByPrincipal.get(principalKey) ?? 1) - 1;
        if (remaining > 0) readsByPrincipal.set(principalKey, remaining);
        else readsByPrincipal.delete(principalKey);
      }
    } catch (error) {
      return workroomError(c, error);
    }
  };
  app.use('/v1/documents/*', mutationAdmission('human'));
  app.use('/v1/handoff', mutationAdmission('human'));
  app.use('/v1/resources', mutationAdmission('human', ['host', 'publisher']));
  app.use('/v1/workflow/select', mutationAdmission('human', ['host']));
  app.use('/v1/workflow/steps/:stepId/transition', mutationAdmission('human'));
  app.use('/v1/workflow/steps/:stepId/propose', mutationAdmission('agent'));
  app.use('/v1/join/:requestId', readAdmission(false));
  app.use('/v1/snapshot', readAdmission(true));
  app.use('/v1/resources/*', readAdmission(true));
  app.use('/v1/join', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Join request body is too large.' }, 413) }));
  app.use('/v1/documents/*', bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: 'Document request body is too large.' }, 413) }));
  app.use('/v1/handoff', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Handoff request body is too large.' }, 413) }));
  app.use('/v1/resources', bodyLimit({ maxSize: WORKROOM_MAX_RESOURCE_UPLOAD_BYTES, onError: (c) => c.json({ error: 'Resource request body is too large.' }, 413) }));
  app.use('/v1/workflow/select', bodyLimit({ maxSize: 3 * 1024 * 1024, onError: (c) => c.json({ error: 'Workflow request body is too large.' }, 413) }));
  app.use('/v1/workflow/steps/*', bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'Workflow transition body is too large.' }, 413) }));
  app.use('/v1/*', bodyLimit({ maxSize: 16 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body is too large.' }, 413) }));

  app.get('/v1/health', async (c) => {
    return c.json({ schemaVersion: 1, roomId: await publicRoomId });
  });

  app.post('/v1/join', async (c) => {
    const sourceKey = remoteSourceKey(c);
    const now = Date.now();
    for (const [key, window] of joinRequestWindowsBySource) {
      if (now - window.startedAt >= 60_000) joinRequestWindowsBySource.delete(key);
    }
    const currentWindow = joinRequestWindowsBySource.get(sourceKey);
    const liveWindow = currentWindow && now - currentWindow.startedAt < 60_000
      ? currentWindow
      : { startedAt: now, count: 0 };
    if (liveWindow.count >= 30) {
      return c.json({ error: 'Too many join requests from this source. Try again shortly.' }, 429);
    }
    if (!currentWindow && joinRequestWindowsBySource.size >= 4_096) {
      const oldest = joinRequestWindowsBySource.keys().next().value as string | undefined;
      if (oldest) joinRequestWindowsBySource.delete(oldest);
    }
    joinRequestWindowsBySource.set(sourceKey, { startedAt: liveWindow.startedAt, count: liveWindow.count + 1 });
    const sourceRequests = activeJoinRequestsBySource.get(sourceKey) ?? 0;
    if (activeJoinRequests >= 4 || sourceRequests >= 1) {
      return c.json({ error: 'The Workroom is busy processing join requests. Try again shortly.' }, 429);
    }
    activeJoinRequests += 1;
    activeJoinRequestsBySource.set(sourceKey, sourceRequests + 1);
    try {
      const body = await c.req.json();
      const result = await service.requestJoin({
        roomId: String(body.roomId ?? ''),
        inviteToken: String(body.inviteToken ?? ''),
        password: String(body.password ?? ''),
        displayName: String(body.displayName ?? ''),
        deviceToken: String(body.deviceToken ?? ''),
        agentToken: String(body.agentToken ?? ''),
        sourceKey,
      });
      return c.json(result, 202);
    } catch (error) {
      return workroomError(c, error);
    } finally {
      activeJoinRequests -= 1;
      const remaining = (activeJoinRequestsBySource.get(sourceKey) ?? 1) - 1;
      if (remaining > 0) activeJoinRequestsBySource.set(sourceKey, remaining);
      else activeJoinRequestsBySource.delete(sourceKey);
    }
  });

  app.get('/v1/join/:requestId', async (c) => {
    try {
      return c.json(await service.getJoinStatus(c.req.param('requestId'), bearerToken(c.req.header('authorization'))));
    } catch (error) {
      return workroomError(c, error);
    }
  });

  app.get('/v1/snapshot', async (c) => {
    try {
      return c.json(await service.snapshot(bearerToken(c.req.header('authorization'))));
    } catch (error) {
      return workroomError(c, error);
    }
  });

  app.put('/v1/documents/:name', async (c) => {
    try {
      const token = bearerToken(c.req.header('authorization'));
      await service.authorizeHuman(token);
      const body = await c.req.json();
      const document = await service.updateDocument(
        token,
        c.req.param('name'),
        String(body.content ?? ''),
        Number(body.expectedRevision),
      );
      return c.json({ document });
    } catch (error) {
      return workroomError(c, error);
    }
  });

  app.post('/v1/handoff', async (c) => {
    try {
      const token = bearerToken(c.req.header('authorization'));
      await service.authorizeHuman(token);
      const body = await c.req.json();
      const document = await service.publishHandoff(
        token,
        String(body.content ?? ''),
        Array.isArray(body.repos) ? body.repos : [],
        Number(body.expectedRevision),
      );
      return c.json({ document });
    } catch (error) {
      return workroomError(c, error);
    }
  });

  app.post('/v1/resources', async (c) => {
    let admitted = false;
    try {
      const token = bearerToken(c.req.header('authorization'));
      await service.authorizeHuman(token, ['host', 'publisher']);
      if (activeResourceUploads >= 2) return c.json({ error: 'The Workroom is busy processing resource uploads. Try again shortly.' }, 429);
      activeResourceUploads += 1;
      admitted = true;
      const pkg = await service.publishResource(token, await c.req.json());
      return c.json({ package: pkg }, 201);
    } catch (error) {
      return workroomError(c, error);
    } finally {
      if (admitted) activeResourceUploads -= 1;
    }
  });

  app.get('/v1/resources/:digest', async (c) => {
    try {
      return c.json({ package: await service.getResource(bearerToken(c.req.header('authorization')), c.req.param('digest')) });
    } catch (error) {
      return workroomError(c, error);
    }
  });

  app.post('/v1/workflow/select', async (c) => {
    try {
      const token = bearerToken(c.req.header('authorization'));
      await service.authorizeHuman(token, ['host']);
      const body = await c.req.json();
      await service.selectWorkflow(token, body.workflow, Number(body.expectedRevision));
      return c.json({ success: true });
    } catch (error) {
      return workroomError(c, error);
    }
  });

  app.post('/v1/workflow/steps/:stepId/transition', async (c) => {
    try {
      const token = bearerToken(c.req.header('authorization'));
      await service.authorizeHuman(token);
      const body = await c.req.json();
      const step = await service.transitionWorkflowStep(
        token,
        c.req.param('stepId'),
        body.status,
        Number(body.expectedRevision),
        typeof body.evidence === 'string' ? body.evidence : undefined,
      );
      return c.json({ step });
    } catch (error) {
      return workroomError(c, error);
    }
  });

  app.post('/v1/workflow/steps/:stepId/propose', async (c) => {
    try {
      const token = bearerToken(c.req.header('authorization'));
      await service.authorizeAgent(token);
      const body = await c.req.json();
      const step = await service.proposeWorkflowStep(
        token,
        c.req.param('stepId'),
        Number(body.expectedRevision),
        typeof body.evidence === 'string' ? body.evidence : '',
      );
      return c.json({ step });
    } catch (error) {
      return workroomError(c, error);
    }
  });

  app.get('/v1/events', async (c) => {
    let admitted = false;
    let handedToStream = false;
    let principalKey = '';
    let authenticationRelease: (() => void) | undefined;
    try {
      let cursor = Number.parseInt(c.req.query('cursor') ?? '0', 10) || 0;
      const token = bearerToken(c.req.header('authorization'));
      const authenticationAdmission = admitProtectedRequest(remoteSourceKey(c));
      if (authenticationAdmission.error) return c.json({ error: authenticationAdmission.error }, 429);
      authenticationRelease = authenticationAdmission.release;
      try {
        await service.snapshot(token);
      } finally {
        authenticationRelease?.();
        authenticationRelease = undefined;
      }
      principalKey = tokenDigest(token);
      const principalStreams = eventStreamsByPrincipal.get(principalKey) ?? 0;
      if (activeEventStreams >= 32 || principalStreams >= 2) {
        return c.json({ error: 'Too many active Workroom event streams.' }, 429);
      }
      activeEventStreams += 1;
      eventStreamsByPrincipal.set(principalKey, principalStreams + 1);
      admitted = true;
      const release = () => {
        if (!admitted) return;
        admitted = false;
        activeEventStreams -= 1;
        const remaining = (eventStreamsByPrincipal.get(principalKey) ?? 1) - 1;
        if (remaining > 0) eventStreamsByPrincipal.set(principalKey, remaining);
        else eventStreamsByPrincipal.delete(principalKey);
      };
      const response = streamSSE(c, async (stream) => {
        try {
          while (!stream.aborted) {
            const snapshot = await service.snapshot(token);
            for (const event of snapshot.activity.filter((candidate) => candidate.sequence > cursor)) {
              await stream.writeSSE({ id: String(event.sequence), event: event.type, data: JSON.stringify(event) });
              cursor = event.sequence;
            }
            await stream.sleep(1_000);
          }
        } finally {
          release();
        }
      });
      handedToStream = true;
      return response;
    } catch (error) {
      return workroomError(c, error);
    } finally {
      authenticationRelease?.();
      if (!handedToStream && admitted) {
        admitted = false;
        activeEventStreams -= 1;
        const remaining = (eventStreamsByPrincipal.get(principalKey) ?? 1) - 1;
        if (remaining > 0) eventStreamsByPrincipal.set(principalKey, remaining);
        else eventStreamsByPrincipal.delete(principalKey);
      }
    }
  });

  return app;
}

export interface StartHostedWorkroomInput {
  readonly homeDir: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly address: string;
  readonly port: number;
  readonly password: string;
  readonly hostDisplayName: string;
  readonly bundle: PortableFeatureBundleV1;
  readonly documents: Partial<Record<WorkroomDocumentName, string>>;
  readonly roomId?: string;
}

export interface HostedWorkroom {
  readonly roomId: string;
  readonly roomDir: string;
  readonly service: WorkroomService;
  readonly server: HttpsServer;
  readonly hostToken: string;
  readonly hostAgentToken: string;
  readonly certificateFingerprint: string;
  readonly url: string;
  stop(): Promise<void>;
}

async function listenWorkroom(
  service: WorkroomService,
  address: string,
  port: number,
  key: string,
  cert: string,
): Promise<HttpsServer> {
  const app = createWorkroomApp(service);
  return new Promise<HttpsServer>((resolve, reject) => {
    const listener = serve({
      fetch: app.fetch,
      hostname: address,
      port,
      createServer: createHttpsServer,
      serverOptions: { key, cert, handshakeTimeout: 10_000 },
    }) as HttpsServer;
    listener.maxConnections = 64;
    listener.requestTimeout = 30_000;
    listener.headersTimeout = 10_000;
    listener.keepAliveTimeout = 5_000;
    const onError = (error: Error) => reject(error);
    listener.once('error', onError);
    listener.once('listening', () => {
      listener.off('error', onError);
      listener.on('error', (error) => console.error('[workroom] listener error:', error.message));
      resolve(listener);
    });
  });
}

function hostedResult(
  state: { roomId: string; address: string; port: number; certificateFingerprint: string },
  roomDir: string,
  service: WorkroomService,
  server: HttpsServer,
  hostToken: string,
  hostAgentToken: string,
): HostedWorkroom {
  const formattedAddress = state.address.includes(':') ? `[${state.address}]` : state.address;
  let stopPromise: Promise<void> | undefined;
  return {
    roomId: state.roomId,
    roomDir,
    service,
    server,
    hostToken,
    hostAgentToken,
    certificateFingerprint: state.certificateFingerprint,
    url: `https://${formattedAddress}:${state.port}`,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
      return stopPromise;
    },
  };
}

interface HostedCredentialV2 {
  readonly schemaVersion: 2;
  readonly hostAgentToken: string;
  readonly encryptedHostToken: EncryptedExportV1;
}

const HOST_CREDENTIAL_FILE = 'host-credential.json';
const PENDING_HOST_CREDENTIAL_FILE = 'host-credential.pending.json';

async function writeHostedCredentialFile(
  destination: string,
  hostToken: string,
  hostAgentToken: string,
  password: string,
): Promise<void> {
  const temp = `${destination}.tmp-${process.pid}`;
  const credential: HostedCredentialV2 = {
    schemaVersion: 2,
    hostAgentToken,
    encryptedHostToken: await encryptExport({ hostToken }, password),
  };
  await fs.writeFile(temp, JSON.stringify(credential, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, destination);
  await fs.chmod(destination, 0o600).catch(() => {});
}

export async function writeHostedWorkroomCredential(
  roomDir: string,
  hostToken: string,
  hostAgentToken: string,
  password: string,
): Promise<void> {
  await writeHostedCredentialFile(path.join(roomDir, HOST_CREDENTIAL_FILE), hostToken, hostAgentToken, password);
}

export async function prepareHostedWorkroomCredentialRotation(
  roomDir: string,
  hostToken: string,
  hostAgentToken: string,
  password: string,
): Promise<void> {
  await writeHostedCredentialFile(path.join(roomDir, PENDING_HOST_CREDENTIAL_FILE), hostToken, hostAgentToken, password);
}

export async function commitHostedWorkroomCredentialRotation(roomDir: string): Promise<void> {
  const destination = path.join(roomDir, HOST_CREDENTIAL_FILE);
  await fs.rename(path.join(roomDir, PENDING_HOST_CREDENTIAL_FILE), destination);
  await fs.chmod(destination, 0o600).catch(() => {});
}

export async function discardHostedWorkroomCredentialRotation(roomDir: string): Promise<void> {
  await fs.unlink(path.join(roomDir, PENDING_HOST_CREDENTIAL_FILE)).catch((error) => {
    if (getErrorCode(error) !== 'ENOENT') throw error;
  });
}

export async function startHostedWorkroom(input: StartHostedWorkroomInput): Promise<HostedWorkroom> {
  assertLocalInterface(input.address);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new WorkroomValidationError('Port must be between 1 and 65535.');
  const roomId = input.roomId ?? `room-${randomUUID().replace(/-/g, '')}`;
  if (!/^room-[a-f0-9]{32}$/.test(roomId)) throw new WorkroomValidationError('Invalid Workroom ID.');
  const roomDir = path.join(input.homeDir, 'workrooms', roomId);
  await fs.mkdir(roomDir, { recursive: true, mode: 0o700 });
  const pems = await generate([{ name: 'commonName', value: 'NexusFlow Workroom' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: input.address }] },
    ],
  });
  const fingerprint = normalizeFingerprint(new X509Certificate(pems.cert).fingerprint256);
  await Promise.all([
    fs.writeFile(path.join(roomDir, 'certificate.pem'), pems.cert, { encoding: 'utf8', mode: 0o600 }),
    fs.writeFile(path.join(roomDir, 'private-key.pem'), pems.private, { encoding: 'utf8', mode: 0o600 }),
  ]);

  const { state, hostToken, hostAgentToken } = await createInitialWorkroomState({
    roomId,
    name: input.name,
    workspaceId: input.workspaceId,
    address: input.address,
    port: input.port,
    certificateFingerprint: fingerprint,
    password: input.password,
    hostDisplayName: input.hostDisplayName,
    bundle: input.bundle,
    documents: input.documents,
  });
  const store = new WorkroomSqliteStore(roomDir);
  await store.initialize(state);
  await writeHostedWorkroomCredential(roomDir, hostToken, hostAgentToken, input.password);
  const service = new WorkroomService(store);
  const server = await listenWorkroom(service, input.address, input.port, pems.private, pems.cert);
  return hostedResult(state, roomDir, service, server, hostToken, hostAgentToken);
}

export interface PausedWorkroom {
  readonly roomId: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly address: string;
  readonly port: number;
  readonly createdAt: string;
}

export interface QuarantinedWorkroom {
  readonly roomId: string;
  readonly status: 'failed' | 'in-progress';
  readonly name?: string;
  readonly workspaceId?: string;
  readonly recordedAt?: string;
}

async function readSmallImportMarker(markerPath: string): Promise<Record<string, unknown>> {
  const maximumBytes = 16 * 1024;
  const handle = await fs.open(markerPath, 'r');
  try {
    const stat = await assertFileHandleMatchesPath(handle, markerPath);
    if (stat.size > BigInt(maximumBytes)) return {};
    const bytes = await readFileHandleAtMost(handle, maximumBytes + 1);
    if (bytes.length > maximumBytes) return {};
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function listQuarantinedWorkrooms(homeDir: string): Promise<QuarantinedWorkroom[]> {
  const root = path.join(homeDir, 'workrooms');
  const result: QuarantinedWorkroom[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^room-[a-f0-9]{32}$/.test(entry.name)) continue;
    const roomDir = path.join(root, entry.name);
    let status: QuarantinedWorkroom['status'] | undefined;
    let markerPath: string | undefined;
    for (const [marker, markerStatus] of [
      ['import-failed.json', 'failed'],
      ['import-in-progress.json', 'in-progress'],
    ] as const) {
      try {
        await fs.access(path.join(roomDir, marker));
        status = markerStatus;
        markerPath = path.join(roomDir, marker);
        break;
      } catch {}
    }
    if (!status || !markerPath) continue;
    const marker: Record<string, unknown> = await readSmallImportMarker(markerPath).catch(() => ({}));
    result.push({
      roomId: entry.name,
      status,
      name: typeof marker.name === 'string' ? marker.name.slice(0, 160) : undefined,
      workspaceId: typeof marker.workspaceId === 'string' ? marker.workspaceId.slice(0, 255) : undefined,
      recordedAt: typeof marker.failedAt === 'string'
        ? marker.failedAt
        : typeof marker.startedAt === 'string' ? marker.startedAt : undefined,
    });
  }
  return result.sort((left, right) => (right.recordedAt ?? '').localeCompare(left.recordedAt ?? ''));
}

export async function discardQuarantinedWorkroom(homeDir: string, roomId: string): Promise<void> {
  if (!/^room-[a-f0-9]{32}$/.test(roomId)) throw new WorkroomValidationError('Invalid quarantined Workroom ID.');
  const root = path.resolve(homeDir, 'workrooms');
  const roomDir = path.resolve(root, roomId);
  if (path.dirname(roomDir) !== root) throw new WorkroomValidationError('Invalid quarantined Workroom ID.');
  const stat = await fs.lstat(roomDir).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new WorkroomValidationError('Quarantined Workroom not found.');
  let quarantined = false;
  for (const marker of ['import-in-progress.json', 'import-failed.json']) {
    try {
      await fs.access(path.join(roomDir, marker));
      quarantined = true;
    } catch {}
  }
  if (!quarantined) throw new WorkroomValidationError('Only a quarantined failed import can be discarded.');
  await fs.rm(roomDir, { recursive: true });
}

export async function listPausedWorkrooms(homeDir: string): Promise<PausedWorkroom[]> {
  const root = path.join(homeDir, 'workrooms');
  const result: PausedWorkroom[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^room-[a-f0-9]{32}$/.test(entry.name)) continue;
    try {
      let quarantined = false;
      for (const marker of ['import-in-progress.json', 'import-failed.json']) {
        try {
          await fs.access(path.join(root, entry.name, marker));
          quarantined = true;
        } catch {}
      }
      if (quarantined) continue;
      const state = await new WorkroomSqliteStore(path.join(root, entry.name)).read();
      await Promise.all([
        fs.access(path.join(root, entry.name, 'certificate.pem')),
        fs.access(path.join(root, entry.name, 'private-key.pem')),
        fs.access(path.join(root, entry.name, 'host-credential.json')),
      ]);
      result.push({
        roomId: state.roomId,
        name: state.name,
        workspaceId: state.workspaceId,
        address: state.address,
        port: state.port,
        createdAt: state.createdAt,
      });
    } catch {}
  }
  return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function resumeHostedWorkroom(homeDir: string, roomId: string, password: string): Promise<HostedWorkroom> {
  if (!/^room-[a-f0-9]{32}$/.test(roomId)) throw new WorkroomValidationError('Invalid paused Workroom ID.');
  const roomDir = path.join(homeDir, 'workrooms', roomId);
  for (const marker of ['import-in-progress.json', 'import-failed.json']) {
    try {
      await fs.access(path.join(roomDir, marker));
      throw new WorkroomValidationError('This Workroom is quarantined because its import did not complete.');
    } catch (error) {
      if (error instanceof WorkroomValidationError) throw error;
      if (getErrorCode(error) !== 'ENOENT') throw error;
    }
  }
  const store = new WorkroomSqliteStore(roomDir);
  const state = await store.read();
  if (!(await verifyPassword(password, state.password))) {
    throw new WorkroomAuthorizationError('The Workroom password is incorrect or its host credential is invalid.');
  }
  await store.migrateLegacy();
  await store.pruneUnreferencedPackages();
  assertLocalInterface(state.address);
  const [cert, key, credentialRaw, pendingCredentialRaw] = await Promise.all([
    fs.readFile(path.join(roomDir, 'certificate.pem'), 'utf8'),
    fs.readFile(path.join(roomDir, 'private-key.pem'), 'utf8'),
    fs.readFile(path.join(roomDir, HOST_CREDENTIAL_FILE), 'utf8').catch(() => undefined),
    fs.readFile(path.join(roomDir, PENDING_HOST_CREDENTIAL_FILE), 'utf8').catch(() => undefined),
  ]);
  const service = new WorkroomService(store);
  let selected: { readonly hostToken: string; readonly hostAgentToken: string; readonly pending: boolean } | undefined;
  for (const candidate of [
    pendingCredentialRaw ? { raw: pendingCredentialRaw, pending: true } : undefined,
    credentialRaw ? { raw: credentialRaw, pending: false } : undefined,
  ]) {
    if (!candidate) continue;
    try {
      const credential = JSON.parse(candidate.raw) as Partial<HostedCredentialV2>;
      if (credential.schemaVersion !== 2 || typeof credential.hostAgentToken !== 'string' || !credential.hostAgentToken || !credential.encryptedHostToken) continue;
      const decrypted = await decryptExport<{ hostToken?: unknown }>(credential.encryptedHostToken, password);
      if (typeof decrypted.hostToken !== 'string') continue;
      await service.snapshot(decrypted.hostToken);
      selected = { hostToken: decrypted.hostToken, hostAgentToken: credential.hostAgentToken, pending: candidate.pending };
      break;
    } catch {}
  }
  if (!selected) {
    throw new WorkroomAuthorizationError('The Workroom password is incorrect or its host credential is invalid.');
  }
  if (selected.pending) await commitHostedWorkroomCredentialRotation(roomDir);
  else if (pendingCredentialRaw) await discardHostedWorkroomCredentialRotation(roomDir).catch(() => {});
  const server = await listenWorkroom(service, state.address, state.port, key, cert);
  return hostedResult(state, roomDir, service, server, selected.hostToken, selected.hostAgentToken);
}
