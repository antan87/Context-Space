import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { execa } from 'execa';
import * as path from 'node:path';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';

import { startOrchestrator, stopOrchestrator, stopRecordedOrchestrator, orchestratorPm2Name } from './orchestrator.js';
import type { OrchestrationDetection } from '../types.js';

vi.mock('node:fs/promises');
vi.mock('execa');

const WS = '/ws/feature-a';

function compose(): OrchestrationDetection {
  return {
    id: 'docker-compose:docker-compose.yml',
    tool: 'docker-compose',
    configPath: '/ws/feature-a/docker-compose.yml',
    startCommand: 'docker compose ... up -d',
    stopCommand: 'docker compose ... down',
    run: { command: 'docker', args: ['compose', '-f', '/ws/feature-a/docker-compose.yml', 'up', '-d'], cwd: '/ws/feature-a' },
    stopRun: { command: 'docker', args: ['compose', '-f', '/ws/feature-a/docker-compose.yml', 'down'], cwd: '/ws/feature-a' },
    mode: 'oneshot',
  };
}

function tilt(): OrchestrationDetection {
  return {
    id: 'tilt:Tiltfile',
    tool: 'tilt',
    configPath: '/ws/feature-a/Tiltfile',
    startCommand: 'tilt up',
    stopCommand: 'Stopped via ContextSpace',
    run: { command: 'tilt', args: ['up', '--file', '/ws/feature-a/Tiltfile'], cwd: '/ws/feature-a' },
    stopRun: { command: 'tilt', args: ['down', '--file', '/ws/feature-a/Tiltfile'], cwd: '/ws/feature-a' },
    mode: 'pm2',
  };
}

/** A throwaway PM2 home with a live daemon record (this process's pid and an rpc.sock file). Never ~ or ~/.pm2. */
const tempDirs: string[] = [];
function fakeLivePm2Home(): string {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pm2t-'));
  tempDirs.push(dir);
  if (dir === os.homedir() || dir.startsWith(path.join(os.homedir(), '.pm2'))) throw new Error('unsafe temp dir');
  nodeFs.writeFileSync(path.join(dir, 'pm2.pid'), String(process.pid));
  nodeFs.writeFileSync(path.join(dir, 'rpc.sock'), '');
  return dir;
}

describe('orchestrator runner', () => {
  const originalPm2Home = process.env.PM2_HOME;
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
    if (originalPm2Home === undefined) delete process.env.PM2_HOME;
    else process.env.PM2_HOME = originalPm2Home;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PM2_HOME = fakeLivePm2Home();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as any);
    vi.mocked(fs.unlink).mockResolvedValue(undefined as any);
  });

  it('starts a one-shot compose tool by executing the structured run (no shell) and records state', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: '' } as any);

    const running = await startOrchestrator(compose(), WS, '/logs');

    expect(running.mode).toBe('oneshot');
    expect(running.pm2Name).toBeUndefined();
    expect(vi.mocked(execa).mock.calls[0]).toEqual([
      'docker',
      ['compose', '-f', '/ws/feature-a/docker-compose.yml', 'up', '-d'],
      { cwd: '/ws/feature-a', shell: false },
    ]);
    const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls.at(-1)?.[1] as string);
    expect(written.orchestrators[0].id).toBe('docker-compose:docker-compose.yml');
  });

  it('wraps a pm2-mode tool under a PM2 app named orch-<id-slug>', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: '' } as any);

    const detection = tilt();
    const running = await startOrchestrator(detection, WS, '/logs');

    // Name/log are keyed on the detection id (not the tool) so same-tool tools
    // in different sub-repos never collide.
    expect(running.pm2Name).toBe(orchestratorPm2Name(WS, detection));
    expect(running.pm2Name).toMatch(/^ctxspace-feature-a-[0-9a-f]{8}-orch-tilt-tiltfile$/);
    expect(running.logName).toBe('orch-tilt-tiltfile');
    // pm2 delete (idempotent) then pm2 start with the orch app name.
    const startCall = vi.mocked(execa).mock.calls.find((c) => (c[1] as string[] | undefined)?.includes('start'));
    expect(startCall?.[1] as string[]).toContain(orchestratorPm2Name(WS, detection));
  });

  it('stops a one-shot tool by running stopRun and clearing state', async () => {
    // State currently has the compose orchestrator recorded.
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        workspacePath: WS,
        services: [],
        orchestrators: [{ id: 'docker-compose:docker-compose.yml', tool: 'docker-compose', configPath: 'x', mode: 'oneshot', startedAt: 'x' }],
        updatedAt: 'x',
      }) as any,
    );
    vi.mocked(execa).mockResolvedValue({ stdout: '' } as any);

    await stopOrchestrator(compose(), WS);

    expect(vi.mocked(execa).mock.calls[0]).toEqual([
      'docker',
      ['compose', '-f', '/ws/feature-a/docker-compose.yml', 'down'],
      { cwd: '/ws/feature-a', shell: false, reject: false },
    ]);
    // No services and no orchestrators left → state file removed.
    expect(fs.unlink).toHaveBeenCalled();
  });

  it('stops a recorded orchestrator that is no longer detected, by its recorded PM2 name', async () => {
    const state = {
      workspacePath: WS,
      services: [],
      orchestrators: [{ id: 'procfile:Procfile', tool: 'procfile', configPath: '/ws/feature-a/Procfile', mode: 'pm2', pm2Name: 'ctxspace-feature-a-1234abcd-orch-procfile', startedAt: 'x' }],
      updatedAt: 'x',
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(state) as any);
    vi.mocked(fs.unlink).mockResolvedValue(undefined as any);
    vi.mocked(execa).mockResolvedValue({ stdout: '' } as any);

    expect(await stopRecordedOrchestrator('procfile:Procfile', WS)).toBe(true);
    expect(execa).toHaveBeenCalledWith('npx', ['pm2', 'delete', 'ctxspace-feature-a-1234abcd-orch-procfile'], { reject: false });
    expect(fs.unlink).toHaveBeenCalled(); // nothing left recorded
    expect(await stopRecordedOrchestrator('tilt:Tiltfile', WS)).toBe(false);
  });
});
