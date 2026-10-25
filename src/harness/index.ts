import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import type { HarnessAdapter } from "./interface.js";
import type { Vendor } from "./types.js";

export function getAdapter(vendor: Vendor, opts?: {
  sessionStore?: SessionStore;         // claude only
  codexClientOptions?: ConstructorParameters<typeof CodexAdapter>[0];
}): HarnessAdapter {
  switch (vendor) {
    case "claude-code":
      return new ClaudeCodeAdapter(opts?.sessionStore);
    case "codex":
      return new CodexAdapter(opts?.codexClientOptions);
  }
}

export * from "./types.js";
export * from "./interface.js";
