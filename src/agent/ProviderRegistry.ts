import type { AgentSession } from './session.js';
import type { ModelOption } from './models.js';

export interface ProviderStatus {
  id: string;
  name: string;
  isConfigured: boolean;
  message?: string;
  icon?: string;
  accessLabel?: string;
  setupIssue?: ProviderSetupIssue;
  recoveryCommand?: string;
  recoveryLabel?: string;
  executionProfiles?: readonly ProviderExecutionProfile[];
  defaultExecutionProfile?: AgentExecutionProfile;
  models?: readonly ModelOption[];
  capabilities: ProviderCapabilities;
}

export type AgentExecutionProfile = 'review' | 'workspace-write';

export interface ProviderExecutionProfile {
  id: AgentExecutionProfile;
  label: string;
  description: string;
}

export type ProviderSetupIssue = 'missing-cli' | 'signed-out' | 'probe-failed';

export interface ProviderSetupHelp {
  setupIssue: ProviderSetupIssue;
  recoveryCommand: string;
  recoveryLabel: string;
}

export interface ProviderCapabilities {
  transport: 'native-api' | 'cli-print' | 'acp' | 'sdk';
  sessionIdentity: 'none' | 'client-assigned' | 'provider-assigned';
  workspaceAccess: 'read-only' | 'workspace-write' | 'harness-managed';
  sessionIdFormat?: 'uuid' | 'opaque';
}

export type AgentEvent =
  | 'data'
  | 'close'
  | 'error'
  | 'system'
  | 'idle'
  | 'session'
  | 'usage'
  | 'quota'
  | 'approval_request'
  | 'file_changed';

export interface ToolApprovalRequest {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  description?: string;
}

export interface AgentHarness extends NodeJS.EventEmitter {
  start(cwd: string, session?: AgentSession): Promise<void>;
  send(data: string, executionProfile?: AgentExecutionProfile): Promise<void>;
  stop(): void;
  respondToApproval?(requestId: string, decision: 'allow' | 'deny', message?: string): void;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  icon?: string;
  accessLabel?: string;
  capabilities: ProviderCapabilities;
  executionProfiles?: readonly ProviderExecutionProfile[];
  defaultExecutionProfile?: AgentExecutionProfile;
  models?: readonly ModelOption[];
  isConfigured(): boolean;
  getStatusMessage(): string | undefined;
  getSetupHelp?(): ProviderSetupHelp | undefined;
  invalidateStatus?(): void;
  createInstance(): AgentHarness;
}

class ProviderRegistryImpl {
  private providers: Map<string, ProviderAdapter> = new Map();
  private lastRefreshCompletedAt: Map<string, number> = new Map();

  register(provider: ProviderAdapter) {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): ProviderAdapter | undefined {
    return this.providers.get(id);
  }

  /** Resolve an untyped renderer value against provider-owned profiles. */
  resolveExecutionProfile(provider: ProviderAdapter, requested: unknown): AgentExecutionProfile | undefined | null {
    const profiles = provider.executionProfiles;
    if (!profiles?.length) return requested === undefined ? undefined : null;
    if (requested !== 'review' && requested !== 'workspace-write') return null;
    return profiles.some(profile => profile.id === requested) ? requested : null;
  }

  /** Resolve an untyped renderer value against the provider-owned model catalog. */
  resolveModel(provider: ProviderAdapter, requested: unknown): string | undefined | null {
    if (requested === undefined || requested === null || requested === '') return undefined;
    if (typeof requested !== 'string') return null;

    const model = requested.trim();
    if (!model || model.length > 100) return null;

    const models = provider.models;
    if (!models?.length) return model;
    return models.some(option => option.id === model) ? model : null;
  }

  getAllStatus(options: { refreshProviderId?: string } = {}): ProviderStatus[] {
    const providers = Array.from(this.providers.values());
    const refreshProvider = options.refreshProviderId
      ? this.providers.get(options.refreshProviderId)
      : undefined;
    const lastRefresh = options.refreshProviderId
      ? this.lastRefreshCompletedAt.get(options.refreshProviderId) ?? 0
      : 0;
    const shouldRefresh = Boolean(
      refreshProvider?.invalidateStatus
      && Date.now() - lastRefresh >= 1_000,
    );
    if (shouldRefresh) refreshProvider?.invalidateStatus?.();

    const statuses = providers.map(provider => {
      const setup = provider.getSetupHelp?.();
      return {
        id: provider.id,
        name: provider.name,
        icon: provider.icon,
        accessLabel: provider.accessLabel,
        capabilities: provider.capabilities,
        executionProfiles: provider.executionProfiles,
        defaultExecutionProfile: provider.defaultExecutionProfile,
        models: provider.models,
        isConfigured: provider.isConfigured(),
        message: provider.getStatusMessage(),
        ...setup,
      };
    });
    // Timestamp after all synchronous probes finish so requests queued during
    // a slow refresh reuse its result instead of immediately spawning again.
    if (shouldRefresh && options.refreshProviderId) {
      this.lastRefreshCompletedAt.set(options.refreshProviderId, Date.now());
    }
    return statuses;
  }
}

export const ProviderRegistry = new ProviderRegistryImpl();
