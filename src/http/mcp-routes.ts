/**
 * @module http/mcp-routes
 * Inspect and register the ContextSpace MCP server for installed AI agents.
 */

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  MCP_AGENT_IDS,
  inspectAgentMcp,
  registerAgentMcp,
  type AgentMcpOptions,
} from '../core/agent-mcp.js';

export type McpRoutesOptions = Omit<AgentMcpOptions, 'dryRun' | 'only'>;

const connectSchema = z.object({
  ids: z.array(z.enum(MCP_AGENT_IDS)).optional(),
}).strict();

// Two Connect presses never mutate agent configs concurrently.
let connectChain: Promise<unknown> = Promise.resolve();

function enqueueConnect<T>(run: () => Promise<T>): Promise<T> {
  const next = connectChain.then(run, run);
  connectChain = next.catch(() => {});
  return next;
}

/** Mounted behind the server's existing local-origin boundary. */
export function registerMcpRoutes(app: Hono, options: McpRoutesOptions = {}) {
  app.get('/api/mcp/agents', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const agents = await inspectAgentMcp(options);
      return c.json({ agents });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post(
    '/api/mcp/agents/connect',
    bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'Request body is too large.' }, 413) }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      let parsedBody: z.infer<typeof connectSchema> = {};
      try {
        const rawText = await c.req.text();
        if (rawText.trim()) {
          let raw: unknown;
          try {
            raw = JSON.parse(rawText);
          } catch {
            return c.json({ error: 'The request must be JSON.' }, 400);
          }
          parsedBody = connectSchema.parse(raw);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          const issue = error.issues[0];
          return c.json({ error: issue ? `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` : 'Invalid request.' }, 400);
        }
        return c.json({ error: 'Invalid request.' }, 400);
      }

      try {
        const results = await enqueueConnect(() => registerAgentMcp({ ...options, only: parsedBody.ids }));
        return c.json({ results });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  );
}
