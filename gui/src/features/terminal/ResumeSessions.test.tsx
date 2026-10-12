import { describe, expect, it } from 'vitest';
import { matchesResumeSession } from './ResumeSessions.js';
import type { AISession } from '../../types.js';

describe('ResumeSessions - matchesResumeSession', () => {
  const agySession: AISession = {
    id: '0192e420-72b1-7a2e-9843-9884a44b8ee3',
    assistant: 'antigravity',
    title: 'Fix auth login bug',
  };

  const codexSession: AISession = {
    id: 'codex-uuid-1234-5678',
    assistant: 'codex',
    title: undefined,
  };

  const claudeSession: AISession = {
    id: 'claude-uuid-8765-4321',
    assistant: 'claude',
    title: 'Refactor search components',
  };

  it('matches by title keyword case-insensitively', () => {
    expect(matchesResumeSession(agySession, 'AUTH')).toBe(true);
    expect(matchesResumeSession(agySession, 'login')).toBe(true);
    expect(matchesResumeSession(agySession, 'search')).toBe(false);
  });

  it('matches by session id', () => {
    expect(matchesResumeSession(agySession, '72b1-7a2e')).toBe(true);
    expect(matchesResumeSession(claudeSession, '8765-4321')).toBe(true);
  });

  it('matches by assistant cli command', () => {
    expect(matchesResumeSession(agySession, 'agy')).toBe(true);
    expect(matchesResumeSession(claudeSession, 'claude')).toBe(true);
    expect(matchesResumeSession(codexSession, 'codex')).toBe(true);
  });

  it('matches by vendor name', () => {
    expect(matchesResumeSession(agySession, 'google')).toBe(true);
    expect(matchesResumeSession(codexSession, 'openai')).toBe(true);
    expect(matchesResumeSession(claudeSession, 'anthropic')).toBe(true);
  });

  it('handles undefined title safely', () => {
    expect(matchesResumeSession(codexSession, 'openai')).toBe(true);
    expect(matchesResumeSession(codexSession, 'nonexistent')).toBe(false);
  });

  it('returns true for empty or whitespace query', () => {
    expect(matchesResumeSession(agySession, '')).toBe(true);
    expect(matchesResumeSession(agySession, '   ')).toBe(true);
  });
});
