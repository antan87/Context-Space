import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AISession, ChatMessage, NormalizedUsage } from '../types.js';

type PiHeader = { type: 'session'; id: string; cwd: string; timestamp?: string };

function sessionRoot(): string {
  return path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
}

async function header(file: string): Promise<PiHeader | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0];
    const record = JSON.parse(firstLine);
    return record.type === 'session' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.id)
      && typeof record.cwd === 'string' && path.isAbsolute(record.cwd) ? record as PiHeader : null;
  } catch { return null; }
  finally { await handle?.close(); }
}

async function files(roots?: string[]): Promise<string[]> {
  const root = sessionRoot();
  // Pi groups files by encoded cwd. Narrow workspace scans to matching folders;
  // the recorded header cwd remains the authority because names can collide.
  const prefixes = roots?.map(cwd => `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}`.toLowerCase());
  let folders: Dirent<string>[] | undefined;
  try { folders = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const groups = await Promise.all((folders ?? []).filter(folder => folder.isDirectory()
    && (!prefixes || prefixes.some(prefix => folder.name.toLowerCase() === `${prefix}--` || folder.name.toLowerCase().startsWith(`${prefix}-`)))).map(async folder => {
    const dir = path.join(root, folder.name);
    let entries: Dirent<string>[] | undefined;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    return (entries ?? []).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => path.join(dir, entry.name));
  }));
  return groups.flat();
}

async function matchingFiles(predicate: (record: PiHeader) => boolean, roots?: string[]): Promise<{ file: string; meta: PiHeader }[]> {
  const candidates = await files(roots);
  const matches = await Promise.all(candidates.map(async file => {
    const meta = await header(file);
    return meta && predicate(meta) ? { file, meta } : null;
  }));
  return matches.filter((match): match is { file: string; meta: PiHeader } => !!match);
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function textOf(message: unknown): string {
  if (!isRecord(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string').map(part => (part as { text: string }).text).join(' ');
  return '';
}

function usageOf(message: unknown): NormalizedUsage | undefined {
  if (!isRecord(message)) return undefined;
  const raw = message.usage;
  if (!isRecord(raw)) return undefined;
  const input = Number(raw.input) || 0, output = Number(raw.output) || 0;
  const cacheRead = Number(raw.cacheRead) || 0, cacheWrite = Number(raw.cacheWrite) || 0;
  const rawCost = isRecord(raw.cost) ? raw.cost.total : undefined;
  const cost = Number(rawCost);
  if (!input && !output && !cacheRead && !cacheWrite && !Number.isFinite(cost)) return undefined;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cacheRead + cacheWrite,
    cacheReadInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite, totalTokens: input + output,
    ...(Number.isFinite(cost) ? { costUsdEstimate: cost } : {}) };
}

function parse(fileContent: string): { title: string; messages: ChatMessage[]; updatedAt: string; usage?: NormalizedUsage } {
  let title = '', updatedAt = '';
  let usage: NormalizedUsage | undefined;
  const messages: ChatMessage[] = [];
  for (const line of fileContent.split('\n')) {
    if (!line) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!isRecord(record)) continue;
    if (typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp)) && record.timestamp > updatedAt) updatedAt = record.timestamp;
    if (record.type === 'session_info' && typeof record.name === 'string' && record.name.trim()) title = record.name;
    if (record.type !== 'message') continue;
    const msg = isRecord(record.message) ? record.message : undefined;
    const role = msg?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = textOf(msg).trim();
    if (!content) continue;
    if (role === 'user' && !title) title = content;
    const turnUsage = role === 'assistant' ? usageOf(msg) : undefined;
    if (turnUsage) {
      usage = { inputTokens: (usage?.inputTokens ?? 0) + turnUsage.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + turnUsage.outputTokens,
        cachedInputTokens: (usage?.cachedInputTokens ?? 0) + (turnUsage.cachedInputTokens ?? 0),
        cacheReadInputTokens: (usage?.cacheReadInputTokens ?? 0) + (turnUsage.cacheReadInputTokens ?? 0),
        cacheWriteInputTokens: (usage?.cacheWriteInputTokens ?? 0) + (turnUsage.cacheWriteInputTokens ?? 0),
        totalTokens: (usage?.totalTokens ?? 0) + (turnUsage.totalTokens ?? 0),
        ...(turnUsage.costUsdEstimate !== undefined || usage?.costUsdEstimate !== undefined
          ? { costUsdEstimate: (usage?.costUsdEstimate ?? 0) + (turnUsage.costUsdEstimate ?? 0) } : {}) };
    }
    const rawTs = (isRecord(record.message) ? record.message.timestamp : undefined) ?? record.timestamp;
    let timestamp: string | undefined;
    if (typeof rawTs === 'string' && rawTs.trim()) {
      timestamp = rawTs;
    } else if (typeof rawTs === 'number' && Number.isFinite(rawTs)) {
      try { timestamp = new Date(rawTs).toISOString(); } catch {}
    }
    messages.push({ role, content, ...(timestamp ? { timestamp } : {}), ...(turnUsage ? { usage: turnUsage } : {}) });
  }
  return { title, messages, updatedAt, usage };
}

export async function findPiSessions(roots: string[], isPathMatch: (cwd: string) => boolean, resolveTargetCwd: (cwd: string) => string): Promise<AISession[]> {
  const matches = await matchingFiles(meta => isPathMatch(meta.cwd), roots);
  const sessions = await Promise.all(matches.map(async ({ file, meta }): Promise<AISession | null> => {
    try {
      const parsed = parse(await fs.readFile(file, 'utf8'));
      if (!parsed.messages.length) return null;
      const title = (parsed.title || 'Pi Session').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      return { id: meta.id, assistant: 'pi', title: title.length > 80 ? `${title.slice(0, 80)}...` : title,
        createdAt: meta.timestamp || '', updatedAt: parsed.updatedAt || meta.timestamp || '', messageCount: parsed.messages.length,
        workspacePath: resolveTargetCwd(meta.cwd), recordedCwd: meta.cwd, threadKind: 'unknown',
        ...(parsed.usage ? { usage: parsed.usage } : {}) };
    } catch { return null; }
  }));
  return sessions.filter((session): session is AISession => !!session);
}

export async function hasPiSessions(roots: string[], isPathMatch: (cwd: string) => boolean): Promise<boolean> {
  return (await matchingFiles(meta => isPathMatch(meta.cwd), roots)).length > 0;
}

export async function getPiTranscript(sessionId: string): Promise<ChatMessage[]> {
  const match = (await matchingFiles(meta => meta.id === sessionId))[0];
  if (!match) throw new Error(`Pi session ${sessionId} not found`);
  return parse(await fs.readFile(match.file, 'utf8')).messages;
}
