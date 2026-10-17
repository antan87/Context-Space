import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Send, PlaySquare, Square, Cpu, Bot, History, Copy, Check, RefreshCw, Hash, Zap, X, Image as ImageIcon, Sparkles, Shield, ChevronDown, FileCode } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { Textarea } from '../../components/ui/textarea.js';
import { cn } from '../../lib/utils.js';
import type { Feature, NormalizedUsage, NormalizedRemainingQuota } from '../../types.js';
import { API_BASE } from '../../lib/apiBase.js';
import { clipboardHtmlToText, safeCopyToClipboard } from '../../lib/clipboard.js';
import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { loadChatStore, saveChatStore, clearChatStore, fetchRemoteChatStore, type ChatMessage, type ChatStore } from './chatStore.js';
import { providerForAssistant, readChatLaunchIntent } from './chatLaunch.js';
import { SessionPicker, type PickableSession } from './SessionPicker.js';
import { isChatExecutionProfile, type ChatExecutionProfile } from './executionProfile.js';
import { CHAT_LAUNCH_CONSUMED_KEY, LEGACY_CHAT_LAUNCH_CONSUMED_KEY } from '../../brand.js';
import AnsiImport from 'ansi-to-react';

const Ansi = (AnsiImport as any).default || AnsiImport;

export function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return n.toLocaleString();
}

export function formatHeaderQuota(quota?: NormalizedRemainingQuota): string {
  if (!quota) return 'Quota: Unmonitored';
  if (quota.planType === 'plan-included') return 'Plan: Included';
  if (quota.contextWindow?.utilizationPercent !== undefined) {
    return `Context: ${quota.contextWindow.utilizationPercent.toFixed(1)}%`;
  }
  if (quota.tokens?.remaining !== undefined) {
    return `Quota: ${formatCompact(quota.tokens.remaining)}`;
  }
  if (quota.requests?.remaining !== undefined) {
    return `Quota: ${quota.requests.remaining} req`;
  }
  if (quota.label) return quota.label;
  return 'Quota: OK';
}

interface AttachedImage {
  id: string;
  name: string;
  dataUrl: string;
  file?: File;
}

interface PendingApproval {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  description?: string;
}

const REASONING_EFFORT_OPTIONS = [
  { id: '', label: 'Auto Effort', description: 'Model/provider default reasoning depth' },
  { id: 'low', label: 'Low Effort', description: 'Fast responses with lightweight reasoning' },
  { id: 'medium', label: 'Medium Effort', description: 'Balanced reasoning depth and latency' },
  { id: 'high', label: 'High Effort', description: 'Deep multi-step reasoning and verification' },
  { id: 'max', label: 'Max Effort', description: 'Maximum thinking budget for complex tasks' },
] as const;

function reasoningEffortLabelForId(id: string): string {
  if (!id) return 'Auto';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

interface AgentChatProps {
  ws: Feature;
  draft?: { id: string; text: string };
  onDraftConsumed?: (id: string) => void;
}

interface ProviderCapabilities {
  transport: 'native-api' | 'cli-print' | 'acp' | 'sdk';
  sessionIdentity: 'none' | 'client-assigned' | 'provider-assigned';
  workspaceAccess: 'read-only' | 'workspace-write' | 'harness-managed';
  sessionIdFormat?: 'uuid' | 'opaque';
}

interface ChatProvider {
  id: string;
  name: string;
  icon?: string;
  accessLabel?: string;
  isConfigured: boolean;
  message?: string;
  setupIssue?: 'missing-cli' | 'signed-out' | 'probe-failed';
  recoveryCommand?: string;
  recoveryLabel?: string;
  executionProfiles?: ExecutionProfileOption[];
  defaultExecutionProfile?: ChatExecutionProfile;
  models?: ModelOption[];
  capabilities: ProviderCapabilities;
}

interface ModelOption {
  id: string;
  label: string;
  description: string;
}

interface ExecutionProfileOption {
  id: ChatExecutionProfile;
  label: string;
  description: string;
}

const PROVIDER_RECOVERY_COMMANDS: Record<string, ReadonlySet<string>> = {
  'claude-cli': new Set([
    'npm install -g @anthropic-ai/claude-code',
    'claude auth login',
    'claude auth status --json',
  ]),
  'claude-sdk': new Set([
    'npm install -g @anthropic-ai/claude-code',
    'claude auth login',
    'claude auth status --json',
  ]),
  'codex-cli': new Set([
    'npm install -g @openai/codex',
    'codex login',
    'codex login status',
  ]),
  'codex-sdk': new Set([
    'npm install -g @openai/codex',
    'codex login',
    'codex login status',
  ]),
  'antigravity-cli': new Set([
    'agy',
  ]),
  'copilot-cli': new Set([
    'copilot login',
    'copilot help',
  ]),
};

const PROVIDER_TRANSPORTS = new Set(['native-api', 'cli-print', 'acp', 'sdk']);
const PROVIDER_SESSION_IDENTITIES = new Set(['none', 'client-assigned', 'provider-assigned']);
const PROVIDER_WORKSPACE_ACCESS = new Set(['read-only', 'workspace-write', 'harness-managed']);
const PROVIDER_SESSION_ID_FORMATS = new Set(['uuid', 'opaque']);
const PROVIDER_SETUP_ISSUES = new Set(['missing-cli', 'signed-out', 'probe-failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function decodeProviderCapabilities(value: unknown): ProviderCapabilities | null {
  if (!isRecord(value)
    || typeof value.transport !== 'string'
    || !PROVIDER_TRANSPORTS.has(value.transport)
    || typeof value.sessionIdentity !== 'string'
    || !PROVIDER_SESSION_IDENTITIES.has(value.sessionIdentity)
    || typeof value.workspaceAccess !== 'string'
    || !PROVIDER_WORKSPACE_ACCESS.has(value.workspaceAccess)
    || (value.sessionIdFormat !== undefined
      && (typeof value.sessionIdFormat !== 'string' || !PROVIDER_SESSION_ID_FORMATS.has(value.sessionIdFormat)))) {
    return null;
  }

  return {
    transport: value.transport as ProviderCapabilities['transport'],
    sessionIdentity: value.sessionIdentity as ProviderCapabilities['sessionIdentity'],
    workspaceAccess: value.workspaceAccess as ProviderCapabilities['workspaceAccess'],
    ...(value.sessionIdFormat === undefined
      ? {}
      : { sessionIdFormat: value.sessionIdFormat as ProviderCapabilities['sessionIdFormat'] }),
  };
}

function decodeChatProvider(value: unknown): ChatProvider | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.isConfigured !== 'boolean'
    || !optionalString(value.icon)
    || !optionalString(value.accessLabel)
    || !optionalString(value.message)
    || !optionalString(value.recoveryCommand)
    || !optionalString(value.recoveryLabel)
    || (value.setupIssue !== undefined
      && (typeof value.setupIssue !== 'string' || !PROVIDER_SETUP_ISSUES.has(value.setupIssue)))) {
    return null;
  }

  const capabilities = decodeProviderCapabilities(value.capabilities);
  if (!capabilities) return null;

  let executionProfiles: ExecutionProfileOption[] | undefined;
  if (value.executionProfiles !== undefined) {
    if (!Array.isArray(value.executionProfiles) || value.executionProfiles.length === 0) return null;
    executionProfiles = [];
    const seen = new Set<ChatExecutionProfile>();
    for (const candidate of value.executionProfiles) {
      if (!isRecord(candidate)
        || !isChatExecutionProfile(candidate.id)
        || typeof candidate.label !== 'string'
        || typeof candidate.description !== 'string'
        || seen.has(candidate.id)) {
        return null;
      }
      seen.add(candidate.id);
      executionProfiles.push({
        id: candidate.id,
        label: candidate.label,
        description: candidate.description,
      });
    }
  }
  if (value.defaultExecutionProfile !== undefined
    && (!isChatExecutionProfile(value.defaultExecutionProfile)
      || !executionProfiles?.some(profile => profile.id === value.defaultExecutionProfile))) {
    return null;
  }
  if (executionProfiles && value.defaultExecutionProfile === undefined) return null;
  if (!executionProfiles && value.defaultExecutionProfile !== undefined) return null;

  let models: ModelOption[] | undefined;
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length === 0) return null;
    models = [];
    const seen = new Set<string>();
    for (const candidate of value.models) {
      if (!isRecord(candidate)
        || typeof candidate.id !== 'string'
        || candidate.id.length > 100
        || typeof candidate.label !== 'string'
        || candidate.label.length === 0
        || candidate.label.length > 100
        || typeof candidate.description !== 'string'
        || candidate.description.length > 300
        || seen.has(candidate.id)) {
        return null;
      }
      seen.add(candidate.id);
      models.push({
        id: candidate.id,
        label: candidate.label,
        description: candidate.description,
      });
    }
  }

  const hasAnySetup = value.setupIssue !== undefined
    || value.recoveryCommand !== undefined
    || value.recoveryLabel !== undefined;
  const hasCompleteSetup = value.setupIssue !== undefined
    && value.recoveryCommand !== undefined
    && value.recoveryLabel !== undefined;
  if ((hasAnySetup && !hasCompleteSetup) || (value.isConfigured && hasAnySetup)) return null;

  return {
    id: value.id,
    name: value.name,
    isConfigured: value.isConfigured,
    capabilities,
    ...(value.icon === undefined ? {} : { icon: value.icon }),
    ...(value.accessLabel === undefined ? {} : { accessLabel: value.accessLabel }),
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.setupIssue === undefined
      ? {}
      : { setupIssue: value.setupIssue as ChatProvider['setupIssue'] }),
    ...(value.recoveryCommand === undefined ? {} : { recoveryCommand: value.recoveryCommand }),
    ...(value.recoveryLabel === undefined ? {} : { recoveryLabel: value.recoveryLabel }),
    ...(executionProfiles === undefined ? {} : { executionProfiles }),
    ...(value.defaultExecutionProfile === undefined
      ? {}
      : { defaultExecutionProfile: value.defaultExecutionProfile }),
    ...(models === undefined ? {} : { models }),
  };
}

function decodeChatProviders(value: unknown): ChatProvider[] | null {
  if (!Array.isArray(value)) return null;
  const providers: ChatProvider[] = [];
  for (const candidate of value) {
    const provider = decodeChatProvider(candidate);
    if (!provider) return null;
    providers.push(provider);
  }
  return providers;
}

function recoveryFor(provider: ChatProvider): { command: string; label: string } | null {
  if (!provider.recoveryCommand || !PROVIDER_RECOVERY_COMMANDS[provider.id]?.has(provider.recoveryCommand)) {
    return null;
  }
  return {
    command: provider.recoveryCommand,
    label: provider.recoveryLabel ?? 'Copy recovery command',
  };
}

function formatShortProfileLabel(label?: string): string {
  if (!label) return 'Review';
  if (label.toLowerCase().includes('review')) return 'Review';
  if (label.toLowerCase().includes('edit') || label.toLowerCase().includes('write')) return 'Edit';
  return label;
}

function modelLabelForId(provider: ChatProvider, modelId: string): string {
  if (!modelId) return 'Auto';
  const found = provider.models?.find(model => model.id === modelId);
  if (found) return found.label;
  return modelId;
}

function reconcileModelSelections(
  current: Record<string, string>,
  providers: ChatProvider[],
): Record<string, string> {
  let changed = false;
  const next = { ...current };
  for (const provider of providers) {
    const selected = current[provider.id];
    if (selected && provider.models && !provider.models.some(model => model.id === selected)) {
      delete next[provider.id];
      changed = true;
    }
  }
  return changed ? next : current;
}

interface StartAgentOptions {
  firstMessage?: string | null;
  executionProfile?: ChatExecutionProfile;
  model?: string;
  provider?: ChatProvider;
  session?: { id: string; started: boolean; model?: string };
  resetSession?: boolean;
  resetMessagesOnDispatch?: boolean;
  onDispatched?: () => void;
  onFailure?: () => void;
}

interface RetryableKickoff {
  providerId: string;
  kickoff: string;
  executionProfile: ChatExecutionProfile;
}

interface PendingTurnAdmission {
  turnId: string;
  text: string;
  message: ChatMessage;
}

const formatTime = (ts?: number) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

/**
 * One chat message. Memoized so a streaming chunk only re-renders (and
 * re-parses the markdown of) the last bubble, not the whole history.
 */
const MessageBubble = memo(function MessageBubble({
  msg,
  idx,
  copied,
  onCopy,
}: {
  msg: ChatMessage;
  idx: number;
  copied: boolean;
  onCopy: (idx: number, content: string) => void;
}) {
  if (msg.role === 'system') {
    return (
      <div className="flex justify-center">
        <span className={cn(
          'rounded-full border px-3 py-1 text-center text-[11px]',
          msg.kind === 'error'
            ? 'border-destructive/25 bg-destructive/10 text-destructive-foreground'
            : 'border-border bg-muted text-muted-foreground'
        )}>
          {msg.content}
        </span>
      </div>
    );
  }

  const isUser = msg.role === 'user';
  const hasAnsi = !isUser && msg.content.includes('\x1b');

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div className={`group relative max-w-[85%] rounded-lg p-3 ${isUser ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-foreground'}`}>
        {isUser ? (
          <div className="flex flex-col gap-2">
            {msg.images && msg.images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {msg.images.map((img, i) => (
                  <img
                    key={i}
                    src={img}
                    alt="Attached"
                    className="max-h-48 max-w-full rounded-lg border border-white/20 object-contain shadow-xs cursor-pointer hover:opacity-95"
                    onClick={() => window.open(img, '_blank')}
                  />
                ))}
              </div>
            )}
            {msg.content && <div className="whitespace-pre-wrap text-sm">{msg.content}</div>}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {hasAnsi ? (
              <div className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs text-foreground">
                <Ansi>{msg.content}</Ansi>
              </div>
            ) : (
              <ChatMarkdown content={msg.content} />
            )}
            {msg.filesChanged && msg.filesChanged.length > 0 && (
              <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-border/70 bg-muted/30 p-2 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-muted-foreground">
                  <FileCode size={13} className="text-primary" />
                  <span>{msg.filesChanged.length} file{msg.filesChanged.length > 1 ? 's' : ''} modified</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {msg.filesChanged.map((f, i) => (
                    <span key={i} className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground border border-border/50">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {msg.usage && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground font-mono">
                <span className="inline-flex items-center gap-1 bg-muted/60 px-1.5 py-0.5 rounded border border-border/40">
                  <Zap size={10} className="text-warning-foreground shrink-0" />
                  <span>{msg.usage.inputTokens.toLocaleString()} in</span>
                  {typeof msg.usage.cachedInputTokens === 'number' && msg.usage.cachedInputTokens > 0 && (
                    <span className="text-muted-foreground">({msg.usage.cachedInputTokens.toLocaleString()} cached)</span>
                  )}
                  <span>·</span>
                  <span>{msg.usage.outputTokens.toLocaleString()} out</span>
                  {msg.usage.costUsdEstimate !== undefined && msg.usage.costUsdEstimate > 0 && (
                    <>
                      <span>·</span>
                      <span>~${msg.usage.costUsdEstimate < 0.01 ? msg.usage.costUsdEstimate.toFixed(4) : msg.usage.costUsdEstimate.toFixed(3)}</span>
                    </>
                  )}
                </span>
              </div>
            )}
            <button
              onClick={() => onCopy(idx, msg.content)}
              className="absolute -right-2.5 -top-2.5 hidden h-6 w-6 cursor-pointer place-items-center rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground group-hover:grid"
              title="Copy message"
            >
              {copied ? <Check size={12} className="text-success-foreground" /> : <Copy size={12} />}
            </button>
          </div>
        )}
      </div>
      {isUser && msg.executionProfile && (
        <span className="mt-1 rounded border border-border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {msg.executionProfile === 'workspace-write' ? 'Edit' : 'Review'}
        </span>
      )}
      {msg.ts && (
        <span className="mt-1 text-[10px] text-muted-foreground">{formatTime(msg.ts)}</span>
      )}
    </div>
  );
});

export function AgentChat({ ws, draft, onDraftConsumed }: AgentChatProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);

  // The component is remounted per workspace (keyed by branch), so the
  // one-time initializer always reads the right store.
  const [initialStore] = useState(() => loadChatStore(ws.branchName));
  const [messages, setMessages] = useState<ChatMessage[]>(initialStore.messages);
  const [input, setInput] = useState('');
  const consumedDraftRef = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || consumedDraftRef.current === draft.id) return;
    consumedDraftRef.current = draft.id;
    setInput((current) => current ? `${current}\n\n${draft.text}` : draft.text);
    onDraftConsumed?.(draft.id);
  }, [draft, onDraftConsumed]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  // True once the current turn has streamed its first chunk.
  const [turnOpen, setTurnOpen] = useState(false);
  const [agentName, setAgentName] = useState('');
  const [profilesByProvider, setProfilesByProvider] = useState(initialStore.profilesByProvider);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string>>(initialStore.modelsByProvider ?? {});
  const [effortsByProvider, setEffortsByProvider] = useState<Record<string, string>>(initialStore.effortsByProvider ?? {});
  const [connectionProviderId, setConnectionProviderId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [sessions, setSessions] = useState(initialStore.sessions);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [sessionSwitching, setSessionSwitching] = useState(false);
  const [sessionUsage, setSessionUsage] = useState<NormalizedUsage | null>(null);
  const [sessionQuota, setSessionQuota] = useState<NormalizedRemainingQuota | null>(null);
  const [retryableKickoff, setRetryableKickoff] = useState<RetryableKickoff | null>(null);
  const [retryChecking, setRetryChecking] = useState(false);
  const [copiedRecoveryProvider, setCopiedRecoveryProvider] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Uploading an image is asynchronous, so `busy` alone cannot prevent a
  // second Enter/click from dispatching the same turn before the first upload
  // completes.
  const turnDispatchingRef = useRef(false);

  const appendSystemNote = useCallback((content: string, kind: 'error' | 'note') => {
    setMessages(prev => [...prev, { role: 'system', content, kind, ts: Date.now() }]);
  }, []);

  const handleImageFiles = useCallback((files: FileList | File[]) => {
    const allFiles = Array.from(files);
    const acceptedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    const nonImages = allFiles.filter(f => !acceptedTypes.has(f.type));
    if (nonImages.length > 0) {
      appendSystemNote(`${nonImages.length} unsupported file(s) ignored. Attach PNG, JPEG, GIF, or WebP images.`, 'note');
    }

    const imageFiles = allFiles.filter(f => acceptedTypes.has(f.type));
    if (imageFiles.length === 0) return;

    for (const file of imageFiles) {
      if (file.size > 20 * 1024 * 1024) {
        appendSystemNote(`Image "${file.name}" exceeds the 20MB limit and was not attached.`, 'error');
        continue;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
          setAttachedImages(current => [
            ...current,
            { id: crypto.randomUUID(), name: file.name || `pasted-image-${Date.now()}.png`, dataUrl, file }
          ]);
        } else {
          appendSystemNote(`Image "${file.name || 'pasted image'}" could not be read.`, 'error');
        }
      };
      reader.onerror = () => appendSystemNote(`Image "${file.name || 'pasted image'}" could not be read.`, 'error');
      reader.readAsDataURL(file);
    }
  }, [appendSystemNote]);

  const updateSessions = useCallback((updater: (prev: ChatStore['sessions']) => ChatStore['sessions']) => {
    setSessions((prev) => {
      const next = updater(prev);
      sessionsRef.current = next;
      return next;
    });
    setSessionRevision(c => c + 1);
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const sessionsRef = useRef(initialStore.sessions);
  const pendingAdmissionsRef = useRef<PendingTurnAdmission[]>([]);
  // Whether stream chunks may append to the last assistant bubble (the one
  // opened by the current turn) — prevents merging into errors or old turns.
  const turnOpenRef = useRef(false);
  const endedNoteRef = useRef(false);
  // Latest snapshot for the debounced/unmount flush.
  const latestRef = useRef({ messages, agentName, profilesByProvider, modelsByProvider, effortsByProvider });
  const profilesByProviderRef = useRef(profilesByProvider);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consumedIntentRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const providerRequestRef = useRef(0);
  const connectionProviderRef = useRef<string | null>(null);
  const sessionSwitchingRef = useRef(false);
  const sessionLoadRef = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const launchIntent = useMemo(() => readChatLaunchIntent(location.state), [location.state]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const turnFilesRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);
  const manualStopRef = useRef(false);
  const startAgentRef = useRef<((providerId?: string, options?: StartAgentOptions) => boolean) | null>(null);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const handleApprovalDecision = useCallback((requestId: string, decision: 'allow' | 'deny') => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'approval_response',
        requestId,
        decision,
      }));
    }
    setPendingApprovals(prev => prev.filter(a => a.requestId !== requestId));
  }, []);

  useEffect(() => {
    latestRef.current = { messages, agentName, profilesByProvider, modelsByProvider, effortsByProvider };
    profilesByProviderRef.current = profilesByProvider;
  }, [messages, agentName, profilesByProvider, modelsByProvider, effortsByProvider]);

  const flushPersist = useCallback(() => {
    persistTimer.current = null;
    saveChatStore(ws.branchName, {
      v: 4,
      sessions: sessionsRef.current,
      providerId: latestRef.current.agentName || initialStore.providerId,
      profilesByProvider: latestRef.current.profilesByProvider,
      modelsByProvider: latestRef.current.modelsByProvider,
      effortsByProvider: latestRef.current.effortsByProvider,
      messages: latestRef.current.messages,
    });
  }, [ws.branchName, initialStore.providerId]);

  useEffect(() => {
    // Don't yank the view down while the user is reading history; always
    // follow their own just-sent message. Use smooth only for the user's own
    // send — a smooth animation restarted on every stream chunk stutters.
    const last = messages[messages.length - 1];
    if (nearBottomRef.current || last?.role === 'user') {
      messagesEndRef.current?.scrollIntoView({ behavior: last?.role === 'user' ? 'smooth' : 'auto' });
    }
    // Persisting the whole transcript on every stream chunk was O(chunks x
    // history); debounce so a burst of chunks writes at most once.
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(flushPersist, 400);
  }, [messages, agentName, profilesByProvider, modelsByProvider, sessionRevision, flushPersist]);

  useEffect(() => {
    // pagehide fires on a hard window/tab close where React's unmount cleanup
    // may not run (e.g. the Electron window closing), so the last exchange is
    // still persisted despite the debounce.
    const onHide = () => flushPersist();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (persistTimer.current) clearTimeout(persistTimer.current);
      flushPersist();
    };
  }, [flushPersist]);

  useEffect(() => {
    let active = true;
    fetchRemoteChatStore(ws.branchName).then((remote) => {
      if (!active || !remote) return;
      setMessages((current) => {
        if (current.length === 0 && remote.messages.length > 0) {
          return remote.messages;
        }
        // localStorage may have dropped inline image bytes after a quota
        // failure. Restore them from the durable server thread when the text
        // transcript already exists locally.
        const remoteImages = new Map(
          remote.messages
            .filter(message => message.images?.length)
            .map(message => [`${message.role}:${message.ts ?? ''}:${message.content}`, message.images!]),
        );
        let changed = false;
        const merged = current.map(message => {
          if (message.images?.length) return message;
          const images = remoteImages.get(`${message.role}:${message.ts ?? ''}:${message.content}`);
          if (!images) return message;
          changed = true;
          return { ...message, images };
        });
        return changed ? merged : current;
      });
      if (remote.sessions && Object.keys(remote.sessions).length > 0) {
        updateSessions((currentSessions) => ({ ...remote.sessions, ...currentSessions }));
      }
      if (remote.isBusy && !wsRef.current) {
        const targetProvider = remote.providerId || agentName;
        if (targetProvider && startAgentRef.current) {
          startAgentRef.current(targetProvider, { firstMessage: null });
        }
      }
    });
    return () => { active = false; };
  }, [ws.branchName, updateSessions, agentName]);

  useEffect(() => {
    const requestId = ++providerRequestRef.current;
    const controller = new AbortController();
    let active = true;

    fetch(`${API_BASE}/api/adapters/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(providerData => {
        if (!active || requestId !== providerRequestRef.current) return;
        const nextProviders = decodeChatProviders(providerData);
        if (!nextProviders) throw new Error('Invalid provider status response');
        setProviders(nextProviders);
        setModelsByProvider(current => reconcileModelSelections(current, nextProviders));
        setProfilesByProvider(current => {
          let changed = false;
          const next = { ...current };
          for (const provider of nextProviders) {
            if (!provider.executionProfiles?.length || !provider.defaultExecutionProfile) continue;
            if (!provider.executionProfiles.some(profile => profile.id === current[provider.id])) {
              next[provider.id] = provider.defaultExecutionProfile;
              changed = true;
            }
          }
          return changed ? next : current;
        });

        // Prefer the provider used last time, else the workspace's configured assistant, else the first configured one.
        const defaultProviderForWs = ws.assistants?.[0] ? providerForAssistant(ws.assistants[0]) : undefined;
        const persisted = initialStore.providerId
          ? nextProviders.find((p: ChatProvider) => p.id === initialStore.providerId)
          : undefined;
        const matchingWsProvider = defaultProviderForWs
          ? nextProviders.find((p: ChatProvider) => p.id === defaultProviderForWs && p.isConfigured)
          : undefined;
        const firstProvider = persisted || matchingWsProvider || nextProviders.find((p: ChatProvider) => p.isConfigured) || nextProviders[0];
        // A StrictMode replay or delayed response must not overwrite a user
        // selection or the provider already bound to a connection.
        if (firstProvider) setAgentName(current => current || firstProvider.id);
      })
      .catch(err => {
        if (active && err?.name !== 'AbortError') console.error('Failed to fetch agent data', err);
      })
      .finally(() => {
        if (active && requestId === providerRequestRef.current) setProvidersLoaded(true);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [initialStore.providerId, ws.assistants]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionLoadRef.current.id += 1;
      sessionLoadRef.current.controller?.abort();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [ws.branchName, ws.workspacePath]);

  const displayedProviderId = connectionProviderId ?? agentName;
  const currentProvider = providers.find(p => p.id === displayedProviderId);
  const currentExecutionProfile = currentProvider?.executionProfiles?.find(
    profile => profile.id === profilesByProvider[currentProvider.id],
  ) ?? currentProvider?.executionProfiles?.find(
    profile => profile.id === currentProvider.defaultExecutionProfile,
  );
  const canStart = Boolean(agentName)
    && Boolean(currentProvider?.isConfigured)
    && (!currentProvider?.executionProfiles || Boolean(currentExecutionProfile))
    && !connecting
    && !sessionSwitching;

  const switchProvider = useCallback((newProviderId: string) => {
    if (busy || connecting || sessionSwitching) return;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
    setConnectionProviderId(null);
    setRetryableKickoff(null);
    setAgentName(newProviderId);
    latestRef.current.agentName = newProviderId;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    flushPersist();
  }, [busy, connecting, sessionSwitching, flushPersist]);

  const profileForProvider = useCallback((providerId: string, providerOverride?: ChatProvider) => {
    const provider = providerOverride ?? providers.find(candidate => candidate.id === providerId);
    if (!provider?.executionProfiles?.length) return undefined;
    const selected = profilesByProviderRef.current[providerId];
    if (selected && provider.executionProfiles.some(profile => profile.id === selected)) {
      return selected;
    }
    return provider.defaultExecutionProfile ?? 'review';
  }, [providers]);

  const closeTurn = useCallback(() => {
    turnOpenRef.current = false;
    setTurnOpen(false);
  }, []);

  // Dispatch a user turn on a given socket: send it, echo the bubble, mark busy.
  const sendTurn = useCallback(async (
    socket: WebSocket,
    text: string,
    executionProfile?: ChatExecutionProfile,
    imagesToSend?: AttachedImage[],
  ) => {
    if (turnDispatchingRef.current) return;
    turnDispatchingRef.current = true;
    const currentImages = imagesToSend ?? attachedImages;
    try {
      const turnId = crypto.randomUUID();
      let uploadedPaths: string[] = [];
      let imageUrls: string[] = [];
      let uploadFailed = false;

      if (currentImages.length > 0) {
        const payloads = await Promise.all(currentImages.map(async (img) => {
          try {
            const res = await fetch(`${API_BASE}/api/chat/upload-attachment`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                dataUrl: img.dataUrl,
                filename: img.name,
                workspacePath: ws.workspacePath,
              }),
            });
            if (res.ok) {
              const data = await res.json();
              if (typeof data.path === 'string' && data.path) return { dataUrl: img.dataUrl, path: data.path };
              throw new Error('Invalid upload response');
            }
            const errData = await res.json().catch(() => ({ error: 'Upload failed' }));
            uploadFailed = true;
            appendSystemNote(`Image "${img.name}" could not be uploaded: ${errData.error || res.statusText}`, 'error');
          } catch (err) {
            console.error('Failed to upload image attachment', err);
            uploadFailed = true;
            appendSystemNote(`Image "${img.name}" failed to upload.`, 'error');
          }
          return { dataUrl: img.dataUrl, path: null };
        }));
        if (uploadFailed) {
          // Keep the draft and every preview so the user can retry or remove
          // the failing image. Sending the text without its requested image
          // changes the meaning of the turn.
          appendSystemNote('The message was kept in the composer. Fix or remove the failed image, then try again.', 'note');
          return;
        }
        uploadedPaths = payloads.map(p => p.path).filter((p): p is string => Boolean(p));
        imageUrls = payloads.map(p => p.dataUrl);
      }

      let turnPrompt = text;
      if (uploadedPaths.length > 0) {
        const fileRefText = uploadedPaths.map(p => `[Attached image: ${p}]`).join('\n');
        turnPrompt = turnPrompt ? `${turnPrompt}\n\n${fileRefText}` : fileRefText;
      }

      const message: ChatMessage = {
        role: 'user',
        content: text,
        ts: Date.now(),
        ...(executionProfile ? { executionProfile } : {}),
        ...(imageUrls.length > 0 ? { images: imageUrls } : {}),
      };
      if (socket.readyState !== WebSocket.OPEN || wsRef.current !== socket) {
        appendSystemNote('The agent disconnected while images were uploading. Your draft and attachments were kept.', 'error');
        return;
      }
      pendingAdmissionsRef.current.push({ turnId, text: turnPrompt, message });
      const effort = effortsByProvider[agentName];
      try {
        socket.send(JSON.stringify({
          type: 'input',
          input: turnPrompt,
          turnId,
          ...(executionProfile ? { executionProfile } : {}),
          command: agentName,
          cwd: ws.workspacePath,
          ...(effort ? { effort } : {}),
        }));
      } catch {
        pendingAdmissionsRef.current = pendingAdmissionsRef.current
          .filter(admission => admission.turnId !== turnId);
        appendSystemNote('Failed to send message to the agent. Your draft and attachments were kept.', 'error');
        return;
      }
      setMessages(prev => [...prev, message]);
      // Only clear the snapshot that was submitted. Edits or newly pasted
      // images made while uploads were in flight remain in the composer.
      setInput(current => current.trim() === text ? '' : current);
      const sentIds = new Set(currentImages.map(image => image.id));
      setAttachedImages(current => current.filter(image => !sentIds.has(image.id)));
      setBusy(true);
      closeTurn();
    } finally {
      turnDispatchingRef.current = false;
    }
  }, [agentName, appendSystemNote, attachedImages, closeTurn, effortsByProvider, ws.workspacePath]);

  const noteSessionEnded = useCallback(() => {
    if (endedNoteRef.current) return;
    endedNoteRef.current = true;
    appendSystemNote('Session ended', 'note');
  }, [appendSystemNote]);

  const stopAgent = useCallback(() => {
    manualStopRef.current = true;
    const socket = wsRef.current;
    if (!socket) return;

    // Closing a CONNECTING socket is valid, but sending on it throws. A stop
    // frame is only meaningful once the transport is open.
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'stop' }));
      } catch {
        // The close below is the authoritative local stop even if the socket
        // changed state between the readyState check and send.
      }
    }
    wsRef.current = null;
    connectionProviderRef.current = null;
    setConnectionProviderId(null);
    setConnecting(false);
    socket.close();
    setConnected(false);
    setBusy(false);
    closeTurn();
    noteSessionEnded();
  }, [closeTurn, noteSessionEnded]);

  const startAgent = useCallback((providerId = agentName, options: StartAgentOptions = {}): boolean => {
    manualStopRef.current = false;
    if (wsRef.current) {
      options.onFailure?.();
      return false;
    }

    const selectedProvider = options.provider ?? providers.find((provider) => provider.id === providerId);
    setAgentName(providerId);
    if (!selectedProvider?.isConfigured) {
      appendSystemNote(
        selectedProvider?.message ?? `The ${providerId} provider is unavailable. Check its local CLI installation and login.`,
        'error',
      );
      options.onFailure?.();
      return false;
    }
    const turnExecutionProfile = options.executionProfile ?? profileForProvider(providerId, selectedProvider);
    const supportsExecutionProfile = turnExecutionProfile !== undefined
      && selectedProvider.executionProfiles?.some(profile => profile.id === turnExecutionProfile) === true;
    if ((options.executionProfile !== undefined || selectedProvider.executionProfiles?.length)
      && !supportsExecutionProfile) {
      appendSystemNote('Select a supported execution profile before starting this local CLI.', 'error');
      options.onFailure?.();
      return false;
    }
    const selectedModel = options.model ?? modelsByProvider[providerId];
    if (selectedModel
      && selectedProvider.models
      && !selectedProvider.models.some(model => model.id === selectedModel)) {
      appendSystemNote('Select a model advertised by this provider before starting the harness.', 'error');
      options.onFailure?.();
      return false;
    }

    // Convert API_BASE to ws:// or wss://
    let wsUrl = API_BASE;
    if (wsUrl.startsWith('http')) {
      wsUrl = wsUrl.replace('http', 'ws');
    } else {
      wsUrl = window.location.origin.replace('http', 'ws');
    }
    wsUrl += '/ws';

    endedNoteRef.current = false;
    let dispatched = false;
    let failureReported = false;
    let socket: WebSocket;

    const failBeforeDispatch = () => {
      if (failureReported || dispatched || !mountedRef.current) return;
      failureReported = true;
      setBusy(false);
      setConnecting(false);
      setConnected(false);
      appendSystemNote('Could not open the local agent connection. Your current chat was preserved; retry explicitly when ready.', 'error');
      options.onFailure?.();
    };

    try {
      socket = new WebSocket(wsUrl);
    } catch {
      failBeforeDispatch();
      return false;
    }
    socket.onopen = () => {
      if (!mountedRef.current || wsRef.current !== socket) {
        socket.close();
        return;
      }
      const startPayload: Record<string, unknown> = {
        type: 'start',
        command: providerId,
        // Sessions always run in the workspace dir — that's where the
        // generated context files live (see src/utils/feature.ts).
        cwd: ws.workspacePath,
      };
      if (selectedModel) {
        startPayload.model = selectedModel;
      }
      const selectedEffort = effortsByProvider[providerId];
      if (selectedEffort) {
        startPayload.effort = selectedEffort;
      }
      const nextSessions = { ...sessionsRef.current };
      if (options.resetSession) delete nextSessions[providerId];
      if (options.session) nextSessions[providerId] = options.session;

      if (selectedProvider.capabilities.sessionIdentity === 'client-assigned') {
        // Claude accepts a caller-assigned UUID for a new session.
        const existing = nextSessions[providerId];
        const session = existing ?? { id: crypto.randomUUID(), started: false };
        nextSessions[providerId] = session;
        startPayload.sessionId = session.id;
        startPayload.resume = session.started;
      } else if (selectedProvider.capabilities.sessionIdentity === 'provider-assigned') {
        // ACP providers and Codex create their own session ids. Only pass one
        // when resuming an id captured from the provider's session event.
        const session = nextSessions[providerId];
        if (session?.started) {
          startPayload.sessionId = session.id;
          startPayload.resume = true;
        }
      }

      // If the user already typed a message, send it as the first turn so
      // Enter connects and sends in one step instead of requiring a second Enter.
      // `null` is an explicit programmatic connect-without-send. This matters
      // for session resume: an unrelated draft in the composer must not become
      // a surprise write-capable first turn. `undefined` retains the manual
      // Start/Enter behavior of sending the visible draft.
      const firstMessage = options.firstMessage === null ? '' : (options.firstMessage ?? input).trim();
      let kickoffAdmission: PendingTurnAdmission | undefined;

      try {
        socket.send(JSON.stringify(startPayload));
        if (firstMessage) {
          const turnId = crypto.randomUUID();
          const message: ChatMessage = {
            role: 'user',
            content: firstMessage,
            ts: Date.now(),
            ...(turnExecutionProfile ? { executionProfile: turnExecutionProfile } : {}),
          };
          kickoffAdmission = { turnId, text: firstMessage, message };
          pendingAdmissionsRef.current.push(kickoffAdmission);
          socket.send(JSON.stringify({
            type: 'input',
            input: firstMessage,
            turnId,
            ...(turnExecutionProfile ? { executionProfile: turnExecutionProfile } : {}),
          }));
        }
      } catch {
        if (kickoffAdmission) {
          pendingAdmissionsRef.current = pendingAdmissionsRef.current
            .filter(admission => admission.turnId !== kickoffAdmission?.turnId);
        }
        failBeforeDispatch();
        wsRef.current = null;
        connectionProviderRef.current = null;
        setConnectionProviderId(null);
        setConnecting(false);
        socket.close();
        return;
      }

      // Only commit session/chat replacement after both frames have been
      // accepted by an open transport. A failed kickoff therefore cannot
      // erase the user's prior local conversation.
      updateSessions(() => nextSessions);
      dispatched = true;
      setConnecting(false);
      setConnected(true);
      if (options.resetMessagesOnDispatch) setMessages([]);
      if (firstMessage) {
        setMessages(prev => [
          ...(options.resetMessagesOnDispatch ? [] : prev),
          kickoffAdmission?.message ?? {
            role: 'user',
            content: firstMessage,
            ts: Date.now(),
            ...(turnExecutionProfile ? { executionProfile: turnExecutionProfile } : {}),
          },
        ]);
        setInput('');
        setBusy(true);
        closeTurn();
      }
      options.onDispatched?.();
    };

    socket.onmessage = (event) => {
      if (wsRef.current !== socket) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'stream') {
          const append = turnOpenRef.current;
          turnOpenRef.current = true;
          setTurnOpen(true);
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (append && last?.role === 'assistant') {
              const newArr = [...prev];
              newArr[newArr.length - 1] = { ...last, content: last.content + payload.text };
              return newArr;
            }
            return [...prev, { role: 'assistant', content: payload.text, ts: Date.now() }];
          });
        } else if (payload.type === 'session' && typeof payload.id === 'string') {
          const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id);
          if (validId) {
            updateSessions(prev => ({
              ...prev,
              [providerId]: { id: payload.id, started: true },
            }));
          }
        } else if (payload.type === 'approval_request' && typeof payload.requestId === 'string') {
          setPendingApprovals(prev => [
            ...prev.filter(a => a.requestId !== payload.requestId),
            {
              requestId: payload.requestId,
              tool: typeof payload.tool === 'string' ? payload.tool : 'Tool',
              input: (payload.input && typeof payload.input === 'object') ? payload.input : {},
              description: typeof payload.description === 'string' ? payload.description : undefined,
            },
          ]);
        } else if (payload.type === 'accepted' && typeof payload.turnId === 'string') {
          pendingAdmissionsRef.current = pendingAdmissionsRef.current
            .filter(admission => admission.turnId !== payload.turnId);
        } else if (payload.type === 'file_changed') {
          if (Array.isArray(payload.paths)) {
            for (const p of payload.paths) {
              if (typeof p === 'string' && p.trim()) {
                turnFilesRef.current.add(p.trim());
              }
            }
          }
        } else if (payload.type === 'usage') {
          const turnUsage: NormalizedUsage = payload.usage;
          const cumulative: NormalizedUsage = payload.cumulative;
          const quota: NormalizedRemainingQuota = payload.quota;

          if (cumulative) setSessionUsage(cumulative);
          if (quota) setSessionQuota(quota);

          if (turnUsage) {
            setMessages((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].role === 'assistant') {
                  const updated = [...prev];
                  updated[i] = { ...updated[i], usage: turnUsage };
                  return updated;
                }
              }
              return prev;
            });
          }
        } else if (payload.type === 'usage_summary') {
          if (payload.cumulative) setSessionUsage(payload.cumulative);
          if (payload.quota) setSessionQuota(payload.quota);
        } else if (payload.type === 'quota') {
          if (payload.quota) setSessionQuota(payload.quota);
        } else if (payload.type === 'status') {
          setBusy(payload.state === 'busy');
          if (payload.state !== 'busy') {
            const filesModified = Array.from(turnFilesRef.current);
            turnFilesRef.current.clear();
            if (filesModified.length > 0) {
              setMessages((prev) => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].role === 'assistant') {
                    const updated = [...prev];
                    const existing = updated[i].filesChanged || [];
                    const merged = Array.from(new Set([...existing, ...filesModified]));
                    updated[i] = { ...updated[i], filesChanged: merged };
                    return updated;
                  }
                }
                return prev;
              });
            }
            closeTurn();
            setPendingApprovals([]);
          }
        } else if (payload.type === 'system') {
          appendSystemNote(payload.message, 'note');
        } else if (payload.type === 'rejected' && payload.reason === 'busy') {
          const rejectedIndex = pendingAdmissionsRef.current
            .findIndex(admission => admission.turnId === payload.turnId);
          const rejected = rejectedIndex === -1
            ? undefined
            : pendingAdmissionsRef.current.splice(rejectedIndex, 1)[0];
          if (rejected) {
            setMessages(prev => prev.filter(message => message !== rejected.message));
            setInput(current => current ? `${rejected.text}\n\n${current}` : rejected.text);
          }
          appendSystemNote(
            typeof payload.message === 'string'
              ? payload.message
              : 'The agent is still processing the current turn.',
            'error',
          );
        } else if (payload.type === 'error') {
          pendingAdmissionsRef.current = [];
          setPendingApprovals([]);
          turnFilesRef.current.clear();
          if (typeof payload.message === 'string' && payload.message.toLowerCase().includes('session')) {
            updateSessions(prev => {
              const next = { ...prev };
              delete next[providerId];
              return next;
            });
          }
          appendSystemNote(payload.message, 'error');
          setBusy(false);
          setConnecting(false);
          closeTurn();
        } else if (payload.type === 'close') {
          pendingAdmissionsRef.current = [];
          setPendingApprovals([]);
          turnFilesRef.current.clear();
          setConnected(false);
          setConnecting(false);
          setBusy(false);
          closeTurn();
          noteSessionEnded();
          socket.close();
          wsRef.current = null;
        }
      } catch (err) {
        console.error('Failed to parse WS message', err);
      }
    };

    socket.onclose = () => {
      // Only the active socket's close affects UI state; a socket that was
      // already superseded (Stop then immediate Start) must not clobber the
      // new connection or emit a spurious "Session ended".
      if (wsRef.current !== socket) return;
      if (!dispatched) failBeforeDispatch();

      const wasBusy = busyRef.current;
      const isManual = manualStopRef.current;

      setConnected(false);
      setConnecting(false);
      setBusy(false);
      closeTurn();
      wsRef.current = null;
      connectionProviderRef.current = null;
      setConnectionProviderId(null);

      if (wasBusy && mountedRef.current && !isManual) {
        appendSystemNote('Connection interrupted. Resuming turn...', 'note');
        setTimeout(() => {
          if (mountedRef.current && !manualStopRef.current && !wsRef.current) {
            startAgentRef.current?.(providerId, { firstMessage: null });
          }
        }, 1200);
        return;
      }

      if (dispatched) noteSessionEnded();
    };

    socket.onerror = () => {
      if (wsRef.current !== socket) return;
      failBeforeDispatch();
      setBusy(false);
      setConnecting(false);
      if (!dispatched) {
        wsRef.current = null;
        connectionProviderRef.current = null;
        setConnectionProviderId(null);
        setConnected(false);
        socket.close();
      }
    };

    wsRef.current = socket;
    connectionProviderRef.current = providerId;
    setConnectionProviderId(providerId);
    setConnecting(true);
    return true;
  }, [agentName, appendSystemNote, closeTurn, effortsByProvider, input, modelsByProvider, noteSessionEnded, profileForProvider, providers, updateSessions, ws.workspacePath]);

  useEffect(() => {
    startAgentRef.current = startAgent;
  }, [startAgent]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if ((!text && attachedImages.length === 0) || busy || sessionSwitchingRef.current || turnDispatchingRef.current) return;
    const socket = wsRef.current;
    const providerId = connectionProviderRef.current || agentName;
    if (!connected || !socket || socket.readyState !== WebSocket.OPEN) {
      if (socket) {
        try {
          socket.close();
        } catch {
          // Ignore socket closure error
        }
        wsRef.current = null;
      }
      if (attachedImages.length > 0) {
        const provider = providers.find(candidate => candidate.id === providerId);
        const executionProfile = profileForProvider(providerId, provider);
        if (provider?.executionProfiles?.length && !executionProfile) return;
        const draftText = text;
        const draftImages = attachedImages;
        startAgent(providerId, {
          firstMessage: null,
          onDispatched: () => {
            const connectedSocket = wsRef.current;
            if (!connectedSocket || connectedSocket.readyState !== WebSocket.OPEN) {
              appendSystemNote('The agent connected, but the pasted message could not be sent. Your draft and attachments were kept.', 'error');
              return;
            }
            void sendTurn(connectedSocket, draftText, executionProfile, draftImages);
          },
        });
      } else {
        startAgent(providerId, { firstMessage: text });
      }
      return;
    }
    const provider = providers.find(candidate => candidate.id === providerId);
    const executionProfile = profileForProvider(providerId, provider);
    if (provider?.executionProfiles?.length && !executionProfile) return;
    void sendTurn(socket, text, executionProfile, attachedImages);
  }, [agentName, appendSystemNote, attachedImages, busy, connected, input, profileForProvider, providers, sendTurn, startAgent]);

  const copyMessage = useCallback((idx: number, content: string) => {
    void safeCopyToClipboard(content).then((copied) => {
      if (!copied) {
        appendSystemNote('Could not copy this message. Check browser clipboard permissions or copy it manually.', 'error');
        return;
      }
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(prev => (prev === idx ? null : prev)), 1500);
    });
  }, [appendSystemNote]);

  const finishSessionSwitch = useCallback((requestId: number) => {
    if (sessionLoadRef.current.id !== requestId) return;
    sessionLoadRef.current.controller = null;
    sessionSwitchingRef.current = false;
    if (mountedRef.current) setSessionSwitching(false);
  }, []);

  const loadSession = useCallback(async (session: PickableSession, connectAfterLoad = false): Promise<boolean> => {
    const requestId = sessionLoadRef.current.id + 1;
    sessionLoadRef.current.controller?.abort();
    const controller = new AbortController();
    sessionLoadRef.current = { id: requestId, controller };
    sessionSwitchingRef.current = true;
    setSessionSwitching(true);
    setPickerError(null);
    const providerId = providerForAssistant(session.assistant);
    if (!providerId) {
      appendSystemNote('This session cannot resume in embedded chat.', 'error');
      finishSessionSwitch(requestId);
      return false;
    }

    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider?.isConfigured) {
      appendSystemNote(
        provider?.message ?? `The ${providerId} provider is unavailable. Check its local CLI installation and login.`,
        'error',
      );
      finishSessionSwitch(requestId);
      return false;
    }

    const isCurrentRequest = () => (
      mountedRef.current
      && sessionLoadRef.current.id === requestId
      && !controller.signal.aborted
    );

    try {
      const res = await fetch(
        `${API_BASE}/api/session/${encodeURIComponent(session.assistant)}/${encodeURIComponent(session.id)}/transcript`,
        { signal: controller.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!isCurrentRequest()) return false;
      const transcript: ChatMessage[] = (Array.isArray(data.messages) ? data.messages : [])
        // The transcript parser yields empty strings for tool_use/tool_result
        // records; drop them instead of rendering empty bubbles.
        .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m: any) => ({
          role: m.role,
          content: m.content,
          ts: m.timestamp ? Date.parse(m.timestamp) || undefined : undefined,
        }));

      if (wsRef.current && !window.confirm('Stop the current chat and resume this session?')) {
        finishSessionSwitch(requestId);
        return false;
      }
      if (wsRef.current) stopAgent();

      setAgentName(providerId);
      const commitTranscript = () => {
        if (!isCurrentRequest()) return;
        // Resuming an existing conversation is a new authorization decision.
        // Never inherit a persisted write-capable profile from the prior chat.
        setProfilesByProvider(current => ({
          ...current,
          [providerId]: 'review',
        }));
        setMessages([
          ...transcript,
          { role: 'system', kind: 'note', content: 'Loaded session — your next message resumes it.', ts: Date.now() },
        ]);
        // A draft belongs to the previous context. Clear it only after the
        // requested session switch has actually succeeded.
        setInput('');
        setPickerOpen(false);
        finishSessionSwitch(requestId);
      };

      if (connectAfterLoad) {
        const started = startAgent(providerId, {
          firstMessage: null,
          session: { id: session.id, started: true },
          onDispatched: commitTranscript,
          onFailure: () => {
            if (!isCurrentRequest()) return;
            setPickerError('Failed to connect to the selected session.');
            finishSessionSwitch(requestId);
          },
        });
        return started;
      }

      updateSessions(prev => ({
        ...prev,
        [providerId]: { id: session.id, started: true },
      }));
      commitTranscript();
      return true;
    } catch (error) {
      if (!isCurrentRequest() || (error instanceof DOMException && error.name === 'AbortError')) return false;
      setPickerError('Failed to load the session transcript.');
      appendSystemNote('Failed to load the session transcript. Your current chat was preserved.', 'error');
      finishSessionSwitch(requestId);
      return false;
    }
  }, [appendSystemNote, finishSessionSwitch, providers, startAgent, stopAgent, updateSessions]);

  const pickSession = useCallback((session: PickableSession) => {
    void loadSession(session);
  }, [loadSession]);

  const dispatchKickoff = useCallback(async (
    claim: RetryableKickoff,
    refreshStatus = false,
    allowUnverified = false,
  ): Promise<boolean> => {
    setRetryableKickoff(claim);
    let freshProvider: ChatProvider | undefined;

    if (refreshStatus) {
      setRetryChecking(true);
      try {
        const response = await fetch(`${API_BASE}/api/adapters/status/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: claim.providerId }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: unknown = await response.json();
        const nextProviders = decodeChatProviders(data);
        if (!nextProviders) throw new Error('Invalid provider status response');
        if (!mountedRef.current) return false;
        setProviders(nextProviders);
        setModelsByProvider(current => reconcileModelSelections(current, nextProviders));
        freshProvider = nextProviders.find((provider) => provider.id === claim.providerId);
        const canTryUnverified = allowUnverified
          && (freshProvider?.setupIssue === 'signed-out' || freshProvider?.setupIssue === 'probe-failed');
        if (!freshProvider || (!freshProvider.isConfigured && !canTryUnverified)) {
          appendSystemNote(
            freshProvider?.message ?? 'The selected local CLI is still unavailable. Install it and sign in, then retry.',
            'error',
          );
          return false;
        }
      } catch {
        if (mountedRef.current) {
          appendSystemNote('Could not refresh the local CLI status. The task handoff was not dispatched.', 'error');
        }
        return false;
      } finally {
        if (mountedRef.current) setRetryChecking(false);
      }
    }

    return startAgent(claim.providerId, {
      firstMessage: claim.kickoff,
      executionProfile: claim.executionProfile,
      provider: freshProvider && allowUnverified
        && (freshProvider.setupIssue === 'signed-out' || freshProvider.setupIssue === 'probe-failed')
        ? { ...freshProvider, isConfigured: true }
        : freshProvider,
      resetSession: true,
      resetMessagesOnDispatch: true,
      onDispatched: () => {
        if (mountedRef.current) setRetryableKickoff(null);
      },
      onFailure: () => {
        if (mountedRef.current) setRetryableKickoff(claim);
      },
    });
  }, [appendSystemNote, startAgent]);

  useEffect(() => {
    if (!providersLoaded || !launchIntent) return;

    let previouslyConsumed = consumedIntentRef.current === launchIntent.nonce;
    try {
      previouslyConsumed = previouslyConsumed
        || sessionStorage.getItem(CHAT_LAUNCH_CONSUMED_KEY) === launchIntent.nonce
        || sessionStorage.getItem(LEGACY_CHAT_LAUNCH_CONSUMED_KEY) === launchIntent.nonce;
      sessionStorage.setItem(CHAT_LAUNCH_CONSUMED_KEY, launchIntent.nonce);
    } catch {
      // sessionStorage can be disabled; the component-local guard still
      // prevents repeats during this mount.
    }
    consumedIntentRef.current = launchIntent.nonce;

    // Remove the write-capable intent before opening a socket. Browser back,
    // reload, and React re-renders must never replay a kickoff.
    const nextState = location.state && typeof location.state === 'object'
      ? { ...(location.state as Record<string, unknown>) }
      : {};
    delete nextState.chatLaunch;
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: Object.keys(nextState).length > 0 ? nextState : null,
    });

    if (previouslyConsumed) return;

    const provider = providers.find((candidate) => candidate.id === launchIntent.providerId);
    setAgentName(launchIntent.providerId);
    setProfilesByProvider(current => ({
      ...current,
      [launchIntent.providerId]: launchIntent.executionProfile,
    }));
    if (launchIntent.model) {
      setModelsByProvider(current => ({
        ...current,
        [launchIntent.providerId]: launchIntent.model!,
      }));
    }
    if (!provider?.isConfigured) {
      appendSystemNote(
        provider?.message ?? 'The selected local CLI is unavailable. Install it and sign in, then try again.',
        'error',
      );
      if (launchIntent.kickoff) {
        setRetryableKickoff({
          providerId: launchIntent.providerId,
          kickoff: launchIntent.kickoff,
          executionProfile: launchIntent.executionProfile,
        });
      }
      return;
    }

    if (launchIntent.sessionId && launchIntent.assistant) {
      void loadSession({
        id: launchIntent.sessionId,
        assistant: launchIntent.assistant,
        title: '',
        createdAt: '',
        updatedAt: '',
        messageCount: 0,
      }, true);
      return;
    }

    if (wsRef.current && !window.confirm('Stop the current chat and continue with the selected local CLI?')) {
      return;
    }
    if (wsRef.current) stopAgent();

    if (launchIntent.kickoff) {
      void dispatchKickoff({
        providerId: launchIntent.providerId,
        kickoff: launchIntent.kickoff,
        executionProfile: launchIntent.executionProfile,
      });
    } else {
      startAgent(launchIntent.providerId, { firstMessage: null });
    }
  }, [
    appendSystemNote,
    dispatchKickoff,
    launchIntent,
    loadSession,
    location.pathname,
    location.search,
    location.state,
    navigate,
    providers,
    providersLoaded,
    startAgent,
    stopAgent,
  ]);

  const clearChat = () => {
    if (window.confirm('Are you sure you want to clear this chat history? This also starts a new agent session.')) {
      // Tear down the live agent first so the next message can't resume the
      // conversation we're clearing.
      if (wsRef.current) stopAgent();
      // Forget only the selected provider's session; switching providers later
      // can still resume its own independently-scoped conversation.
      updateSessions(prev => {
        const remaining = { ...prev };
        delete remaining[agentName];
        return remaining;
      });
      endedNoteRef.current = false;
      setMessages([]);
      clearChatStore(ws.branchName);
    }
  };

  const showThinking = busy && !turnOpen;
  const currentRecovery = currentProvider ? recoveryFor(currentProvider) : null;

  const copyRecoveryCommand = () => {
    if (!currentProvider || !currentRecovery) return;
    const copyFailed = () => appendSystemNote('Could not copy the recovery command. Copy the command shown above manually.', 'error');
    void safeCopyToClipboard(currentRecovery.command).then((copied) => {
      if (!copied) {
        copyFailed();
        return;
      }
      setCopiedRecoveryProvider(currentProvider.id);
      setTimeout(() => {
        if (mountedRef.current) setCopiedRecoveryProvider(current => current === currentProvider.id ? null : current);
      }, 1500);
    });
  };

  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const activeSessionId = sessions[agentName]?.id;

  const copySessionId = (id: string) => {
    safeCopyToClipboard(id).then(() => {
      setCopiedSessionId(true);
      setTimeout(() => {
        if (mountedRef.current) setCopiedSessionId(false);
      }, 1500);
    });
  };

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="font-semibold text-foreground">Chat</h3>
          <StatusBadge tone={connected ? 'running' : 'idle'} dot>
            {connected
              ? `${currentProvider?.name || 'Connected'}${currentProvider && modelsByProvider[currentProvider.id] ? ` (${modelLabelForId(currentProvider, modelsByProvider[currentProvider.id])})` : ''}`
              : 'Disconnected'}
          </StatusBadge>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          {sessionUsage && (sessionUsage.inputTokens > 0 || sessionUsage.outputTokens > 0) && (
            <div
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono bg-muted/60 border border-border/60 text-muted-foreground shrink-0"
              title={`Session Total: ${sessionUsage.inputTokens.toLocaleString()} in${sessionUsage.cachedInputTokens ? ` (${sessionUsage.cachedInputTokens.toLocaleString()} cached)` : ''} · ${sessionUsage.outputTokens.toLocaleString()} out${sessionUsage.costUsdEstimate !== undefined ? ` · ~$${sessionUsage.costUsdEstimate.toFixed(3)}` : ''}`}
            >
              <Zap size={11} className="text-warning-foreground shrink-0" />
              <span>{formatCompact(sessionUsage.totalTokens ?? (sessionUsage.inputTokens + sessionUsage.outputTokens))}</span>
            </div>
          )}
          {sessionQuota && (
            <div
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono border shrink-0",
                sessionQuota.tokens?.status === 'exceeded' || sessionQuota.requests?.status === 'exceeded'
                  ? "bg-destructive/10 border-destructive/30 text-destructive-foreground"
                  : sessionQuota.tokens?.status === 'approaching_limit' || sessionQuota.requests?.status === 'approaching_limit'
                  ? "bg-amber-500/10 border-amber-500/30 text-warning-foreground"
                  : "bg-muted/60 border-border/60 text-muted-foreground"
              )}
              title={
                sessionQuota.warningMessage ||
                (sessionQuota.tokens?.resetsAt ? `Resets at ${new Date(sessionQuota.tokens.resetsAt).toLocaleTimeString()}` : sessionQuota.label)
              }
            >
              <span>{formatHeaderQuota(sessionQuota)}</span>
            </div>
          )}
          {activeSessionId && (
            <button
              onClick={() => copySessionId(activeSessionId)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer border border-border/60"
              title={`Session ID: ${activeSessionId} (Click to copy)`}
            >
              <Hash size={11} className="opacity-60" />
              <span>{activeSessionId.slice(0, 8)}...</span>
              {copiedSessionId ? <Check size={11} className="text-success-foreground" /> : <Copy size={11} className="opacity-60" />}
            </button>
          )}
          {messages.length > 0 && (
            <button onClick={clearChat} className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-destructive-foreground">
              Clear
            </button>
          )}
          <button
            onClick={() => { setPickerError(null); setPickerOpen(true); }}
            className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Resume a past session"
          >
            <History size={14} />
          </button>
          {(connected || busy || connecting) && (
            <Button size="sm" variant="outline" onClick={stopAgent}>
              <Square size={14} className="text-destructive-foreground" />
              Stop
            </Button>
          )}
        </div>
      </div>

      <SessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        ws={ws}
        onPick={pickSession}
        error={pickerError}
        pending={sessionSwitching}
      />

      <div
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (el) {
            nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }
        }}
        className="flex-1 space-y-4 overflow-y-auto p-4"
      >
        {messages.length === 0 && !showThinking && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            No messages yet. Start the agent and say hello.
          </div>
        )}
        {messages.map((msg, idx) => (
          <MessageBubble
            key={idx}
            msg={msg}
            idx={idx}
            copied={copiedIdx === idx}
            onCopy={copyMessage}
          />
        ))}
        {showThinking && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground shadow-xs animate-pulse">
              <RefreshCw size={13} className="animate-spin text-primary" />
              <span>{currentProvider?.name || 'Agent'} is thinking and executing...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-card p-3">
        {currentProvider && !currentProvider.isConfigured && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="shrink-0 font-semibold">{currentProvider.name} provider status:</span>
                <span>{currentProvider.message}</span>
              </div>
              {currentRecovery && (
                <code className="w-fit rounded bg-background/70 px-2 py-1 font-mono text-[11px] text-foreground">
                  {currentRecovery.command}
                </code>
              )}
            </div>
            {currentRecovery && (
              <Button size="sm" variant="outline" onClick={copyRecoveryCommand} className="shrink-0">
                {copiedRecoveryProvider === currentProvider.id ? <Check size={12} /> : <Copy size={12} />}
                {copiedRecoveryProvider === currentProvider.id ? 'Copied' : currentRecovery.label}
              </Button>
            )}
          </div>
        )}
        {retryableKickoff && !connecting && !connected && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <span>
              The workspace kickoff was not dispatched ({retryableKickoff.executionProfile === 'workspace-write' ? 'Edit workspace' : 'Review only'}).
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void dispatchKickoff(retryableKickoff, true)}
              disabled={sessionSwitching || retryChecking}
            >
              {retryChecking ? 'Checking CLI…' : 'Recheck & retry'}
            </Button>
            {currentProvider?.setupIssue && currentProvider.setupIssue !== 'missing-cli' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void dispatchKickoff(retryableKickoff, true, true)}
                disabled={sessionSwitching || retryChecking}
              >
                Try with existing CLI auth
              </Button>
            )}
          </div>
        )}
        {pendingApprovals.map((req) => (
          <div
            key={req.requestId}
            role="alert"
            aria-live="polite"
            className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs shadow-xs animate-fade-in"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 font-semibold text-warning-foreground">
                <Shield size={14} className="animate-pulse shrink-0" />
                <span>Tool Approval Required</span>
                <Badge variant="outline" className="text-[10px] uppercase font-mono border-amber-500/40 text-amber-700 dark:text-amber-400">
                  {req.tool}
                </Badge>
                {req.description && (
                  <span className="text-[11px] font-normal text-muted-foreground italic">
                    ({req.description})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => handleApprovalDecision(req.requestId, 'allow')}
                  className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-1 cursor-pointer"
                >
                  <Check size={12} />
                  <span>Approve</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleApprovalDecision(req.requestId, 'deny')}
                  className="h-7 text-xs text-destructive hover:bg-destructive/10 border-border/80 gap-1 cursor-pointer"
                >
                  <X size={12} />
                  <span>Deny</span>
                </Button>
              </div>
            </div>
            {req.input && (
              <div className="rounded-md bg-background/80 p-2 font-mono text-[11px] text-foreground overflow-x-auto max-h-24 select-text">
                {typeof req.input.command === 'string'
                  ? `Command: ${req.input.command}`
                  : typeof req.input.path === 'string'
                  ? `File: ${req.input.path}`
                  : JSON.stringify(req.input, null, 2)}
              </div>
            )}
          </div>
        ))}
        <div className="flex w-full flex-col rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-border/50 bg-muted/20 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Harness Selector */}
              <Menu>
                <MenuTrigger
                  aria-label="Select Provider"
                  disabled={busy || connecting || sessionSwitching}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-2xs transition-colors hover:bg-accent hover:border-border disabled:pointer-events-none disabled:opacity-50"
                >
                  {currentProvider?.icon === 'Bot' ? <Bot size={13} className="text-primary" /> : <Cpu size={13} className="text-primary" />}
                  <span>{currentProvider?.name ?? 'Select Agent'}</span>
                  <ChevronDown size={11} className="opacity-50 ml-0.5" />
                </MenuTrigger>
                <MenuPopup align="start" side="top">
                  {providers.filter(p => p.isConfigured || p.setupIssue !== 'missing-cli').map((p) => (
                    <MenuItem
                      key={p.id}
                      onClick={() => switchProvider(p.id)}
                      className={cn(
                        'flex items-center gap-2 text-xs cursor-pointer',
                        p.id === displayedProviderId && 'font-semibold text-primary',
                      )}
                    >
                      {p.icon === 'Bot' ? <Bot size={14} /> : <Cpu size={14} />}
                      <span className="flex-1">{p.name}</span>
                      {p.id === displayedProviderId && <Check size={12} className="text-primary ml-auto" />}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>

              {/* Model Selector */}
              {currentProvider?.models?.length && (
                <Menu>
                  <MenuTrigger
                    aria-label="Select model"
                    disabled={connected || connecting || busy || sessionSwitching || Boolean(retryableKickoff)}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-2xs transition-colors hover:bg-accent hover:border-border disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Sparkles size={12} className="text-warning-foreground shrink-0" />
                    <span className="max-w-44 truncate">{modelLabelForId(currentProvider, modelsByProvider[currentProvider.id] ?? '')}</span>
                    <ChevronDown size={11} className="opacity-50 ml-0.5" />
                  </MenuTrigger>
                  <MenuPopup align="start" side="top" className="max-w-80">
                    {currentProvider.models.map((m) => (
                      <MenuItem
                        key={m.id}
                        onClick={() => setModelsByProvider(current => ({
                          ...current,
                          [currentProvider.id]: m.id,
                        }))}
                      >
                        <span className="flex flex-col">
                          <span className="font-medium flex items-center gap-1.5">
                            <Sparkles size={11} className="text-warning-foreground" />
                            {m.label}
                          </span>
                          <span className="text-xs text-muted-foreground">{m.description}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              )}

              {/* Execution Profile Selector */}
              {currentProvider?.executionProfiles?.length && currentExecutionProfile && (
                <Menu>
                  <MenuTrigger
                    aria-label="Select execution profile"
                    disabled={connecting || busy || sessionSwitching || Boolean(retryableKickoff)}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-2xs transition-colors hover:bg-accent hover:border-border disabled:pointer-events-none disabled:opacity-50"
                    title={currentExecutionProfile.description}
                  >
                    <Shield size={12} className={currentExecutionProfile.id === 'workspace-write' ? "text-warning-foreground shrink-0" : "text-success-foreground shrink-0"} />
                    <span>{formatShortProfileLabel(currentExecutionProfile.label)}</span>
                    <ChevronDown size={11} className="opacity-50 ml-0.5" />
                  </MenuTrigger>
                  <MenuPopup align="start" side="top" className="max-w-80">
                    {currentProvider.executionProfiles.map((profile) => (
                      <MenuItem
                        key={profile.id}
                        onClick={() => setProfilesByProvider(current => ({
                          ...current,
                          [currentProvider.id]: profile.id,
                        }))}
                      >
                        <span className="flex flex-col">
                          <span className="font-medium flex items-center gap-1.5">
                            <Shield size={12} className={profile.id === 'workspace-write' ? "text-warning-foreground" : "text-success-foreground"} />
                            {profile.label}
                          </span>
                          <span className="text-xs text-muted-foreground">{profile.description}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              )}

              {/* Reasoning Effort Selector */}
              {currentProvider && (
                <Menu>
                  <MenuTrigger
                    aria-label="Select reasoning effort"
                    disabled={connected || connecting || busy || sessionSwitching || Boolean(retryableKickoff)}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-2xs transition-colors hover:bg-accent hover:border-border disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Zap size={12} className={effortsByProvider[currentProvider.id] ? "text-warning-foreground fill-amber-500/20 shrink-0" : "text-muted-foreground shrink-0"} />
                    <span>{reasoningEffortLabelForId(effortsByProvider[currentProvider.id] ?? '')}</span>
                    <ChevronDown size={11} className="opacity-50 ml-0.5" />
                  </MenuTrigger>
                  <MenuPopup align="start" side="top" className="max-w-72">
                    {REASONING_EFFORT_OPTIONS.map((e) => (
                      <MenuItem
                        key={e.id}
                        onClick={() => setEffortsByProvider(current => ({
                          ...current,
                          [currentProvider.id]: e.id,
                        }))}
                      >
                        <span className="flex flex-col">
                          <span className="font-medium flex items-center gap-1.5">
                            {e.id && <Zap size={12} className="text-warning-foreground" />}
                            {e.label}
                          </span>
                          <span className="text-xs text-muted-foreground">{e.description}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              )}
            </div>

            {/* Right Side: Tools & Actions */}
            <div className="flex items-center gap-1 shrink-0">
              <input
                type="file"
                ref={fileInputRef}
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) handleImageFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || sessionSwitching}
                className="flex cursor-pointer items-center justify-center rounded-md border border-border/60 bg-background/90 p-1.5 text-muted-foreground shadow-2xs transition-colors hover:bg-accent hover:text-foreground hover:border-border disabled:pointer-events-none disabled:opacity-50"
                title="Attach image (or paste / drop into chat)"
              >
                <ImageIcon size={14} className="text-primary" />
              </button>
            </div>
          </div>
          {attachedImages.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-border/40 px-3 py-2 bg-muted/20">
              {attachedImages.map((img) => (
                <div key={img.id} className="group relative flex items-center rounded-lg border border-border/80 bg-card p-1 shadow-xs">
                  <img src={img.dataUrl} alt={img.name} className="h-14 w-14 rounded-md object-cover" />
                  <button
                    type="button"
                    onClick={() => setAttachedImages(current => current.filter(i => i.id !== img.id))}
                    className="absolute -top-1.5 -right-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 transition-colors"
                    title="Remove image"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            className={cn("flex items-end gap-2 p-2", isDragging && "ring-2 ring-primary ring-inset rounded-b-xl bg-accent/30")}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer?.files?.length) {
                handleImageFiles(e.dataTransfer.files);
              }
            }}
          >
            <Textarea
              value={input}
              disabled={sessionSwitching}
              onPaste={(e) => {
                // Rich clipboard payloads can expose an image preview alongside
                // copied text (notably across desktop apps). Let the browser
                // paste plain text normally instead of attaching that image.
                if (e.clipboardData?.getData('text/plain')) return;
                const htmlText = clipboardHtmlToText(e.clipboardData?.getData('text/html') ?? '');
                if (htmlText.trim()) {
                  e.preventDefault();
                  const target = e.currentTarget;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  setInput(current => `${current.slice(0, start)}${htmlText}${current.slice(end)}`);
                  requestAnimationFrame(() => {
                    target.focus();
                    const caret = start + htmlText.length;
                    target.setSelectionRange(caret, caret);
                  });
                  return;
                }
                const items = e.clipboardData?.items;
                const imageFiles: File[] = [];
                if (items) {
                  for (let i = 0; i < items.length; i++) {
                    if (items[i].type.startsWith('image/')) {
                      const file = items[i].getAsFile();
                      if (file) imageFiles.push(file);
                    }
                  }
                }
                // Some browsers expose clipboard images through `files` but
                // leave the item list empty. Keep this fallback for screenshots
                // copied from native apps and remote desktop sessions.
                if (imageFiles.length === 0 && e.clipboardData?.files?.length) {
                  for (const file of Array.from(e.clipboardData.files)) {
                    if (file.type.startsWith('image/')) imageFiles.push(file);
                  }
                }
                if (imageFiles.length > 0) {
                  e.preventDefault();
                  handleImageFiles(imageFiles);
                }
              }}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (busy || connecting || sessionSwitchingRef.current) return;
                  if (!connected) {
                    if (canStart) {
                      if (input.trim() || attachedImages.length) sendMessage();
                      else startAgent();
                    }
                  } else {
                    sendMessage();
                  }
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                }
              }}
              placeholder={connected ? 'Message the agent... (Shift+Enter for new line)' : 'Start the agent or press Enter...'}
              unstyled
              className="flex-1 [&_[data-slot=textarea]]:max-h-[200px] [&_[data-slot=textarea]]:min-h-11 [&_[data-slot=textarea]]:resize-none [&_[data-slot=textarea]]:text-sm"
              rows={1}
            />
            {!connected ? (
              <Button className="h-11 shrink-0 rounded-lg" onClick={() => { if (input.trim() || attachedImages.length) sendMessage(); else startAgent(); }} disabled={!canStart}>
                <PlaySquare size={14} />
                Start
              </Button>
            ) : (
              <Button
                className="h-11 shrink-0 rounded-lg"
                onClick={sendMessage}
                disabled={(!input.trim() && attachedImages.length === 0) || busy || sessionSwitching}
              >
                {busy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
