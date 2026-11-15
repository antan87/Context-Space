import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { loadPlugins } from './loader.js';
import { getStorageProvider } from '../adapters/registry.js';
import type { StoragePort } from '../ports/storage.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  vi.restoreAllMocks();
});

describe('loadPlugins', () => {
  it('does nothing when plugins list is empty', async () => {
    const program = new Command();
    await expect(loadPlugins(program, [])).resolves.toBeUndefined();
  });

  it('loads a valid plugin and executes register with context', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-test-'));
    tempDirs.push(dir);

    const pluginPath = path.join(dir, 'test-plugin.mjs');
    const content = `
      export default {
        name: 'test-plugin',
        version: '1.0.0',
        register(context) {
          context.registerCommand((prog) => {
            prog.command('custom-plugin-cmd').action(() => {});
          });
          context.registerStorageProvider('custom-storage', {
            meta: {
              name: 'custom-storage',
              displayName: 'Custom Storage',
              description: 'Custom storage provider',
            },
            readWorkspaceKnowledge: async () => null,
            writeWorkspaceKnowledge: async () => {},
          });
        }
      };
    `;
    await fs.writeFile(pluginPath, content, 'utf-8');

    const program = new Command();
    await loadPlugins(program, [pluginPath]);

    // Command should be registered
    const cmd = program.commands.find((c) => c.name() === 'custom-plugin-cmd');
    expect(cmd).toBeDefined();

    // Storage provider should be registered
    const provider = getStorageProvider('custom-storage');
    expect(provider).toBeDefined();
    expect(provider?.meta.name).toBe('custom-storage');
  });

  it('loads a plugin exported as named export "plugin"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-test-'));
    tempDirs.push(dir);

    const pluginPath = path.join(dir, 'named-plugin.mjs');
    const content = `
      export const plugin = {
        name: 'named-plugin',
        version: '1.0.0',
        register(context) {
          context.registerCommand((prog) => {
            prog.command('named-cmd').action(() => {});
          });
        }
      };
    `;
    await fs.writeFile(pluginPath, content, 'utf-8');

    const program = new Command();
    await loadPlugins(program, [pluginPath]);

    const cmd = program.commands.find((c) => c.name() === 'named-cmd');
    expect(cmd).toBeDefined();
  });

  it('warns when a plugin does not export a valid NexusFlowPlugin', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-test-'));
    tempDirs.push(dir);

    const pluginPath = path.join(dir, 'invalid-plugin.mjs');
    await fs.writeFile(pluginPath, 'export default { foo: "bar" };', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const program = new Command();

    await loadPlugins(program, [pluginPath]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not export a valid NexusFlowPlugin'),
    );
  });

  it('logs an error when module fails to import', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = new Command();

    await loadPlugins(program, ['/nonexistent/path/to/plugin.mjs']);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load plugin'),
      expect.any(String),
    );
  });
});
