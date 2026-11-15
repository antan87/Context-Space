import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenAI } from '@google/genai';
import { NativeAgent } from './NativeAgent.js';
import { NativeClaudeAgent } from './NativeClaudeAgent.js';
import { NativeGoogleAgent } from './NativeGoogleAgent.js';

// Ensure no keys leak in from the environment.
beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

async function* toAsyncStream<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

const cases: [string, () => any, RegExp][] = [
  ['NativeAgent (OpenAI)', () => new NativeAgent(), /OpenAI API key is not configured/],
  ['NativeClaudeAgent', () => new NativeClaudeAgent(), /Anthropic API key is not configured/],
  ['NativeGoogleAgent', () => new NativeGoogleAgent(), /Google API key is not configured/],
];

describe('native agents without an API key', () => {
  for (const [name, make, expected] of cases) {
    it(`${name}: constructs without throwing and emits a clear config error on send`, async () => {
      // Construction must not throw even though the SDK client would reject an
      // empty key — the client is built lazily behind the config gate.
      const agent = make();
      const events: { type: string; message?: string }[] = [];
      agent.on('error', (e: Error) => events.push({ type: 'error', message: e.message }));
      agent.on('idle', () => events.push({ type: 'idle' }));

      await agent.start('/tmp/ws');
      await agent.send('hello');

      const err = events.find((e) => e.type === 'error');
      expect(err, 'expected an error event').toBeTruthy();
      expect(err!.message).toMatch(expected);
      // No network call happened, and the turn settled.
      expect(events.some((e) => e.type === 'idle')).toBe(true);
    });
  }
});

describe('NativeAgent (OpenAI) streaming and tool calls', () => {
  it('streams content and handles multi-chunk tool calls with out-of-order delta frames', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-native-test-'));
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'hello world', 'utf-8');

    try {
      // Turn 1: model returns tool calls with fragmented/chunked name and args
      const step1Chunks = [
        { choices: [{ delta: { content: 'Thinking...' } }] },
        // Tool 0 header arrives with id but name in next chunk
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_001', type: 'function', function: { name: '' } }] } }] },
        // Tool 1 header arrives
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_002', type: 'function', function: { name: 'list_directory' } }] } }] },
        // Tool 0 name arrives and arguments start
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"filePath":"' } }] } }] },
        // Tool 0 arguments finish
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'test.txt"}' } }] } }] },
        // Tool 1 arguments arrive
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"dirPath":"."}' } }] } }] },
      ];

      // Turn 2: model sees tool outputs and returns final message
      const step2Chunks = [
        { choices: [{ delta: { content: 'Both tools executed successfully.' } }] },
      ];

      const createSpy = vi.fn()
        .mockResolvedValueOnce(toAsyncStream(step1Chunks))
        .mockResolvedValueOnce(toAsyncStream(step2Chunks));

      const mockOpenAI = {
        chat: { completions: { create: createSpy } },
      } as unknown as OpenAI;

      const agent = new NativeAgent(mockOpenAI);
      const dataEvents: string[] = [];
      agent.on('data', (d: string) => dataEvents.push(d));

      await agent.start(tempDir);
      await agent.send('read test.txt and list dir');

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(dataEvents.some((d) => d.includes('Running tool: read_file'))).toBe(true);
      expect(dataEvents.some((d) => d.includes('Running tool: list_directory'))).toBe(true);
      expect(dataEvents.some((d) => d.includes('Both tools executed successfully.'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('handles tool execution errors gracefully without throwing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-err-test-'));

    try {
      const step1Chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_err', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }] } }] },
      ];
      const step2Chunks = [
        { choices: [{ delta: { content: 'Handled error.' } }] },
      ];

      const createSpy = vi.fn()
        .mockResolvedValueOnce(toAsyncStream(step1Chunks))
        .mockResolvedValueOnce(toAsyncStream(step2Chunks));

      const mockOpenAI = {
        chat: { completions: { create: createSpy } },
      } as unknown as OpenAI;

      const agent = new NativeAgent(mockOpenAI);
      await agent.start(tempDir);
      await agent.send('run unknown');

      expect(createSpy).toHaveBeenCalledTimes(2);
      // Second call receives the tool message with Error: Unknown tool
      const secondCallMessages = createSpy.mock.calls[1][0].messages;
      const toolMsg = secondCallMessages.find((m: any) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.content).toContain('Error: Unknown tool: unknown_tool');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('NativeClaudeAgent streaming and tool calls', () => {
  it('handles interleaved content blocks and preserves unstopped pending tools', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-native-test-'));
    await fs.writeFile(path.join(tempDir, 'data.txt'), 'content', 'utf-8');

    try {
      // Stream interleaved: block 0 starts, block 1 starts, deltas interleaved, stream ends without block 1 stop
      const step1Chunks = [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Processing...' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_0', name: 'read_file' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'list_directory' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"filePath":"data.txt"}' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"dirPath":"."}' } },
        { type: 'content_block_stop', index: 0 },
        // Notice index 1 has NO content_block_stop before stream finishes — pendingTools must retain it!
      ];

      const step2Chunks = [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Finished successfully.' } },
      ];

      const createSpy = vi.fn()
        .mockResolvedValueOnce(toAsyncStream(step1Chunks))
        .mockResolvedValueOnce(toAsyncStream(step2Chunks));

      const mockAnthropic = {
        messages: { create: createSpy },
      } as unknown as Anthropic;

      const agent = new NativeClaudeAgent(mockAnthropic);
      const dataEvents: string[] = [];
      agent.on('data', (d: string) => dataEvents.push(d));

      await agent.start(tempDir);
      await agent.send('read and list');

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(dataEvents.some((d) => d.includes('Running tool: read_file'))).toBe(true);
      expect(dataEvents.some((d) => d.includes('Running tool: list_directory'))).toBe(true);
      expect(dataEvents.some((d) => d.includes('Finished successfully.'))).toBe(true);

      // Verify the user turn contained two tool_result blocks
      const secondCallMessages = createSpy.mock.calls[1][0].messages;
      const userToolResultMsg = secondCallMessages.find((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'));
      expect(userToolResultMsg).toBeDefined();
      expect(userToolResultMsg.content).toHaveLength(2);
      expect(userToolResultMsg.content[0].type).toBe('tool_result');
      expect(userToolResultMsg.content[1].type).toBe('tool_result');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips malformed JSON tool input and safely emits fallback assistant turn', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-malformed-test-'));

    try {
      const step1Chunks = [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_bad', name: 'read_file' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"unclosed_json' } },
        { type: 'content_block_stop', index: 0 },
      ];

      const createSpy = vi.fn()
        .mockResolvedValueOnce(toAsyncStream(step1Chunks));

      const mockAnthropic = {
        messages: { create: createSpy },
      } as unknown as Anthropic;

      const agent = new NativeClaudeAgent(mockAnthropic);
      await agent.start(tempDir);
      await agent.send('malformed test');

      // The turn finishes without calling step 2 because no valid tool calls were parsed
      expect(createSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('NativeGoogleAgent streaming and tool calls', () => {
  it('streams content and passes call id back in functionResponse', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-native-test-'));
    await fs.writeFile(path.join(tempDir, 'gemini.txt'), 'gemini test', 'utf-8');

    try {
      const step1Chunks = [
        { text: 'Analyzing...' },
        {
          functionCalls: [
            { id: 'fcall_001', name: 'read_file', args: { filePath: 'gemini.txt' } },
          ],
        },
      ];

      const step2Chunks = [
        { text: 'File read complete.' },
      ];

      const generateContentStreamSpy = vi.fn()
        .mockResolvedValueOnce(toAsyncStream(step1Chunks))
        .mockResolvedValueOnce(toAsyncStream(step2Chunks));

      const mockGoogle = {
        models: { generateContentStream: generateContentStreamSpy },
      } as unknown as GoogleGenAI;

      const agent = new NativeGoogleAgent(mockGoogle);
      const dataEvents: string[] = [];
      agent.on('data', (d: string) => dataEvents.push(d));

      await agent.start(tempDir);
      await agent.send('read gemini.txt');

      expect(generateContentStreamSpy).toHaveBeenCalledTimes(2);
      expect(dataEvents.some((d) => d.includes('Running tool: read_file'))).toBe(true);
      expect(dataEvents.some((d) => d.includes('File read complete.'))).toBe(true);

      // Verify that step 2 receives functionResponse with matching id
      const secondCallContents = generateContentStreamSpy.mock.calls[1][0].contents;
      const userFuncContent = secondCallContents.find((c: any) => c.role === 'user' && c.parts?.some((p: any) => p.functionResponse));
      expect(userFuncContent).toBeDefined();
      expect(userFuncContent.parts[0].functionResponse).toEqual({
        name: 'read_file',
        response: { result: 'gemini test' },
        id: 'fcall_001',
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
