import type { Command } from 'commander';
import type { StoragePort } from '../ports/storage.js';

export type { StoragePort, StorageAdapterMeta, AdapterConfigField } from '../ports/storage.js';

export interface PluginRegistryContext {
  /** Registers a custom storage provider/adapter. The provider must include a `meta` property. */
  registerStorageProvider(name: string, provider: StoragePort): void;

  /** Registers a custom commander CLI subcommand. */
  registerCommand(commandBuilder: (program: Command) => void): void;
}

export interface NexusFlowPlugin {
  name: string;
  version: string;
  register(context: PluginRegistryContext): void | Promise<void>;
}
