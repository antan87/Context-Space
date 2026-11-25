import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const DEEP_DESIGN = {
  group: ['**/design/**', '!**/design/index', '!**/design/index.js', '!**/design/index.ts'],
  message: 'Import from design/index (or design) only; files inside the module are private.',
};
const DIRECT_UI = {
  // Every spelling of the folder: `../../components/ui/button.js`, the barrel `../components/ui`,
  // and from inside `components/`: `./ui/button.js`, `../ui`.
  // Relative paths with a `ui` segment (`./ui/button.js`, `../../components/ui`, `../ui`); packages like monaco's `.../ui/...` are not relative.
  regex: '^\\.{1,2}/(?:[^/]+/)*ui(?:/|$)',
  message: 'New code imports controls from design/index, not components/ui/*. (Old importers are on LEGACY_UI_IMPORTERS; it may only get shorter.)',
};

// Files that imported components/ui/* directly when the design module was added (DS2a).
// Remove a file from this list when it moves to design/index. Never add one.
export const LEGACY_UI_IMPORTERS = [
  'src/App.tsx',
  'src/app/AppSidebar.tsx',
  'src/app/UpdateNotice.tsx',
  'src/components/AddRepoPicker.tsx',
  'src/components/ArchiveWorkspaceDialog.tsx',
  'src/components/DeleteWorkspaceDialog.tsx',
  'src/components/Diagram.tsx',
  'src/components/RepoChecklist.tsx',
  'src/components/ScaffoldRepoInline.tsx',
  'src/features/board/AssignmentCard.tsx',
  'src/features/board/BoardKnowledge.tsx',
  'src/features/board/BoardNowLine.tsx',
  'src/features/board/BoardReader.tsx',
  'src/features/board/BoardSidebar.tsx',
  'src/features/board/ReaderPage.tsx',
  'src/features/changes/CodeSection.tsx',
  'src/features/changes/CommitReviewPanel.tsx',
  'src/features/changes/FinishPanel.tsx',
  'src/features/changes/PluggableDiffViewer.tsx',
  'src/features/chat/ChatAttentionCards.tsx',
  'src/features/chat/ChatDock.tsx',
  'src/features/chat/ChatHome.tsx',
  'src/features/chat/WorkspaceChatResume.tsx',
  'src/features/chat/WorkspaceServicesControl.tsx',
  'src/features/guide/GettingStartedPage.tsx',
  'src/features/knowledge/KnowledgeView.tsx',
  'src/features/plan/AnswerBox.tsx',
  'src/features/progress/ProgressPanel.tsx',
  'src/features/progress/WhereAreWeStrip.tsx',
  'src/features/sessions/SessionHistory.tsx',
  'src/features/sessions/TranscriptDialog.tsx',
  'src/features/settings/DataPrivacyPanel.tsx',
  'src/features/setup/FolderField.tsx',
  'src/features/setup/SetupPage.tsx',
  'src/features/skills/BuiltInSkills.tsx',
  'src/features/skills/SkillsExplorer.tsx',
  'src/features/skills/WorkspaceSkillDialogs.tsx',
  'src/features/skills/WorkspaceSkillSections.tsx',
  'src/features/skills/WorkspaceSkillsTab.tsx',
  'src/features/terminal/ResumeSessions.tsx',
  'src/features/terminal/SessionDeck.tsx',
  'src/features/terminal/TerminalPane.tsx',
  'src/features/terminal/TerminalWorkspace.tsx',
  'src/features/work-guidance/BriefDraftNotices.tsx',
  'src/features/work-guidance/DocumentViewer.tsx',
  'src/features/workrooms/HandoffStream.tsx',
  'src/features/workrooms/WorkspaceWorkroomTab.tsx',
  'src/features/workspace-home/WorkspaceTabs.tsx',
  'src/features/workspace-launch/ResourcePreview.tsx',
  'src/features/workspace-launch/SkillPicker.tsx',
  'src/features/workspace-launch/WorkspaceLauncher.tsx',
  'src/features/workspace-shell/ArchivedWorkspaceView.tsx',
  'src/features/workspace-shell/WorkspaceHeader.tsx',
  'src/features/workspace-shell/WorkspaceMarks.tsx',
  'src/features/workspace-shell/WorkspaceRail.tsx',
  'src/features/worktrees/PrepareRepoDialog.tsx',
  'src/features/worktrees/RepositoriesList.tsx',
  'src/lib/status.ts',
  'src/pages/AgentsPage.tsx',
  'src/pages/DashboardPage.tsx',
  'src/pages/ProjectsPage.tsx',
  'src/pages/SettingsPage.tsx',
  'src/pages/SkillsPage.tsx',
  'src/pages/StartWorkPage.tsx',
  'src/pages/StrategiesPage.tsx',
  'src/pages/WorkroomsPage.tsx',
  'src/pages/WorkspacesPage.tsx',
];

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // Ported shadcn-style primitives (see components/ui): they intentionally
    // export cva variants beside components (breaks the fast-refresh rule) and
    // include upstream patterns like the memoized random skeleton width.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/purity': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', 'e2e/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Design module rules (see src/design/README.md).
    // (a) The module stays a leaf: it never reaches into screens, React Flow or queries.
    files: ['src/design/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/features/**', '**/features'], message: 'design/ is a leaf: it must not import from features/. Pass plain values in as props.' },
            { group: ['@xyflow/react', '@xyflow/react/**'], message: 'design/ must not import React Flow. The Board passes its handles in as children.' },
            { group: ['@tanstack/react-query', '@tanstack/react-query/**'], message: 'design/ must not import queries or mutations. Pass values and callbacks in as props.' },
          ],
        },
      ],
    },
  },
  {
    // (b) Outside the module only `design/index` is public. (c) New code does not import
    // `components/ui/*` directly: it uses `design/index`. Files that already did are in
    // LEGACY_UI_IMPORTERS below, and that list may only get shorter.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/design/**', 'src/components/ui/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [DEEP_DESIGN, DIRECT_UI] }],
    },
  },
  {
    // The controls themselves may not reach into the module's private files either.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [DEEP_DESIGN] }],
    },
  },
  {
    files: LEGACY_UI_IMPORTERS,
    rules: {
      'no-restricted-imports': ['error', { patterns: [DEEP_DESIGN] }],
    },
  },
])
