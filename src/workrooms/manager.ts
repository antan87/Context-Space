import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getConfigDir } from '../core/config.js';
import { acquireLock } from '../core/locks.js';
import { getErrorCode } from '../utils/errors.js';
import { loadFeatureConfig } from '../core/workspace.js';
import {
  WORKROOM_MAX_DOCUMENT_BYTES,
  WORKROOM_MAX_RESOURCE_CATALOG_JSON_BYTES,
  WORKROOM_MAX_WORKFLOW_EVIDENCE_BYTES,
  WorkroomAuthorizationError,
  WorkroomValidationError,
  type WorkflowPackageV1,
  type WorkflowStepV1,
  type WorkflowStepProgressV1,
  type WorkroomDocumentName,
  type WorkroomInviteV1,
  type WorkroomSnapshotV1,
} from './contracts.js';
import { PinnedWorkroomClient, formatWorkroomInvite, parseWorkroomInvite } from './client.js';
import { decryptExport, encryptExport, randomToken, tokenDigest, type EncryptedExportV1 } from './crypto.js';
import {
  commitHostedWorkroomCredentialRotation,
  discardQuarantinedWorkroom,
  discardHostedWorkroomCredentialRotation,
  listQuarantinedWorkrooms,
  listPausedWorkrooms,
  prepareHostedWorkroomCredentialRotation,
  resumeHostedWorkroom,
  startHostedWorkroom,
  type HostedWorkroom,
  type StartHostedWorkroomInput,
} from './host.js';
import {
  applyCachedResource,
  cacheResourcePackage,
  digestLocalResourceDefinition,
  getLocalResourceDefinition,
  listLocalShareableResources,
  packageLocalResource,
} from './local-resources.js';
import { buildPublishedHandoff, type PortableWorkroomPreview } from './portable.js';
import { parseResourceDefinition, validateResourcePackage } from './resource-package.js';
import { workroomExportPayloadSchema, type WorkroomExportPayloadV1 } from './store.js';

interface ActiveWorkroomCredentialV1 {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly url: string;
  readonly fingerprint: string;
  readonly agentToken: string;
  readonly memberId?: string;
  readonly ownerPid?: number;
  readonly ownershipId?: string;
}

export function validateWorkroomExportPayload(input: unknown): {
  readonly payload: WorkroomExportPayloadV1;
  readonly packages: ReturnType<typeof validateResourcePackage>[];
} {
  const parsed = workroomExportPayloadSchema.safeParse(input);
  if (!parsed.success) throw new WorkroomValidationError('The Workroom export payload does not match schema version 1.');
  const payload = parsed.data as WorkroomExportPayloadV1;
  for (const name of ['plan', 'decisions', 'handoff'] as const) {
    const document = payload.room.documents[name];
    if (document.name !== name || Buffer.byteLength(document.content, 'utf8') > WORKROOM_MAX_DOCUMENT_BYTES) {
      throw new WorkroomValidationError(`The exported ${name} document is invalid or too large.`);
    }
    if (document.history.some((revision) => revision.revision >= document.revision || Buffer.byteLength(revision.content, 'utf8') > WORKROOM_MAX_DOCUMENT_BYTES)) {
      throw new WorkroomValidationError(`The exported ${name} document history is invalid.`);
    }
  }
  for (let index = 1; index < payload.room.activity.length; index += 1) {
    if (payload.room.activity[index]!.sequence <= payload.room.activity[index - 1]!.sequence) {
      throw new WorkroomValidationError('The Workroom export activity sequence is invalid.');
    }
  }
  const workflowEvidenceBytes = payload.room.workflowProgress?.steps.reduce(
    (total, step) => total + Buffer.byteLength(step.evidence ?? '', 'utf8'),
    0,
  ) ?? 0;
  if (workflowEvidenceBytes > WORKROOM_MAX_WORKFLOW_EVIDENCE_BYTES) {
    throw new WorkroomValidationError('The Workroom export workflow evidence exceeds the 512 KiB room limit.');
  }
  const packages = payload.packages.map((pkg) => validateResourcePackage(pkg));
  const packageStorageBytes = packages.reduce(
    (total, pkg) => total + Buffer.byteLength(`${JSON.stringify(pkg, null, 2)}\n`, 'utf8'),
    0,
  );
  if (packageStorageBytes > WORKROOM_MAX_RESOURCE_CATALOG_JSON_BYTES) {
    throw new WorkroomValidationError('The Workroom export exceeds the 40 MiB shared resource storage limit.');
  }
  const keys = new Set<string>();
  for (const pkg of packages) {
    const key = `${pkg.manifest.kind}:${pkg.manifest.id}:${pkg.manifest.version}`;
    if (keys.has(key)) throw new WorkroomValidationError('The Workroom export contains duplicate immutable resource versions.');
    keys.add(key);
  }
  const catalog = new Map(payload.room.resources.map((resource) => [resource.digest, resource]));
  if (catalog.size !== packages.length || payload.room.resources.some((resource) => resource.quarantinedAt)) {
    throw new WorkroomValidationError('The Workroom export resource catalog does not match its packages.');
  }
  for (const pkg of packages) {
    const resource = catalog.get(pkg.manifest.digest);
    if (!resource || resource.kind !== pkg.manifest.kind || resource.id !== pkg.manifest.id || resource.version !== pkg.manifest.version) {
      throw new WorkroomValidationError('The Workroom export resource catalog does not match its packages.');
    }
  }
  return { payload, packages };
}

function activeCredentialPath(workspaceId: string, homeDir = getConfigDir()): string {
  const safePrefix = workspaceId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'workspace';
  const identity = createHash('sha256').update(workspaceId, 'utf8').digest('hex').slice(0, 16);
  return path.join(homeDir, 'workrooms', 'active', `${safePrefix}-${identity}.json`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === 'EPERM';
  }
}

async function writeActiveCredential(
  credential: Omit<ActiveWorkroomCredentialV1, 'ownerPid' | 'ownershipId'>,
  homeDir = getConfigDir(),
): Promise<string> {
  const destination = activeCredentialPath(credential.workspaceId, homeDir);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${destination}.lock`, {
    staleMs: 60_000,
    timeoutMs: 10_000,
    timeoutMessage: 'Timed out waiting for the active Workroom credential lock.',
  });
  const ownershipId = randomUUID();
  const temp = `${destination}.tmp-${process.pid}-${ownershipId}`;
  try {
    const existing = await fs.readFile(destination, 'utf8')
      .then((raw) => JSON.parse(raw) as ActiveWorkroomCredentialV1, () => undefined);
    if (existing?.ownerPid && existing.ownershipId && processIsAlive(existing.ownerPid)) {
      throw new WorkroomValidationError('Another running NexusFlow dashboard already owns the Workroom connection for this workspace.');
    }
    await fs.writeFile(temp, JSON.stringify({ ...credential, ownerPid: process.pid, ownershipId }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, destination);
    await fs.chmod(destination, 0o600).catch(() => {});
    return ownershipId;
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  } finally {
    await release();
  }
}

async function removeOwnedActiveCredential(
  workspaceId: string,
  roomId: string,
  ownershipId: string,
  homeDir = getConfigDir(),
): Promise<void> {
  const destination = activeCredentialPath(workspaceId, homeDir);
  const release = await acquireLock(`${destination}.lock`, {
    staleMs: 60_000,
    timeoutMs: 10_000,
    timeoutMessage: 'Timed out waiting for the active Workroom credential lock.',
  });
  try {
    const existing = await fs.readFile(destination, 'utf8')
      .then((raw) => JSON.parse(raw) as ActiveWorkroomCredentialV1, () => undefined);
    if (existing?.roomId === roomId && existing.ownershipId === ownershipId && existing.ownerPid === process.pid) {
      await fs.unlink(destination).catch(() => {});
    }
  } finally {
    await release();
  }
}

export async function loadPinnedWorkroomClientForWorkspace(workspaceId: string): Promise<PinnedWorkroomClient> {
  let credential: ActiveWorkroomCredentialV1;
  try {
    credential = JSON.parse(await fs.readFile(activeCredentialPath(workspaceId), 'utf8')) as ActiveWorkroomCredentialV1;
  } catch {
    throw new WorkroomValidationError('No active Workroom connection is registered for this workspace.');
  }
  if (credential.schemaVersion !== 1 || credential.workspaceId !== workspaceId || !credential.agentToken) {
    throw new WorkroomValidationError('The active Workroom connection record is invalid.');
  }
  return new PinnedWorkroomClient(credential.url, credential.fingerprint, credential.agentToken);
}

interface GuestConnection {
  readonly invite: WorkroomInviteV1;
  readonly displayName: string;
  readonly deviceToken: string;
  readonly agentToken: string;
  readonly requestId: string;
  readonly client: PinnedWorkroomClient;
  readonly agentClient: PinnedWorkroomClient;
  readonly localWorkspaceId?: string;
  effectiveWorkspaceId?: string;
  status: 'pending' | 'accepted' | 'rejected';
  memberId?: string;
}

export interface WorkroomHumanAuthority {
  readonly digest: string;
  readonly generation: number;
}

export type WorkroomManagerStatus =
  | { mode: 'idle' }
  | { mode: 'host'; roomId: string; name: string; url: string; localWorkspaceId: string; certificateFingerprint: string; snapshot: WorkroomSnapshotV1 }
  | { mode: 'guest'; roomId: string; name?: string; url: string; status: GuestConnection['status']; connection?: 'connected' | 'disconnected' | 'revoked'; memberId?: string; localWorkspaceId?: string; snapshot?: WorkroomSnapshotV1 };

type StartManagerWorkroomInput = Omit<StartHostedWorkroomInput, 'homeDir' | 'bundle' | 'documents' | 'workspaceId'>
  & Pick<PortableWorkroomPreview, 'workspaceId' | 'bundle' | 'documents'>;
type WorkroomLifecycleState = 'idle' | 'starting' | 'resuming' | 'joining' | 'polling' | 'importing' | 'stopping';

export class WorkroomManager {
  private host?: HostedWorkroom;
  private guest?: GuestConnection;
  private humanSession?: WorkroomHumanAuthority;
  private activeGeneration = 0;
  private activeHumanOperations = 0;
  private lifecycleState: WorkroomLifecycleState = 'idle';
  private passwordRotationInProgress = false;
  private shutdownRequested = false;
  private stopPromise?: Promise<void>;
  private readonly lifecycleWaiters = new Set<() => void>();
  private readonly credentialOwnership = new Map<string, { readonly roomId: string; readonly ownershipId: string }>();
  private recoveryFailures: number[] = [];

  constructor(private readonly homeDir = getConfigDir()) {}

  public hasActiveRoom(): boolean {
    return Boolean(this.host || this.guest);
  }

  public activeRoomType(): 'host' | 'guest' | undefined {
    if (this.host) return 'host';
    if (this.guest) return 'guest';
    return undefined;
  }

  private activeRoomChanged(): void {
    this.activeGeneration += 1;
    this.humanSession = undefined;
  }

  private signalLifecycleChange(): void {
    const waiters = [...this.lifecycleWaiters];
    this.lifecycleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private async waitForLifecycleIdle(): Promise<void> {
    while (this.lifecycleState !== 'idle' || this.passwordRotationInProgress || this.activeHumanOperations > 0) {
      await new Promise<void>((resolve) => this.lifecycleWaiters.add(resolve));
    }
  }

  private beginLifecycle(next: Exclude<WorkroomLifecycleState, 'idle'>): void {
    if (this.shutdownRequested && next !== 'stopping') {
      throw new WorkroomValidationError('The Workroom is shutting down.');
    }
    if (this.passwordRotationInProgress) {
      throw new WorkroomValidationError('A Workroom password rotation is already in progress.');
    }
    if (this.lifecycleState !== 'idle') {
      throw new WorkroomValidationError(`A Workroom lifecycle change is already ${this.lifecycleState}.`);
    }
    if (next !== 'stopping' && next !== 'polling' && (this.host || this.guest)) {
      throw new WorkroomValidationError('Stop or leave the active Workroom first.');
    }
    if (next === 'polling' && !this.guest) throw new WorkroomValidationError('No pending Workroom join exists.');
    this.lifecycleState = next;
  }

  private endLifecycle(expected: Exclude<WorkroomLifecycleState, 'idle'>): void {
    if (this.lifecycleState === expected) this.lifecycleState = 'idle';
    this.signalLifecycleChange();
  }

  public beginHumanSession(): string {
    if (!this.host && !this.guest) throw new WorkroomValidationError('Join or start a Workroom first.');
    if (this.shutdownRequested || this.lifecycleState === 'stopping') {
      throw new WorkroomValidationError('The Workroom is shutting down.');
    }
    const token = randomToken();
    this.humanSession = { digest: tokenDigest(token), generation: this.activeGeneration };
    return token;
  }

  public async reclaimHostHumanSession(password: string): Promise<string> {
    if (!this.host) throw new WorkroomValidationError('Guest connections must leave and rejoin after losing local human authority.');
    const cutoff = Date.now() - 60_000;
    this.recoveryFailures = this.recoveryFailures.filter((attempt) => attempt >= cutoff);
    if (this.recoveryFailures.length >= 5) {
      throw new WorkroomValidationError('Too many failed local recovery attempts. Try again in one minute.');
    }
    if (!(await this.host.service.verifyHostRecoveryPassword(password))) {
      this.recoveryFailures.push(Date.now());
      throw new WorkroomAuthorizationError('The Workroom password is incorrect.');
    }
    this.recoveryFailures = [];
    return this.beginHumanSession();
  }

  public abandonLockedGuest(): Promise<void> {
    if (!this.guest || this.host) throw new WorkroomValidationError('Only a locked guest connection can be abandoned without a human session.');
    return this.stopOrLeave();
  }

  public assertHumanSession(token: string | undefined): WorkroomHumanAuthority {
    if (!token || !this.humanSession || tokenDigest(token) !== this.humanSession.digest
      || this.humanSession.generation !== this.activeGeneration) {
      throw new WorkroomAuthorizationError('A browser-established Workroom human session is required.');
    }
    return this.humanSession;
  }

  private assertHumanAuthority(authority: WorkroomHumanAuthority): void {
    if (!this.humanSession || authority.digest !== this.humanSession.digest
      || authority.generation !== this.humanSession.generation
      || authority.generation !== this.activeGeneration) {
      throw new WorkroomAuthorizationError('The Workroom changed after this browser operation was authorized.');
    }
  }

  public async runWithHumanAuthority<T>(authority: WorkroomHumanAuthority, operation: () => Promise<T>): Promise<T> {
    this.assertHumanAuthority(authority);
    if (this.shutdownRequested || this.lifecycleState === 'stopping') {
      throw new WorkroomValidationError('The Workroom is shutting down.');
    }
    this.activeHumanOperations += 1;
    try {
      this.assertHumanAuthority(authority);
      return await operation();
    } finally {
      this.activeHumanOperations -= 1;
      this.signalLifecycleChange();
    }
  }

  public async startHost(input: StartManagerWorkroomInput): Promise<WorkroomManagerStatus> {
    this.beginLifecycle('starting');
    try {
      return await this.startHostUnlocked(input);
    } finally {
      this.endLifecycle('starting');
    }
  }

  private async startHostUnlocked(input: StartManagerWorkroomInput): Promise<WorkroomManagerStatus> {
    const hosted = await startHostedWorkroom({
      homeDir: this.homeDir,
      name: input.name,
      workspaceId: input.workspaceId,
      address: input.address,
      port: input.port,
      password: input.password,
      hostDisplayName: input.hostDisplayName,
      bundle: input.bundle,
      documents: input.documents,
    });
    this.host = hosted;
    this.activeRoomChanged();
    try {
      const ownershipId = await writeActiveCredential({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        roomId: hosted.roomId,
        url: hosted.url,
        fingerprint: hosted.certificateFingerprint,
        agentToken: hosted.hostAgentToken,
      }, this.homeDir);
      this.credentialOwnership.set(input.workspaceId, { roomId: hosted.roomId, ownershipId });
    } catch (error) {
      this.host = undefined;
      this.activeRoomChanged();
      this.recoveryFailures = [];
      await hosted.stop().catch(() => {});
      throw error;
    }
    return this.status();
  }

  public listPaused() {
    return listPausedWorkrooms(this.homeDir);
  }

  public listQuarantined() {
    return listQuarantinedWorkrooms(this.homeDir);
  }

  public discardQuarantined(roomId: string) {
    if (this.host || this.guest) throw new WorkroomValidationError('Stop or leave the active Workroom before discarding a failed import.');
    return discardQuarantinedWorkroom(this.homeDir, roomId);
  }

  public async resumeHost(roomId: string, password: string): Promise<WorkroomManagerStatus> {
    this.beginLifecycle('resuming');
    try {
      const hosted = await resumeHostedWorkroom(this.homeDir, roomId, password);
      this.host = hosted;
      this.activeRoomChanged();
      const state = await hosted.service.store.read();
      try {
        const ownershipId = await writeActiveCredential({
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          roomId: state.roomId,
          url: hosted.url,
          fingerprint: state.certificateFingerprint,
          agentToken: hosted.hostAgentToken,
        }, this.homeDir);
        this.credentialOwnership.set(state.workspaceId, { roomId: state.roomId, ownershipId });
      } catch (error) {
        this.host = undefined;
        this.activeRoomChanged();
        await hosted.stop().catch(() => {});
        throw error;
      }
      return this.status();
    } finally {
      this.endLifecycle('resuming');
    }
  }

  public stopOrLeave(authority?: WorkroomHumanAuthority): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (authority) this.assertHumanAuthority(authority);
    this.shutdownRequested = true;
    const stopPromise = this.stopOrLeaveOnce();
    this.stopPromise = stopPromise;
    return stopPromise;
  }

  private async stopOrLeaveOnce(): Promise<void> {
    try {
      await this.waitForLifecycleIdle();
      this.beginLifecycle('stopping');
      const host = this.host;
      const workspaceIds = [
        host ? (await host.service.store.read()).workspaceId : undefined,
        this.guest?.effectiveWorkspaceId ?? this.guest?.localWorkspaceId,
      ].filter((value): value is string => Boolean(value));
      const ownedCredentials = workspaceIds.flatMap((workspaceId) => {
        const owned = this.credentialOwnership.get(workspaceId);
        return owned ? [{ workspaceId, ...owned }] : [];
      });
      this.host = undefined;
      this.guest = undefined;
      this.activeRoomChanged();
      if (host) await host.stop();
      await Promise.all(ownedCredentials.map((owned) => removeOwnedActiveCredential(
        owned.workspaceId, owned.roomId, owned.ownershipId, this.homeDir,
      ).catch(() => {})));
      for (const workspaceId of workspaceIds) this.credentialOwnership.delete(workspaceId);
    } finally {
      this.endLifecycle('stopping');
      this.shutdownRequested = false;
      this.stopPromise = undefined;
      this.signalLifecycleChange();
    }
  }

  public async status(): Promise<WorkroomManagerStatus> {
    if (this.host) {
      const snapshot = await this.host.service.snapshot(this.host.hostAgentToken);
      return {
        mode: 'host',
        roomId: this.host.roomId,
        name: snapshot.name,
        url: this.host.url,
        localWorkspaceId: (await this.host.service.store.read()).workspaceId,
        certificateFingerprint: this.host.certificateFingerprint,
        snapshot,
      };
    }
    if (this.guest) {
      let snapshot: WorkroomSnapshotV1 | undefined;
      let connection: 'connected' | 'disconnected' | 'revoked' | undefined;
      if (this.guest.status === 'accepted') {
        try {
          snapshot = await this.guest.agentClient.snapshot();
          connection = 'connected';
        } catch (error) {
          connection = error instanceof WorkroomAuthorizationError ? 'revoked' : 'disconnected';
        }
      }
      return {
        mode: 'guest',
        roomId: this.guest.invite.roomId,
        name: snapshot?.name,
        url: this.guest.invite.url,
        status: this.guest.status,
        connection,
        memberId: this.guest.memberId,
        localWorkspaceId: this.guest.effectiveWorkspaceId ?? this.guest.localWorkspaceId,
        snapshot,
      };
    }
    return { mode: 'idle' };
  }

  public async createInvite(): Promise<{ readonly invite: string; readonly expiresAt: string }> {
    if (!this.host) throw new WorkroomValidationError('Only the active host can create invitations.');
    const created = await this.host.service.createInvite(this.host.hostToken);
    return {
      invite: formatWorkroomInvite({
        schemaVersion: 1,
        url: this.host.url,
        roomId: this.host.roomId,
        token: created.token,
        fingerprint: this.host.certificateFingerprint,
      }),
      expiresAt: created.expiresAt,
    };
  }

  public async join(inviteText: string, password: string, displayName: string, localWorkspaceId?: string): Promise<WorkroomManagerStatus> {
    this.beginLifecycle('joining');
    try {
      const invite = parseWorkroomInvite(inviteText);
      const deviceToken = randomToken();
      const agentToken = randomToken();
      const publicClient = new PinnedWorkroomClient(invite.url, invite.fingerprint);
      const health = await publicClient.health();
      if (health.roomId !== invite.roomId) throw new WorkroomAuthorizationError('The invitation does not match this Workroom.');
      const response = await publicClient.requestJoin({
        roomId: invite.roomId,
        inviteToken: invite.token,
        password,
        displayName,
        deviceToken,
        agentToken,
      });
      this.guest = {
        invite,
        displayName: displayName.trim(),
        deviceToken,
        agentToken,
        requestId: response.requestId,
        client: new PinnedWorkroomClient(invite.url, invite.fingerprint, deviceToken),
        agentClient: new PinnedWorkroomClient(invite.url, invite.fingerprint, agentToken),
        localWorkspaceId,
        status: 'pending',
      };
      this.activeRoomChanged();
      return this.status();
    } finally {
      this.endLifecycle('joining');
    }
  }

  public async pollJoin(): Promise<WorkroomManagerStatus> {
    this.beginLifecycle('polling');
    try {
      const guest = this.guest!;
      const result = await guest.client.joinStatus(guest.requestId, guest.deviceToken);
      guest.status = result.status;
      guest.memberId = result.memberId;
      if (result.status === 'accepted') {
        const snapshot = await guest.agentClient.snapshot();
        guest.effectiveWorkspaceId = guest.localWorkspaceId;
        if (guest.effectiveWorkspaceId) {
          const ownershipId = await writeActiveCredential({
            schemaVersion: 1,
            workspaceId: guest.effectiveWorkspaceId,
            roomId: snapshot.roomId,
            url: guest.invite.url,
            fingerprint: guest.invite.fingerprint,
            agentToken: guest.agentToken,
            memberId: result.memberId,
          }, this.homeDir);
          this.credentialOwnership.set(guest.effectiveWorkspaceId, { roomId: snapshot.roomId, ownershipId });
        }
      }
      return this.status();
    } finally {
      this.endLifecycle('polling');
    }
  }

  public async decideJoin(requestId: string, accept: boolean): Promise<void> {
    if (!this.host) throw new WorkroomValidationError('Only the active host can decide join requests.');
    await this.host.service.decideJoin(this.host.hostToken, requestId, accept);
  }

  public async setRole(memberId: string, role: 'publisher' | 'member'): Promise<void> {
    if (!this.host) throw new WorkroomValidationError('Only the active host can change member roles.');
    await this.host.service.setParticipantRole(this.host.hostToken, memberId, role);
  }

  public async revokeMember(memberId: string): Promise<void> {
    if (!this.host) throw new WorkroomValidationError('Only the active host can revoke members.');
    await this.host.service.revokeParticipant(this.host.hostToken, memberId);
  }

  public async rotatePassword(password: string, revokeDevices = true): Promise<void> {
    const host = this.host;
    if (!host) throw new WorkroomValidationError('Only the active host can rotate the password.');
    if (this.shutdownRequested) throw new WorkroomValidationError('The Workroom is shutting down.');
    if (this.lifecycleState !== 'idle') throw new WorkroomValidationError(`A Workroom lifecycle change is already ${this.lifecycleState}.`);
    if (this.passwordRotationInProgress) throw new WorkroomValidationError('A Workroom password rotation is already in progress.');
    this.passwordRotationInProgress = true;
    let stateRotated = false;
    try {
      await prepareHostedWorkroomCredentialRotation(host.roomDir, host.hostToken, host.hostAgentToken, password);
      await host.service.rotatePassword(host.hostToken, password, revokeDevices);
      stateRotated = true;
      await commitHostedWorkroomCredentialRotation(host.roomDir);
    } catch (error) {
      if (!stateRotated) await discardHostedWorkroomCredentialRotation(host.roomDir).catch(() => {});
      throw error;
    } finally {
      this.passwordRotationInProgress = false;
      this.signalLifecycleChange();
    }
  }

  private activeRoom(): { roomId: string; service?: HostedWorkroom['service']; token: string; client?: PinnedWorkroomClient } {
    if (this.host) return { roomId: this.host.roomId, service: this.host.service, token: this.host.hostToken };
    if (this.guest?.status === 'accepted') return { roomId: this.guest.invite.roomId, token: this.guest.deviceToken, client: this.guest.client };
    throw new WorkroomValidationError('Join or start a Workroom first.');
  }

  public async snapshot(): Promise<WorkroomSnapshotV1> {
    if (this.host) return this.host.service.snapshot(this.host.hostAgentToken);
    if (this.guest?.status === 'accepted') return this.guest.agentClient.snapshot();
    throw new WorkroomValidationError('Join or start a Workroom first.');
  }

  public async updateDocument(name: WorkroomDocumentName, content: string, expectedRevision: number) {
    const active = this.activeRoom();
    return active.service
      ? active.service.updateDocument(active.token, name, content, expectedRevision)
      : (await active.client!.updateDocument(name, content, expectedRevision)).document;
  }

  public async publishHandoff(workspacePath: string) {
    const feature = await loadFeatureConfig(workspacePath);
    if (!feature) throw new WorkroomValidationError('Local workspace not found.');
    const active = this.activeRoom();
    const snapshot = active.service ? await active.service.snapshot(active.token) : await active.client!.snapshot();
    const actor = this.host
      ? snapshot.participants.find((participant) => participant.role === 'host')
      : snapshot.participants.find((participant) => participant.id === this.guest?.memberId);
    if (!actor) throw new WorkroomAuthorizationError('The active Workroom member could not be identified.');
    const handoff = await buildPublishedHandoff(feature, workspacePath, actor.id);
    return active.service
      ? active.service.publishHandoff(active.token, handoff.markdown, handoff.repos, snapshot.documents.handoff.revision)
      : (await active.client!.publishHandoff(handoff.markdown, handoff.repos, snapshot.documents.handoff.revision)).document;
  }

  public listLocalResources() {
    return listLocalShareableResources();
  }

  public async publishLocalResource(kind: 'skill' | 'agent' | 'workflow', id: string, version: string) {
    const active = this.activeRoom();
    const pkg = await packageLocalResource(kind, id, version);
    return active.service
      ? active.service.publishResource(active.token, pkg)
      : (await active.client!.publishResource(pkg)).package;
  }

  public async downloadResource(digest: string): Promise<{
    readonly cachePath: string;
    readonly preview: {
      readonly manifest: Awaited<ReturnType<WorkroomManager['snapshot']>>['resources'][number];
      readonly action: 'create' | 'update';
      readonly localDigest: string;
      readonly incomingDefinition: string;
      readonly existingDefinition?: string;
      readonly files: Array<{
        readonly path: string;
        readonly bytes: number;
        readonly executable: boolean;
        readonly encoding: 'utf8' | 'base64';
        readonly content: string;
      }>;
    };
  }> {
    const active = this.activeRoom();
    const pkg = active.service
      ? await active.service.getResource(active.token, digest)
      : (await active.client!.getResource(digest)).package;
    const existingDefinition = await getLocalResourceDefinition(pkg.manifest.kind, pkg.manifest.id);
    return {
      cachePath: await cacheResourcePackage(active.roomId, pkg),
      preview: {
        manifest: pkg.manifest,
        action: existingDefinition ? 'update' : 'create',
        localDigest: digestLocalResourceDefinition(existingDefinition),
        incomingDefinition: JSON.stringify(parseResourceDefinition(pkg), null, 2),
        existingDefinition: existingDefinition ? JSON.stringify(existingDefinition, null, 2) : undefined,
        files: pkg.files.map((file) => {
          const bytes = Buffer.from(file.contentBase64, 'base64');
          let content: string;
          let encoding: 'utf8' | 'base64';
          try {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (/[^\t\n\r\x20-\x7e\u00a0-\uffff]/u.test(decoded)) throw new Error('binary');
            content = decoded;
            encoding = 'utf8';
          } catch {
            content = bytes.toString('base64');
            encoding = 'base64';
          }
          return {
            path: file.path,
            bytes: bytes.length,
            executable: Boolean((file.mode ?? 0) & 0o111),
            encoding,
            content,
          };
        }),
      },
    };
  }

  public async applyResource(digest: string, approvedDigest: string, approvedLocalDigest: string) {
    const active = this.activeRoom();
    return applyCachedResource(active.roomId, digest, approvedDigest, approvedLocalDigest);
  }

  public async quarantineResource(digest: string): Promise<void> {
    if (!this.host) throw new WorkroomValidationError('Only the active host can quarantine a shared resource version.');
    await this.host.service.quarantineResource(this.host.hostToken, digest);
  }

  public async purgeResource(digest: string): Promise<void> {
    if (!this.host) throw new WorkroomValidationError('Only the active host can purge a quarantined shared resource version.');
    await this.host.service.purgeResource(this.host.hostToken, digest);
  }

  public async selectWorkflow(workflow: WorkflowPackageV1, expectedRevision: number): Promise<void> {
    const active = this.activeRoom();
    if (active.service) await active.service.selectWorkflow(active.token, workflow, expectedRevision);
    else await active.client!.selectWorkflow(workflow, expectedRevision);
  }

  public async selectLocalWorkflow(
    workflowId: string,
    version: string,
    steps: readonly WorkflowStepV1[],
    expectedRevision: number,
  ): Promise<void> {
    if (!this.host) throw new WorkroomValidationError('Only the active host can select a shared workflow.');
    const definition = await getLocalResourceDefinition('workflow', workflowId);
    if (!definition || typeof definition.name !== 'string' || typeof definition.description !== 'string' || typeof definition.content !== 'string') {
      throw new WorkroomValidationError('Select an available local workflow.');
    }
    await this.selectWorkflow({
      schemaVersion: 1,
      id: workflowId,
      version,
      name: definition.name,
      description: definition.description,
      markdown: definition.content,
      steps: [...steps],
      dependencies: [],
    }, expectedRevision);
  }

  public async transitionWorkflowStep(
    stepId: string,
    status: WorkflowStepProgressV1['status'],
    expectedRevision: number,
    evidence?: string,
  ) {
    const active = this.activeRoom();
    return active.service
      ? active.service.transitionWorkflowStep(active.token, stepId, status, expectedRevision, evidence)
      : (await active.client!.transitionWorkflowStep(stepId, status, expectedRevision, evidence)).step;
  }

  public async exportRoom(passphrase: string): Promise<EncryptedExportV1> {
    if (!this.host) throw new WorkroomValidationError('Only the active host can export the room.');
    if (passphrase.length < 12) throw new WorkroomValidationError('Export passphrases must contain at least 12 characters.');
    return encryptExport(await this.host.service.store.createExportPayload(), passphrase);
  }

  public async importRoom(
    envelope: EncryptedExportV1,
    exportPassphrase: string,
    host: Omit<StartHostedWorkroomInput, 'homeDir' | 'bundle' | 'documents' | 'workspaceId' | 'name'> & { name?: string },
  ): Promise<WorkroomManagerStatus> {
    this.beginLifecycle('importing');
    try {
      return await this.importRoomUnlocked(envelope, exportPassphrase, host);
    } finally {
      this.endLifecycle('importing');
    }
  }

  private async importRoomUnlocked(
    envelope: EncryptedExportV1,
    exportPassphrase: string,
    host: Omit<StartHostedWorkroomInput, 'homeDir' | 'bundle' | 'documents' | 'workspaceId' | 'name'> & { name?: string },
  ): Promise<WorkroomManagerStatus> {
    let decrypted: unknown;
    try {
      decrypted = await decryptExport<unknown>(envelope, exportPassphrase);
    } catch {
      throw new WorkroomValidationError('The encrypted Workroom export is invalid or the passphrase is incorrect.');
    }
    const { payload, packages } = validateWorkroomExportPayload(decrypted);
    const roomId = `room-${randomUUID().replace(/-/g, '')}`;
    const roomDir = path.join(this.homeDir, 'workrooms', roomId);
    const importMarker = {
      schemaVersion: 1,
      name: host.name || payload.room.name,
      workspaceId: payload.room.workspaceId,
    };
    await fs.mkdir(roomDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(roomDir, 'import-in-progress.json'), JSON.stringify({ ...importMarker, startedAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
    let importedHost: HostedWorkroom | undefined;
    try {
      await this.startHostUnlocked({
        ...host,
        roomId,
        name: host.name || payload.room.name,
        workspaceId: payload.room.workspaceId,
        bundle: payload.room.bundle,
        documents: {
          plan: payload.room.documents.plan.content,
          decisions: payload.room.documents.decisions.content,
          handoff: payload.room.documents.handoff.content,
        },
      });
      importedHost = this.host!;
      for (const pkg of packages) await importedHost.service.publishResource(importedHost.hostToken, pkg);
      await importedHost.service.store.mutate((state) => {
        const importedActivity = payload.room.activity.slice(-999);
        const sequence = (importedActivity.at(-1)?.sequence ?? 0) + 1;
        const roomCreated = state.activity[0];
        return {
          state: {
            ...state,
            revision: state.revision + 1,
            documents: payload.room.documents,
            workflowProgress: payload.room.workflowProgress,
            activity: roomCreated ? [...importedActivity, {
              ...roomCreated,
              sequence,
              summary: 'Imported encrypted Workroom backup with new room credentials.',
            }] : importedActivity,
          },
          result: undefined,
        };
      });
      await fs.unlink(path.join(roomDir, 'import-in-progress.json'));
      return this.status();
    } catch (error) {
      if (this.host) {
        this.host = undefined;
        this.activeRoomChanged();
      }
      await importedHost?.stop().catch(() => {});
      const failureMarkerWritten = await fs.writeFile(
        path.join(roomDir, 'import-failed.json'),
        JSON.stringify({ ...importMarker, failedAt: new Date().toISOString() }),
        { encoding: 'utf8', mode: 0o600 },
      ).then(() => true, () => false);
      if (failureMarkerWritten) {
        await fs.unlink(path.join(roomDir, 'import-in-progress.json')).catch(() => {});
      }
      const owned = this.credentialOwnership.get(payload.room.workspaceId);
      if (owned) {
        await removeOwnedActiveCredential(payload.room.workspaceId, owned.roomId, owned.ownershipId, this.homeDir).catch(() => {});
        this.credentialOwnership.delete(payload.room.workspaceId);
      }
      throw error;
    }
  }
}

export const workroomManager = new WorkroomManager();
