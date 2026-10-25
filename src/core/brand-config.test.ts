import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  BRAND_CONFIG,
  resolveFirstEnv,
  resolveBrandHomeDir,
  resolveWorkspaceFilePath,
  resolveWorkspaceFilePathSync,
  getPm2ProcessPrefix,
  getDesktopReadyTokens,
  getDesktopReadyPortRegex,
  getFreshnessSentinelRegex,
  createFreshnessMarker,
  resolveWorkspaceChatLedger,
  resolveWorkspaceChatLedgerSync,
  readWorkspaceChatMessages,
} from './brand-config.js';

describe('Brand Configuration System', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defines canonical brand identities and CLI aliases', () => {
    expect(BRAND_CONFIG.identity.name).toBe('ContextSpace');
    expect(BRAND_CONFIG.identity.cliName).toBe('ctxspace');
    expect(BRAND_CONFIG.identity.cliAliases).toContain('contextspace');
    expect(BRAND_CONFIG.identity.cliAliases).toContain('cs');
    expect(BRAND_CONFIG.identity.cliAliases).toContain('nexusflow');
  });

  it('defines file pairs with primary and legacy conventions', () => {
    expect(BRAND_CONFIG.files.manifest.primary).toBe('contextspace.json');
    expect(BRAND_CONFIG.files.manifest.legacy).toBe('nexusflow.json');
    expect(BRAND_CONFIG.files.lock.primary).toBe('contextspace.lock');
    expect(BRAND_CONFIG.files.lock.legacy).toBe('nexusflow.lock');
    expect(BRAND_CONFIG.files.knowledge.primary).toBe('contextspace-knowledge.md');
    expect(BRAND_CONFIG.files.knowledge.legacy).toBe('nexusflow-knowledge.md');
  });

  it('defines GitHub repository and release URLs pointing to Context-Space with legacy fallbacks', () => {
    expect(BRAND_CONFIG.github.owner).toBe('antan87');
    expect(BRAND_CONFIG.github.repo).toBe('Context-Space');
    expect(BRAND_CONFIG.github.legacyRepo).toBe('NexusFlow');
    expect(BRAND_CONFIG.github.repoUrl).toBe('https://github.com/antan87/Context-Space');
    expect(BRAND_CONFIG.github.legacyRepoUrl).toBe('https://github.com/antan87/NexusFlow');
    expect(BRAND_CONFIG.github.releaseApiUrl).toBe('https://api.github.com/repos/antan87/Context-Space/releases/latest');
    expect(BRAND_CONFIG.github.legacyReleaseApiUrl).toBe('https://api.github.com/repos/antan87/NexusFlow/releases/latest');
    expect(BRAND_CONFIG.github.releasePageUrl).toBe('https://github.com/antan87/Context-Space/releases/latest');
    expect(BRAND_CONFIG.github.legacyReleasePageUrl).toBe('https://github.com/antan87/NexusFlow/releases/latest');
  });

  it('defines the canonical Tropical Sunset Hex-CW theme palette', () => {
    expect(BRAND_CONFIG.theme.primary).toBe('#F97316');
    expect(BRAND_CONFIG.theme.sunset.gold).toBe('#FDE047');
    expect(BRAND_CONFIG.theme.sunset.coral).toBe('#FB923C');
    expect(BRAND_CONFIG.theme.sunset.hibiscus).toBe('#F43F5E');
    expect(BRAND_CONFIG.theme.sunset.indigo).toBe('#6366F1');
    expect(BRAND_CONFIG.theme.dark.background).toBe('#0A0812');
  });

  it('defines extended atmospheric color palettes (Aurora, Forest, Nebula, Glacier)', () => {
    expect(BRAND_CONFIG.theme.aurora).toEqual({
      first: '#5EEAD4',
      middle: '#22D3EE',
      last: '#818CF8',
      depth: '#6366F1',
    });
    expect(BRAND_CONFIG.theme.forest).toEqual({
      first: '#86EFAC',
      middle: '#22C55E',
      last: '#14B8A6',
      depth: '#0F766E',
    });
    expect(BRAND_CONFIG.theme.nebula).toEqual({
      first: '#F472B6',
      middle: '#C084FC',
      last: '#818CF8',
      depth: '#4F46E5',
    });
    expect(BRAND_CONFIG.theme.glacier).toEqual({
      first: '#93C5FD',
      middle: '#38BDF8',
      last: '#60A5FA',
      depth: '#2563EB',
    });
  });

  it('resolves first defined environment variable in priority order', () => {
    delete process.env.CONTEXTSPACE_HOME;
    delete process.env.NEXUSFLOW_HOME;

    expect(resolveFirstEnv(BRAND_CONFIG.env.home)).toBeUndefined();

    process.env.NEXUSFLOW_HOME = '/legacy/home';
    expect(resolveFirstEnv(BRAND_CONFIG.env.home)).toBe('/legacy/home');

    process.env.CONTEXTSPACE_HOME = '/primary/home';
    expect(resolveFirstEnv(BRAND_CONFIG.env.home)).toBe('/primary/home');
  });

  it('resolves brand home directory with env priority and fallback', () => {
    process.env.CONTEXTSPACE_HOME = '/custom/cs/home';
    expect(resolveBrandHomeDir()).toBe(path.resolve('/custom/cs/home'));
  });

  it('computes workspace-scoped PM2 prefix', () => {
    const ws = '/path/to/my-feature';
    const prefix = getPm2ProcessPrefix(ws);
    expect(prefix).toMatch(/^ctxspace-my-feature-[0-9a-f]{8}-$/);
  });

  it('generates desktop readiness handshake tokens and parser regex', () => {
    const tokens = getDesktopReadyTokens(4567);
    expect(tokens).toContain('CONTEXTSPACE_READY_PORT=4567');
    expect(tokens).toContain('NEXUSFLOW_READY_PORT=4567');

    const regex = getDesktopReadyPortRegex();
    expect('CONTEXTSPACE_READY_PORT=5000'.match(regex)?.[1]).toBe('5000');
    expect('NEXUSFLOW_READY_PORT=6000'.match(regex)?.[1]).toBe('6000');
  });

  it('creates and matches freshness sentinel markers', () => {
    const marker = createFreshnessMarker('abc1234');
    expect(marker).toContain('<!-- CONTEXTSPACE:FRESHNESS:START -->');
    expect(marker).toContain('<!-- CONTEXTSPACE:FRESHNESS:END -->');
    expect(marker).toContain('ContextSpace@abc1234');

    const regex = getFreshnessSentinelRegex();
    expect(regex.test(marker)).toBe(true);

    const legacyMarker = `<!-- NEXUSFLOW:FRESHNESS:START -->\n> **NexusFlow snapshot:** NexusFlow@abc1234\n<!-- NEXUSFLOW:FRESHNESS:END -->`;
    expect(regex.test(legacyMarker)).toBe(true);
  });

  it('resolves workspace files asynchronously with fallback', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-test-'));
    try {
      // Non-existent file defaults to primary path
      const missing = await resolveWorkspaceFilePath(tempDir, 'manifest');
      expect(missing.path).toBe(path.join(tempDir, 'contextspace.json'));
      expect(missing.exists).toBe(false);

      // Legacy file exists
      await fs.writeFile(path.join(tempDir, 'nexusflow.json'), '{}');
      const legacy = await resolveWorkspaceFilePath(tempDir, 'manifest');
      expect(legacy.path).toBe(path.join(tempDir, 'nexusflow.json'));
      expect(legacy.isLegacy).toBe(true);
      expect(legacy.exists).toBe(true);

      // Primary file exists (takes precedence)
      await fs.writeFile(path.join(tempDir, 'contextspace.json'), '{}');
      const primary = await resolveWorkspaceFilePath(tempDir, 'manifest');
      expect(primary.path).toBe(path.join(tempDir, 'contextspace.json'));
      expect(primary.isLegacy).toBe(false);
      expect(primary.exists).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves workspace files synchronously with fallback', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-test-sync-'));
    try {
      await fs.writeFile(path.join(tempDir, 'nexusflow.lock'), '{}');
      const legacy = resolveWorkspaceFilePathSync(tempDir, 'lock');
      expect(legacy.path).toBe(path.join(tempDir, 'nexusflow.lock'));
      expect(legacy.isLegacy).toBe(true);

      await fs.writeFile(path.join(tempDir, 'contextspace.lock'), '{}');
      const primary = resolveWorkspaceFilePathSync(tempDir, 'lock');
      expect(primary.path).toBe(path.join(tempDir, 'contextspace.lock'));
      expect(primary.isLegacy).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves machine files into .contextspace/ with root fallback', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-test-machine-'));
    try {
      // 1. None exist -> canonical primary in .contextspace/
      const missingState = await resolveWorkspaceFilePath(tempDir, 'state');
      expect(missingState.path).toBe(path.join(tempDir, '.contextspace', 'state.json'));
      expect(missingState.exists).toBe(false);

      // 2. Fallback root file exists (.contextspace-state.json)
      await fs.writeFile(path.join(tempDir, '.contextspace-state.json'), '{"v":"cs"}');
      await fs.writeFile(path.join(tempDir, '.nexusflow-state.json'), '{"v":"nf"}');
      const fallbackState = await resolveWorkspaceFilePath(tempDir, 'state');
      // .contextspace-state.json takes precedence over .nexusflow-state.json
      expect(fallbackState.path).toBe(path.join(tempDir, '.contextspace-state.json'));
      expect(fallbackState.isLegacy).toBe(true);
      expect(fallbackState.exists).toBe(true);

      // 3. Primary exists (.contextspace/state.json takes precedence)
      await fs.mkdir(path.join(tempDir, '.contextspace'), { recursive: true });
      await fs.writeFile(path.join(tempDir, '.contextspace', 'state.json'), '{}');
      const primaryState = await resolveWorkspaceFilePath(tempDir, 'state');
      expect(primaryState.path).toBe(path.join(tempDir, '.contextspace', 'state.json'));
      expect(primaryState.isLegacy).toBe(false);
      expect(primaryState.exists).toBe(true);

      // 4. Machine lock and state files resolve to .contextspace/
      const lockRes = resolveWorkspaceFilePathSync(tempDir, 'stateLock');
      expect(lockRes.path).toBe(path.join(tempDir, '.contextspace', 'state.lock'));
      expect(lockRes.isLegacy).toBe(false);

      const mutRes = resolveWorkspaceFilePathSync(tempDir, 'mutationLock');
      expect(mutRes.path).toBe(path.join(tempDir, '.contextspace', 'mutation.lock'));
      expect(mutRes.isLegacy).toBe(false);

      const runRes = resolveWorkspaceFilePathSync(tempDir, 'runningState');
      expect(runRes.path).toBe(path.join(tempDir, '.contextspace', 'running.json'));
      expect(runRes.isLegacy).toBe(false);

      const cacheRes = resolveWorkspaceFilePathSync(tempDir, 'analysisCache');
      expect(cacheRes.path).toBe(path.join(tempDir, '.contextspace', 'analysis-cache.json'));
      expect(cacheRes.isLegacy).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('resolveWorkspaceChatLedger & readWorkspaceChatMessages', () => {
    it('resolves native workspace chat ledger (.contextspace)', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-chat-native-'));
      try {
        await fs.mkdir(path.join(tempDir, '.contextspace'), { recursive: true });

        // Without existing file
        const emptyRes = resolveWorkspaceChatLedgerSync(tempDir);
        expect(emptyRes.chatPath).toBe(path.join(tempDir, '.contextspace', 'chat.jsonl'));
        expect(emptyRes.isLegacy).toBe(false);
        expect(emptyRes.exists).toBe(false);

        // With existing file
        await fs.writeFile(path.join(tempDir, '.contextspace', 'chat.jsonl'), '{"msg": "hi"}\n');
        const asyncRes = await resolveWorkspaceChatLedger(tempDir);
        expect(asyncRes.chatPath).toBe(path.join(tempDir, '.contextspace', 'chat.jsonl'));
        expect(asyncRes.isLegacy).toBe(false);
        expect(asyncRes.exists).toBe(true);
        expect(asyncRes.readPaths).toEqual([path.join(tempDir, '.contextspace', 'chat.jsonl')]);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('resolves legacy workspace chat ledger (.nexusflow)', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-chat-legacy-'));
      try {
        await fs.mkdir(path.join(tempDir, '.nexusflow'), { recursive: true });

        // Without existing file
        const emptyRes = resolveWorkspaceChatLedgerSync(tempDir);
        expect(emptyRes.chatPath).toBe(path.join(tempDir, '.nexusflow', 'chat.jsonl'));
        expect(emptyRes.isLegacy).toBe(true);
        expect(emptyRes.exists).toBe(false);

        // With existing file
        await fs.writeFile(path.join(tempDir, '.nexusflow', 'chat.jsonl'), '{"msg": "hi legacy"}\n');
        const asyncRes = await resolveWorkspaceChatLedger(tempDir);
        expect(asyncRes.chatPath).toBe(path.join(tempDir, '.nexusflow', 'chat.jsonl'));
        expect(asyncRes.isLegacy).toBe(true);
        expect(asyncRes.exists).toBe(true);
        expect(asyncRes.readPaths).toEqual([path.join(tempDir, '.nexusflow', 'chat.jsonl')]);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('preserves existing legacy ledger in mixed-directory workspaces', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-chat-mixed-'));
      try {
        await fs.mkdir(path.join(tempDir, '.nexusflow'), { recursive: true });
        await fs.mkdir(path.join(tempDir, '.contextspace'), { recursive: true });

        // When only legacy chat file exists with history
        await fs.writeFile(path.join(tempDir, '.nexusflow', 'chat.jsonl'), '{"id": "1", "message": "hist"}\n');

        const resolved = resolveWorkspaceChatLedgerSync(tempDir);
        expect(resolved.chatPath).toBe(path.join(tempDir, '.nexusflow', 'chat.jsonl'));
        expect(resolved.isLegacy).toBe(true);
        expect(resolved.exists).toBe(true);
        expect(resolved.readPaths).toEqual([path.join(tempDir, '.nexusflow', 'chat.jsonl')]);

        const asyncResolved = await resolveWorkspaceChatLedger(tempDir);
        expect(asyncResolved.chatPath).toBe(path.join(tempDir, '.nexusflow', 'chat.jsonl'));
        expect(asyncResolved.isLegacy).toBe(true);
        expect(asyncResolved.exists).toBe(true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('reads and aggregates messages across both ledgers when both exist in mixed workspaces', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-chat-both-'));
      try {
        await fs.mkdir(path.join(tempDir, '.nexusflow'), { recursive: true });
        await fs.mkdir(path.join(tempDir, '.contextspace'), { recursive: true });

        const legacyMsg = { id: 'msg-1', timestamp: '2026-09-01T12:00:00.000Z', message: 'Legacy message' };
        const primaryMsg = { id: 'msg-2', timestamp: '2026-09-02T12:00:00.000Z', message: 'Primary message' };

        await fs.writeFile(path.join(tempDir, '.nexusflow', 'chat.jsonl'), JSON.stringify(legacyMsg) + '\n');
        await fs.writeFile(path.join(tempDir, '.contextspace', 'chat.jsonl'), JSON.stringify(primaryMsg) + '\n');

        const resolved = resolveWorkspaceChatLedgerSync(tempDir);
        expect(resolved.chatPath).toBe(path.join(tempDir, '.contextspace', 'chat.jsonl'));
        expect(resolved.readPaths).toHaveLength(2);

        const { messages, ledgerInfo } = await readWorkspaceChatMessages(tempDir);
        expect(ledgerInfo.readPaths).toHaveLength(2);
        expect(messages).toHaveLength(2);
        expect(messages[0].id).toBe('msg-1');
        expect(messages[1].id).toBe('msg-2');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
