import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentExecutionProfile } from './ProviderRegistry.js';
import { getAugmentedPath } from '../utils/user-paths.js';

/**
 * Shared lifecycle for CLI-backed agents (claude, codex, agy). Each turn spawns the
 * binary once in print mode, streams stdout as `data`, and emits `idle` when
 * the turn ends. Subclasses supply the binary, the per-turn args, how the
 * prompt is delivered.
 *
 * Prompt delivery differs per CLI: `claude` is an npm `.cmd` shim that needs
 * `shell: true` on Windows, and under a shell an argv prompt would be split on
 * spaces, so its prompt goes over stdin. `agy` is a native binary that reads
 * the prompt from argv and needs no shell (argv is passed literally, so no
 * quoting hazard).
 */
export abstract class CliAdapterBase extends EventEmitter {
  protected cwd: string = '';
  protected isFirstTurn: boolean = true;
  private isProcessing: boolean = false;
  private stopped: boolean = false;
  private child: ChildProcess | null = null;
  private pendingTurnError: Error | null = null;

  /** Executable name, e.g. 'claude' or 'agy'. */
  protected abstract readonly binary: string;
  /** Short label for stderr/error diagnostics. */
  protected abstract readonly label: string;
  /** The AI tool's name, given to it as CTXSPACE_HARNESS so `ctxspace plan` records which tool made a change. */
  protected readonly harness?: string;
  /** Spawn through a shell (needed to resolve a `.cmd` shim on Windows). */
  protected readonly useShell: boolean = false;
  /** Pipe the prompt to stdin (true) vs. include it in argv via buildArgs (false). */
  protected readonly promptViaStdin: boolean = false;
  /**
   * Most legacy CLI adapters treat process dispatch as enough to advance their
   * first-turn argv. Structured adapters can opt out and call
   * acknowledgeFirstTurn() only after the provider confirms session creation.
   */
  protected readonly advanceFirstTurnOnDispatch: boolean = true;

  /** Args for one print-mode turn. Receives the prompt so argv-mode CLIs can
   *  include it; stdin-mode CLIs ignore it. */
  protected abstract buildArgs(
    isFirstTurn: boolean,
    prompt: string,
    executionProfile?: AgentExecutionProfile,
  ): string[];

  /**
   * Consume one stdout chunk. Structured-output adapters override this to
   * decode provider events and emit only user-facing text. The return value
   * means the chunk was handled as a meaningful result (including a structured
   * provider error), so a later non-zero exit should not add a duplicate error.
   */
  protected handleStdout(text: string): boolean {
    if (!text) return false;
    this.emit('data', text);
    return true;
  }

  /** Flush a final unterminated structured-output record, if any. */
  protected finishStdout(_exitCode: number | null): boolean {
    return false;
  }

  /** Mark the current provider session as created/resumable. */
  protected acknowledgeFirstTurn(): void {
    this.isFirstTurn = false;
  }

  /**
   * Fail the active turn without publishing an idle/error state before its
   * subprocess has actually settled. Protocol failures may also terminate the
   * process so a write-capable CLI cannot outlive the UI's busy state.
   */
  protected failCurrentTurn(error: Error, terminateProcess = false): void {
    this.pendingTurnError ??= error;
    if (terminateProcess) killTree(this.child, { detached: process.platform !== 'win32' });
  }

  public async start(cwd: string): Promise<void> {
    this.cwd = cwd;
    this.isFirstTurn = true;
    this.pendingTurnError = null;
  }

  public async send(data: string, executionProfile?: AgentExecutionProfile): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.stopped = false;
    this.pendingTurnError = null;

    const args = this.buildArgs(this.isFirstTurn, data, executionProfile);
    if (this.advanceFirstTurnOnDispatch) this.acknowledgeFirstTurn();
    this.runTurn(args, data);
  }

  /** Subclasses can customize environment variables for the CLI subprocess. */
  protected buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' }; // Strip colors for easier parsing
    if (this.harness) env.CTXSPACE_HARNESS = this.harness;
    const augmented = getAugmentedPath(env);
    env.PATH = augmented;
    if (process.platform === 'win32') {
      env.Path = augmented;
    }
    return env;
  }

  /** Kept as a seam so lifecycle tests can exercise process failures without a real CLI. */
  protected spawnProcess(args: string[]): ChildProcess {
    return spawn(this.binary, args, {
      cwd: this.cwd,
      shell: this.useShell,
      detached: process.platform !== 'win32',
      env: this.buildEnv(),
    });
  }

  private runTurn(args: string[], data: string) {
    const cliProcess = this.spawnProcess(args);
    this.child = cliProcess;
    if (this.promptViaStdin) {
      cliProcess.stdin?.once?.('error', () => {
        // Ignore EPIPE / write errors on stdin; the process error or close event will settle the turn
      });
      cliProcess.stdin?.write(data);
      cliProcess.stdin?.end();
    }

    let producedOutput = false;
    let stderrTail = '';
    let settled = false;

    // Let Node's StringDecoder preserve UTF-8 code points split across OS
    // buffer boundaries before structured adapters see the text.
    cliProcess.stdout?.setEncoding?.('utf8');
    cliProcess.stdout?.on('data', (chunk) => {
      producedOutput = this.handleStdout(typeof chunk === 'string' ? chunk : chunk.toString()) || producedOutput;
    });

    // CLIs print warnings and progress on stderr; only keep it for diagnostics.
    cliProcess.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      console.warn(`[${this.label} stderr]`, text.trimEnd());
    });

    const settle = (code: number | null, startError?: Error) => {
      if (settled) return;
      settled = true;
      this.isProcessing = false;
      this.child = null;
      if (!startError) producedOutput = this.finishStdout(code) || producedOutput;

      const turnError = this.pendingTurnError;
      this.pendingTurnError = null;
      if (turnError) {
        this.emit('error', turnError);
      } else if (startError) {
        this.emit('error', new Error(`Failed to start ${this.label}: ${startError.message}`));
      } else if (!this.stopped && code !== 0 && !producedOutput) {
        // A non-zero exit after an intentional stop is expected, not an error.
        this.emit('error', new Error(`${this.label} exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}`));
      }
      // Turn separation is the GUI's concern — do not inject stray output here,
      // or a failed turn would spawn an empty bubble on the client.
      this.emit('idle');
    };

    cliProcess.on('error', (err) => {
      settle(null, err);
    });

    cliProcess.on('close', (code) => {
      settle(code);
    });
  }

  public stop(): void {
    this.stopped = true;
    this.pendingTurnError = null;
    killTree(this.child, { detached: process.platform !== 'win32' });
    this.child = null;
    this.isProcessing = false;
    this.emit('close', 0);
  }
}

export interface KillTreeOptions {
  detached?: boolean;
  gracePeriodMs?: number;
}

// With shell:true or child subprocess trees, terminating a process requires killing
// the whole tree. On Windows, taskkill /T /F handles this. On POSIX (Linux/macOS),
// we send SIGTERM to the process group (when spawned detached) or direct child process,
// with a graceful escalation to SIGKILL if still alive after the grace period.
//
// Notes on trade-offs:
// - Direct PID liveness probe: process.kill(pid, 0) verifies the direct child. When
//   spawned with detached: true, group signaling (-pid) cleanly terminates all child/grandchild
//   processes. In non-detached fallback, only the direct child process is signaled.
// - Unref'd escalation timer: setTimeout.unref() allows the host CLI/server process to exit
//   naturally without being kept alive by pending escalation timers during clean shutdown.
export function killTree(child: ChildProcess | null, options?: KillTreeOptions) {
  if (!child || child.exitCode !== null || !child.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    let signaled = false;
    if (options?.detached) {
      try {
        process.kill(-pid, 'SIGTERM');
        signaled = true;
      } catch {}
    }
    if (!signaled) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }

    const gracePeriod = options?.gracePeriodMs ?? 3000;
    const forceKillTimer = setTimeout(() => {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e: any) {
        alive = e?.code === 'EPERM';
      }
      if (!alive) return;

      if (options?.detached) {
        try {
          process.kill(-pid, 'SIGKILL');
          return;
        } catch {}
      }
      try {
        child.kill('SIGKILL');
      } catch {}
    }, gracePeriod);
    forceKillTimer.unref?.();
  }
}
