import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { resolveCliOptions } from '../utils/cli-options.js';

describe('resolveCliOptions', () => {
  it('returns original options when cmd is undefined', () => {
    const input = { json: true, scope: 'workspace' as const };
    const result = resolveCliOptions(undefined, input);
    expect(result).toEqual({ json: true, scope: 'workspace' });
  });

  it('merges command options with source cli', () => {
    const cmd = new Command();
    cmd.option('--json', 'json output');
    cmd.option('--name <name>', 'name');
    cmd.setOptionValueWithSource('name', 'custom-name', 'cli');
    cmd.setOptionValueWithSource('json', false, 'default');

    const input = { json: true };
    const result = resolveCliOptions(cmd, input);
    expect(result).toEqual({ json: true, name: 'custom-name' });
  });

  it('inherits parent command options provided via cli', () => {
    const root = new Command();
    root.option('--json', 'global json');
    root.setOptionValueWithSource('json', true, 'cli');

    const sub = root.command('child');
    sub.option('--filter <pattern>', 'filter pattern');
    sub.setOptionValueWithSource('filter', '*.ts', 'cli');

    const input = { initial: 'val' };
    const result = resolveCliOptions(sub, input);
    expect(result).toEqual({ initial: 'val', json: true, filter: '*.ts' });
  });

  it('lets subcommand cli options override parent cli options', () => {
    const root = new Command();
    root.option('--mode <mode>', 'mode');
    root.setOptionValueWithSource('mode', 'parent-mode', 'cli');

    const sub = root.command('child');
    sub.option('--mode <mode>', 'mode');
    sub.setOptionValueWithSource('mode', 'sub-mode', 'cli');

    const result = resolveCliOptions(sub, { initial: 1 });
    expect(result).toEqual({ initial: 1, mode: 'sub-mode' });
  });

  it('ignores default or env options from parent/cmd', () => {
    const root = new Command();
    root.option('--env-opt <val>', 'env opt');
    root.setOptionValueWithSource('envOpt', 'val-from-env', 'env');

    const sub = root.command('child');
    sub.option('--default-opt <val>', 'default opt');
    sub.setOptionValueWithSource('defaultOpt', 'val-from-default', 'default');

    const result = resolveCliOptions(sub, { base: 'data' });
    expect(result).toEqual({ base: 'data' });
  });
});
