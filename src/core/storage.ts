import { getActiveStorageProvider } from './adapters/registry.js';

export async function writeWorkspaceFile(workspacePath: string, featureId: string, filename: string, content: string): Promise<void> {
  await getActiveStorageProvider().writeWorkspaceFile(workspacePath, featureId, filename, content);
}

export async function readWorkspaceFile(workspacePath: string, featureId: string, filename: string): Promise<string> {
  return await getActiveStorageProvider().readWorkspaceFile(workspacePath, featureId, filename);
}

export async function workspaceFileExists(workspacePath: string, featureId: string, filename: string): Promise<boolean> {
  return await getActiveStorageProvider().workspaceFileExists(workspacePath, featureId, filename);
}

/** Removes one workspace document. False when the storage adapter cannot remove documents. */
export async function deleteWorkspaceFile(workspacePath: string, featureId: string, filename: string): Promise<boolean> {
  const provider = getActiveStorageProvider();
  if (!provider.deleteWorkspaceFile) return false;
  await provider.deleteWorkspaceFile(workspacePath, featureId, filename);
  return true;
}

export function resolveWorkspaceFileUrl(workspacePath: string, featureId: string, filename: string): string {
  return getActiveStorageProvider().resolveWorkspaceFileUrl(workspacePath, featureId, filename);
}

export async function writeBaseFile(workspacePath: string, repoName: string, filename: string, content: string): Promise<void> {
  await getActiveStorageProvider().writeBaseFile(workspacePath, repoName, filename, content);
}

export async function readBaseFile(workspacePath: string, repoName: string, filename: string): Promise<string> {
  return await getActiveStorageProvider().readBaseFile(workspacePath, repoName, filename);
}

export async function baseFileExists(workspacePath: string, repoName: string, filename: string): Promise<boolean> {
  return await getActiveStorageProvider().baseFileExists(workspacePath, repoName, filename);
}

export function resolveBaseFileUrl(workspacePath: string, repoName: string, filename: string): string {
  return getActiveStorageProvider().resolveBaseFileUrl(workspacePath, repoName, filename);
}

export async function deleteWorkspaceFiles(workspacePath: string, featureId: string): Promise<void> {
  await getActiveStorageProvider().deleteWorkspace(workspacePath, featureId);
}
