import type { Command } from 'commander';

/**
 * Resolves CLI options for a command by combining explicitly passed options
 * with options set via CLI on the command itself or its parent command.
 */
export function resolveCliOptions<T extends object = Record<string, unknown>>(
  cmd: Command | undefined,
  options: T,
): T {
  const result: Record<string, unknown> = { ...(options as Record<string, unknown>) };
  if (!cmd) return result as T;
  const parent = cmd.parent;
  if (parent) {
    for (const [key, val] of Object.entries(parent.opts() || {})) {
      if (parent.getOptionValueSource?.(key) === 'cli') {
        result[key] = val;
      }
    }
  }
  for (const [key, val] of Object.entries(cmd.opts() || {})) {
    if (cmd.getOptionValueSource?.(key) === 'cli') {
      result[key] = val;
    }
  }
  return result as T;
}
