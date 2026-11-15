import { EventEmitter } from 'node:events';

/**
 * Shared lifecycle for the SDK-backed native agents. Owns the processing guard,
 * the abort controller, and the idle/error signalling so each provider only
 * implements its SDK-specific streaming loop.
 */
export abstract class NativeAgentBase extends EventEmitter {
  protected cwd: string = '';
  protected isProcessing: boolean = false;
  protected abortController: AbortController | null = null;

  /** Human label used in server-side error logs. */
  protected abstract readonly label: string;

  /** Clear provider-specific conversation history for a new session. */
  protected abstract resetHistory(): void;

  /** Run one user turn's agent loop, honoring `signal` for cancellation. */
  protected abstract runLoop(userInput: string, signal: AbortSignal): Promise<void>;

  /**
   * Returns a user-facing message when the provider isn't usable (e.g. missing
   * API key), or null when it is. Checked before each turn so a misconfigured
   * provider gives a clear error instead of a raw SDK auth exception.
   */
  protected configError(): string | null {
    return null;
  }

  public async start(cwd: string): Promise<void> {
    this.cwd = cwd;
    this.resetHistory();
  }

  public async send(data: string): Promise<void> {
    if (this.isProcessing) return;

    const cfgError = this.configError();
    if (cfgError) {
      this.emit('error', new Error(cfgError));
      this.emit('idle');
      return;
    }

    this.isProcessing = true;
    const controller = new AbortController();
    this.abortController = controller;
    try {
      await this.runLoop(data, controller.signal);
    } catch (err) {
      // Any error surfacing after an intentional Stop is the abort, not a
      // failure — the SDKs throw APIUserAbortError (name !== 'AbortError'),
      // so check the signal rather than the error name.
      if (!controller.signal.aborted) {
        console.error(`${this.label} error:`, err);
        this.emit('error', err);
      }
    } finally {
      this.isProcessing = false;
      this.emit('idle');
    }
  }

  public stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.emit('close', 0);
  }
}
