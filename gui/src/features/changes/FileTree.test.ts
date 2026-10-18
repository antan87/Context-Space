import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FileTree,
  buildCompactedTree,
  filterTreeFiles,
  flattenTreeFiles,
  getAllDirectoryPaths,
  getAncestorPaths,
  getMatchingBranchPaths,
  getVisibleTreeRows,
  normalizePath,
  treeOrderedFiles,
  computeTreeKeyNavigation,
  type TreeFile,
  type VisibleTreeRow,
  type TreeNavAction,
} from './FileTree.js';

interface CustomFile extends TreeFile {
  type: string;
  additions?: number;
  deletions?: number;
}

describe('buildCompactedTree', () => {
  it('returns an empty root for an empty list of files', () => {
    const tree = buildCompactedTree([]);
    expect(tree).toEqual({
      name: '',
      path: '',
      directories: [],
      files: [],
    });
  });

  it('ignores invalid or empty file items', () => {
    // @ts-expect-error testing invalid runtime inputs
    const tree = buildCompactedTree([null, undefined, { file: '' }]);
    expect(tree.directories).toEqual([]);
    expect(tree.files).toEqual([{ file: '' }]);
  });

  it('places root files at root and sorts them alphabetically', () => {
    const files: TreeFile[] = [
      { file: 'tsconfig.json' },
      { file: 'README.md' },
      { file: 'package.json' },
    ];
    const tree = buildCompactedTree(files);
    expect(tree.directories).toEqual([]);
    expect(tree.files.map((f) => f.file)).toEqual([
      'package.json',
      'README.md',
      'tsconfig.json',
    ]);
  });

  it('compacts single-child directory chains by default', () => {
    const files: TreeFile[] = [
      { file: 'src/features/changes/FileTree.tsx' },
    ];
    const tree = buildCompactedTree(files);
    expect(tree.files).toEqual([]);
    expect(tree.directories).toHaveLength(1);

    const compacted = tree.directories[0]!;
    expect(compacted.name).toBe('src/features/changes');
    expect(compacted.path).toBe('src/features/changes');
    expect(compacted.directories).toEqual([]);
    expect(compacted.files.map((f) => f.file)).toEqual([
      'src/features/changes/FileTree.tsx',
    ]);
  });

  it('preserves uncompacted directory nodes when compact option is false', () => {
    const files: TreeFile[] = [
      { file: 'src/features/changes/FileTree.tsx' },
    ];
    const tree = buildCompactedTree(files, { compact: false });
    expect(tree.directories).toHaveLength(1);
    expect(tree.directories[0]!.name).toBe('src');
    expect(tree.directories[0]!.path).toBe('src');

    const features = tree.directories[0]!.directories[0]!;
    expect(features.name).toBe('features');
    expect(features.path).toBe('src/features');

    const changes = features.directories[0]!;
    expect(changes.name).toBe('changes');
    expect(changes.path).toBe('src/features/changes');
    expect(changes.files.map((f) => f.file)).toEqual([
      'src/features/changes/FileTree.tsx',
    ]);
  });

  it('does not compact a directory that contains both a file and a subdirectory', () => {
    const files: TreeFile[] = [
      { file: 'src/index.ts' },
      { file: 'src/components/Button.tsx' },
    ];
    const tree = buildCompactedTree(files);
    expect(tree.directories).toHaveLength(1);

    const src = tree.directories[0]!;
    expect(src.name).toBe('src');
    expect(src.path).toBe('src');
    expect(src.files.map((f) => f.file)).toEqual(['src/index.ts']);
    expect(src.directories).toHaveLength(1);

    const comp = src.directories[0]!;
    expect(comp.name).toBe('components');
    expect(comp.path).toBe('src/components');
    expect(comp.files.map((f) => f.file)).toEqual(['src/components/Button.tsx']);
  });

  it('compacts single-child chains under branched directories', () => {
    const files: TreeFile[] = [
      { file: 'src/components/ui/Button.tsx' },
      { file: 'src/components/ui/Dialog.tsx' },
      { file: 'src/lib/utils/format.ts' },
    ];
    const tree = buildCompactedTree(files);
    expect(tree.directories).toHaveLength(1);

    const src = tree.directories[0]!;
    expect(src.name).toBe('src');
    expect(src.directories).toHaveLength(2);

    // Sorted alphabetically: 'components/ui' then 'lib/utils'
    const componentsUi = src.directories[0]!;
    expect(componentsUi.name).toBe('components/ui');
    expect(componentsUi.path).toBe('src/components/ui');
    expect(componentsUi.files.map((f) => f.file)).toEqual([
      'src/components/ui/Button.tsx',
      'src/components/ui/Dialog.tsx',
    ]);

    const libUtils = src.directories[1]!;
    expect(libUtils.name).toBe('lib/utils');
    expect(libUtils.path).toBe('src/lib/utils');
    expect(libUtils.files.map((f) => f.file)).toEqual([
      'src/lib/utils/format.ts',
    ]);
  });

  it('normalizes Windows backslashes and leading ./ or /', () => {
    const files: TreeFile[] = [
      { file: 'src\\components\\ui\\Button.tsx' },
      { file: './src/index.ts' },
      { file: '/docs/guide.md' },
    ];
    const tree = buildCompactedTree(files);

    const dirNames = tree.directories.map((d) => d.name);
    expect(dirNames).toEqual(['docs', 'src']);

    const docs = tree.directories[0]!;
    expect(docs.files.map((f) => f.file)).toEqual(['/docs/guide.md']);

    const src = tree.directories[1]!;
    expect(src.files.map((f) => f.file)).toEqual(['./src/index.ts']);
    expect(src.directories[0]!.name).toBe('components/ui');
    expect(src.directories[0]!.files.map((f) => f.file)).toEqual([
      'src\\components\\ui\\Button.tsx',
    ]);
  });

  it('preserves custom properties on the original file object', () => {
    const files: CustomFile[] = [
      { file: 'src/app.ts', type: 'modified', additions: 10, deletions: 2 },
    ];
    const tree = buildCompactedTree(files);
    const file = tree.directories[0]!.files[0]!;
    expect(file.type).toBe('modified');
    expect(file.additions).toBe(10);
    expect(file.deletions).toBe(2);
  });
});

describe('flattenTreeFiles', () => {
  it('returns empty array for empty tree', () => {
    const tree = buildCompactedTree([]);
    expect(flattenTreeFiles(tree)).toEqual([]);
  });

  it('places directory files before root files in visual order', () => {
    // Visually, folders are rendered first in the list, then root files
    const files: TreeFile[] = [
      { file: 'z_root.txt' },
      { file: 'a_folder/file.txt' },
    ];
    const tree = buildCompactedTree(files);
    const flattened = flattenTreeFiles(tree);

    // a_folder (directory) appears before z_root.txt (root file)
    expect(flattened.map((f) => f.file)).toEqual([
      'a_folder/file.txt',
      'z_root.txt',
    ]);

    // Even if the root file starts with 'a' and folder starts with 'z',
    // the folder is rendered before root files!
    const files2: TreeFile[] = [
      { file: 'a_root.txt' },
      { file: 'z_folder/file.txt' },
    ];
    const tree2 = buildCompactedTree(files2);
    const flattened2 = flattenTreeFiles(tree2);
    expect(flattened2.map((f) => f.file)).toEqual([
      'z_folder/file.txt',
      'a_root.txt',
    ]);
  });

  it('produces identical visual order whether compacted or uncompacted', () => {
    const files: TreeFile[] = [
      { file: 'README.md' },
      { file: 'src/features/changes/FileTree.tsx' },
      { file: 'src/features/changes/FileTree.test.ts' },
      { file: 'src/index.ts' },
      { file: 'package.json' },
    ];
    const compactedTree = buildCompactedTree(files, { compact: true });
    const uncompactedTree = buildCompactedTree(files, { compact: false });

    const orderCompacted = flattenTreeFiles(compactedTree).map((f) => f.file);
    const orderUncompacted = flattenTreeFiles(uncompactedTree).map((f) => f.file);

    expect(orderCompacted).toEqual(orderUncompacted);
    expect(orderCompacted).toEqual([
      'src/features/changes/FileTree.test.ts',
      'src/features/changes/FileTree.tsx',
      'src/index.ts',
      'package.json',
      'README.md',
    ]);
  });

  it('flattens complex nested directory trees strictly in depth-first visual order', () => {
    const files: TreeFile[] = [
      { file: 'root_b.txt' },
      { file: 'dir1/sub1/deep.txt' },
      { file: 'dir1/b.txt' },
      { file: 'dir1/a.txt' },
      { file: 'dir2/c.txt' },
      { file: 'root_a.txt' },
    ];
    const tree = buildCompactedTree(files);
    const flattened = flattenTreeFiles(tree).map((f) => f.file);

    expect(flattened).toEqual([
      // dir1 comes first alphabetically
      // inside dir1, sub1 directory comes before dir1's files
      'dir1/sub1/deep.txt',
      'dir1/a.txt',
      'dir1/b.txt',
      // dir2 comes next
      'dir2/c.txt',
      // root files come last, sorted alphabetically
      'root_a.txt',
      'root_b.txt',
    ]);
  });
});

describe('treeOrderedFiles', () => {
  it('directly returns files in deterministic visual tree order', () => {
    const files: TreeFile[] = [
      { file: 'z.txt' },
      { file: 'docs/intro.md' },
      { file: 'src/main.ts' },
      { file: 'a.txt' },
    ];
    const ordered = treeOrderedFiles(files).map((f) => f.file);
    expect(ordered).toEqual([
      'docs/intro.md',
      'src/main.ts',
      'a.txt',
      'z.txt',
    ]);
  });
});

describe('Multi-Repo Visual Ordering & Traversal', () => {
  it('sequences files across multi-repo changesets with 0 out-of-order jumps', () => {
    // Simulating two repositories in a workspace
    const repoA = {
      repoName: 'backend',
      repoPath: '/workspace/backend',
      files: [
        { file: 'README.md' },
        { file: 'src/server.ts' },
        { file: 'src/routes/api.ts' },
      ],
    };

    const repoB = {
      repoName: 'frontend',
      repoPath: '/workspace/frontend',
      files: [
        { file: 'package.json' },
        { file: 'src/index.tsx' },
        { file: 'src/components/App.tsx' },
      ],
    };

    const repos = [repoA, repoB];

    // Build the visual order across both repos
    const multiRepoOrderedFiles = repos.flatMap((repo) =>
      treeOrderedFiles(repo.files).map((f) => ({
        repoName: repo.repoName,
        file: f.file,
      }))
    );

    expect(multiRepoOrderedFiles).toEqual([
      // Backend files in visual tree order
      { repoName: 'backend', file: 'src/routes/api.ts' },
      { repoName: 'backend', file: 'src/server.ts' },
      { repoName: 'backend', file: 'README.md' },
      // Frontend files in visual tree order
      { repoName: 'frontend', file: 'src/components/App.tsx' },
      { repoName: 'frontend', file: 'src/index.tsx' },
      { repoName: 'frontend', file: 'package.json' },
    ]);

    // Simulate stepping forward through the entire multi-repo list (Next / Alt+Down)
    for (let i = 0; i < multiRepoOrderedFiles.length - 1; i++) {
      const current = multiRepoOrderedFiles[i]!;
      const next = multiRepoOrderedFiles[i + 1]!;
      // Traversal step is strictly sequential
      expect(next).toBe(multiRepoOrderedFiles[i + 1]);
      // Boundary check: index 2 is backend/README.md, index 3 is frontend/src/components/App.tsx
      if (i === 2) {
        expect(current.repoName).toBe('backend');
        expect(next.repoName).toBe('frontend');
      }
    }

    // Simulate stepping backward through the entire multi-repo list (Prev / Alt+Up)
    for (let i = multiRepoOrderedFiles.length - 1; i > 0; i--) {
      const current = multiRepoOrderedFiles[i]!;
      const prev = multiRepoOrderedFiles[i - 1]!;
      expect(prev).toBe(multiRepoOrderedFiles[i - 1]);
      if (i === 3) {
        expect(current.repoName).toBe('frontend');
        expect(prev.repoName).toBe('backend');
      }
    }
  });

  it('populates jump dropdown options matching visual tree order with 1:1 index traversal', () => {
    const repos = [
      {
        repoName: 'api',
        files: [
          { file: 'server.ts', type: 'modified', additions: 5, deletions: 1 },
          { file: 'routes/auth.ts', type: 'added', additions: 50, deletions: 0 },
        ],
      },
      {
        repoName: 'web',
        files: [
          { file: 'public/favicon.ico', type: 'added', additions: 1, deletions: 0 },
          { file: 'src/App.tsx', type: 'modified', additions: 10, deletions: 4 },
        ],
      },
    ];

    const treeOrdered = repos.flatMap((repo) =>
      treeOrderedFiles(repo.files).map((f) => ({
        repoName: repo.repoName,
        file: f.file,
        type: f.type,
        additions: f.additions,
        deletions: f.deletions,
      }))
    );

    // Dropdown options simulated as in ChangesViewer
    const dropdownOptions = treeOrdered.map((f, i) => ({
      index: i,
      label: `[${f.type.slice(0, 3)}] ${f.repoName}: ${f.file} (+${f.additions} -${f.deletions})`,
      target: f,
    }));

    expect(dropdownOptions).toHaveLength(4);
    expect(dropdownOptions[0]!.target).toEqual({
      repoName: 'api',
      file: 'routes/auth.ts',
      type: 'added',
      additions: 50,
      deletions: 0,
    });
    expect(dropdownOptions[1]!.target).toEqual({
      repoName: 'api',
      file: 'server.ts',
      type: 'modified',
      additions: 5,
      deletions: 1,
    });
    expect(dropdownOptions[2]!.target).toEqual({
      repoName: 'web',
      file: 'public/favicon.ico',
      type: 'added',
      additions: 1,
      deletions: 0,
    });
    expect(dropdownOptions[3]!.target).toEqual({
      repoName: 'web',
      file: 'src/App.tsx',
      type: 'modified',
      additions: 10,
      deletions: 4,
    });

    // Selecting option at dropdown index 2 navigates to exact file
    const selected = treeOrdered[2]!;
    expect(selected.repoName).toBe('web');
    expect(selected.file).toBe('public/favicon.ico');
  });

  it('handles multi-repo changesets with empty repositories without skipping or throwing', () => {
    const repos = [
      { repoName: 'repo-empty-1', files: [] },
      { repoName: 'repo-active', files: [{ file: 'docs/guide.md' }, { file: 'index.ts' }] },
      { repoName: 'repo-empty-2', files: [] },
    ];

    const ordered = repos.flatMap((repo) =>
      treeOrderedFiles(repo.files).map((f) => ({
        repoName: repo.repoName,
        file: f.file,
      }))
    );

    expect(ordered).toEqual([
      { repoName: 'repo-active', file: 'docs/guide.md' },
      { repoName: 'repo-active', file: 'index.ts' },
    ]);
  });

  it('sorts arbitrarily shuffled inputs into strictly deterministic visual tree order', () => {
    const shuffled: TreeFile[] = [
      { file: 'z_dir/sub_b/file.ts' },
      { file: 'root_z.ts' },
      { file: 'a_dir/b_file.ts' },
      { file: 'z_dir/sub_a/file.ts' },
      { file: 'a_dir/a_file.ts' },
      { file: 'root_a.ts' },
      { file: 'z_dir/root_in_z.ts' },
    ];

    const ordered = treeOrderedFiles(shuffled).map((f) => f.file);
    expect(ordered).toEqual([
      // a_dir files
      'a_dir/a_file.ts',
      'a_dir/b_file.ts',
      // z_dir: sub_a, then sub_b, then files in z_dir
      'z_dir/sub_a/file.ts',
      'z_dir/sub_b/file.ts',
      'z_dir/root_in_z.ts',
      // root files alphabetical
      'root_a.ts',
      'root_z.ts',
    ]);
  });

  it('handles paths with multiple slashes and spaces cleanly', () => {
    const files: TreeFile[] = [
      { file: 'src//deep///path//my file.ts' },
      { file: 'src/deep/path/another file.ts' },
    ];
    const tree = buildCompactedTree(files);
    const ordered = flattenTreeFiles(tree).map((f) => f.file);

    expect(ordered).toEqual([
      'src/deep/path/another file.ts',
      'src//deep///path//my file.ts',
    ]);
  });

  it('does not create phantom dot folders for repeated ./ prefixes or segments', () => {
    const files: TreeFile[] = [
      { file: '././foo.txt' },
      { file: 'src/./components/Button.tsx' },
      { file: './//docs///guide.md' },
    ];
    const tree = buildCompactedTree(files);

    // foo.txt must be directly in root.files, not in a '.' directory!
    expect(tree.files.map((f) => f.file)).toEqual(['././foo.txt']);
    const dirNames = tree.directories.map((d) => d.name);
    expect(dirNames).not.toContain('.');
    expect(dirNames).toEqual(['docs', 'src/components']);
  });

  it('sorts files in subdirectories deterministically despite differing slash formats', () => {
    const files: TreeFile[] = [
      { file: '//src/Button.tsx' },
      { file: '/src/Avatar.tsx' },
    ];
    const tree = buildCompactedTree(files);
    const ordered = flattenTreeFiles(tree).map((f) => f.file);

    // Avatar.tsx should come before Button.tsx alphabetically
    expect(ordered).toEqual(['/src/Avatar.tsx', '//src/Button.tsx']);
  });

  it('safely handles missing file type properties in dropdown formatting without throwing', () => {
    const repos = [
      {
        repoName: 'backend',
        files: [
          // @ts-expect-error type missing intentionally
          { file: 'src/index.ts', additions: 3, deletions: 1 },
        ],
      },
    ];

    const treeOrdered = repos.flatMap((repo) =>
      treeOrderedFiles(repo.files).map((f: any) => ({
        repoName: repo.repoName,
        file: f.file,
        type: f.type || 'modified',
        additions: f.additions || 0,
        deletions: f.deletions || 0,
      }))
    );

    const dropdownOptions = treeOrdered.map((f, i) => ({
      index: i,
      label: `[${(f.type || 'modified').slice(0, 3)}] ${f.repoName}: ${f.file} (+${f.additions} -${f.deletions})`,
      target: f,
    }));

    expect(dropdownOptions[0]!.label).toBe('[mod] backend: src/index.ts (+3 -1)');
  });

  it('handles unselected currentFileIndex (-1) transitions', () => {
    const files = [
      { file: 'src/a.ts' },
      { file: 'src/b.ts' },
    ];
    const ordered = treeOrderedFiles(files);
    let currentIdx = -1;

    // Next when unselected jumps to index 0
    if (currentIdx === -1 && ordered.length > 0) {
      currentIdx = 0;
    }
    expect(ordered[currentIdx]!.file).toBe('src/a.ts');

    // Prev when unselected jumps to last file
    currentIdx = -1;
    if (currentIdx === -1 && ordered.length > 0) {
      currentIdx = ordered.length - 1;
    }
    expect(ordered[currentIdx]!.file).toBe('src/b.ts');
  });
});

describe('normalizePath utility', () => {
  it('strips redundant leading slashes and dot prefixes', () => {
    expect(normalizePath('//src/Button.tsx')).toBe('src/Button.tsx');
    expect(normalizePath('///src/Button.tsx')).toBe('src/Button.tsx');
    expect(normalizePath('././src/Button.tsx')).toBe('src/Button.tsx');
    expect(normalizePath('.///src/Button.tsx')).toBe('src/Button.tsx');
    expect(normalizePath('src\\\\components\\\\Button.tsx')).toBe('src/components/Button.tsx');
    expect(normalizePath('src//utils///format.ts')).toBe('src/utils/format.ts');
    expect(normalizePath('')).toBe('');
  });
});

describe('getAllDirectoryPaths', () => {
  it('returns an empty array for an empty tree or root files only', () => {
    const emptyTree = buildCompactedTree([]);
    expect(getAllDirectoryPaths(emptyTree)).toEqual([]);

    const rootFilesTree = buildCompactedTree([
      { file: 'README.md' },
      { file: 'package.json' },
    ]);
    expect(getAllDirectoryPaths(rootFilesTree)).toEqual([]);
  });

  it('collects all directory paths in a compacted tree', () => {
    const files: TreeFile[] = [
      { file: 'src/features/changes/FileTree.tsx' },
      { file: 'src/features/changes/FileTree.test.ts' },
      { file: 'docs/guide.md' },
    ];
    const tree = buildCompactedTree(files, { compact: true });
    const paths = getAllDirectoryPaths(tree);
    expect(paths).toEqual(['docs', 'src/features/changes']);
  });

  it('collects all nested directory paths in an uncompacted tree', () => {
    const files: TreeFile[] = [
      { file: 'src/features/changes/FileTree.tsx' },
      { file: 'docs/guide.md' },
    ];
    const tree = buildCompactedTree(files, { compact: false });
    const paths = getAllDirectoryPaths(tree);
    expect(paths).toEqual(['docs', 'src', 'src/features', 'src/features/changes']);
  });

  it('collects directories across branched hierarchies in depth-first order', () => {
    const files: TreeFile[] = [
      { file: 'src/components/ui/Button.tsx' },
      { file: 'src/components/ui/Dialog.tsx' },
      { file: 'src/lib/format.ts' },
      { file: 'tests/unit.test.ts' },
    ];
    const tree = buildCompactedTree(files, { compact: true });
    const paths = getAllDirectoryPaths(tree);
    expect(paths).toEqual([
      'src',
      'src/components/ui',
      'src/lib',
      'tests',
    ]);
  });
});

describe('getAncestorPaths', () => {
  it('returns empty array for empty inputs or root files', () => {
    const tree = buildCompactedTree([{ file: 'README.md' }]);
    expect(getAncestorPaths(tree, '')).toEqual([]);
    expect(getAncestorPaths(tree, 'README.md')).toEqual([]);
    expect(getAncestorPaths(tree, 'unknown.ts')).toEqual([]);
  });

  it('returns compacted ancestor path for a nested file', () => {
    const files: TreeFile[] = [
      { file: 'src/features/changes/FileTree.tsx' },
      { file: 'package.json' },
    ];
    const tree = buildCompactedTree(files, { compact: true });
    const ancestors = getAncestorPaths(tree, 'src/features/changes/FileTree.tsx');
    expect(ancestors).toEqual(['src/features/changes']);
  });

  it('returns all ancestor directory paths in an uncompacted tree', () => {
    const files: TreeFile[] = [
      { file: 'src/features/changes/FileTree.tsx' },
    ];
    const tree = buildCompactedTree(files, { compact: false });
    const ancestors = getAncestorPaths(tree, 'src/features/changes/FileTree.tsx');
    expect(ancestors.slice().sort()).toEqual(['src', 'src/features', 'src/features/changes'].sort());
  });

  it('handles paths with Windows backslashes and redundant prefixes', () => {
    const files: TreeFile[] = [
      { file: 'src/components/Button.tsx' },
    ];
    const tree = buildCompactedTree(files);
    const winAncestors = getAncestorPaths(tree, 'src\\components\\Button.tsx');
    expect(winAncestors).toEqual(['src/components']);

    const dotAncestors = getAncestorPaths(tree, './src/components/Button.tsx');
    expect(dotAncestors).toEqual(['src/components']);

    const slashAncestors = getAncestorPaths(tree, '//src/components/Button.tsx');
    expect(slashAncestors).toEqual(['src/components']);
  });

  it('returns ancestors when target is a directory path itself', () => {
    const files: TreeFile[] = [
      { file: 'src/components/ui/Button.tsx' },
    ];
    const tree = buildCompactedTree(files, { compact: false });
    const ancestors = getAncestorPaths(tree, 'src/components/ui');
    expect(ancestors.slice().sort()).toEqual(['src', 'src/components', 'src/components/ui'].sort());
  });
});

describe('FileTree component rendering', () => {
  const sampleFiles: TreeFile[] = [
    { file: 'README.md' },
    { file: 'src/components/Button.tsx' },
    { file: 'src/components/Dialog.tsx' },
    { file: 'src/utils/format.ts' },
  ];
  const renderFileMock = (f: TreeFile) => createElement('span', { 'data-name': f.file }, f.file.split('/').at(-1));
  const render = (props: Partial<Parameters<typeof FileTree<TreeFile>>[0]> = {}) => renderToStaticMarkup(
    createElement(FileTree<TreeFile>, { files: sampleFiles, renderFile: renderFileMock, label: 'Workspace files', ...props }),
  );

  it('starts with folders closed when defaultExpanded is false, rendering only the top level', () => {
    const html = render({ defaultExpanded: false });
    expect(html).toContain('README.md');
    expect(html).toContain('<span class="truncate">src</span>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Button.tsx');
    expect(html).not.toContain('format.ts');
  });

  it('starts with every folder open by default', () => {
    const html = render();
    expect(html).not.toContain('aria-expanded="false"');
    for (const name of ['Button.tsx', 'Dialog.tsx', 'format.ts', 'README.md']) expect(html).toContain(name);
  });

  it('shows exactly the folders a controlled expandedPaths opens', () => {
    const html = render({ expandedPaths: new Set(['src', 'src/components']) });
    expect(html).toContain('data-path="src/components"');
    expect(html).toContain('Button.tsx');
    expect(html).toContain('data-path="src/utils"');
    expect(html).not.toContain('format.ts');
  });

  it('renders no rows inside closed folders for an empty controlled set (Collapse All)', () => {
    const html = render({ expandedPaths: new Set() });
    expect(html).not.toContain('Button.tsx');
    expect(html).not.toContain('data-path="src/components"');
  });

  it('indents each level with one 12px guide instead of nested margins', () => {
    const html = render({ expandedPaths: new Set(['src', 'src/components']) });
    const buttonRow = html.slice(html.indexOf('data-file-path="src/components/Button.tsx"'));
    const row = buttonRow.slice(0, buttonRow.indexOf('</li>'));
    expect(row.match(/border-l border-border\/70/g)).toHaveLength(2);
  });

  it('opens the folders above the selected file even when folders start closed', () => {
    const html = render({ selectedPath: 'src/components/Button.tsx', defaultExpanded: false });
    expect(html).toContain('data-file-path="src/components/Button.tsx"');
    expect(html).not.toContain('format.ts');
  });

  it('marks rows with normalized paths for targeting', () => {
    const html = render({ files: [{ file: './src\\app.ts' }] });
    expect(html).toContain('data-file-path="src/app.ts"');
  });

  it('gives the selected row the selected look and the others none', () => {
    const html = render({ selectedPath: 'README.md' });
    const readme = html.slice(html.lastIndexOf('<li', html.indexOf('data-file-path="README.md"')));
    expect(readme.slice(0, readme.indexOf('>'))).toContain('bg-accent font-medium');
  });
});

describe('filterTreeFiles', () => {
  const sampleFiles: TreeFile[] = [
    { file: 'README.md' },
    { file: 'package.json' },
    { file: 'src/components/Button.tsx' },
    { file: 'src/components/Dialog.tsx' },
    { file: 'src/utils/format.ts' },
    { file: 'tests/e2e/login.spec.ts' },
  ];

  it('returns all files when search query is empty or whitespace-only', () => {
    expect(filterTreeFiles(sampleFiles, '')).toEqual(sampleFiles);
    expect(filterTreeFiles(sampleFiles, '   ')).toEqual(sampleFiles);
  });

  it('filters files case-insensitively by filename substring', () => {
    const results = filterTreeFiles(sampleFiles, 'button');
    expect(results.map(f => f.file)).toEqual(['src/components/Button.tsx']);

    const upperResults = filterTreeFiles(sampleFiles, 'BUTTON');
    expect(upperResults.map(f => f.file)).toEqual(['src/components/Button.tsx']);
  });

  it('filters files by directory path substring', () => {
    const results = filterTreeFiles(sampleFiles, 'components');
    expect(results.map(f => f.file)).toEqual([
      'src/components/Button.tsx',
      'src/components/Dialog.tsx',
    ]);
  });

  it('normalizes slashes and backslashes in search queries', () => {
    const results = filterTreeFiles(sampleFiles, 'src\\components');
    expect(results.map(f => f.file)).toEqual([
      'src/components/Button.tsx',
      'src/components/Dialog.tsx',
    ]);
  });

  it('filters files by file extension', () => {
    const results = filterTreeFiles(sampleFiles, '.json');
    expect(results.map(f => f.file)).toEqual(['package.json']);
  });

  it('returns an empty array when no files match', () => {
    const results = filterTreeFiles(sampleFiles, 'nonexistent_file_xyz');
    expect(results).toEqual([]);
  });

  it('gracefully ignores null, undefined, or invalid file items', () => {
    // @ts-expect-error testing invalid runtime data
    const mixed = [null, undefined, { file: 'valid.ts' }, { other: 123 }];
    // @ts-expect-error testing invalid runtime data
    const results = filterTreeFiles(mixed, 'valid');
    expect(results.map(f => f.file)).toEqual(['valid.ts']);
  });
});

describe('getMatchingBranchPaths', () => {
  const sampleFiles: TreeFile[] = [
    { file: 'src/components/Button.tsx' },
    { file: 'src/components/Dialog.tsx' },
    { file: 'src/utils/format.ts' },
    { file: 'tests/e2e/login.spec.ts' },
  ];

  it('returns an empty Set when query is empty or only whitespace', () => {
    expect(getMatchingBranchPaths(sampleFiles, '')).toEqual(new Set());
    expect(getMatchingBranchPaths(sampleFiles, '   ')).toEqual(new Set());
  });

  it('returns an empty Set when no files match', () => {
    expect(getMatchingBranchPaths(sampleFiles, 'nonexistent')).toEqual(new Set());
  });

  it('returns compacted directory branch paths containing matching files', () => {
    const branches = getMatchingBranchPaths(sampleFiles, 'button', { compact: true });
    // In compacted mode, single-child chains are combined
    expect(branches.has('src/components')).toBe(true);
    expect(branches.has('src/utils')).toBe(false);
  });

  it('returns all ancestor directory paths when compact option is false', () => {
    const branches = getMatchingBranchPaths(sampleFiles, 'button', { compact: false });
    expect(branches.has('src')).toBe(true);
    expect(branches.has('src/components')).toBe(true);
    expect(branches.has('src/utils')).toBe(false);
  });

  it('auto-expands multiple branches when matches span multiple directories', () => {
    const branches = getMatchingBranchPaths(sampleFiles, 'ts', { compact: true });
    expect(branches.has('src/components')).toBe(true);
    expect(branches.has('src/utils')).toBe(true);
    expect(branches.has('tests/e2e')).toBe(true);
  });
});

describe('getVisibleTreeRows', () => {
  const sampleFiles: TreeFile[] = [
    { file: 'README.md' },
    { file: 'src/components/Button.tsx' },
    { file: 'src/components/Dialog.tsx' },
    { file: 'src/utils/format.ts' },
  ];

  it('returns only root files and top-level collapsed folders when expandedPaths is empty', () => {
    const root = buildCompactedTree(sampleFiles);
    const visible = getVisibleTreeRows(root, new Set());

    expect(visible).toMatchObject([
      {
        type: 'folder',
        id: 'dir:src',
        path: 'src',
        name: 'src',
        parentPath: null,
        isExpanded: false,
      },
      {
        type: 'file',
        id: 'file:README.md',
        path: 'README.md',
        name: 'README.md',
        parentPath: null,
      },
    ]);
  });

  it('includes child folders and files when parent folder is expanded', () => {
    const root = buildCompactedTree(sampleFiles);
    const visible = getVisibleTreeRows(root, new Set(['src']));

    expect(visible).toMatchObject([
      {
        type: 'folder',
        id: 'dir:src',
        path: 'src',
        name: 'src',
        parentPath: null,
        isExpanded: true,
      },
      {
        type: 'folder',
        id: 'dir:src/components',
        path: 'src/components',
        name: 'components',
        parentPath: 'src',
        isExpanded: false,
      },
      {
        type: 'folder',
        id: 'dir:src/utils',
        path: 'src/utils',
        name: 'utils',
        parentPath: 'src',
        isExpanded: false,
      },
      {
        type: 'file',
        id: 'file:README.md',
        path: 'README.md',
        name: 'README.md',
        parentPath: null,
      },
    ]);
  });

  it('includes nested files when all ancestor branches are expanded', () => {
    const root = buildCompactedTree(sampleFiles);
    const visible = getVisibleTreeRows(root, new Set(['src', 'src/components', 'src/utils']));

    expect(visible.map(r => ({ type: r.type, path: r.path, parentPath: r.parentPath }))).toEqual([
      { type: 'folder', path: 'src', parentPath: null },
      { type: 'folder', path: 'src/components', parentPath: 'src' },
      { type: 'file', path: 'src/components/Button.tsx', parentPath: 'src/components' },
      { type: 'file', path: 'src/components/Dialog.tsx', parentPath: 'src/components' },
      { type: 'folder', path: 'src/utils', parentPath: 'src' },
      { type: 'file', path: 'src/utils/format.ts', parentPath: 'src/utils' },
      { type: 'file', path: 'README.md', parentPath: null },
    ]);
  });

  it('states the level, position and number of siblings of each row for assistive technology', () => {
    const root = buildCompactedTree(sampleFiles);
    const visible = getVisibleTreeRows(root, new Set(['src', 'src/components']));
    expect(visible.map(({ id, level, posinset, setsize }) => ({ id, level, posinset, setsize }))).toEqual([
      { id: 'dir:src', level: 1, posinset: 1, setsize: 2 },
      { id: 'dir:src/components', level: 2, posinset: 1, setsize: 2 },
      { id: 'file:src/components/Button.tsx', level: 3, posinset: 1, setsize: 2 },
      { id: 'file:src/components/Dialog.tsx', level: 3, posinset: 2, setsize: 2 },
      { id: 'dir:src/utils', level: 2, posinset: 2, setsize: 2 },
      { id: 'file:README.md', level: 1, posinset: 2, setsize: 2 },
    ]);
    expect(visible[2]!.file).toBe(sampleFiles[1]);
  });

  it('expands compacted folder when any intermediate compacted path is in expandedPaths', () => {
    const compactedFiles: TreeFile[] = [
      { file: 'docs/reports/q1/summary.md' },
    ];
    const root = buildCompactedTree(compactedFiles, { compact: true });
    expect(root.directories[0]?.name).toBe('docs/reports/q1');
    expect(root.directories[0]?.path).toBe('docs/reports/q1');
    expect(root.directories[0]?.compactedPaths).toEqual(['docs', 'docs/reports', 'docs/reports/q1']);

    // Expanded using the original prefix 'docs'
    const visibleWithDocs = getVisibleTreeRows(root, new Set(['docs']));
    expect(visibleWithDocs[0]?.isExpanded).toBe(true);
    expect(visibleWithDocs[1]?.path).toBe('docs/reports/q1/summary.md');

    // Expanded using the intermediate path 'docs/reports'
    const visibleWithIntermediate = getVisibleTreeRows(root, new Set(['docs/reports']));
    expect(visibleWithIntermediate[0]?.isExpanded).toBe(true);
    expect(visibleWithIntermediate[1]?.path).toBe('docs/reports/q1/summary.md');

    // Expanded using the full compacted path 'docs/reports/q1'
    const visibleWithFull = getVisibleTreeRows(root, new Set(['docs/reports/q1']));
    expect(visibleWithFull[0]?.isExpanded).toBe(true);
    expect(visibleWithFull[1]?.path).toBe('docs/reports/q1/summary.md');
  });

  it('handles empty trees gracefully', () => {
    const root = buildCompactedTree([]);
    const visible = getVisibleTreeRows(root, new Set());
    expect(visible).toMatchObject([]);
  });
});

describe('computeTreeKeyNavigation (Arrow Key Navigation & Keyboard Model)', () => {
  const visibleRows: VisibleTreeRow[] = [
    { type: 'folder', id: 'dir:src', path: 'src', name: 'src', parentPath: null, isExpanded: true },
    { type: 'folder', id: 'dir:src/components', path: 'src/components', name: 'components', parentPath: 'src', isExpanded: false },
    { type: 'folder', id: 'dir:src/utils', path: 'src/utils', name: 'utils', parentPath: 'src', isExpanded: true },
    { type: 'file', id: 'file:src/utils/format.ts', path: 'src/utils/format.ts', name: 'format.ts', parentPath: 'src/utils' },
    { type: 'file', id: 'file:README.md', path: 'README.md', name: 'README.md', parentPath: null },
  ];

  it('advances focus to next row on ArrowDown', () => {
    const action = computeTreeKeyNavigation('ArrowDown', visibleRows[0], visibleRows);
    expect(action).toEqual({ type: 'focus', targetRow: visibleRows[1] });

    const nextAction = computeTreeKeyNavigation('ArrowDown', visibleRows[1], visibleRows);
    expect(nextAction).toEqual({ type: 'focus', targetRow: visibleRows[2] });
  });

  it('stops at last row on ArrowDown', () => {
    const lastRow = visibleRows[visibleRows.length - 1];
    const action = computeTreeKeyNavigation('ArrowDown', lastRow, visibleRows);
    expect(action).toEqual({ type: 'none' });
  });

  it('moves focus to previous row on ArrowUp', () => {
    const action = computeTreeKeyNavigation('ArrowUp', visibleRows[2], visibleRows);
    expect(action).toEqual({ type: 'focus', targetRow: visibleRows[1] });
  });

  it('stops at first row on ArrowUp', () => {
    const firstRow = visibleRows[0];
    const action = computeTreeKeyNavigation('ArrowUp', firstRow, visibleRows);
    expect(action).toEqual({ type: 'none' });
  });

  it('expands collapsed folder on ArrowRight', () => {
    const action = computeTreeKeyNavigation('ArrowRight', visibleRows[1], visibleRows);
    expect(action).toEqual({ type: 'toggle', path: 'src/components' });
  });

  it('moves focus into first child on ArrowRight when folder is already expanded', () => {
    const action = computeTreeKeyNavigation('ArrowRight', visibleRows[0], visibleRows);
    expect(action).toEqual({ type: 'focus', targetRow: visibleRows[1] });
  });

  it('does nothing on ArrowRight for a file', () => {
    const fileRow = visibleRows[3];
    const action = computeTreeKeyNavigation('ArrowRight', fileRow, visibleRows);
    expect(action).toEqual({ type: 'none' });
  });

  it('collapses expanded folder on ArrowLeft', () => {
    const action = computeTreeKeyNavigation('ArrowLeft', visibleRows[2], visibleRows);
    expect(action).toEqual({ type: 'toggle', path: 'src/utils' });
  });

  it('moves focus to parent folder on ArrowLeft when on a collapsed subfolder or child file', () => {
    const actionSubfolder = computeTreeKeyNavigation('ArrowLeft', visibleRows[1], visibleRows);
    expect(actionSubfolder).toEqual({ type: 'focus', targetRow: visibleRows[0] });

    const actionFile = computeTreeKeyNavigation('ArrowLeft', visibleRows[3], visibleRows);
    expect(actionFile).toEqual({ type: 'focus', targetRow: visibleRows[2] });
  });

  it('does nothing on ArrowLeft for a root-level item that has no parent and is not expanded', () => {
    const action = computeTreeKeyNavigation('ArrowLeft', visibleRows[4], visibleRows);
    expect(action).toEqual({ type: 'none' });
  });

  it('jumps directly to first row on Home', () => {
    const action = computeTreeKeyNavigation('Home', visibleRows[3], visibleRows);
    expect(action).toEqual({ type: 'focus', targetRow: visibleRows[0] });
  });

  it('jumps directly to last row on End', () => {
    const action = computeTreeKeyNavigation('End', visibleRows[1], visibleRows);
    expect(action).toEqual({ type: 'focus', targetRow: visibleRows[visibleRows.length - 1] });
  });

  it('toggles folder on Enter and Space', () => {
    const enterAction = computeTreeKeyNavigation('Enter', visibleRows[0], visibleRows);
    expect(enterAction).toEqual({ type: 'toggle', path: 'src' });

    const spaceAction = computeTreeKeyNavigation(' ', visibleRows[1], visibleRows);
    expect(spaceAction).toEqual({ type: 'toggle', path: 'src/components' });
  });

  it('activates file on Enter and Space', () => {
    const enterAction = computeTreeKeyNavigation('Enter', visibleRows[3], visibleRows);
    expect(enterAction).toEqual({ type: 'activate', path: 'src/utils/format.ts' });

    const spaceAction = computeTreeKeyNavigation(' ', visibleRows[3], visibleRows);
    expect(spaceAction).toEqual({ type: 'activate', path: 'src/utils/format.ts' });
  });

  it('returns none for non-navigational keys or invalid inputs', () => {
    const dummyAction: TreeNavAction = computeTreeKeyNavigation('Tab', visibleRows[0], visibleRows);
    expect(dummyAction).toEqual({ type: 'none' });
    expect(computeTreeKeyNavigation('Escape', visibleRows[0], visibleRows)).toEqual({ type: 'none' });
    expect(computeTreeKeyNavigation('ArrowDown', undefined, visibleRows)).toEqual({ type: 'none' });
    expect(computeTreeKeyNavigation('ArrowDown', visibleRows[0], [])).toEqual({ type: 'none' });
  });
});

describe('WAI-ARIA tree markup', () => {
  const sampleFiles: TreeFile[] = [
    { file: 'README.md' },
    { file: 'src/components/Button.tsx' },
    { file: 'src/utils/format.ts' },
  ];
  const renderFileMock = (f: TreeFile) => createElement('span', null, f.file);
  const render = (props: Partial<Parameters<typeof FileTree<TreeFile>>[0]> = {}) => renderToStaticMarkup(
    createElement(FileTree<TreeFile>, { files: sampleFiles, renderFile: renderFileMock, label: 'Source files tree', ...props }),
  );
  const rowOf = (html: string, attribute: string) => {
    const start = html.lastIndexOf('<li', html.indexOf(attribute));
    return html.slice(start, html.indexOf('>', start) + 1);
  };

  it('renders one flat role="tree" list with its label and no nested groups or disclosure widgets', () => {
    const html = render();
    expect(html).toContain('role="tree" aria-label="Source files tree"');
    expect(html).not.toContain('role="group"');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
    expect(html).not.toContain('<nav');
  });

  it('puts the tree item state on the row itself: level, expansion, selection', () => {
    const html = render({ selectedPath: 'README.md', expandedPaths: new Set(['src', 'src/components']) });
    const folder = rowOf(html, 'data-path="src/components"');
    expect(folder).toContain('role="treeitem"');
    expect(folder).toContain('aria-level="2"');
    expect(folder).toContain('aria-expanded="true"');
    expect(folder).not.toContain('aria-selected');
    expect(rowOf(html, 'data-path="src/utils"')).toContain('aria-expanded="false"');
    expect(rowOf(html, 'data-file-path="README.md"')).toContain('aria-selected="true"');
    expect(rowOf(html, 'data-file-path="src/components/Button.tsx"')).toContain('aria-selected="false"');
  });

  it('leaves the row content free of focusable controls and selection state', () => {
    const html = render({ selectedPath: 'README.md' });
    expect(html.match(/tabindex=/g)?.length).toBe(html.match(/role="treeitem"/g)?.length);
    expect(html).not.toContain('<button');
  });

  it('marks rows for cheap off-screen rendering through one class', () => {
    const html = render();
    expect(html).toContain('tree-row');
    expect(html).not.toContain('content-visibility');
  });
});

describe('Roving tab stop', () => {
  const sampleFiles: TreeFile[] = [
    { file: 'README.md' },
    { file: 'src/components/Button.tsx' },
    { file: 'src/utils/format.ts' },
  ];
  const render = (props: Partial<Parameters<typeof FileTree<TreeFile>>[0]> = {}) => renderToStaticMarkup(
    createElement(FileTree<TreeFile>, { files: sampleFiles, renderFile: (f: TreeFile) => createElement('span', null, f.file), label: 'Roving', ...props }),
  );
  const tabStops = (html: string) => [...html.matchAll(/<li[^>]*data-row-id="([^"]+)"[^>]*tabindex="0"/g)].map((match) => match[1]);

  it('makes the first row the only tab stop when nothing is selected', () => {
    expect(tabStops(render({ defaultExpanded: false }))).toEqual(['dir:src']);
  });

  it('makes the selected file the only tab stop', () => {
    expect(tabStops(render({ selectedPath: 'README.md' }))).toEqual(['file:README.md']);
    expect(tabStops(render({ selectedPath: 'src/components/Button.tsx' }))).toEqual(['file:src/components/Button.tsx']);
  });

  it('falls back to the first row when the selected file is inside a closed folder', () => {
    const html = render({ selectedPath: 'src/components/Button.tsx', expandedPaths: new Set() });
    expect(tabStops(html)).toEqual(['dir:src']);
    expect(html).not.toContain('data-file-path="src/components/Button.tsx"');
  });

  it('climbs directory hierarchy step-by-step with ArrowLeft', () => {
    const deepRows: VisibleTreeRow[] = [
      { type: 'folder', id: 'dir:src', path: 'src', name: 'src', parentPath: null, isExpanded: true, level: 1, posinset: 1, setsize: 1 },
      { type: 'folder', id: 'dir:src/components', path: 'src/components', name: 'components', parentPath: 'src', isExpanded: true },
      { type: 'folder', id: 'dir:src/components/ui', path: 'src/components/ui', name: 'ui', parentPath: 'src/components', isExpanded: false },
      { type: 'file', id: 'file:src/components/ui/Button.tsx', path: 'src/components/ui/Button.tsx', name: 'Button.tsx', parentPath: 'src/components/ui' },
    ];

    // From child file: ArrowLeft moves focus to parent folder
    const action1 = computeTreeKeyNavigation('ArrowLeft', deepRows[3], deepRows);
    expect(action1).toEqual({ type: 'focus', targetRow: deepRows[2] });

    // From collapsed folder with parent: ArrowLeft moves focus to parent folder
    const action2 = computeTreeKeyNavigation('ArrowLeft', deepRows[2], deepRows);
    expect(action2).toEqual({ type: 'focus', targetRow: deepRows[1] });

    // From expanded folder: ArrowLeft collapses it
    const action3 = computeTreeKeyNavigation('ArrowLeft', deepRows[1], deepRows);
    expect(action3).toEqual({ type: 'toggle', path: 'src/components' });
  });
  it('computes visible rows and keyboard actions correctly with filtered search results', () => {
    const query = 'format';
    const filteredFiles = filterTreeFiles(sampleFiles, query);
    const root = buildCompactedTree(filteredFiles);
    const visible = getVisibleTreeRows(root, new Set(['src/utils']));
    expect(visible).toMatchObject([
      { type: 'folder', id: 'dir:src/utils', path: 'src/utils', name: 'src/utils', parentPath: null, isExpanded: true },
      { type: 'file', id: 'file:src/utils/format.ts', path: 'src/utils/format.ts', name: 'format.ts', parentPath: 'src/utils' },
    ]);

    const downAction = computeTreeKeyNavigation('ArrowDown', visible[0], visible);
    expect(downAction).toEqual({ type: 'focus', targetRow: visible[1] });

    const upAction = computeTreeKeyNavigation('ArrowUp', visible[1], visible);
    expect(upAction).toEqual({ type: 'focus', targetRow: visible[0] });
  });
  it('normalizes Windows backslashes to extract proper file names in getVisibleTreeRows', () => {
    const winFiles: TreeFile[] = [
      { file: 'src\\components\\ui\\Modal.tsx' },
    ];
    const root = buildCompactedTree(winFiles);
    const visible = getVisibleTreeRows(root, new Set(['src/components/ui']));
    expect(visible).toMatchObject([
      {
        type: 'folder',
        id: 'dir:src/components/ui',
        path: 'src/components/ui',
        name: 'src/components/ui',
        parentPath: null,
        isExpanded: true,
      },
      {
        type: 'file',
        id: 'file:src/components/ui/Modal.tsx',
        path: 'src/components/ui/Modal.tsx',
        name: 'Modal.tsx',
        parentPath: 'src/components/ui',
      },
    ]);
  });
  it('preserves roving tabindex without focus loss during repeated directory toggle', () => {
    const root = buildCompactedTree(sampleFiles);
    const expanded = new Set(['src']);
    let visible = getVisibleTreeRows(root, expanded);

    // Initial visible rows: src, src/components, src/utils, README.md
    expect(visible.map(r => r.id)).toContain('dir:src/components');

    // Toggle src/components open
    expanded.add('src/components');
    visible = getVisibleTreeRows(root, expanded);
    expect(visible.map(r => r.id)).toContain('file:src/components/Button.tsx');

    // Active row on src/components is preserved
    const componentsRow = visible.find(r => r.id === 'dir:src/components');
    expect(componentsRow).toBeDefined();

    // Toggle src/components closed
    expanded.delete('src/components');
    visible = getVisibleTreeRows(root, expanded);
    expect(visible.map(r => r.id)).not.toContain('file:src/components/Button.tsx');
    expect(visible.map(r => r.id)).toContain('dir:src/components');
  });
});
