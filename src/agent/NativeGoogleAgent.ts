import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionCall,
  type GenerateContentConfig,
  type Part,
} from '@google/genai';
import { NativeAgentBase } from './NativeAgentBase.js';
import {
  NATIVE_TOOLS,
  NATIVE_STEP_LIMIT,
  STEP_LIMIT_NOTICE,
  buildSystemPrompt,
  executeNativeTool,
} from './nativeTools.js';
import { toErrorMessage } from '../utils/errors.js';

export class NativeGoogleAgent extends NativeAgentBase {
  protected readonly label = 'NativeGoogleAgent';
  private ai: GoogleGenAI | null = null;
  private history: Content[] = [];
  private modelName: string;

  constructor(client?: GoogleGenAI) {
    super();
    this.ai = client ?? null;
    // Allow users to override the model via env var, fallback to gemini-2.0-flash
    this.modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  }

  private client(): GoogleGenAI {
    return (this.ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' }));
  }

  protected configError(): string | null {
    if (this.ai) return null;
    return process.env.GEMINI_API_KEY ? null : 'Google API key is not configured (set GEMINI_API_KEY).';
  }

  protected resetHistory() {
    this.history = [];
  }

  protected async runLoop(userInput: string, signal: AbortSignal) {
    this.history.push({ role: 'user', parts: [{ text: userInput }] });

    const config: GenerateContentConfig = {
      systemInstruction: buildSystemPrompt(this.cwd),
      // Cancels an in-flight request when stop() aborts the controller.
      abortSignal: signal,
      tools: [{
        functionDeclarations: NATIVE_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: {
            type: Type.OBJECT,
            properties: { [t.argName]: { type: Type.STRING, description: t.argDescription } },
            required: [t.argName],
          },
        })),
      }],
    };

    let completed = false;

    for (let step = 0; step < NATIVE_STEP_LIMIT; step++) {
      if (signal.aborted) break;

      const responseStream = await this.client().models.generateContentStream({
        model: this.modelName,
        contents: this.history,
        config,
      });

      let fullText = '';
      const functionCalls: FunctionCall[] = [];

      for await (const chunk of responseStream) {
        if (chunk.text) {
          fullText += chunk.text;
          this.emit('data', chunk.text);
        }
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          functionCalls.push(...chunk.functionCalls);
        }
      }

      const modelParts: Part[] = [];
      if (fullText) modelParts.push({ text: fullText });
      if (functionCalls.length > 0) modelParts.push(...functionCalls.map((fc) => ({ functionCall: fc })));
      this.history.push({ role: 'model', parts: modelParts });

      if (functionCalls.length === 0) {
        completed = true;
        break;
      }

      const functionResponses: Part[] = [];
      for (const call of functionCalls) {
        this.emit('data', `\n\n*Running tool: ${call.name}*\n`);
        let result: string;
        try {
          result = await executeNativeTool(this.cwd, call.name || '', call.args || {});
        } catch (e) {
          result = `Error: ${toErrorMessage(e)}`;
        }
        functionResponses.push({
          functionResponse: {
            name: call.name || '',
            response: { result },
            ...(call.id ? { id: call.id } : {}),
          },
        });
      }

      this.history.push({ role: 'user', parts: functionResponses });
    }

    if (!completed && !signal.aborted) {
      this.emit('data', STEP_LIMIT_NOTICE);
    }
  }
}
