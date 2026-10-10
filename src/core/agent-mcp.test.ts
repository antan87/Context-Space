import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MCP_REGISTRATION_NAME,
  agentMcpServer,
  inspectAgentMcp,
  registerAgentMcp,
  unboundMcpServer,
  type AgentMcpOptions,
  type CommandRunner,
} from './agent-mcp.js';
import { BRAND_CONFIG, ENGINE_NPM_PACKAGE } from './constants.js';

let home: string;
let calls: Array<{ file: string; args: string[] }>;
/** The program path exactly as the code under test handed it to the runner. */
let rawFiles: string[];
/** Which agent CLIs this test pretends are installed. No real executables are involved. */
let installed: Set<string>;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-agent-mcp-'));
  calls = [];
  rawFiles = [];
  installed = new Set();
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
});

async function install(...names: string[]) {
  for (const name of names) installed.add(name);
}

const read = (file: string) => fs.readFile(path.join(home, file), 'utf8');
const readJson = async (file: string) => JSON.parse(await read(file));
async function write(file: string, content: string) {
  const target = path.join(home, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}
const exists = (file: string) => fs.access(path.join(home, file)).then(() => true, () => false);

/** Env for the code under test. Agents are located through `installed`, not through PATH. */
const envWith = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: '', ...extra });

/**
 * Behaves like the real CLIs, as observed: Claude refuses a duplicate name with
 * exit 1, while Codex and Antigravity silently overwrite a same-named server.
 */
function fakeCli(env: NodeJS.ProcessEnv): CommandRunner {
  return async (file, args) => {
    rawFiles.push(file);
    // win32.basename understands both `/` and `\\`, and the extension is dropped: `C:\\bin\\codex.cmd` is the tool `codex`.
    const tool = path.win32.basename(file).replace(/\.(exe|cmd)$/i, '');
    calls.push({ file: tool, args });
    const [, , ...rest] = args; // after "mcp add"
    if (tool === 'claude') {
      const scope = rest.splice(0, 2); // --scope user
      expect(scope).toEqual(['--scope', 'user']);
    }
    const name = rest[0]!;
    const dash = rest.indexOf('--');
    const [command, ...commandArgs] = rest.slice(dash + 1);

    if (tool === 'claude') {
      const config = path.join(env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');
      const data = await fs.readFile(config, 'utf8').then(JSON.parse, () => ({}));
      if (data.mcpServers?.[name]) return { exitCode: 1, stdout: '', stderr: `MCP server ${name} already exists in user config` };
      data.mcpServers = { ...data.mcpServers, [name]: { type: 'stdio', command, args: commandArgs, env: {} } };
      await fs.mkdir(path.dirname(config), { recursive: true });
      await fs.writeFile(config, JSON.stringify(data), 'utf8');
    } else if (tool === 'codex') {
      const config = path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'config.toml');
      const data = await fs.readFile(config, 'utf8').then(parseToml, () => ({} as Record<string, any>));
      data.mcp_servers = { ...(data.mcp_servers as object), [name]: { command, args: commandArgs } };
      await fs.mkdir(path.dirname(config), { recursive: true });
      await fs.writeFile(config, stringifyToml(data), 'utf8');
    } else if (tool === 'agy') {
      const config = path.join(home, '.gemini', 'config', 'mcp_config.json');
      const data = await fs.readFile(config, 'utf8').then(JSON.parse, () => ({}));
      data.mcpServers = { ...data.mcpServers, [name]: { command, args: commandArgs } };
      await fs.mkdir(path.dirname(config), { recursive: true });
      await fs.writeFile(config, JSON.stringify(data), 'utf8');
    }
    return { exitCode: 0, stdout: `Added ${name}`, stderr: '' };
  };
}

const options = (extra: Partial<AgentMcpOptions> = {}, env: NodeJS.ProcessEnv = envWith()): AgentMcpOptions => ({
  env,
  home,
  platform: 'linux',
  run: fakeCli(env),
  findBinary: (name) => (installed.has(name) ? `/fake/bin/${name}` : null),
  ...extra,
});

const byId = <T extends { id: string }>(items: T[], id: string) => items.find((item) => item.id === id)!;

describe('unboundMcpServer', () => {
  it('names no workspace, so the server finds it from the agent working directory', () => {
    const server = unboundMcpServer();
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', `${ENGINE_NPM_PACKAGE}@latest`, 'mcp', 'run', '--role', 'interactive']);
  });

  it('asks the registry for the latest version, because npx reuses a bare package from its cache forever', () => {
    const [, spec] = unboundMcpServer().args;
    expect(spec).not.toBe(ENGINE_NPM_PACKAGE);
    expect(spec).toBe(`${ENGINE_NPM_PACKAGE}@latest`);
  });
});

describe('agentMcpServer', () => {
  it('is exactly the unbound server everywhere except Windows', () => {
    expect(agentMcpServer('linux')).toEqual(unboundMcpServer());
    expect(agentMcpServer('darwin')).toEqual(unboundMcpServer());
  });

  it('runs npx through cmd /c on Windows, because npx there is a .cmd shim an agent cannot start directly', () => {
    const base = unboundMcpServer();
    expect(agentMcpServer('win32')).toEqual({ command: 'cmd', args: ['/c', 'npx', ...base.args] });
  });

  it('keeps asking the registry for the latest version on Windows too', () => {
    expect(agentMcpServer('win32').args).toContain(`${ENGINE_NPM_PACKAGE}@latest`);
    expect(agentMcpServer('win32').args).not.toContain(ENGINE_NPM_PACKAGE);
  });

  it('leaves unboundMcpServer alone, so the editor configs written on Windows are unchanged', () => {
    expect(unboundMcpServer().command).toBe('npx');
  });
});

describe('inspectAgentMcp', () => {
  it('reports agents that are not installed', async () => {
    const result = await inspectAgentMcp(options());
    expect(result.map((r) => r.status.state)).toEqual(['not-installed', 'not-installed', 'not-installed', 'not-installed']);
  });

  it('reports an installed agent with no config as missing', async () => {
    await install('claude', 'codex', 'agy');
    const result = await inspectAgentMcp(options());
    expect(byId(result, 'claude').status).toEqual({ state: 'missing' });
    expect(byId(result, 'codex').status).toEqual({ state: 'missing' });
    expect(byId(result, 'antigravity').status).toEqual({ state: 'missing' });
  });

  it.each([
    BRAND_CONFIG.mcp.serverName,
    BRAND_CONFIG.mcp.legacyServerName,
    BRAND_CONFIG.mcp.adapterServerName,
    BRAND_CONFIG.mcp.legacyAdapterServerName,
  ])('treats a server named "%s" as already registered', async (name) => {
    await install('claude');
    await write('.claude.json', JSON.stringify({ mcpServers: { [name]: { command: 'whatever' } } }));
    expect(byId(await inspectAgentMcp(options()), 'claude').status).toEqual({ state: 'registered', serverName: name });
  });

  it('ignores unrelated servers', async () => {
    await install('antigravity'.replace('antigravity', 'agy'));
    await write('.gemini/config/mcp_config.json', JSON.stringify({ mcpServers: { memory: { command: 'npx' } } }));
    expect(byId(await inspectAgentMcp(options()), 'antigravity').status).toEqual({ state: 'missing' });
  });

  it('reads Claude config from CLAUDE_CONFIG_DIR when set', async () => {
    await install('claude');
    await write('custom/.claude.json', JSON.stringify({ mcpServers: { [MCP_REGISTRATION_NAME]: {} } }));
    const env = envWith({ CLAUDE_CONFIG_DIR: path.join(home, 'custom') });
    expect(byId(await inspectAgentMcp(options({}, env)), 'claude').status.state).toBe('registered');
  });

  it('reads Codex config from CODEX_HOME when set', async () => {
    await install('codex');
    await write('elsewhere/config.toml', `[mcp_servers.${MCP_REGISTRATION_NAME}]\ncommand = "npx"\n`);
    const env = envWith({ CODEX_HOME: path.join(home, 'elsewhere') });
    expect(byId(await inspectAgentMcp(options({}, env)), 'codex').status.state).toBe('registered');
  });

  it('reads Codex servers from the default ~/.codex/config.toml', async () => {
    await install('codex');
    await write('.codex/config.toml', '[mcp_servers.playwright]\ncommand = "npx"\n');
    expect(byId(await inspectAgentMcp(options()), 'codex').status).toEqual({ state: 'missing' });
  });

  it.each([
    ['claude', '.claude.json', '{not json'],
    ['antigravity', '.gemini/config/mcp_config.json', '[1, 2]'],
    ['codex', '.codex/config.toml', 'this = is = not toml'],
  ])('reports an unreadable %s config instead of guessing', async (id, file, content) => {
    await install({ claude: 'claude', antigravity: 'agy', codex: 'codex' }[id]!);
    await write(file, content);
    const { status } = byId(await inspectAgentMcp(options()), id);
    expect(status.state).toBe('unreadable');
  });

  describe('pi', () => {
    it('needs the MCP adapter package before it can use any server', async () => {
      await install('pi');
      const { status } = byId(await inspectAgentMcp(options()), 'pi');
      expect(status).toMatchObject({ state: 'unsupported' });
      expect((status as { reason: string }).reason).toContain('pi install npm:pi-mcp-adapter');
    });

    it('is unsupported when the settings list other packages only', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', JSON.stringify({ packages: ['npm:pi-web-access'] }));
      expect(byId(await inspectAgentMcp(options()), 'pi').status.state).toBe('unsupported');
    });

    it('is missing the server once the adapter is installed', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }));
      expect(byId(await inspectAgentMcp(options()), 'pi').status).toEqual({ state: 'missing' });
    });

    it('finds the adapter settings under PI_CODING_AGENT_DIR', async () => {
      await install('pi');
      await write('pi-dir/settings.json', JSON.stringify({ packages: ['git:github.com/x/pi-mcp-adapter'] }));
      const env = envWith({ PI_CODING_AGENT_DIR: path.join(home, 'pi-dir') });
      expect(byId(await inspectAgentMcp(options({}, env)), 'pi').status).toEqual({ state: 'missing' });
    });

    it.each(['.config/mcp/mcp.json', '.agents/mcp.json', '.agents/mcp/mcp.json'])('sees a server in %s', async (file) => {
      await install('pi');
      await write('.pi/agent/settings.json', JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }));
      await write(file, JSON.stringify({ mcpServers: { contextspace: { command: '/home/me/.local/bin/ctxspace-mcp' } } }));
      expect(byId(await inspectAgentMcp(options()), 'pi').status).toEqual({ state: 'registered', serverName: 'contextspace' });
    });
  });
});

describe('registerAgentMcp', () => {
  it('registers with each installed agent through its own CLI', async () => {
    await install('claude', 'codex', 'agy');

    const results = await registerAgentMcp(options());

    expect(results.filter((r) => r.outcome.result === 'added').map((r) => r.id).sort()).toEqual(['antigravity', 'claude', 'codex']);
    const server = unboundMcpServer();
    expect(calls).toEqual(expect.arrayContaining([
      { file: 'claude', args: ['mcp', 'add', '--scope', 'user', MCP_REGISTRATION_NAME, '--', server.command, ...server.args] },
      { file: 'codex', args: ['mcp', 'add', MCP_REGISTRATION_NAME, '--', server.command, ...server.args] },
      { file: 'agy', args: ['mcp', 'add', MCP_REGISTRATION_NAME, '--', server.command, ...server.args] },
    ]));
    expect(calls).toHaveLength(3);
    // The agents now list the server.
    expect((await readJson('.claude.json')).mcpServers[MCP_REGISTRATION_NAME].command).toBe('npx');
    expect(parseToml(await read('.codex/config.toml')).mcp_servers).toHaveProperty(MCP_REGISTRATION_NAME);
    expect((await readJson('.gemini/config/mcp_config.json')).mcpServers).toHaveProperty(MCP_REGISTRATION_NAME);
  });

  it('only touches agents that are installed', async () => {
    await install('claude');
    const results = await registerAgentMcp(options());
    expect(calls.map((c) => c.file)).toEqual(['claude']);
    expect(byId(results, 'codex').outcome).toEqual({ result: 'not-installed' });
    expect(await exists('.codex/config.toml')).toBe(false);
  });

  it('does nothing on a second run', async () => {
    await install('claude', 'codex', 'agy');
    await registerAgentMcp(options());
    calls.length = 0;

    const again = await registerAgentMcp(options());

    expect(calls).toEqual([]);
    expect(again.map((r) => r.outcome.result)).toEqual(['already', 'already', 'already', 'not-installed']);
  });

  it('never replaces an existing entry, which Codex and Antigravity would overwrite silently', async () => {
    await install('codex', 'agy');
    const custom = JSON.stringify({ mcpServers: { contextspace: { command: '/home/me/bin/my-launcher', args: ['custom'] } } });
    await write('.gemini/config/mcp_config.json', custom);
    await write('.codex/config.toml', '[mcp_servers.contextspace]\ncommand = "/home/me/bin/my-launcher"\n');

    const results = await registerAgentMcp(options());

    expect(calls).toEqual([]);
    expect(byId(results, 'antigravity').outcome).toEqual({ result: 'already', serverName: 'contextspace' });
    expect(byId(results, 'codex').outcome).toEqual({ result: 'already', serverName: 'contextspace' });
    expect(await read('.gemini/config/mcp_config.json')).toBe(custom);
    expect(await read('.codex/config.toml')).toContain('/home/me/bin/my-launcher');
  });

  it('leaves an unreadable config untouched and says so', async () => {
    await install('claude');
    await write('.claude.json', '{broken');

    const results = await registerAgentMcp(options());

    expect(calls).toEqual([]);
    expect(await read('.claude.json')).toBe('{broken');
    expect(byId(results, 'claude').outcome).toMatchObject({ result: 'skipped' });
    expect((byId(results, 'claude').outcome as { reason: string }).reason).toContain('could not read');
  });

  it('changes nothing in a dry run', async () => {
    await install('claude', 'codex', 'agy');

    const results = await registerAgentMcp(options({ dryRun: true }));

    expect(calls).toEqual([]);
    expect(await exists('.claude.json')).toBe(false);
    expect(await exists('.codex/config.toml')).toBe(false);
    expect(await exists('.gemini/config/mcp_config.json')).toBe(false);
    expect(results.filter((r) => r.outcome.result === 'would-add').map((r) => r.id).sort()).toEqual(['antigravity', 'claude', 'codex']);
  });

  describe('on native Windows', () => {
    const windows = (extra: Partial<AgentMcpOptions> = {}) =>
      options({ platform: 'win32', findBinary: (name) => (['claude', 'codex', 'agy'].includes(name) ? `C:\\bin\\${name}.exe` : null), ...extra });

    it('registers through cmd /c with each agent CLI, because npx cannot be started directly there', async () => {
      const results = await registerAgentMcp(windows());

      for (const id of ['claude', 'codex', 'antigravity']) expect(byId(results, id).outcome).toMatchObject({ result: 'added' });
      const wrapper = ['--', 'cmd', '/c', 'npx', '-y', `${ENGINE_NPM_PACKAGE}@latest`, 'mcp', 'run', '--role', 'interactive'];
      expect(calls).toEqual([
        { file: 'claude', args: ['mcp', 'add', '--scope', 'user', MCP_REGISTRATION_NAME, ...wrapper] },
        { file: 'codex', args: ['mcp', 'add', MCP_REGISTRATION_NAME, ...wrapper] },
        { file: 'agy', args: ['mcp', 'add', MCP_REGISTRATION_NAME, ...wrapper] },
      ]);
    });

    it('leaves each agent config listing the server with the cmd wrapper, which is what the agent will launch', async () => {
      await registerAgentMcp(windows());

      const claude = (await readJson('.claude.json')).mcpServers[MCP_REGISTRATION_NAME];
      expect(claude).toMatchObject({ command: 'cmd', args: ['/c', 'npx', '-y', `${ENGINE_NPM_PACKAGE}@latest`, 'mcp', 'run', '--role', 'interactive'] });
      const codex = parseToml(await read('.codex/config.toml')).mcp_servers as Record<string, { command: string; args: string[] }>;
      expect(codex[MCP_REGISTRATION_NAME]).toMatchObject({ command: 'cmd', args: ['/c', 'npx', '-y', `${ENGINE_NPM_PACKAGE}@latest`, 'mcp', 'run', '--role', 'interactive'] });
      const agy = (await readJson('.gemini/config/mcp_config.json')).mcpServers[MCP_REGISTRATION_NAME];
      expect(agy).toMatchObject({ command: 'cmd', args: expect.arrayContaining(['/c', 'npx']) });
    });

    it('hands an agent path with spaces to the runner as one program, never split or quoted into the arguments', async () => {
      const spaced: Record<string, string> = {
        claude: 'C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd',
        codex: 'C:\\Program Files\\nodejs\\codex.cmd',
        agy: 'D:\\My Tools\\Antigravity Agent\\agy.exe',
      };
      const results = await registerAgentMcp(windows({ findBinary: (name) => spaced[name] ?? null }));

      expect(rawFiles).toEqual([spaced.claude, spaced.codex, spaced.agy]);
      for (const id of ['claude', 'codex', 'antigravity']) expect(byId(results, id).outcome).toMatchObject({ result: 'added' });
      const everyArgument = calls.flatMap((call) => call.args);
      for (const piece of ['Program', 'Files', 'Smith', 'Tools', '"', "'"]) {
        expect(everyArgument.some((arg) => arg.includes(piece))).toBe(false);
      }
    });

    it('does not register again when the server is already there, and does not replace it', async () => {
      await write('.claude.json', JSON.stringify({ mcpServers: { [MCP_REGISTRATION_NAME]: { command: 'node', args: ['mine.js'] } } }));

      const results = await registerAgentMcp(windows());

      expect(byId(results, 'claude').outcome).toEqual({ result: 'already', serverName: MCP_REGISTRATION_NAME });
      expect(calls.some((call) => call.file === 'claude')).toBe(false);
      expect((await readJson('.claude.json')).mcpServers[MCP_REGISTRATION_NAME]).toEqual({ command: 'node', args: ['mine.js'] });
    });

    it('keeps unrelated Codex settings and servers, and respects CODEX_HOME', async () => {
      const env = envWith({ CODEX_HOME: path.join(home, 'custom-codex') });
      await write('custom-codex/config.toml', stringifyToml({ model: 'keep-me', mcp_servers: { other: { command: 'x', args: ['y'] } } }));

      const results = await registerAgentMcp(windows({ run: fakeCli(env), env }));

      expect(byId(results, 'codex').outcome).toMatchObject({ result: 'added' });
      const config = parseToml(await read('custom-codex/config.toml')) as Record<string, any>;
      expect(config.model).toBe('keep-me');
      expect(config.mcp_servers.other).toEqual({ command: 'x', args: ['y'] });
      expect(config.mcp_servers[MCP_REGISTRATION_NAME].command).toBe('cmd');
      expect(await exists('.codex/config.toml')).toBe(false);
    });

    it('writes the same wrapper into Pi\'s shared config', async () => {
      await write('.pi/agent/settings.json', JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }));
      const results = await registerAgentMcp(options({ platform: 'win32', findBinary: (name) => (name === 'pi' ? 'C:\\Program Files\\pi\\pi.exe' : null) }));

      expect(byId(results, 'pi').outcome).toMatchObject({ result: 'added' });
      const server = (await readJson('.config/mcp/mcp.json')).mcpServers[MCP_REGISTRATION_NAME];
      expect(server).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', `${ENGINE_NPM_PACKAGE}@latest`, 'mcp', 'run', '--role', 'interactive'] });
    });

    it('shows what it would do in a dry run and changes nothing', async () => {
      const results = await registerAgentMcp(windows({ dryRun: true }));

      expect(calls).toEqual([]);
      expect(await exists('.claude.json')).toBe(false);
      expect(results.filter((r) => r.outcome.result === 'would-add').map((r) => r.id).sort()).toEqual(['antigravity', 'claude', 'codex']);
    });

    it('reports a CLI that fails on Windows with its message, like anywhere else', async () => {
      const run: CommandRunner = async () => ({ exitCode: 1, stdout: '', stderr: "'cmd' is not recognized" });

      const results = await registerAgentMcp(windows({ run }));

      expect(byId(results, 'claude').outcome).toMatchObject({ result: 'failed', reason: expect.stringContaining("'cmd' is not recognized") });
      expect(await exists('.claude.json')).toBe(false);
    });

    it('reports a CLI that claims success but changes nothing as a failure, since the config is the proof', async () => {
      const run: CommandRunner = async () => ({ exitCode: 0, stdout: 'Added', stderr: '' });

      const results = await registerAgentMcp(windows({ run }));

      expect(byId(results, 'claude').outcome).toMatchObject({ result: 'failed', reason: expect.stringContaining('still does not list the server') });
    });

    it('tells doctor the server can be set up, instead of calling Windows unsupported', async () => {
      const claude = byId(await inspectAgentMcp(windows()), 'claude').status;
      expect(claude).toEqual({ state: 'missing' });
    });

    it('still recognises a server the user added by hand', async () => {
      await write('.claude.json', JSON.stringify({ mcpServers: { [MCP_REGISTRATION_NAME]: { command: 'cmd' } } }));
      expect(byId(await inspectAgentMcp(windows()), 'claude').status.state).toBe('registered');
    });
  });

  describe('when registration goes wrong', () => {
    it('reports a CLI that exits non-zero, with its message, and carries on with the rest', async () => {
      await install('claude', 'codex');
      const env = envWith();
      const real = fakeCli(env);
      const run: CommandRunner = async (file, args, e) =>
        path.basename(file) === 'claude' ? { exitCode: 2, stdout: '', stderr: 'permission denied\nwriting config failed' } : real(file, args, e);

      const results = await registerAgentMcp(options({ run }, env));

      const claude = byId(results, 'claude').outcome;
      expect(claude).toMatchObject({ result: 'failed' });
      expect((claude as { reason: string }).reason).toContain('exited with code 2');
      expect((claude as { reason: string }).reason).toContain('writing config failed');
      expect(byId(results, 'codex').outcome.result).toBe('added');
    });

    it('does not trust a CLI that exits 0 without registering anything', async () => {
      await install('agy');
      const run: CommandRunner = async () => ({ exitCode: 0, stdout: 'Added', stderr: '' });

      const results = await registerAgentMcp(options({ run }));

      const outcome = byId(results, 'antigravity').outcome;
      expect(outcome).toMatchObject({ result: 'failed' });
      expect((outcome as { reason: string }).reason).toContain('still does not list the server');
    });

    it('reports a CLI that cannot be started', async () => {
      await install('codex');
      const run: CommandRunner = async () => { throw new Error('spawn EACCES'); };
      const outcome = byId(await registerAgentMcp(options({ run })), 'codex').outcome;
      expect(outcome).toEqual({ result: 'failed', reason: 'spawn EACCES' });
    });

    it('reports a timed-out CLI, whose exit code is unknown', async () => {
      await install('claude');
      const run: CommandRunner = async () => ({ exitCode: undefined, stdout: '', stderr: '' });
      const outcome = byId(await registerAgentMcp(options({ run })), 'claude').outcome;
      expect((outcome as { reason: string }).reason).toContain('exited with code unknown');
    });
  });

  describe('pi', () => {
    const adapter = JSON.stringify({ packages: ['npm:pi-mcp-adapter'] });

    it('writes the shared MCP file, keeping every other server and key', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', adapter);
      await write('.config/mcp/mcp.json', JSON.stringify({ settings: { toolPrefix: 'short' }, mcpServers: { memory: { command: 'npx', args: ['memory'] } } }));

      const results = await registerAgentMcp(options());

      expect(byId(results, 'pi').outcome.result).toBe('added');
      const config = await readJson('.config/mcp/mcp.json');
      expect(config.settings).toEqual({ toolPrefix: 'short' });
      expect(config.mcpServers.memory).toEqual({ command: 'npx', args: ['memory'] });
      expect(config.mcpServers[MCP_REGISTRATION_NAME]).toEqual(unboundMcpServer());
      expect(calls).toEqual([]);
    });

    it('creates the shared file and its folder when neither exists', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', adapter);
      await registerAgentMcp(options());
      expect((await readJson('.config/mcp/mcp.json')).mcpServers[MCP_REGISTRATION_NAME]).toEqual(unboundMcpServer());
    });

    it('is idempotent', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', adapter);
      await registerAgentMcp(options());
      const first = await read('.config/mcp/mcp.json');

      const again = await registerAgentMcp(options());

      expect(byId(again, 'pi').outcome).toEqual({ result: 'already', serverName: MCP_REGISTRATION_NAME });
      expect(await read('.config/mcp/mcp.json')).toBe(first);
    });

    it('leaves an existing hand-made entry alone', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', adapter);
      const mine = JSON.stringify({ mcpServers: { contextspace: { command: '/home/me/.local/bin/ctxspace-mcp', args: ['mcp', 'run'] } } });
      await write('.config/mcp/mcp.json', mine);

      const results = await registerAgentMcp(options());

      expect(byId(results, 'pi').outcome).toEqual({ result: 'already', serverName: 'contextspace' });
      expect(await read('.config/mcp/mcp.json')).toBe(mine);
    });

    it('does nothing without the adapter, and says what to install', async () => {
      await install('pi');
      const results = await registerAgentMcp(options());
      expect(byId(results, 'pi').outcome).toMatchObject({ result: 'skipped' });
      expect(await exists('.config/mcp/mcp.json')).toBe(false);
    });

    it('does not overwrite a shared file it cannot parse', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', adapter);
      await write('.config/mcp/mcp.json', '{ "mcpServers": ');

      const results = await registerAgentMcp(options());

      expect(byId(results, 'pi').outcome.result).toBe('skipped');
      expect(await read('.config/mcp/mcp.json')).toBe('{ "mcpServers": ');
    });

    it('fails without writing when "mcpServers" is not an object', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', adapter);
      await write('.config/mcp/mcp.json', JSON.stringify({ mcpServers: ['oops'] }));

      const outcome = byId(await registerAgentMcp(options()), 'pi').outcome;

      expect(outcome).toMatchObject({ result: 'failed' });
      expect(await read('.config/mcp/mcp.json')).toBe(JSON.stringify({ mcpServers: ['oops'] }));
    });

    it('does not dry-run into the file', async () => {
      await install('pi');
      await write('.pi/agent/settings.json', adapter);
      const results = await registerAgentMcp(options({ dryRun: true }));
      expect(byId(results, 'pi').outcome.result).toBe('would-add');
      expect(await exists('.config/mcp/mcp.json')).toBe(false);
    });
  });
});
