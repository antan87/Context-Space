import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginRegistryContext, NexusFlowPlugin } from './index.js';
import { registerStorageProvider } from '../adapters/registry.js';
import { toErrorMessage } from '../../utils/errors.js';

export async function loadPlugins(program: any, pluginsList: string[]): Promise<void> {
  const context: PluginRegistryContext = {
    registerStorageProvider(name, provider) {
      registerStorageProvider(name, provider);
    },
    registerCommand(commandBuilder) {
      commandBuilder(program);
    }
  };

  for (const pluginPath of pluginsList) {
    try {
      let resolvedPath = pluginPath;
      if (pluginPath.startsWith('.') || path.isAbsolute(pluginPath)) {
        resolvedPath = path.resolve(pluginPath);
      }
      
      // Dynamic import works with standard file:// URLs across platforms
      const fileUrl = resolvedPath.startsWith('file://') ? resolvedPath : pathToFileURL(resolvedPath).href;
      const module = await import(fileUrl);
      const plugin: NexusFlowPlugin = module.default || module.plugin;
      
      if (plugin && typeof plugin.register === 'function') {
        await plugin.register(context);
      } else {
        console.warn(`Warning: Plugin at "${pluginPath}" does not export a valid NexusFlowPlugin.`);
      }
    } catch (error) {
      console.error(`Failed to load plugin "${pluginPath}":`, toErrorMessage(error));
    }
  }
}
