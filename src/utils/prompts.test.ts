import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SkillItem } from '../types.js';

const mockCheckbox = vi.fn();

vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inquirer/prompts')>();
  return {
    ...actual,
    checkbox: (...args: any[]) => mockCheckbox(...args),
  };
});

// Import after mocking
import { promptSelectSkills } from './prompts.js';
import { Separator } from '@inquirer/prompts';

describe('promptSelectSkills', () => {
  beforeEach(() => {
    mockCheckbox.mockReset();
  });

  it('returns empty array directly when given no skills', async () => {
    const result = await promptSelectSkills([]);
    expect(result).toEqual([]);
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('partitions skills into ContextSpace catalog and global harness skills with Separators', async () => {
    let capturedChoices: any[] = [];
    mockCheckbox.mockImplementation(async (config: any) => {
      capturedChoices = config.choices;
      return ['catalog-1', 'harness-1'];
    });

    const mockSkills: SkillItem[] = [
      {
        id: 'catalog-1',
        name: 'Catalog Skill 1',
        title: 'Catalog Skill 1 Title',
        category: 'workflow',
        description: 'ContextSpace catalog skill description',
        content: '',
        custom: false,
      },
      {
        id: 'harness-1',
        name: 'Harness Skill 1',
        title: 'Harness Skill 1 Title',
        category: 'testing',
        description: 'Harness skill description',
        content: '',
        custom: false,
        source: {
          harness: 'claude',
          label: 'Claude Code',
          root: '/home/.claude',
        },
      },
    ];

    const result = await promptSelectSkills(mockSkills);
    expect(result).toEqual(['catalog-1', 'harness-1']);
    expect(mockCheckbox).toHaveBeenCalledTimes(1);

    // Verify Separators and choices
    expect(capturedChoices).toHaveLength(4);
    expect(capturedChoices[0]).toBeInstanceOf(Separator);
    expect(capturedChoices[0].separator).toContain('ContextSpace Catalog Skills');
    expect(capturedChoices[1]).toMatchObject({
      value: 'catalog-1',
      name: expect.stringContaining('Catalog Skill 1 Title'),
    });

    expect(capturedChoices[2]).toBeInstanceOf(Separator);
    expect(capturedChoices[2].separator).toContain('Global Harness Skills');
    expect(capturedChoices[3]).toMatchObject({
      value: 'harness-1',
      name: expect.stringContaining('Claude Code'),
    });
  });

  it('handles skills with missing or empty description without throwing', async () => {
    let capturedChoices: any[] = [];
    mockCheckbox.mockImplementation(async (config: any) => {
      capturedChoices = config.choices;
      return [];
    });

    const skillsWithNoDesc: SkillItem[] = [
      {
        id: 'no-desc',
        name: 'no-desc',
        category: 'general',
        description: '',
        content: '',
        custom: false,
      },
    ];

    const result = await promptSelectSkills(skillsWithNoDesc);
    expect(result).toEqual([]);
    expect(capturedChoices).toHaveLength(2);
    expect(capturedChoices[1]).toMatchObject({
      value: 'no-desc',
      name: 'no-desc',
    });
  });
});
