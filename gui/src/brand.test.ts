import { describe, expect, it } from 'vitest';
import {
  BRAND_CONFIG,
  GITHUB_REPO,
  LEGACY_GITHUB_REPO,
  GITHUB_REPO_URL,
  LEGACY_GITHUB_REPO_URL,
  GITHUB_RELEASE_URL,
  LEGACY_GITHUB_RELEASE_URL,
  GITHUB_RELEASE_PAGE_URL,
  LEGACY_GITHUB_RELEASE_PAGE_URL,
  GITHUB_RELEASE_API_URL,
  LEGACY_GITHUB_RELEASE_API_URL,
} from './brand.js';

describe('GUI brand configuration', () => {
  it('defines GitHub repository and release URLs pointing to Context-Space with legacy fallbacks', () => {
    expect(BRAND_CONFIG.github.owner).toBe('antan87');
    expect(BRAND_CONFIG.github.repo).toBe('Context-Space');
    expect(BRAND_CONFIG.github.legacyRepo).toBe('NexusFlow');
    expect(BRAND_CONFIG.github.repoUrl).toBe('https://github.com/antan87/Context-Space');
    expect(BRAND_CONFIG.github.legacyRepoUrl).toBe('https://github.com/antan87/NexusFlow');
    expect(BRAND_CONFIG.github.releaseUrl).toBe('https://github.com/antan87/Context-Space/releases/latest');
    expect(BRAND_CONFIG.github.legacyReleaseUrl).toBe('https://github.com/antan87/NexusFlow/releases/latest');
    expect(BRAND_CONFIG.github.releasePageUrl).toBe('https://github.com/antan87/Context-Space/releases/latest');
    expect(BRAND_CONFIG.github.legacyReleasePageUrl).toBe('https://github.com/antan87/NexusFlow/releases/latest');
    expect(BRAND_CONFIG.github.releaseApiUrl).toBe('https://api.github.com/repos/antan87/Context-Space/releases/latest');
    expect(BRAND_CONFIG.github.legacyReleaseApiUrl).toBe('https://api.github.com/repos/antan87/NexusFlow/releases/latest');
  });

  it('exports GitHub constants correctly', () => {
    expect(GITHUB_REPO).toBe('Context-Space');
    expect(LEGACY_GITHUB_REPO).toBe('NexusFlow');
    expect(GITHUB_REPO_URL).toBe('https://github.com/antan87/Context-Space');
    expect(LEGACY_GITHUB_REPO_URL).toBe('https://github.com/antan87/NexusFlow');
    expect(GITHUB_RELEASE_URL).toBe('https://github.com/antan87/Context-Space/releases/latest');
    expect(LEGACY_GITHUB_RELEASE_URL).toBe('https://github.com/antan87/NexusFlow/releases/latest');
    expect(GITHUB_RELEASE_PAGE_URL).toBe('https://github.com/antan87/Context-Space/releases/latest');
    expect(LEGACY_GITHUB_RELEASE_PAGE_URL).toBe('https://github.com/antan87/NexusFlow/releases/latest');
    expect(GITHUB_RELEASE_API_URL).toBe('https://api.github.com/repos/antan87/Context-Space/releases/latest');
    expect(LEGACY_GITHUB_RELEASE_API_URL).toBe('https://api.github.com/repos/antan87/NexusFlow/releases/latest');
  });
});
