import type { Command } from 'commander';

/**
 * Resolves CLI options for a command by combining explicitly passed options
 * with options set via CLI on the command itself or its parent command.
 */
export function resolveCliOptions<T extends object = Record<string, unknown>>(
  cmd: Command | undefined,
  options?: T,
): T {
  const result: Record<string, unknown> = { ...(options as Record<string, unknown> | undefined) };
  if (!cmd) return result as T;
  const ancestors: Command[] = [];
  let curr = cmd.parent;
  while (curr) {
    ancestors.unshift(curr);
    curr = curr.parent;
  }
  for (const ancestor of ancestors) {
    for (const [key, val] of Object.entries(ancestor.opts() || {})) {
      if (ancestor.getOptionValueSource?.(key) === 'cli') {
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

