import { describe, expect, it } from 'vitest';
import { AntigravityCliAdapter } from './AntigravityCliAdapter.js';
import { ClaudeCliAdapter } from './ClaudeCliAdapter.js';
import { CodexCliAdapter } from './CodexCliAdapter.js';

// Each AI tool the in-app chat starts is told its name, so `ctxspace plan` acts as the AI and records the tool.
describe('the environment of an AI tool started by the in-app chat', () => {
  it.each([
    ['claude', class extends ClaudeCliAdapter { env() { return this.buildEnv(); } }],
    ['codex', class extends CodexCliAdapter { env() { return this.buildEnv(); } }],
    ['antigravity', class extends AntigravityCliAdapter { env() { return this.buildEnv(); } }],
  ])('names %s in CTXSPACE_HARNESS', (harness, Adapter) => {
    expect(new Adapter().env().CTXSPACE_HARNESS).toBe(harness);
  });
});
