import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  Check,
  Clipboard,
  Download,
  KeyRound,
  Link2,
  LogOut,
  Network,
  PackageCheck,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  UserCheck,
  UserMinus,
  Users,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select.js';
import { Spinner } from '../components/ui/spinner.js';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs.js';
import { Textarea } from '../components/ui/textarea.js';
import { HandoffStream, type WorkroomTool } from '../features/workrooms/HandoffStream.js';
import { apiFetch, ApiError } from '../lib/api/client.js';
import { safeCopyToClipboard } from '../lib/clipboard.js';
import {
  BRAND_NAME,
  LEGACY_BRAND_NAME,
  CLI_NAME,
  WORKROOM_ROOM_EXTENSION,
  WORKROOM_LEGACY_ROOM_EXTENSION,
  WORKROOM_INVITE_PROTOCOL,
} from '../brand.js';
import type {
  Feature,
  WorkflowStepProgress,
  WorkroomDocument,
  WorkroomDocumentName,
  WorkroomSnapshot,
  WorkroomStatus,
} from '../types.js';

interface WorkroomsPageProps {
  workspaces: Feature[];
  showToast: (message: string, type?: 'success' | 'error' | 'info', duration?: number) => void;
}

interface NetworkInterface {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
}

interface Preview {
  workspaceId: string;
  bundle: WorkroomSnapshot['bundle'];
  bundleDigest: string;
  bundleWarnings: string[];
  documents: Record<WorkroomDocumentName, string>;
  warnings: Record<WorkroomDocumentName, string[]>;
}

interface ResourceReview {
  action: 'create' | 'update';
  localDigest: string;
  incomingDefinition: string;
  existingDefinition?: string;
  files: Array<{ path: string; bytes: number; executable: boolean; encoding: 'utf8' | 'base64'; content: string }>;
}

interface LocalResource {
  kind: 'skill' | 'agent' | 'workflow';
  id: string;
  name: string;
  description: string;
  custom: boolean;
}

interface PausedWorkroom {
  roomId: string;
  name: string;
  workspaceId: string;
  address: string;
  port: number;
  createdAt: string;
}

interface QuarantinedWorkroom {
  roomId: string;
  status: 'failed' | 'in-progress';
  name?: string;
  workspaceId?: string;
  recordedAt?: string;
}

const documentLabels: Record<WorkroomDocumentName, string> = {
  plan: 'Plan',
  decisions: 'Decisions & knowledge',
  handoff: 'Handoff',
};

const toolLabels: Record<WorkroomTool, string> = {
  overview: 'Project & privacy',
  context: 'Shared context',
  resources: 'Resources',
  workflow: 'Workflow',
  members: 'People',
  activity: 'Full activity log',
  security: 'Security & encrypted export',
};

function randomPassphrase(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 24);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusSnapshot(status: WorkroomStatus): WorkroomSnapshot | undefined {
  return status.mode === 'host' ? status.snapshot : status.mode === 'guest' ? status.snapshot : undefined;
}

function withSnapshot(status: WorkroomStatus, snapshot: WorkroomSnapshot): WorkroomStatus {
  if (status.mode === 'host' || status.mode === 'guest') return { ...status, snapshot };
  return status;
}

function reconcileStatus(current: WorkroomStatus, incoming: WorkroomStatus): WorkroomStatus {
  const currentSnapshot = statusSnapshot(current);
  const incomingSnapshot = statusSnapshot(incoming);
  if (!currentSnapshot || !incomingSnapshot || currentSnapshot.roomId !== incomingSnapshot.roomId) return incoming;

  const newerSnapshot = incomingSnapshot.revision >= currentSnapshot.revision ? incomingSnapshot : currentSnapshot;
  const documents = {
    plan: incomingSnapshot.documents.plan.revision >= currentSnapshot.documents.plan.revision
      ? incomingSnapshot.documents.plan
      : currentSnapshot.documents.plan,
    decisions: incomingSnapshot.documents.decisions.revision >= currentSnapshot.documents.decisions.revision
      ? incomingSnapshot.documents.decisions
      : currentSnapshot.documents.decisions,
    handoff: incomingSnapshot.documents.handoff.revision >= currentSnapshot.documents.handoff.revision
      ? incomingSnapshot.documents.handoff
      : currentSnapshot.documents.handoff,
  };
  return withSnapshot(incoming, { ...newerSnapshot, documents });
}

function reconcileHandoffDocument(current: WorkroomStatus, roomId: string, document: WorkroomDocument): WorkroomStatus {
  const currentSnapshot = statusSnapshot(current);
  if (!currentSnapshot || currentSnapshot.roomId !== roomId || document.revision < currentSnapshot.documents.handoff.revision) return current;
  return withSnapshot(current, {
    ...currentSnapshot,
    documents: { ...currentSnapshot.documents, handoff: document },
  });
}

async function digestContext(bundle: WorkroomSnapshot['bundle'], documents: Record<WorkroomDocumentName, string>): Promise<string> {
  const canonical = JSON.stringify({
    bundle,
    documents: { plan: documents.plan, decisions: documents.decisions, handoff: documents.handoff },
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function WorkroomsPage({ workspaces, showToast }: WorkroomsPageProps) {
  const [status, setStatus] = useState<WorkroomStatus>({ mode: 'idle' });
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sharedDocuments, setSharedDocuments] = useState<Record<WorkroomDocumentName, string>>({ plan: '', decisions: '', handoff: '' });
  const [includedDocuments, setIncludedDocuments] = useState<Record<WorkroomDocumentName, boolean>>({ plan: false, decisions: false, handoff: false });
  const [contextConfirmed, setContextConfirmed] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('4242');
  const [hostName, setHostName] = useState('');
  const [password, setPassword] = useState(() => randomPassphrase());
  const [invite, setInvite] = useState('');
  const [inviteExpiresAt, setInviteExpiresAt] = useState('');
  const [joinInvite, setJoinInvite] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinName, setJoinName] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [drafts, setDrafts] = useState<Record<WorkroomDocumentName, string>>({ plan: '', decisions: '', handoff: '' });
  const [dirtyDocs, setDirtyDocs] = useState<Record<WorkroomDocumentName, boolean>>({ plan: false, decisions: false, handoff: false });
  const [localResources, setLocalResources] = useState<LocalResource[]>([]);
  const [selectedResource, setSelectedResource] = useState('');
  const [resourceVersion, setResourceVersion] = useState('0.1.0');
  const [downloaded, setDownloaded] = useState<Record<string, ResourceReview>>({});
  const [workflowResource, setWorkflowResource] = useState('');
  const [workflowVersion, setWorkflowVersion] = useState('0.1.0');
  const [workflowSteps, setWorkflowSteps] = useState('Plan\nImplement\nVerify\nReview');
  const [workflowEvidence, setWorkflowEvidence] = useState<Record<string, string>>({});
  const [rotationPassword, setRotationPassword] = useState(() => randomPassphrase());
  const [exportPassphrase, setExportPassphrase] = useState(() => randomPassphrase());
  const [importEnvelope, setImportEnvelope] = useState<Record<string, unknown> | null>(null);
  const [activeTab, setActiveTab] = useState<'stream' | WorkroomTool>('stream');
  const [handoffMessage, setHandoffMessage] = useState('');
  const [pausedRooms, setPausedRooms] = useState<PausedWorkroom[]>([]);
  const [quarantinedRooms, setQuarantinedRooms] = useState<QuarantinedWorkroom[]>([]);
  const busyRef = useRef<string | null>(null);
  const streamHeadingRef = useRef<HTMLHeadingElement>(null);
  const toolBackButtonRef = useRef<HTMLButtonElement>(null);
  const activeRoomRenderedRef = useRef(false);

  const snapshot = status.mode === 'host' ? status.snapshot : status.mode === 'guest' ? status.snapshot : undefined;
  const isHost = status.mode === 'host';
  const isPending = status.mode === 'guest' && status.status === 'pending';
  const me = status.mode === 'host'
    ? snapshot?.participants.find((participant) => participant.role === 'host')
    : status.mode === 'guest'
      ? snapshot?.participants.find((participant) => participant.id === status.memberId)
      : undefined;
  const canPublish = me?.role === 'host' || me?.role === 'publisher';
  const hasSnapshot = Boolean(snapshot);

  const refreshStatus = useCallback(async (notify = false) => {
    try {
      const result = await apiFetch<{ status: WorkroomStatus }>('/api/workrooms/status');
      setStatus((current) => reconcileStatus(current, result.status));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        try {
          const session = await apiFetch<{ active: boolean; locked: boolean; roomType?: 'host' | 'guest' }>('/api/workrooms/session');
          setStatus(session.active && session.locked && session.roomType
            ? { mode: 'locked', roomType: session.roomType }
            : { mode: 'idle' });
          return;
        } catch (sessionError) {
          if (notify) showToast(errorMessage(sessionError), 'error');
          return;
        }
      }
      if (notify) showToast(errorMessage(error), 'error');
    }
  }, [showToast]);

  const refreshStoredRooms = useCallback(async () => {
    const [paused, quarantined] = await Promise.all([
      apiFetch<{ rooms: PausedWorkroom[] }>('/api/workrooms/paused'),
      apiFetch<{ rooms: QuarantinedWorkroom[] }>('/api/workrooms/quarantined'),
    ]);
    setPausedRooms(paused.rooms);
    setQuarantinedRooms(quarantined.rooms);
  }, []);

  useEffect(() => {
    void Promise.all([
      refreshStatus(),
      apiFetch<{ interfaces: NetworkInterface[] }>('/api/workrooms/interfaces').then((result) => {
        setInterfaces(result.interfaces);
        setAddress((current) => current || result.interfaces.find((item) => !item.internal && item.family === 'IPv4')?.address || result.interfaces[0]?.address || '');
      }),
      refreshStoredRooms(),
    ]);
    const timer = window.setInterval(() => void refreshStatus(), 3_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus, refreshStoredRooms]);

  useEffect(() => {
    if (!workspaceId) {
      setPreview(null);
      return;
    }
    void apiFetch<{ preview: Preview }>(`/api/workrooms/preview/${encodeURIComponent(workspaceId)}`)
      .then(({ preview: next }) => {
        setPreview(next);
        setSharedDocuments(next.documents);
        setIncludedDocuments({ plan: false, decisions: false, handoff: false });
        setContextConfirmed(false);
        setRoomName((current) => current || `${next.bundle.feature.id} workroom`);
      })
      .catch((error) => showToast(errorMessage(error), 'error'));
  }, [workspaceId, showToast]);

  useEffect(() => {
    if (!snapshot) return;
    setDrafts((current) => ({
      plan: dirtyDocs.plan ? current.plan : snapshot.documents.plan.content,
      decisions: dirtyDocs.decisions ? current.decisions : snapshot.documents.decisions.content,
      handoff: dirtyDocs.handoff ? current.handoff : snapshot.documents.handoff.content,
    }));
  }, [snapshot, dirtyDocs]);

  useEffect(() => {
    if (!snapshot?.workflowProgress) return;
    setWorkflowEvidence((current) => Object.fromEntries(snapshot.workflowProgress!.steps.map((step) => [
      step.stepId,
      current[step.stepId] ?? step.evidence ?? '',
    ])));
  }, [snapshot?.workflowProgress]);

  useEffect(() => {
    if (!hasSnapshot) return;
    void apiFetch<{ resources: LocalResource[] }>('/api/workrooms/local-resources')
      .then(({ resources }) => {
        setLocalResources(resources);
        setSelectedResource((current) => current || (resources[0] ? `${resources[0].kind}:${resources[0].id}` : ''));
        setWorkflowResource((current) => current || resources.find((resource) => resource.kind === 'workflow')?.id || '');
      })
      .catch(() => {});
  }, [hasSnapshot]);

  useEffect(() => {
    if (status.mode === 'idle') {
      setHandoffMessage('');
      setActiveTab('stream');
    }
  }, [status.mode]);

  useEffect(() => {
    if (!hasSnapshot) {
      activeRoomRenderedRef.current = false;
      return;
    }
    if (!activeRoomRenderedRef.current) {
      activeRoomRenderedRef.current = true;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (activeTab === 'stream') streamHeadingRef.current?.focus();
      else toolBackButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, hasSnapshot]);

  const perform = async (key: string, action: () => Promise<void>, success?: string): Promise<boolean> => {
    if (busyRef.current !== null) return false;
    busyRef.current = key;
    setBusy(key);
    try {
      await action();
      await refreshStatus();
      await refreshStoredRooms().catch(() => {});
      if (success) showToast(success, 'success');
      return true;
    } catch (error) {
      showToast(errorMessage(error), 'error', 8_000);
      return false;
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const startRoom = () => perform('start', async () => {
    if (!preview) throw new Error('Select and preview a workspace first.');
    const documents = {
      plan: includedDocuments.plan ? sharedDocuments.plan : '',
      decisions: includedDocuments.decisions ? sharedDocuments.decisions : '',
      handoff: includedDocuments.handoff ? sharedDocuments.handoff : '',
    };
    const result = await apiFetch<{ status: WorkroomStatus }>('/api/workrooms/start', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        name: roomName,
        address,
        port: Number(port),
        password,
        hostDisplayName: hostName,
        contextConfirmed,
        contextDigest: await digestContext(preview.bundle, documents),
        documents,
      }),
    });
    setStatus(result.status);
  }, 'Workroom started.');

  const resumeRoom = (roomId: string) => perform(`resume-${roomId}`, async () => {
    const result = await apiFetch<{ status: WorkroomStatus }>(`/api/workrooms/${encodeURIComponent(roomId)}/resume`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    setStatus(result.status);
  }, 'Workroom resumed with its existing identity and memberships.');

  const discardFailedImport = (roomId: string) => {
    if (!window.confirm(`Discard failed import ${roomId}? This removes only its quarantined local files so you can retry the original encrypted export.`)) return;
    void perform(`discard-${roomId}`, async () => {
      await apiFetch(`/api/workrooms/quarantined/${encodeURIComponent(roomId)}/discard`, {
        method: 'POST',
        body: JSON.stringify({ confirmRoomId: roomId }),
      });
    }, 'Failed import discarded. You can retry the encrypted export.');
  };

  const joinRoom = () => perform('join', async () => {
    const result = await apiFetch<{ status: WorkroomStatus }>('/api/workrooms/join', {
      method: 'POST',
      body: JSON.stringify({ invite: joinInvite, password: joinPassword, displayName: joinName, workspaceId: workspaceId || undefined }),
    });
    setStatus(result.status);
  }, 'Join request sent to the host.');

  const pollJoin = () => perform('poll', async () => {
    const result = await apiFetch<{ status: WorkroomStatus }>('/api/workrooms/join/poll', { method: 'POST' });
    setStatus(result.status);
  });

  const stopOrLeave = () => perform('stop', async () => {
    await apiFetch('/api/workrooms/stop', { method: 'POST' });
    setStatus({ mode: 'idle' });
    setActiveTab('stream');
    setHandoffMessage('');
    setInvite('');
  }, isHost ? 'Workroom stopped.' : 'Left the Workroom.');

  const createInvite = () => perform('invite', async () => {
    const result = await apiFetch<{ invite: string; expiresAt: string }>('/api/workrooms/invites', { method: 'POST' });
    setInvite(result.invite);
    setInviteExpiresAt(result.expiresAt);
    await safeCopyToClipboard(result.invite);
  }, 'One-use invitation copied. Share the password separately.');

  const saveDocument = (name: WorkroomDocumentName) => perform(`doc-${name}`, async () => {
    if (!snapshot) return;
    try {
      await apiFetch(`/api/workrooms/documents/${name}`, {
        method: 'PUT',
        body: JSON.stringify({ content: drafts[name], expectedRevision: snapshot.documents[name].revision }),
      });
      setDirtyDocs((current) => ({ ...current, [name]: false }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await refreshStatus();
        throw new Error('Someone updated this document first. Your draft is preserved; compare it with the latest revision and save again.', { cause: error });
      }
      throw error;
    }
  }, `${documentLabels[name]} shared.`);

  const publishResource = () => perform('publish-resource', async () => {
    const [kind, id] = selectedResource.split(':');
    await apiFetch('/api/workrooms/resources/publish', {
      method: 'POST',
      body: JSON.stringify({ kind, id, version: resourceVersion }),
    });
  }, 'Immutable resource version published.');

  const downloadResource = (digest: string) => perform(`download-${digest}`, async () => {
    const result = await apiFetch<{ preview: ResourceReview }>(`/api/workrooms/resources/${digest}/download`, { method: 'POST' });
    setDownloaded((current) => ({ ...current, [digest]: result.preview }));
  }, 'Resource downloaded to the local quarantine cache. Review it before applying.');

  const applyResource = (digest: string) => perform(`apply-${digest}`, async () => {
    const review = downloaded[digest];
    if (!review) throw new Error('Download and review this resource again before applying it.');
    await apiFetch(`/api/workrooms/resources/${digest}/apply`, {
      method: 'POST',
      body: JSON.stringify({ approvedDigest: digest, approvedLocalDigest: review.localDigest }),
    });
  }, `Resource applied to your local ${BRAND_NAME} catalog.`);

  const quarantineResource = (digest: string) => perform(`quarantine-${digest}`, async () => {
    await apiFetch(`/api/workrooms/resources/${digest}/quarantine`, { method: 'POST' });
  }, 'Resource version quarantined and removed from future exports and downloads.');

  const purgeResource = (digest: string) => {
    if (!window.confirm(`Permanently purge quarantined resource ${digest}? Its package bytes and catalog entry will be removed so the room quota can be reused.`)) return;
    void perform(`purge-${digest}`, async () => {
      await apiFetch(`/api/workrooms/resources/${digest}/purge`, {
        method: 'POST',
        body: JSON.stringify({ confirmDigest: digest }),
      });
    }, 'Quarantined resource permanently purged and its room quota released.');
  };

  const selectWorkflow = () => perform('select-workflow', async () => {
    const local = localResources.find((resource) => resource.kind === 'workflow' && resource.id === workflowResource);
    if (!local) throw new Error('Select a local workflow.');
    const steps = workflowSteps.split(/\r?\n/).map((title) => title.trim()).filter(Boolean).map((title, index) => ({
      id: `${index + 1}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step'}`,
      title,
      requiresEvidence: true,
    }));
    await apiFetch('/api/workrooms/workflow/select', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: local.id,
        version: workflowVersion,
        steps,
        expectedRevision: snapshot?.workflowProgress?.revision ?? 0,
      }),
    });
  }, 'Shared workflow selected.');

  const transitionStep = (step: WorkflowStepProgress, nextStatus: WorkflowStepProgress['status']) => perform(`step-${step.stepId}`, async () => {
    const definition = snapshot?.workflowProgress?.package.steps.find((candidate) => candidate.id === step.stepId);
    const evidence = (workflowEvidence[step.stepId] ?? step.evidence ?? '').trim();
    if (nextStatus === 'completed' && definition?.requiresEvidence && !evidence) {
      throw new Error('Add evidence before completing this workflow step.');
    }
    await apiFetch(`/api/workrooms/workflow/steps/${encodeURIComponent(step.stepId)}/transition`, {
      method: 'POST',
      body: JSON.stringify({ status: nextStatus, expectedRevision: step.revision, ...(nextStatus === 'completed' && evidence ? { evidence } : {}) }),
    });
  });

  const postHandoffUpdate = async (message: string) => {
    const submittedMessage = message.trim();
    const posted = await perform('stream-post', async () => {
      if (!snapshot) throw new Error('The Workroom snapshot is not available.');
      if (dirtyDocs.handoff) throw new Error('Resolve the unsaved Handoff draft in Shared context before posting another update.');
      const currentContent = snapshot.documents.handoff.content.trimEnd();
      const content = currentContent ? `${currentContent}\n\n${submittedMessage}\n` : `${submittedMessage}\n`;
      try {
        const result = await apiFetch<{ document: WorkroomDocument }>('/api/workrooms/documents/handoff', {
          method: 'PUT',
          body: JSON.stringify({ content, expectedRevision: snapshot.documents.handoff.revision }),
        });
        setStatus((current) => reconcileHandoffDocument(current, snapshot.roomId, result.document));
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await refreshStatus();
          throw new Error('Someone updated the handoff first. Your update is preserved; review the latest shared context and post again.', { cause: error });
        }
        throw error;
      }
    }, 'Handoff update shared.');
    if (posted) setHandoffMessage((current) => current.trim() === submittedMessage ? '' : current);
    return posted;
  };

  const exportRoom = () => perform('export', async () => {
    const result = await apiFetch<{ export: Record<string, unknown> }>('/api/workrooms/export', {
      method: 'POST',
      body: JSON.stringify({ passphrase: exportPassphrase }),
    });
    const blob = new Blob([JSON.stringify(result.export, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${snapshot?.roomId ?? `${CLI_NAME}-workroom`}${WORKROOM_ROOM_EXTENSION}`;
    link.click();
    URL.revokeObjectURL(link.href);
  }, 'Encrypted Workroom export created.');

  const importRoom = () => perform('import', async () => {
    if (!importEnvelope) throw new Error(`Choose a ${WORKROOM_ROOM_EXTENSION} or ${WORKROOM_LEGACY_ROOM_EXTENSION} export first.`);
    const result = await apiFetch<{ status: WorkroomStatus }>('/api/workrooms/import', {
      method: 'POST',
      body: JSON.stringify({
        export: importEnvelope,
        exportPassphrase,
        name: roomName || undefined,
        address,
        port: Number(port),
        password,
        hostDisplayName: hostName,
      }),
    });
    setStatus(result.status);
  }, 'Encrypted export imported as a new Workroom with new credentials.');

  if (status.mode === 'locked') {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-5 py-16 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-amber-500/10 text-amber-700"><KeyRound /></div>
        <div><h1 className="text-xl font-semibold">Active Workroom is locked</h1><p className="mt-2 text-sm text-muted-foreground">This browser lost its local human-session cookie. {status.roomType === 'host' ? 'Enter the room password to regain host dashboard controls.' : 'For safety, leave this local guest connection and join again with the invitation and room password.'}</p></div>
        {status.roomType === 'host' ? <div className="mx-auto flex w-full max-w-sm flex-col gap-3"><Label htmlFor="workroom-recovery-password">Room password</Label><Input id="workroom-recovery-password" type="password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} /><Button onClick={() => perform('reclaim', async () => { await apiFetch('/api/workrooms/session/reclaim', { method: 'POST', body: JSON.stringify({ password: recoveryPassword }) }); setRecoveryPassword(''); }, 'Local Workroom dashboard reconnected.')} disabled={busy !== null || !recoveryPassword}>{busy === 'reclaim' ? <Spinner /> : <KeyRound />} Unlock host dashboard</Button></div> : <div><Button variant="destructive-outline" onClick={() => perform('abandon-locked-guest', async () => { await apiFetch('/api/workrooms/session/abandon', { method: 'POST', body: JSON.stringify({ confirm: true }) }); setStatus({ mode: 'idle' }); }, 'Locked guest connection left. Join the Workroom again.')} disabled={busy !== null}>{busy === 'abandon-locked-guest' ? <Spinner /> : <LogOut />} Leave and rejoin</Button></div>}
      </div>
    );
  }

  if (status.mode === 'idle') {
    return (
      <div className="mx-auto max-w-6xl animate-fade-in space-y-6">
        <header>
          <div className="flex items-center gap-2">
            <Users className="text-primary" size={20} />
            <h1 className="text-xl font-semibold text-foreground">Workrooms</h1>
            <Badge variant="info">Experimental</Badge>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Share only the project context and reusable agent resources you explicitly review over a private LAN or VPN. {BRAND_NAME} never adds code, diffs, credentials, terminals, or AI sessions automatically.
            {' '}<Link className="underline" to="/settings#data-and-privacy">Data, retention and export boundaries</Link>.
          </p>
        </header>

        <Alert variant="info">
          <ShieldCheck />
          <AlertTitle>No listener runs by default</AlertTitle>
          <AlertDescription>A Workroom binds only to the network address you select and stops with {BRAND_NAME}.</AlertDescription>
        </Alert>

        {pausedRooms.length > 0 && <Card><CardHeader><CardTitle>Paused Workrooms</CardTitle><CardDescription>Enter the room password in the host form below, then resume on the same saved address and port. The password unlocks human authority; agent credentials remain read-and-propose-only.</CardDescription></CardHeader><CardContent className="grid gap-2 sm:grid-cols-2">{pausedRooms.map((room) => <div key={room.roomId} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"><div className="min-w-0"><p className="truncate text-sm font-semibold">{room.name}</p><p className="truncate font-mono text-[10px] text-muted-foreground">{room.address}:{room.port} · {room.workspaceId}</p></div><Button size="sm" variant="outline" onClick={() => resumeRoom(room.roomId)} disabled={busy !== null || password.length < 12}>{busy === `resume-${room.roomId}` ? <Spinner /> : <Play />} Resume</Button></div>)}</CardContent></Card>}

        {quarantinedRooms.length > 0 && <Card><CardHeader><CardTitle>Failed imports</CardTitle><CardDescription>These rooms never completed import and cannot be resumed. Inspect the identity below, discard its quarantined local files, then retry the original encrypted export.</CardDescription></CardHeader><CardContent className="grid gap-2 sm:grid-cols-2">{quarantinedRooms.map((room) => <div key={room.roomId} className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 p-3"><div className="min-w-0"><p className="truncate text-sm font-semibold">{room.name || room.roomId}</p><p className="truncate font-mono text-[10px] text-muted-foreground">{room.status === 'failed' ? 'Import failed' : 'Import interrupted'}{room.workspaceId ? ` · ${room.workspaceId}` : ''}</p></div><Button size="sm" variant="destructive-outline" onClick={() => discardFailedImport(room.roomId)} disabled={busy !== null}>{busy === `discard-${room.roomId}` ? <Spinner /> : <Trash2 />} Discard</Button></div>)}</CardContent></Card>}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Network size={15} /> Start a Workroom</CardTitle>
              <CardDescription>Host collaboration from this computer. Your existing dashboard remains localhost-only.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Workspace</Label>
                <Select value={workspaceId} onValueChange={(value) => typeof value === 'string' && setWorkspaceId(value)}>
                  <SelectTrigger><SelectValue>{workspaces.find((item) => item.branchName === workspaceId)?.branchName || 'Select a workspace'}</SelectValue></SelectTrigger>
                  <SelectPopup>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.branchName}>{workspace.branchName}</SelectItem>)}</SelectPopup>
                </Select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5"><Label>Room name</Label><Input value={roomName} onChange={(event) => setRoomName(event.target.value)} /></div>
                <div className="space-y-1.5"><Label>Your display name</Label><Input value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder="Defaults to OS user" /></div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
                <div className="space-y-1.5">
                  <Label>Network interface</Label>
                  <Select value={address} onValueChange={(value) => typeof value === 'string' && setAddress(value)}>
                    <SelectTrigger><SelectValue>{address || 'Select an address'}</SelectValue></SelectTrigger>
                    <SelectPopup>{interfaces.map((item) => <SelectItem key={`${item.name}-${item.address}`} value={item.address}>{item.name} · {item.address}{item.internal ? ' (local only)' : ''}</SelectItem>)}</SelectPopup>
                  </Select>
                </div>
                <div className="space-y-1.5"><Label>Port</Label><Input type="number" value={port} onChange={(event) => setPort(event.target.value)} /></div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between"><Label>Room password</Label><Button size="xs" variant="ghost" onClick={() => setPassword(randomPassphrase())}>Generate</Button></div>
                <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
                <p className="text-[11px] text-muted-foreground">Share this separately from the invitation. Minimum 12 characters.</p>
              </div>
              {preview && (
                <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3 text-xs">
                  <div><p className="font-semibold text-foreground">Exact sharing review</p><p className="mt-1 text-muted-foreground">Repository identities below are always included. Local context files are excluded until you explicitly include each one.</p></div>
                  {preview.bundleWarnings.map((warning) => <p key={warning} className="text-amber-700 dark:text-amber-300">Bundle warning: {warning}</p>)}
                  <div className="space-y-1 font-mono text-[10px] text-muted-foreground">{preview.bundle.repos.map((repo) => <div key={repo.id} className="break-all">{repo.name}: {repo.remoteUrl}</div>)}</div>
                  <details><summary className="cursor-pointer font-semibold text-foreground">Complete shared feature metadata</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[10px]">{JSON.stringify(preview.bundle, null, 2)}</pre></details>
                  {(Object.keys(documentLabels) as WorkroomDocumentName[]).map((name) => <div key={name} className="space-y-1.5 rounded border border-border bg-background p-2"><label className="flex items-center gap-2 font-semibold text-foreground"><input type="checkbox" checked={includedDocuments[name]} onChange={(event) => { setIncludedDocuments((current) => ({ ...current, [name]: event.target.checked })); setContextConfirmed(false); }} /> Include {documentLabels[name]}</label>{preview.warnings[name].map((warning) => <p key={warning} className="text-amber-700 dark:text-amber-300">Warning: {warning}</p>)}<Textarea aria-label={`${documentLabels[name]} exact outbound content`} className="min-h-28 font-mono text-[10px]" value={sharedDocuments[name]} onChange={(event) => { setSharedDocuments((current) => ({ ...current, [name]: event.target.value })); setContextConfirmed(false); }} /><p className="text-[10px] text-muted-foreground">{includedDocuments[name] ? `${sharedDocuments[name].length.toLocaleString()} characters will be shared.` : 'Excluded from the Workroom.'}</p></div>)}
                  <label className="flex items-start gap-2 rounded border border-border bg-background p-2 text-[11px]"><input className="mt-0.5" type="checkbox" checked={contextConfirmed} onChange={(event) => setContextConfirmed(event.target.checked)} /><span>I reviewed the exact included text and repository identities, including any credential, path, diff, or transcript warnings.</span></label>
                </div>
              )}
              <Button className="w-full" onClick={startRoom} disabled={!preview || !contextConfirmed || !address || password.length < 12 || busy !== null}>
                {busy === 'start' ? <Spinner /> : <Play />} Start private Workroom
              </Button>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Link2 size={15} /> Join a Workroom</CardTitle>
                <CardDescription>Paste the invitation and enter the separately shared password. The host must approve this device.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5"><Label>Invitation</Label><Textarea className="min-h-24 font-mono text-xs" value={joinInvite} onChange={(event) => setJoinInvite(event.target.value)} placeholder={`${WORKROOM_INVITE_PROTOCOL}//workroom/join?...`} /></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5"><Label>Password</Label><Input type="password" value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} /></div>
                  <div className="space-y-1.5"><Label>Your display name</Label><Input value={joinName} onChange={(event) => setJoinName(event.target.value)} /></div>
                </div>
                <div className="space-y-1.5"><Label>Local workspace mapping</Label><Select value={workspaceId} onValueChange={(value) => typeof value === 'string' && setWorkspaceId(value)}><SelectTrigger><SelectValue>{workspaces.find((item) => item.branchName === workspaceId)?.branchName || 'Select your checkout (recommended)'}</SelectValue></SelectTrigger><SelectPopup>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.branchName}>{workspace.branchName}</SelectItem>)}</SelectPopup></Select><p className="text-[11px] text-muted-foreground">Used for local agent proposals and handoff snapshots; code remains in this checkout.</p></div>
                <Button className="w-full" onClick={joinRoom} disabled={!joinInvite || !joinPassword || busy !== null}>{busy === 'join' ? <Spinner /> : <UserCheck />} Request to join</Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Upload size={15} /> Import an encrypted room</CardTitle><CardDescription>Creates a new room identity, certificate, password, and membership set.</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                <Input type="file" accept={`.json,${WORKROOM_ROOM_EXTENSION},${WORKROOM_LEGACY_ROOM_EXTENSION}`} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 150 * 1024 * 1024) {
                    showToast('Workroom export files are limited to 150 MiB.', 'error');
                    return;
                  }
                  void file.text().then((text) => setImportEnvelope(JSON.parse(text))).catch(() => showToast('Invalid Workroom export file.', 'error'));
                }} />
                <div className="space-y-1.5"><Label>Export passphrase</Label><Input type="password" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} /></div>
                <Button variant="outline" className="w-full" onClick={importRoom} disabled={!importEnvelope || !address || password.length < 12 || busy !== null}>{busy === 'import' ? <Spinner /> : <Upload />} Import and host</Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (isPending || (status.mode === 'guest' && status.status === 'rejected')) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-5 py-16 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-primary/10 text-primary">{isPending ? <RefreshCw className="animate-spin" /> : <UserMinus />}</div>
        <div><h1 className="text-xl font-semibold">{isPending ? 'Waiting for host approval' : 'Join request rejected'}</h1><p className="mt-2 text-sm text-muted-foreground">{isPending ? 'Your device credential is ready, but no room context is available until the host accepts you.' : 'Ask the host for a new one-use invitation if this was unexpected.'}</p></div>
        <div className="flex justify-center gap-2">{isPending && <Button onClick={pollJoin} disabled={busy !== null}>{busy === 'poll' ? <Spinner /> : <RefreshCw />} Check approval</Button>}<Button variant="outline" onClick={stopOrLeave}>Cancel</Button></div>
      </div>
    );
  }

  if (status.mode === 'guest' && status.status === 'accepted' && !snapshot) {
    const revoked = status.connection === 'revoked';
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-5 py-16 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-amber-500/10 text-amber-700">{revoked ? <UserMinus /> : <Network />}</div>
        <div><h1 className="text-xl font-semibold">{revoked ? 'Workroom access was revoked' : 'Workroom connection is unavailable'}</h1><p className="mt-2 text-sm text-muted-foreground">{revoked ? 'Leave this local connection, then ask the host for a new one-use invitation if you should rejoin.' : 'The host or VPN may be offline. You can retry without losing the local connection, or leave immediately.'}</p></div>
        <div className="flex justify-center gap-2">{!revoked && <Button onClick={() => refreshStatus(true)} disabled={busy !== null}><RefreshCw /> Retry connection</Button>}<Button variant="outline" onClick={stopOrLeave} disabled={busy !== null}>{busy === 'stop' ? <Spinner /> : <Square />} Leave local connection</Button></div>
      </div>
    );
  }

  if (!snapshot) {
    return <div className="flex justify-center py-24"><Spinner className="size-6" /></div>;
  }

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-4">
      {activeTab !== 'stream' && (
        <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center">
          <Button ref={toolBackButtonRef} variant="ghost" onClick={() => setActiveTab('stream')}><ArrowLeft /> Back to Handoff Stream</Button>
          <div className="min-w-0 sm:border-l sm:border-border sm:pl-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{snapshot.name}</p>
            <h1 className="truncate text-lg font-semibold">{toolLabels[activeTab]}</h1>
          </div>
        </header>
      )}

      {invite && (
        <Alert variant="success">
          <KeyRound />
          <AlertTitle>One-use invitation ready</AlertTitle>
          <AlertDescription><span className="break-all font-mono text-[10px]">{invite}</span><span>Expires {new Date(inviteExpiresAt).toLocaleString()}. Share the password separately.</span></AlertDescription>
          <Button size="sm" variant="outline" onClick={() => void safeCopyToClipboard(invite)}><Clipboard /> Copy</Button>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'stream' | WorkroomTool)}>
        <TabsList className="hidden">
          <TabsTab value="stream">Handoff Stream</TabsTab>
          {(Object.keys(toolLabels) as WorkroomTool[]).map((tool) => <TabsTab key={tool} value={tool}>{toolLabels[tool]}</TabsTab>)}
        </TabsList>

        <TabsPanel value="stream" className="mt-0">
          <HandoffStream
            snapshot={snapshot}
            roomUrl={status.url}
            isHost={isHost}
            me={me}
            busy={busy}
            message={handoffMessage}
            hasUnsavedHandoffDraft={dirtyDocs.handoff}
            headingRef={streamHeadingRef}
            onCreateInvite={createInvite}
            onRefresh={() => refreshStatus(true)}
            onStopOrLeave={stopOrLeave}
            onOpenTool={setActiveTab}
            onMessageChange={setHandoffMessage}
            onPostUpdate={postHandoffUpdate}
          />
        </TabsPanel>

        <TabsPanel value="overview" className="space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            <Card><CardHeader><CardDescription>Members</CardDescription><CardTitle className="text-2xl">{snapshot.participants.filter((item) => !item.revokedAt).length}</CardTitle></CardHeader></Card>
            <Card><CardHeader><CardDescription>Shared resources</CardDescription><CardTitle className="text-2xl">{snapshot.resources.filter((item) => !item.quarantinedAt).length}</CardTitle></CardHeader></Card>
            <Card><CardHeader><CardDescription>Repository identities</CardDescription><CardTitle className="text-2xl">{snapshot.bundle.repos.length}</CardTitle></CardHeader></Card>
          </div>
          <Card><CardHeader><CardTitle>{snapshot.bundle.feature.goal}</CardTitle><CardDescription>{snapshot.bundle.project.name} · portable feature {snapshot.bundle.feature.id}</CardDescription></CardHeader><CardContent className="space-y-2">{snapshot.bundle.repos.map((repo) => <div key={repo.id} className="rounded-md border border-border p-3"><div className="flex justify-between gap-3"><span className="text-sm font-medium">{repo.name}</span><Badge variant="secondary">{repo.defaultBranch}</Badge></div><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{repo.remoteUrl}</p>{repo.handoff && <p className="mt-1 text-xs text-muted-foreground">{repo.handoff.branch} @ {repo.handoff.commit.slice(0, 12)} · {repo.handoff.dirty ? 'dirty' : 'clean'} · ↑{repo.handoff.ahead} ↓{repo.handoff.behind}</p>}</div>)}</CardContent></Card>
          <Alert variant="info"><ShieldCheck /><AlertTitle>Never collected automatically</AlertTitle><AlertDescription>{BRAND_NAME} does not add source archives, filenames, diffs, local paths, credentials, terminals, editor state, or AI transcripts. A developer can still include sensitive text in a reviewed shared document.</AlertDescription></Alert>
        </TabsPanel>

        <TabsPanel value="context" className="space-y-4">
          {(Object.keys(documentLabels) as WorkroomDocumentName[]).map((name) => <Card key={name}><CardHeader><div className="flex items-center justify-between"><div><CardTitle>{documentLabels[name]}</CardTitle><CardDescription>Revision {snapshot.documents[name].revision} · updated {new Date(snapshot.documents[name].updatedAt).toLocaleString()}</CardDescription></div>{dirtyDocs[name] && <Badge variant="warning">Local draft</Badge>}</div></CardHeader><CardContent className="space-y-3"><Textarea className="min-h-64 font-mono text-xs" value={drafts[name]} disabled={busy !== null} onChange={(event) => { setDrafts((current) => ({ ...current, [name]: event.target.value })); setDirtyDocs((current) => ({ ...current, [name]: true })); }} /><div className="flex flex-wrap justify-end gap-2">{name === 'handoff' && <Button variant="outline" onClick={() => perform('handoff', () => apiFetch('/api/workrooms/handoff', { method: 'POST', body: JSON.stringify({ workspaceId: status.localWorkspaceId }) }).then(() => undefined), 'Git metadata handoff published.')} disabled={!status.localWorkspaceId || busy !== null}><RefreshCw /> Publish Git snapshot</Button>}<Button onClick={() => saveDocument(name)} disabled={!dirtyDocs[name] || busy !== null}>{busy === `doc-${name}` ? <Spinner /> : <Upload />} Share revision</Button></div></CardContent></Card>)}
        </TabsPanel>

        <TabsPanel value="resources" className="space-y-4">
          {canPublish && <Card><CardHeader><CardTitle>Publish a local resource</CardTitle><CardDescription>Published versions are immutable. Connected developers are notified and choose whether to download and apply them.</CardDescription></CardHeader><CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end"><div className="flex-1 space-y-1.5"><Label>Resource</Label><Select value={selectedResource} onValueChange={(value) => typeof value === 'string' && setSelectedResource(value)}><SelectTrigger><SelectValue>{localResources.find((item) => `${item.kind}:${item.id}` === selectedResource)?.name || 'Select resource'}</SelectValue></SelectTrigger><SelectPopup>{localResources.map((resource) => <SelectItem key={`${resource.kind}:${resource.id}`} value={`${resource.kind}:${resource.id}`}>{resource.kind} · {resource.name}</SelectItem>)}</SelectPopup></Select></div><div className="space-y-1.5"><Label>Version</Label><Input className="w-32 font-mono" value={resourceVersion} onChange={(event) => setResourceVersion(event.target.value)} /></div><Button onClick={publishResource} disabled={!selectedResource || busy !== null}><Upload /> Publish</Button></CardContent></Card>}
          <div className="grid gap-3">
            {snapshot.resources.length === 0 ? <Card className="p-8 text-center text-sm text-muted-foreground">No resources have been published.</Card> : snapshot.resources.map((resource) => {
              const review = downloaded[resource.digest];
              const compatibility = [
                resource.compatibility?.platforms?.length ? `platforms: ${resource.compatibility.platforms.join(', ')}` : undefined,
                resource.compatibility?.contextspace ? `${BRAND_NAME} ${resource.compatibility.contextspace}` : resource.compatibility?.nexusflow ? `${LEGACY_BRAND_NAME} ${resource.compatibility.nexusflow}` : undefined,
              ].filter(Boolean).join(' · ');
              return <Card key={resource.digest} className={resource.quarantinedAt ? 'opacity-60' : ''}><CardContent className="space-y-3 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><Badge variant="secondary">{resource.kind}</Badge><span className="text-sm font-semibold">{resource.id}@{resource.version}</span>{resource.quarantinedAt && <Badge variant="error">Quarantined</Badge>}</div><p className="mt-1 font-mono text-[10px] text-muted-foreground">SHA-256 {resource.digest}</p>{compatibility && <p className="mt-1 text-[10px] text-muted-foreground">Compatibility · {compatibility}</p>}</div>{!resource.quarantinedAt ? <div className="flex flex-wrap gap-2">{review ? <Button onClick={() => applyResource(resource.digest)} disabled={busy !== null}><PackageCheck /> Approve exact digest &amp; apply</Button> : <Button variant="outline" onClick={() => downloadResource(resource.digest)} disabled={busy !== null}><Download /> Download for review</Button>}{isHost && <Button variant="ghost" onClick={() => quarantineResource(resource.digest)} disabled={busy !== null}>Quarantine</Button>}</div> : isHost && <Button variant="destructive-outline" onClick={() => purgeResource(resource.digest)} disabled={busy !== null}>{busy === `purge-${resource.digest}` ? <Spinner /> : <Trash2 />} Purge permanently</Button>}</div>{review && <div className="space-y-3 rounded border border-border bg-muted/30 p-3"><div><p className="text-xs font-semibold">Exact package review · {review.action === 'update' ? 'updates an existing local resource' : 'creates a new local resource'}</p><p className="text-[10px] text-muted-foreground">Applying installs the incoming definition shown below and is bound to SHA-256 {resource.digest}.</p></div>{review.existingDefinition && <details><summary className="cursor-pointer text-xs font-semibold">Current local definition</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[10px]">{review.existingDefinition}</pre></details>}<details open><summary className="cursor-pointer text-xs font-semibold">Incoming applied definition</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[10px]">{review.incomingDefinition}</pre></details><div className="space-y-2">{review.files.map((file) => <details key={file.path}><summary className="cursor-pointer font-mono text-[10px]">{file.path} · {file.bytes.toLocaleString()} bytes · {file.encoding}{file.executable ? ' · executable' : ''}</summary><pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[10px]">{file.content}</pre></details>)}</div></div>}</CardContent></Card>;
            })}
          </div>
        </TabsPanel>

        <TabsPanel value="workflow" className="space-y-4">
          {isHost && !snapshot.workflowProgress && <Card><CardHeader><CardTitle>Start shared workflow tracking</CardTitle><CardDescription>Convert a local strategy into explicit ordered steps. Agents may propose completion; a developer confirms it.</CardDescription></CardHeader><CardContent className="space-y-3"><div className="grid gap-3 sm:grid-cols-[1fr_130px]"><div className="space-y-1.5"><Label>Workflow</Label><Select value={workflowResource} onValueChange={(value) => typeof value === 'string' && setWorkflowResource(value)}><SelectTrigger><SelectValue>{localResources.find((item) => item.id === workflowResource && item.kind === 'workflow')?.name || 'Select workflow'}</SelectValue></SelectTrigger><SelectPopup>{localResources.filter((item) => item.kind === 'workflow').map((resource) => <SelectItem key={resource.id} value={resource.id}>{resource.name}</SelectItem>)}</SelectPopup></Select></div><div className="space-y-1.5"><Label>Version</Label><Input value={workflowVersion} onChange={(event) => setWorkflowVersion(event.target.value)} /></div></div><div className="space-y-1.5"><Label>Ordered steps, one per line</Label><Textarea className="min-h-32" value={workflowSteps} onChange={(event) => setWorkflowSteps(event.target.value)} /></div><Button onClick={selectWorkflow} disabled={!workflowResource || busy !== null}><Play /> Start workflow</Button></CardContent></Card>}
          {!isHost && !snapshot.workflowProgress && <Card><CardHeader><CardTitle>No shared workflow yet</CardTitle><CardDescription>The host can select a reviewed workflow for this room. You can continue sharing context and handoff updates while you wait.</CardDescription></CardHeader></Card>}
          {snapshot.workflowProgress && (
            <Card>
              <CardHeader><CardTitle>{snapshot.workflowProgress.package.name}@{snapshot.workflowProgress.workflow.version}</CardTitle><CardDescription>Exact strategy retained at digest {snapshot.workflowProgress.workflow.digest.slice(0, 12)}… · shared progress revision {snapshot.workflowProgress.revision}</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                {snapshot.workflowProgress.steps.map((step, index) => {
                  const definition = snapshot.workflowProgress!.package.steps.find((candidate) => candidate.id === step.stepId);
                  return (
                    <div key={step.stepId} className="rounded-lg border border-border p-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2"><span className="grid size-5 place-items-center rounded-full bg-muted text-[10px]">{index + 1}</span><span className="text-xs font-semibold">{definition?.title || step.stepId}</span><Badge variant={step.status === 'completed' ? 'success' : step.status === 'completion_proposed' ? 'warning' : 'secondary'}>{step.status.replace('_', ' ')}</Badge></div>
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{step.stepId}</p>
                          {step.evidence && <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">Evidence: {step.evidence}</p>}
                          {definition?.requiresEvidence && <div className="mt-3 space-y-1.5"><Label htmlFor={`workflow-evidence-${step.stepId}`}>Completion evidence</Label><Textarea id={`workflow-evidence-${step.stepId}`} className="min-h-20 text-xs" value={workflowEvidence[step.stepId] ?? step.evidence ?? ''} onChange={(event) => setWorkflowEvidence((current) => ({ ...current, [step.stepId]: event.target.value }))} placeholder="Tests, review result, or other verification" /></div>}
                        </div>
                        <div className="flex flex-wrap gap-1.5">{step.status === 'completion_proposed' ? <><Button size="sm" onClick={() => transitionStep(step, 'completed')}><Check /> Confirm</Button><Button size="sm" variant="outline" onClick={() => transitionStep(step, 'in_progress')}>Reject</Button></> : <><Button size="sm" variant="outline" onClick={() => transitionStep(step, 'in_progress')}>In progress</Button><Button size="sm" variant="outline" onClick={() => transitionStep(step, 'completed')}>Complete</Button><Button size="sm" variant="ghost" onClick={() => transitionStep(step, 'pending')}>Reopen</Button></>}</div>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </TabsPanel>

        <TabsPanel value="members" className="space-y-4">
          {isHost && snapshot.pendingJoins.map((request) => <Alert key={request.id} variant="warning"><UserCheck /><AlertTitle>{request.displayName} wants to join</AlertTitle><AlertDescription>Requested {new Date(request.requestedAt).toLocaleString()}</AlertDescription><div className="flex gap-1"><Button size="sm" onClick={() => perform(`accept-${request.id}`, () => apiFetch(`/api/workrooms/members/${request.id}/decision`, { method: 'POST', body: JSON.stringify({ accept: true }) }).then(() => undefined))}>Accept</Button><Button size="sm" variant="outline" onClick={() => perform(`reject-${request.id}`, () => apiFetch(`/api/workrooms/members/${request.id}/decision`, { method: 'POST', body: JSON.stringify({ accept: false }) }).then(() => undefined))}>Reject</Button></div></Alert>)}
          <Card><CardContent className="divide-y divide-border p-0">{snapshot.participants.map((participant) => <div key={participant.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${participant.revokedAt ? 'bg-muted-foreground' : 'bg-emerald-500'}`} /><span className="text-sm font-semibold">{participant.displayName}</span><Badge variant={participant.role === 'host' ? 'info' : 'secondary'}>{participant.role}</Badge>{participant.id === me?.id && <Badge variant="success">You</Badge>}</div><p className="mt-1 text-[11px] text-muted-foreground">Joined {new Date(participant.joinedAt).toLocaleString()}</p></div>{isHost && participant.role !== 'host' && !participant.revokedAt && <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => perform(`role-${participant.id}`, () => apiFetch(`/api/workrooms/members/${participant.id}/role`, { method: 'PUT', body: JSON.stringify({ role: participant.role === 'publisher' ? 'member' : 'publisher' }) }).then(() => undefined))}>{participant.role === 'publisher' ? 'Make member' : 'Make publisher'}</Button><Button size="sm" variant="destructive-outline" onClick={() => perform(`revoke-${participant.id}`, () => apiFetch(`/api/workrooms/members/${participant.id}`, { method: 'DELETE' }).then(() => undefined))}><UserMinus /> Revoke</Button></div>}</div>)}</CardContent></Card>
        </TabsPanel>

        <TabsPanel value="activity"><Card><CardContent className="divide-y divide-border p-0">{[...snapshot.activity].reverse().map((event) => <div key={event.sequence} className="flex gap-3 p-4"><Activity className="mt-0.5 shrink-0 text-muted-foreground" size={14} /><div><p className="text-sm">{event.summary}</p><p className="mt-1 text-[10px] text-muted-foreground">#{event.sequence} · {event.type} · {new Date(event.createdAt).toLocaleString()}</p></div></div>)}</CardContent></Card></TabsPanel>

        <TabsPanel value="security" className="space-y-4">
          <Card><CardHeader><CardTitle>TLS identity</CardTitle><CardDescription>Guests pin this SHA-256 fingerprint from the invitation. Mismatches stop before any password or device credential is sent.</CardDescription></CardHeader><CardContent><code className="break-all text-xs">{snapshot.certificateFingerprint}</code></CardContent></Card>
          {isHost && <div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle>Rotate room password</CardTitle><CardDescription>Outstanding invitations are revoked. Existing device credentials are revoked by default.</CardDescription></CardHeader><CardContent className="space-y-3"><Input type="password" value={rotationPassword} onChange={(event) => setRotationPassword(event.target.value)} /><Button variant="destructive-outline" onClick={() => perform('rotate', () => apiFetch('/api/workrooms/password/rotate', { method: 'POST', body: JSON.stringify({ password: rotationPassword, revokeDevices: true }) }).then(() => undefined), 'Password rotated and guest devices revoked.')}><KeyRound /> Rotate and revoke</Button></CardContent></Card><Card><CardHeader><CardTitle>Encrypted portable export</CardTitle><CardDescription>Excludes certificates, password hashes, invitations, and device credentials.</CardDescription></CardHeader><CardContent className="space-y-3"><div className="space-y-1.5"><Label>Export passphrase</Label><Input type="password" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} /></div><Button variant="outline" onClick={exportRoom} disabled={exportPassphrase.length < 12 || busy !== null}><Download /> Export room</Button></CardContent></Card></div>}
        </TabsPanel>
      </Tabs>
    </div>
  );
}
