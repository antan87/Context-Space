/**
 * @module core/ports/storage
 * Storage Port defining the interface for workspace document persistence.
 *
 * Adapters implement this interface to provide different storage backends.
 * Each adapter is self-describing via the `meta` property, which enables
 * automatic discovery in CLI, GUI, and plugin systems.
 */

/** Describes a single configurable field for an adapter. */
export interface AdapterConfigField {
  /** Machine-readable key, stored in config.json. */
  key: string;
  /** Human-readable label for CLI prompts and GUI forms. */
  label: string;
  /** Value type — 'path' renders a file picker in the GUI. */
  type: 'string' | 'boolean' | 'number' | 'path';
  /** Whether the field must be set before the adapter can be used. */
  required?: boolean;
  /** Default value when not explicitly configured. */
  default?: unknown;
  /** Help text shown in CLI prompts and GUI tooltips. */
  description?: string;
}

/** Metadata that makes an adapter self-describing and discoverable. */
export interface StorageAdapterMeta {
  /** Unique machine-readable identifier (e.g. 'obsidian'). */
  name: string;
  /** Human-readable name for CLI tables and GUI dropdowns (e.g. 'Obsidian Vault'). */
  displayName: string;
  /** One-line description of what this adapter does. */
  description: string;
  /** Configuration fields this adapter accepts. Empty array = no config needed. */
  configFields: AdapterConfigField[];
}

export interface StoragePort {
  /** Adapter metadata — who am I, what do I need? */
  readonly meta: StorageAdapterMeta;

  /** Called once after registration with the user's per-adapter settings. */
  configure?(settings: Record<string, unknown>): void;

  /** Writes a workspace context/metadata document. */
  writeWorkspaceFile(workspacePath: string, featureId: string, filename: string, content: string): Promise<void>;

  /** Reads a workspace context/metadata document. */
  readWorkspaceFile(workspacePath: string, featureId: string, filename: string): Promise<string>;

  /** Checks if a workspace context/metadata document exists. */
  workspaceFileExists(workspacePath: string, featureId: string, filename: string): Promise<boolean>;

  /**
   * Removes one workspace document; a document that does not exist is not an error. Optional: an
   * adapter without it keeps retired documents, and callers must cope with that.
   */
  deleteWorkspaceFile?(workspacePath: string, featureId: string, filename: string): Promise<void>;

  /** Resolves the human-readable path or link to the workspace document for the AI assistant. */
  resolveWorkspaceFileUrl(workspacePath: string, featureId: string, filename: string): string;

  /** Writes a per-repo base document that outlives any one feature workspace. */
  writeBaseFile(workspacePath: string, repoName: string, filename: string, content: string): Promise<void>;

  /** Reads a per-repo base document. */
  readBaseFile(workspacePath: string, repoName: string, filename: string): Promise<string>;

  /** Checks if a per-repo base document exists. */
  baseFileExists(workspacePath: string, repoName: string, filename: string): Promise<boolean>;

  /** Resolves the human-readable path or link to the base document. */
  resolveBaseFileUrl(workspacePath: string, repoName: string, filename: string): string;

  /** Cleanly deletes all workspace-specific documents from the storage backend. */
  deleteWorkspace(workspacePath: string, featureId: string): Promise<void>;
}
