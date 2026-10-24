import Anthropic from '@anthropic-ai/sdk';
import { NativeAgentBase } from './NativeAgentBase.js';
import {
  NATIVE_TOOLS,
  NATIVE_STEP_LIMIT,
  STEP_LIMIT_NOTICE,
  buildSystemPrompt,
  executeNativeTool,
} from './nativeTools.js';
import { toErrorMessage } from '../utils/errors.js';

export class NativeClaudeAgent extends NativeAgentBase {
  protected readonly label = 'NativeClaudeAgent';
  private anthropic: Anthropic | null = null;
  private messages: any[] = [];
  private modelName: string;

  constructor() {
    super();
    this.modelName = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  }

  private client(): Anthropic {
    return (this.anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' }));
  }

  protected configError(): string | null {
    return process.env.ANTHROPIC_API_KEY ? null : 'Anthropic API key is not configured (set ANTHROPIC_API_KEY).';
  }

  protected resetHistory() {
    this.messages = [];
  }

  protected async runLoop(userInput: string, signal: AbortSignal) {
    this.messages.push({ role: 'user', content: userInput });

    const system = buildSystemPrompt(this.cwd);
    const tools: Anthropic.Tool[] = NATIVE_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: { [t.argName]: { type: 'string', description: t.argDescription } },
        required: [t.argName],
      },
    }));

    let completed = false;

    for (let step = 0; step < NATIVE_STEP_LIMIT; step++) {
      if (signal.aborted) break;

      const stream = await this.client().messages.create({
        model: this.modelName,
        max_tokens: 8192,
        system,
        messages: this.messages,
        tools,
        stream: true,
      }, { signal });

      let content = '';
      const toolCalls: any[] = [];
      let currentToolCall: any = null;

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          content += chunk.delta.text;
          this.emit('data', chunk.delta.text);
        } else if (chunk.type === 'content_block_start' && chunk.content_block.type === 'tool_use') {
          currentToolCall = { id: chunk.content_block.id, name: chunk.content_block.name, input: '' };
          this.emit('data', `\n\n*Running tool: ${currentToolCall.name}*\n`);
        } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'input_json_delta' && currentToolCall) {
          currentToolCall.input += chunk.delta.partial_json;
        } else if (chunk.type === 'content_block_stop') {
          if (currentToolCall) {
            toolCalls.push(currentToolCall);
            currentToolCall = null;
          }
        }
      }

      // Parse tool inputs up front. A tool_use block and its later tool_result
      // must be paired: if the JSON is malformed we drop BOTH, otherwise the
      // Anthropic API rejects the next request with a dangling tool_result and
      // the whole session is wedged.
      const assistantContent: any[] = [];
      if (content) assistantContent.push({ type: 'text', text: content });
      const validCalls: { id: string; name: string; args: any }[] = [];
      for (const tc of toolCalls) {
        try {
          const args = JSON.parse(tc.input || '{}');
          assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: args });
          validCalls.push({ id: tc.id, name: tc.name, args });
        } catch {
          // Malformed tool input — skip the block entirely (no tool_result).
        }
      }

      // Anthropic requires strictly alternating user/assistant turns with
      // non-empty content. If the model returned nothing usable (no text and
      // only malformed tool calls), record a minimal assistant turn so the
      // next user message doesn't produce two consecutive user turns (400).
      if (assistantContent.length === 0) {
        assistantContent.push({ type: 'text', text: '(no response)' });
      }
      this.messages.push({ role: 'assistant', content: assistantContent });

      if (validCalls.length === 0) {
        completed = true;
        break;
      }

      const toolResultContent: any[] = [];
      for (const call of validCalls) {
        try {
          const result = await executeNativeTool(this.cwd, call.name, call.args);
          toolResultContent.push({ type: 'tool_result', tool_use_id: call.id, content: result });
        } catch (err) {
          toolResultContent.push({ type: 'tool_result', tool_use_id: call.id, content: `Error: ${toErrorMessage(err)}`, is_error: true });
        }
      }

      this.messages.push({ role: 'user', content: toolResultContent });
    }

    if (!completed && !signal.aborted) {
      this.emit('data', STEP_LIMIT_NOTICE);
    }
  }
}
