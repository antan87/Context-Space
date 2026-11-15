import { X509Certificate } from 'node:crypto';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';

import {
  WorkroomAuthorizationError,
  WorkroomRevisionError,
  WorkroomValidationError,
  workroomInviteSchema,
  type WorkflowPackageV1,
  type WorkflowStepProgressV1,
  type WorkroomDocumentName,
  type WorkroomInviteV1,
  type WorkroomResourcePackageV1,
  type WorkroomSnapshotV1,
  type PortableRepoV1,
} from './contracts.js';
import { normalizeFingerprint } from './crypto.js';
import {
  WORKROOM_DEFAULT_INVITE_PROTOCOL,
  WORKROOM_INVITE_PROTOCOLS,
} from '../core/constants.js';

const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

export function formatWorkroomInvite(invite: WorkroomInviteV1): string {
  const parsed = workroomInviteSchema.parse(invite);
  const url = new URL(`${WORKROOM_DEFAULT_INVITE_PROTOCOL}//workroom/join`);
  url.searchParams.set('v', String(parsed.schemaVersion));
  url.searchParams.set('url', parsed.url);
  url.searchParams.set('room', parsed.roomId);
  url.searchParams.set('token', parsed.token);
  url.searchParams.set('fingerprint', parsed.fingerprint);
  return url.toString();
}

export function parseWorkroomInvite(value: string): WorkroomInviteV1 {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new WorkroomValidationError('Paste a valid Workroom invitation.');
  }
  if (!WORKROOM_INVITE_PROTOCOLS.includes(parsed.protocol) || parsed.hostname !== 'workroom' || parsed.pathname !== '/join') {
    throw new WorkroomValidationError('Paste a valid Workroom invitation.');
  }
  return workroomInviteSchema.parse({
    schemaVersion: Number(parsed.searchParams.get('v')),
    url: parsed.searchParams.get('url'),
    roomId: parsed.searchParams.get('room'),
    token: parsed.searchParams.get('token'),
    fingerprint: normalizeFingerprint(parsed.searchParams.get('fingerprint') ?? ''),
  });
}

async function fetchPinnedCertificate(baseUrl: URL, expectedFingerprint: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hostname = baseUrl.hostname.replace(/^\[|\]$/g, '');
    let settled = false;
    const finish = (error?: Error, cert?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(cert!);
    };
    const socket = tls.connect({
      host: hostname,
      port: Number(baseUrl.port || 443),
      rejectUnauthorized: false,
      servername: net.isIP(hostname) ? undefined : hostname,
    });
    socket.setTimeout(10_000, () => finish(new Error('Timed out while verifying the Workroom certificate.')));
    socket.once('error', (error) => finish(error));
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(true);
      if (!peer.raw) return finish(new Error('The Workroom did not present a certificate.'));
      const certificate = new X509Certificate(peer.raw);
      const actual = normalizeFingerprint(certificate.fingerprint256);
      if (actual !== normalizeFingerprint(expectedFingerprint)) {
        return finish(new WorkroomAuthorizationError('Workroom TLS fingerprint mismatch. The invitation may be stale or intercepted.'));
      }
      finish(undefined, certificate.toString());
    });
  });
}

export class PinnedWorkroomClient {
  private agent?: https.Agent;
  private readonly baseUrl: URL;

  constructor(
    url: string,
    private readonly fingerprint: string,
    private readonly deviceToken?: string,
  ) {
    this.baseUrl = new URL(url);
    if (this.baseUrl.protocol !== 'https:') throw new WorkroomValidationError('Workrooms require HTTPS.');
  }

  public async connect(): Promise<void> {
    if (this.agent) return;
    const certificate = await fetchPinnedCertificate(this.baseUrl, this.fingerprint);
    const expected = normalizeFingerprint(this.fingerprint);
    this.agent = new https.Agent({
      ca: certificate,
      rejectUnauthorized: true,
      checkServerIdentity: (hostname, cert) => {
        const hostnameError = tls.checkServerIdentity(hostname, cert);
        if (hostnameError) return hostnameError;
        if (normalizeFingerprint(cert.fingerprint256) !== expected) return new Error('Workroom TLS fingerprint mismatch.');
        return undefined;
      },
    });
  }

  private async request<T>(method: string, pathname: string, body?: unknown, token = this.deviceToken): Promise<T> {
    await this.connect();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise<T>((resolve, reject) => {
      const request = https.request(new URL(pathname, this.baseUrl), {
        method,
        agent: this.agent,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Workroom response exceeded the safe size limit.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data: unknown = null;
          try { data = raw ? JSON.parse(raw) : null; } catch {}
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            const dataObj = (data && typeof data === 'object') ? (data as Record<string, unknown>) : null;
            const message = typeof dataObj?.error === 'string' ? dataObj.error : `Workroom request failed (${status}).`;
            if (status === 401 || status === 403) return reject(new WorkroomAuthorizationError(message));
            if (status === 409) return reject(new WorkroomRevisionError(Number(dataObj?.expectedRevision), Number(dataObj?.actualRevision)));
            return reject(new WorkroomValidationError(message));
          }
          resolve(data as T);
        });
      });
      request.setTimeout(30_000, () => request.destroy(new Error('Workroom request timed out.')));
      request.once('error', reject);
      request.end(payload);
    });
  }

  public health(): Promise<{ schemaVersion: 1; roomId: string }> {
    return this.request('GET', '/v1/health', undefined, undefined);
  }

  public requestJoin(input: {
    roomId: string;
    inviteToken: string;
    password: string;
    displayName: string;
    deviceToken: string;
    agentToken: string;
  }): Promise<{ requestId: string; status: 'pending' }> {
    return this.request('POST', '/v1/join', input, undefined);
  }

  public joinStatus(requestId: string, deviceToken: string): Promise<{ status: 'pending' | 'accepted' | 'rejected'; memberId?: string }> {
    return this.request('GET', `/v1/join/${encodeURIComponent(requestId)}`, undefined, deviceToken);
  }

  public snapshot(): Promise<WorkroomSnapshotV1> {
    return this.request('GET', '/v1/snapshot');
  }

  public updateDocument(name: WorkroomDocumentName, content: string, expectedRevision: number) {
    return this.request<{ document: WorkroomSnapshotV1['documents'][WorkroomDocumentName] }>(
      'PUT',
      `/v1/documents/${name}`,
      { content, expectedRevision },
    );
  }

  public publishHandoff(content: string, repos: PortableRepoV1[], expectedRevision: number) {
    return this.request<{ document: WorkroomSnapshotV1['documents']['handoff'] }>(
      'POST',
      '/v1/handoff',
      { content, repos, expectedRevision },
    );
  }

  public publishResource(pkg: WorkroomResourcePackageV1): Promise<{ package: WorkroomResourcePackageV1 }> {
    return this.request('POST', '/v1/resources', pkg);
  }

  public getResource(digest: string): Promise<{ package: WorkroomResourcePackageV1 }> {
    return this.request('GET', `/v1/resources/${encodeURIComponent(digest)}`);
  }

  public selectWorkflow(workflow: WorkflowPackageV1, expectedRevision: number): Promise<{ success: true }> {
    return this.request('POST', '/v1/workflow/select', { workflow, expectedRevision });
  }

  public transitionWorkflowStep(
    stepId: string,
    status: WorkflowStepProgressV1['status'],
    expectedRevision: number,
    evidence?: string,
  ): Promise<{ step: WorkflowStepProgressV1 }> {
    return this.request('POST', `/v1/workflow/steps/${encodeURIComponent(stepId)}/transition`, {
      status,
      expectedRevision,
      evidence,
    });
  }

  public proposeWorkflowStep(
    stepId: string,
    expectedRevision: number,
    evidence: string,
  ): Promise<{ step: WorkflowStepProgressV1 }> {
    return this.request('POST', `/v1/workflow/steps/${encodeURIComponent(stepId)}/propose`, {
      expectedRevision,
      evidence,
    });
  }
}
