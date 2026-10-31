import { describe, expect, it } from 'vitest';
import type { PlanFileView } from '../plan/planFile.js';
import { parseCommitNodeId } from './boardActions.js';
import type { BoardCard, BoardView } from './boardData.js';
import {
  forgeDisplayName,
  resolveCommitContext,
  safeForgeUrl,
} from './commitContext.js';

describe('parseCommitNodeId', () => {
  it('parses valid commit node IDs, normalizing uppercase SHA', () => {
    expect(parseCommitNodeId('commit:repo:a1b2c3d')).toEqual({ repo: 'repo', sha: 'a1b2c3d' });
    expect(parseCommitNodeId('commit:billing-api:a1b2c3d#2')).toEqual({ repo: 'billing-api', sha: 'a1b2c3d' });
    expect(parseCommitNodeId('commit:billing:A1B2C3D4E5F67890')).toEqual({
      repo: 'billing',
      sha: 'a1b2c3d4e5f67890',
    });
    expect(parseCommitNodeId('commit:my repo:a1b2c3d')).toEqual({ repo: 'my repo', sha: 'a1b2c3d' });
    expect(parseCommitNodeId('commit:my:custom:repo:a1b2c3d')).toEqual({
      repo: 'my:custom:repo',
      sha: 'a1b2c3d',
    });
  });

  it('rejects invalid repositories, formats, or SHAs', () => {
    // Slashes and backslashes
    expect(parseCommitNodeId('commit:foo/bar:a1b2c3d')).toBeNull();
    expect(parseCommitNodeId('commit:foo\\bar:a1b2c3d')).toBeNull();

    // Dot and double-dot
    expect(parseCommitNodeId('commit:.:a1b2c3d')).toBeNull();
    expect(parseCommitNodeId('commit:..:a1b2c3d')).toBeNull();

    // Repo length > 200
    expect(parseCommitNodeId(`commit:${'r'.repeat(201)}:a1b2c3d`)).toBeNull();
    expect(parseCommitNodeId(`commit:${'r'.repeat(200)}:a1b2c3d`)).toEqual({
      repo: 'r'.repeat(200),
      sha: 'a1b2c3d',
    });

    // Control characters
    expect(parseCommitNodeId('commit:repo\x00name:a1b2c3d')).toBeNull();
    expect(parseCommitNodeId('commit:repo\nname:a1b2c3d')).toBeNull();
    expect(parseCommitNodeId('commit:repo\x1fname:a1b2c3d')).toBeNull();
    expect(parseCommitNodeId('commit:repo\x7fname:a1b2c3d')).toBeNull();

    // Short or non-hex SHA
    expect(parseCommitNodeId('commit:repo:123456')).toBeNull();
    expect(parseCommitNodeId('commit:repo:nothex12345')).toBeNull();
    expect(parseCommitNodeId('not-a-commit-node-id')).toBeNull();
    expect(parseCommitNodeId('')).toBeNull();
  });
});

describe('forgeDisplayName', () => {
  it('returns proper display names for supported forges', () => {
    expect(forgeDisplayName('github')).toBe('GitHub');
    expect(forgeDisplayName('gitlab')).toBe('GitLab');
    expect(forgeDisplayName('azure')).toBe('Azure DevOps');
    expect(forgeDisplayName('bitbucket')).toBe('Bitbucket');
  });

  it('returns null for unknown or empty forge kinds', () => {
    expect(forgeDisplayName('unknown')).toBeNull();
    expect(forgeDisplayName(null)).toBeNull();
    expect(forgeDisplayName(undefined)).toBeNull();
  });
});

describe('safeForgeUrl', () => {
  it('accepts valid https and http URLs', () => {
    expect(safeForgeUrl('https://github.com/org/repo/commit/1234567890abcdef')).toBe(
      'https://github.com/org/repo/commit/1234567890abcdef',
    );
    expect(safeForgeUrl('http://gitlab.internal/group/proj/-/commit/abcdef1')).toBe(
      'http://gitlab.internal/group/proj/-/commit/abcdef1',
    );
  });

  it('rejects unsafe protocols or invalid URLs', () => {
    expect(safeForgeUrl('javascript:alert(1)')).toBeNull();
    expect(safeForgeUrl('javascript:void(0)')).toBeNull();
    expect(safeForgeUrl('data:text/html,evil')).toBeNull();
    expect(safeForgeUrl('ftp://files.example.com')).toBeNull();
    expect(safeForgeUrl('file:///etc/passwd')).toBeNull();
    expect(safeForgeUrl('not a url')).toBeNull();
    expect(safeForgeUrl('')).toBeNull();
    expect(safeForgeUrl(null)).toBeNull();
    expect(safeForgeUrl(undefined)).toBeNull();
  });
});

describe('resolveCommitContext', () => {
  const commitSha = 'a1b2c3d4e5f678901234567890abcdef12345678';
  const shortSha = 'a1b2c3d';

  const makeCard = (id: string, fields: Partial<BoardCard> = {}): BoardCard => ({
    id,
    kind: 'note',
    title: `Card ${id}`,
    pinned: false,
    archived: false,
    by: 'test',
    at: '2026-10-01T00:00:00Z',
    updatedBy: 'test',
    updatedAt: '2026-10-01T00:00:00Z',
    ...fields,
  });

  it('returns empty results for invalid or too-short SHAs', () => {
    expect(resolveCommitContext({ repo: 'api', sha: '123' })).toEqual({ steps: [], pictures: [] });
    expect(resolveCommitContext({ repo: 'api', sha: 'not-hex-string' })).toEqual({ steps: [], pictures: [] });
  });

  it('finds steps mentioning the commit SHA in step text', () => {
    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      steps: [
        { key: 'root-step', text: `Implement feature in ${shortSha}`, done: true },
        { key: 'unrelated-step', text: 'Another unrelated task', done: false },
      ],
      checkpoints: [
        {
          key: 'cp-1',
          title: 'Checkpoint 1',
          done: false,
          decisions: [],
          steps: [
            { key: 'cp-step-1', text: `Review commit ${commitSha}`, done: false },
          ],
        },
      ],
      decisions: [],
      waiting: [],
      changes: [],
    };

    const result = resolveCommitContext({ repo: 'api', sha: commitSha, plan });
    expect(result.steps).toEqual([
      {
        key: 'root-step',
        text: `Implement feature in ${shortSha}`,
        done: true,
        checkpointTitle: undefined,
        planPath: 'PLAN.md',
      },
      {
        key: 'cp-step-1',
        text: `Review commit ${commitSha}`,
        done: false,
        checkpointTitle: 'Checkpoint 1',
        planPath: 'PLAN.md',
      },
    ]);
  });

  it('matches board links between commit node and cards, matching step keys', () => {
    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      steps: [
        { key: 'step-via-link', text: 'Step linked through card', done: false },
      ],
      checkpoints: [],
      decisions: [],
      waiting: [],
      changes: [],
    };

    const board: BoardView = {
      cards: [
        makeCard('card-1', { step: 'step-via-link' }),
        makeCard('card-archived', { step: 'step-via-link', archived: true }),
      ],
      links: [
        {
          id: 'link-1',
          from: `commit:api:${shortSha}#1`,
          to: 'card-1',
          by: 'test',
          at: '2026-10-01T00:00:00Z',
        },
        {
          id: 'link-2',
          from: 'card-archived',
          to: `commit:api:${commitSha}`,
          by: 'test',
          at: '2026-10-01T00:00:00Z',
        },
      ],
      positions: {},
    };

    const result = resolveCommitContext({ repo: 'api', sha: commitSha, plan, board });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].key).toBe('step-via-link');
  });

  it('extracts pictures from linked file cards, step-assigned file cards, and backtick spans', () => {
    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      steps: [
        {
          key: 'step-1',
          text: `Check commit ${shortSha}. Pictures: \`board-pictures/header.png\`, \`header-menu.png\`, and unrelated \`readme.txt\``,
          done: true,
        },
      ],
      checkpoints: [],
      decisions: [],
      waiting: [],
      changes: [],
    };

    const board: BoardView = {
      cards: [
        // Linked directly to commit
        makeCard('pic-card-1', {
          kind: 'file',
          path: 'assets/diagram.png',
          title: 'System Diagram',
        }),
        // Linked via step-1
        makeCard('pic-card-2', {
          kind: 'file',
          path: 'board-pictures/header.png',
          title: 'Custom Header Title',
          step: 'step-1',
        }),
        // Non-image file card should be ignored
        makeCard('doc-card', {
          kind: 'file',
          path: 'docs/spec.md',
          title: 'Spec Doc',
          step: 'step-1',
        }),
        // Archived picture should be ignored
        makeCard('pic-card-archived', {
          kind: 'file',
          path: 'assets/archived.png',
          title: 'Old Diagram',
          archived: true,
          step: 'step-1',
        }),
      ],
      links: [
        {
          id: 'link-1',
          from: 'pic-card-1',
          to: `commit:api:${commitSha}`,
          by: 'test',
          at: '2026-10-01T00:00:00Z',
        },
      ],
      positions: {},
    };

    const result = resolveCommitContext({ repo: 'api', sha: commitSha, plan, board });
    expect(result.pictures).toEqual([
      { path: 'assets/diagram.png', title: 'System Diagram' },
      { path: 'board-pictures/header.png', title: 'Custom Header Title' },
      { path: 'board-pictures/header-menu.png', title: 'header-menu.png' },
    ]);
  });

  it('deduplicates steps and pictures', () => {
    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      steps: [
        { key: 'dup-step', text: `Commit ${shortSha} first mention`, done: false },
      ],
      checkpoints: [
        {
          key: 'cp-dup',
          title: 'Duplicate CP',
          done: false,
          decisions: [],
          steps: [
            { key: 'dup-step', text: `Commit ${shortSha} second mention`, done: false },
          ],
        },
      ],
      decisions: [],
      waiting: [],
      changes: [],
    };

    const board: BoardView = {
      cards: [
        makeCard('pic-1', { kind: 'file', path: 'img/a.png', title: 'Image A', step: 'dup-step' }),
      ],
      links: [
        {
          id: 'l-1',
          from: 'pic-1',
          to: `commit:api:${commitSha}`,
          by: 'test',
          at: '2026-10-01T00:00:00Z',
        },
      ],
      positions: {},
    };

    const result = resolveCommitContext({ repo: 'api', sha: commitSha, plan, board });
    expect(result.steps).toHaveLength(1);
    expect(result.pictures).toHaveLength(1);
    expect(result.pictures[0].path).toBe('img/a.png');
  });

  it('rejects unsafe plan.file and backticked globs/placeholders/schemes/commands without polluting lastDir', () => {
    const plan: PlanFileView = {
      file: '../PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      steps: [
        {
          key: 's1',
          text: `Commit ${shortSha}. Reject globs \`design/calm-*.png\`, placeholders \`board-pictures/<slice>.png\`, CLI \`npx shot out/a.png\`, schemes \`data:image/foo.png\`, and bare \`unprefixed.png\`. Then valid \`assets/real.png\` and relative \`sibling.png\`.`,
          done: false,
        },
      ],
      checkpoints: [],
      decisions: [],
      waiting: [],
      changes: [],
    };

    const result = resolveCommitContext({ repo: 'api', sha: commitSha, plan });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].planPath).toBeUndefined();
    expect(result.pictures).toEqual([
      { path: 'assets/real.png', title: 'real.png' },
      { path: 'assets/sibling.png', title: 'sibling.png' },
    ]);
  });

  it('does not match English words like "feedback" as commit SHAs, but matches (sha) and `sha`', () => {
    const feedbackSha = 'feedbac1234567';
    const validSha = 'a1b2c3d4e5f678901234567890abcdef12345678';
    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      steps: [
        { key: 'step-feedback', text: 'Address review feedback from teammates', done: false },
        { key: 'step-paren', text: 'Fix bug (a1b2c3d)', done: false },
        { key: 'step-backtick', text: 'Revert `a1b2c3d` commit', done: false },
      ],
      checkpoints: [],
      decisions: [],
      waiting: [],
      changes: [],
    };

    const feedbackResult = resolveCommitContext({ repo: 'api', sha: feedbackSha, plan });
    expect(feedbackResult.steps).toEqual([]);

    const validResult = resolveCommitContext({ repo: 'api', sha: validSha, plan });
    expect(validResult.steps.map((s) => s.key)).toEqual(['step-paren', 'step-backtick']);
  });
});
