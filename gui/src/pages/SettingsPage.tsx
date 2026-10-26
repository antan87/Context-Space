import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, RefreshCw } from 'lucide-react';
import { DataPrivacyPanel } from '../features/settings/DataPrivacyPanel.js';

import { Alert } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select.js';
import { Separator } from '../components/ui/separator.js';
import { Spinner } from '../components/ui/spinner.js';
import { Switch } from '../components/ui/switch.js';
import type { DetectedEditor, ContextSpaceConfig, StorageAdapterMeta, ToolStatus } from '../types.js';
import { FolderField } from '../features/setup/FolderField.js';
import { checkFolders, repoSummary, type ConfigPathsReport, type FolderKey } from '../features/setup/setupApi.js';

interface SettingsPageProps {
  workspaces: { id: string; branchName: string }[];
  config: ContextSpaceConfig | null;
  setConfig: (config: ContextSpaceConfig) => void;
  saveStatus: 'success' | 'error' | null;
  saveError?: { message: string; fields: ConfigPathsReport | null } | null;
  editors: DetectedEditor[];
  adapters: StorageAdapterMeta[];
  saveAppConfig: (config: ContextSpaceConfig) => void;
  isSettingsFormValid: boolean;

  toolsStatus: ToolStatus[];
  toolsLoading: boolean;
  updatingToolId: string | null;
  fetchToolsStatus: (force?: boolean) => void;
  handleUpdateTool: (toolId: string) => void;
}

export function SettingsPage({
  workspaces,
  config,
  setConfig,
  saveStatus,
  saveError,
  editors,
  adapters,
  saveAppConfig,
  isSettingsFormValid,

  toolsStatus,
  toolsLoading,
  updatingToolId,
  fetchToolsStatus,
  handleUpdateTool,
}: SettingsPageProps) {
  const [folderReport, setFolderReport] = useState<ConfigPathsReport | null>(null);
  const [checking, setChecking] = useState<Partial<Record<FolderKey, boolean>>>({});
  const checkRequest = useRef(0);
  // A refused save reports which folder failed; show it on that field.
  useEffect(() => { if (saveError?.fields) setFolderReport(saveError.fields); }, [saveError]);

  if (!config) return null;

  const checkFolder = async (field: FolderKey, value: string) => {
    if (!value.trim()) return;
    const request = ++checkRequest.current;
    setChecking({ [field]: true });
    try {
      const report = await checkFolders({ devDir: field === 'devDir' ? value : config.devDir, workspacesDir: field === 'workspacesDir' ? value : config.workspacesDir });
      if (request === checkRequest.current) setFolderReport(report);
    } catch {
      // Saving checks again; a failed check says nothing about the folder.
    } finally {
      if (request === checkRequest.current) setChecking({});
    }
  };
  const editFolder = (field: FolderKey, value: string) => {
    setConfig({ ...config, [field]: value });
    setFolderReport((report) => report && { ...report, [field]: undefined });
  };

  const selectedEditor = editors.find((ed) => ed.command === config.defaultEditor);
  const selectedAdapter = adapters.find((a) => a.name === (config.storageProvider || 'local'));


  return (
    <div className="mx-auto max-w-4xl animate-fade-in">
      <header className="mb-6 border-b border-border/70 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-foreground">Global Settings</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Configure your local development directories, AI search parameters, storage adapters, and editor defaults.
        </p>
      </header>

      <DataPrivacyPanel workspaces={workspaces} />

      {saveStatus === 'success' && (
        <Alert variant="success" className="mb-6">
          <Check size={18} /> Settings successfully saved and updated!
        </Alert>
      )}
      {saveStatus === 'error' && (
        <Alert variant="error" className="mb-6">
          <AlertTriangle size={18} /> Settings were not saved. {saveError?.message ?? 'Could not save configuration details to disk.'}
        </Alert>
      )}

      <Card className="mb-6 rounded-xl border border-border/80 bg-card/70 backdrop-blur-md p-6 shadow-xs">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <FolderField
            id="settings-devDir"
            label="Code folder"
            description="The folder that holds your Git repositories."
            placeholder=""
            value={config.devDir}
            onChange={(value) => editFolder('devDir', value)}
            onCommit={(value) => void checkFolder('devDir', value)}
            check={folderReport?.devDir}
            checking={checking.devDir}
            okText={repoSummary(folderReport?.devDir?.repoCount)}
          />
          <FolderField
            id="settings-workspacesDir"
            label="Workspaces folder"
            description="Where a folder is created for each task."
            placeholder=""
            value={config.workspacesDir}
            onChange={(value) => editFolder('workspacesDir', value)}
            onCommit={(value) => void checkFolder('workspacesDir', value)}
            check={folderReport?.workspacesDir}
            checking={checking.workspacesDir}
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-scanDepth" className="text-sm">Repo Search Depth</Label>
            <Input
              type="number"
              min={1}
              max={5}
              id="settings-scanDepth"
              value={config.scanDepth}
              onChange={(e) => setConfig({ ...config, scanDepth: parseInt(e.target.value, 10) })}
            />
            <span className="text-xs text-muted-foreground">
              Max directory levels deep the system will traverse for git repos.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-sm">Default Assistant</Label>
            <Select
              value={config.defaultAssistant || ''}
              onValueChange={(value) =>
                typeof value === 'string' && setConfig({ ...config, defaultAssistant: value || null })
              }
            >
              <SelectTrigger aria-label="Default Assistant">
                <SelectValue>
                  {config.defaultAssistant === 'claude'
                    ? 'Claude Code'
                    : config.defaultAssistant === 'antigravity'
                      ? 'Antigravity'
                      : config.defaultAssistant === 'codex'
                        ? 'Codex'
                        : config.defaultAssistant === 'copilot'
                          ? 'GitHub Copilot'
                          : config.defaultAssistant === 'cursor'
                            ? 'Cursor'
                            : config.defaultAssistant === 'pi'
                              ? 'Pi'
                              : 'None (Prompt me)'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="">None (Prompt me)</SelectItem>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="antigravity">Antigravity</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="copilot">GitHub Copilot</SelectItem>
                <SelectItem value="cursor">Cursor</SelectItem>
                <SelectItem value="pi">Pi</SelectItem>
              </SelectPopup>
            </Select>
            <span className="text-xs text-muted-foreground">Your preferred workspace context manager.</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-sm">Preferred Editor</Label>
            <Select
              value={config.defaultEditor || ''}
              onValueChange={(value) =>
                typeof value === 'string' && setConfig({ ...config, defaultEditor: value || null })
              }
            >
              <SelectTrigger aria-label="Preferred Editor">
                <SelectValue>
                  {selectedEditor
                    ? `${selectedEditor.name} ${selectedEditor.detected ? '(Detected)' : '(Not found)'}`
                    : 'No preference'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="">No preference</SelectItem>
                {editors.map((ed) => (
                  <SelectItem key={ed.command} value={ed.command}>
                    {ed.name} {ed.detected ? '(Detected)' : '(Not found)'}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="text-xs text-muted-foreground">Shown first in the “Open with…” workspace chooser.</span>
          </div>

          <div className="flex flex-col gap-4 md:col-span-2">
            <Separator className="mt-1" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">Workspace Storage Settings</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose where maps, plans, and knowledge files are stored.
              </p>
            </div>

            <div className="flex max-w-md flex-col gap-1.5">
              <Label htmlFor="storageProvider" className="text-sm">
                Storage Provider
              </Label>
              <Select
                value={config.storageProvider || 'local'}
                onValueChange={(value) => {
                  if (typeof value !== 'string') return;
                  const val = value;
                  const newConf = { ...config, storageProvider: val };
                  const adapterForValue = adapters.find((a) => a.name === val);
                  if (adapterForValue?.configFields?.length) {
                    if (!newConf.adapterConfig) newConf.adapterConfig = {};
                    if (!newConf.adapterConfig[val]) newConf.adapterConfig[val] = {};
                    adapterForValue.configFields.forEach((f) => {
                      if (newConf.adapterConfig![val][f.key] === undefined && f.default !== undefined) {
                        newConf.adapterConfig![val][f.key] = f.default;
                      }
                    });
                  }
                  setConfig(newConf);
                }}
              >
                <SelectTrigger id="storageProvider" aria-label="Storage Provider">
                  <SelectValue>
                    {selectedAdapter?.displayName ?? 'Local Workspace (Folders)'}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {adapters.length > 0 ? (
                    adapters.map((a) => (
                      <SelectItem key={a.name} value={a.name}>
                        {a.displayName}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="local">Local Workspace (Folders)</SelectItem>
                  )}
                </SelectPopup>
              </Select>
              <span className="text-xs text-muted-foreground">
                {selectedAdapter?.description ||
                  'The built-in local adapter stores documents in the workspace. Plugin adapters define their own storage and sharing behavior.'}
              </span>
            </div>

            {(() => {
              const activeProv = config.storageProvider || 'local';
              const activeAdapter = adapters.find((a) => a.name === activeProv);
              if (!activeAdapter?.configFields?.length) {
                return null;
              }

              return (
                <div className="flex max-w-md flex-col gap-4 rounded-xl border border-border bg-muted/40 p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {activeAdapter.displayName} Settings
                  </h4>
                  {activeAdapter.configFields.map((field) => {
                    const value = config.adapterConfig?.[activeProv]?.[field.key] ?? field.default ?? '';
                    const updateField = (val: unknown) => {
                      const newAdapterConfig = {
                        ...(config.adapterConfig || {}),
                        [activeProv]: {
                          ...(config.adapterConfig?.[activeProv] || {}),
                          [field.key]: val,
                        },
                      };
                      setConfig({ ...config, adapterConfig: newAdapterConfig });
                    };

                    if (field.type === 'boolean') {
                      return (
                        <Label key={field.key} className="flex cursor-pointer items-start gap-3 text-sm">
                          <Switch checked={!!value} onCheckedChange={(checked) => updateField(checked)} />
                          <span className="flex flex-col">
                            <span className="text-sm font-medium text-foreground">{field.label}</span>
                            {field.description && (
                              <span className="mt-0.5 text-xs leading-normal text-muted-foreground">
                                {field.description}
                              </span>
                            )}
                          </span>
                        </Label>
                      );
                    }

                    return (
                      <div key={field.key} className="flex flex-col gap-1.5">
                        <Label className="text-sm">{field.label}</Label>
                        <Input
                          type={field.type === 'number' ? 'number' : 'text'}
                          value={typeof value === 'string' || typeof value === 'number' ? value : String(value ?? '')}
                          onChange={(e) => {
                            const val = field.type === 'number' ? Number(e.target.value) : e.target.value;
                            updateField(val);
                          }}
                        />
                        {field.description && (
                          <span className="text-xs leading-normal text-muted-foreground">{field.description}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
      </Card>


      <Card className="mt-6 rounded-xl border border-border/80 bg-card/70 backdrop-blur-md p-6 shadow-xs">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-foreground">AI Toolchain Updates</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Monitor and update the CLI packages and assistants in your workflow.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => fetchToolsStatus(true)} disabled={toolsLoading}>
            {toolsLoading ? <Spinner className="size-3" /> : <RefreshCw size={13} />}
            {toolsLoading ? 'Checking...' : 'Check Now'}
          </Button>
        </div>

        {toolsLoading && toolsStatus.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
            <Spinner className="size-6" />
            <span className="text-xs">Fetching registry version details...</span>
          </div>
        ) : toolsStatus.length === 0 ? (
          <p className="py-4 text-xs text-muted-foreground">No toolchain information available.</p>
        ) : (
          <div className="space-y-4">
            {toolsStatus.map((tool) => (
              <div
                key={tool.id}
                className="flex flex-col gap-4 rounded-xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    {tool.name}
                    <Badge variant={tool.installed ? 'success' : 'secondary'} size="sm">
                      {tool.installed ? 'Installed' : 'Not Installed'}
                    </Badge>
                  </h4>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      Installed version: <code className="font-mono text-[10px] text-foreground">{tool.currentVersion}</code>
                    </span>
                    {tool.installed && (
                      <span>
                        Latest: <code className="font-mono text-[10px] text-foreground">{tool.latestVersion}</code>
                      </span>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{tool.updateCmd}</p>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  {tool.updateAvailable ? (
                    <Button size="sm" onClick={() => handleUpdateTool(tool.id)} disabled={updatingToolId !== null}>
                      {updatingToolId === tool.id ? (
                        <>
                          <Spinner className="size-3" /> Updating...
                        </>
                      ) : (
                        'Update Tool'
                      )}
                    </Button>
                  ) : tool.installed ? (
                    <div className="flex items-center gap-2">
                      <Badge variant="success" className="gap-1.5">
                        <Check size={12} /> Up to Date
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUpdateTool(tool.id)}
                        disabled={updatingToolId !== null}
                      >
                        {updatingToolId === tool.id ? (
                          <>
                            <Spinner className="size-3" /> Reinstalling...
                          </>
                        ) : (
                          'Reinstall'
                        )}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUpdateTool(tool.id)}
                      disabled={updatingToolId !== null}
                    >
                      {updatingToolId === tool.id ? (
                        <>
                          <Spinner className="size-3" /> Installing...
                        </>
                      ) : (
                        'Install CLI'
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mb-10 flex justify-end pt-4">
        <Button onClick={() => saveAppConfig(config)} disabled={!isSettingsFormValid}>
          <Check size={16} /> Save Configuration
        </Button>
      </div>
    </div>
  );
}
