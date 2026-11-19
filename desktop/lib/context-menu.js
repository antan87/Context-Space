import { externalLinkTarget, isAppShellNavigation } from './security.js';

/**
 * @typedef {{
 *   writeText: (text: string) => void;
 *   copyImageAt: (x: number, y: number) => void;
 *   downloadURL: (url: string) => void;
 *   openExternal: (url: string) => void;
 *   loadURL: (url: string) => void;
 *   replaceMisspelling: (word: string) => void;
 * }} ContextMenuActions
 */

/**
 * Parses a local workspace picture URL (`/api/workspace/:id/documents/file?name=...`)
 * into its native download URL (`&download=1`) and workspace-relative file path.
 * Returns `null` for external URLs or URLs whose origin/port does not match `appPort`.
 *
 * @param {string} srcURL
 * @param {number | null | undefined} appPort
 * @returns {{ downloadUrl: string; filePath: string } | null}
 */
export function parseWorkspacePictureUrl(srcURL, appPort) {
  const portNum = Number(appPort);
  if (typeof srcURL !== 'string' || !srcURL.trim() || !Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return null;
  let parsed;
  try {
    parsed = new URL(srcURL);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return null;
  if (parsed.port !== String(portNum)) return null;
  if (!/^\/api\/workspace\/[^/]+\/documents\/file$/.test(parsed.pathname)) return null;

  const rawName = parsed.searchParams.get('name');
  if (!rawName || !rawName.trim()) return null;
  const cleanName = rawName.trim().replace(/^\/+/, '');
  const rawRepo = (parsed.searchParams.get('repo') ?? '').trim().replace(/^\/+|\/+$/g, '');
  // The endpoint resolves `name` relative to the repo, so the path is always repo + name, with no prefix stripping
  const filePath = rawRepo ? `${rawRepo}/${cleanName}` : cleanName;

  const downloadUrl = new URL(parsed.toString());
  downloadUrl.searchParams.delete('open');
  downloadUrl.searchParams.set('download', '1');

  return {
    downloadUrl: downloadUrl.toString(),
    filePath,
  };
}

function isDownloadablePictureUrl(srcURL) {
  try {
    const parsed = new URL(srcURL);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'data:' || parsed.protocol === 'blob:';
  } catch {
    return false;
  }
}

/**
 * Builds an Electron context menu template for the current right-click parameters.
 * Returns an empty array when there is nothing to act on so callers skip showing a menu.
 *
 * @param {{
 *   x?: number;
 *   y?: number;
 *   isEditable?: boolean;
 *   selectionText?: string;
 *   misspelledWord?: string;
 *   dictionarySuggestions?: string[];
 *   mediaType?: string;
 *   hasImageContents?: boolean;
 *   srcURL?: string;
 *   linkURL?: string;
 *   editFlags?: { canCut?: boolean; canCopy?: boolean; canPaste?: boolean; canSelectAll?: boolean };
 * }} params
 * @param {{ appPort?: number | null }} context
 * @param {ContextMenuActions} actions
 */
export function buildContextMenuTemplate(params, context, actions) {
  const safeParams = params ?? {};
  const appPort = context?.appPort ?? null;
  const selectionText = typeof safeParams.selectionText === 'string' ? safeParams.selectionText : '';
  const hasSelection = selectionText.trim().length > 0;
  const editFlags = safeParams.editFlags ?? {};
  const sections = [];

  if (
    safeParams.isEditable &&
    safeParams.misspelledWord &&
    Array.isArray(safeParams.dictionarySuggestions) &&
    safeParams.dictionarySuggestions.length > 0
  ) {
    sections.push(
      safeParams.dictionarySuggestions.slice(0, 8).map((suggestion) => ({
        label: suggestion,
        click: () => actions.replaceMisspelling(suggestion),
      })),
    );
  }

  if (safeParams.isEditable) {
    sections.push([
      { label: 'Cut', role: 'cut', enabled: editFlags.canCut ?? hasSelection },
      { label: 'Copy', role: 'copy', enabled: editFlags.canCopy ?? hasSelection },
      { label: 'Paste', role: 'paste', enabled: editFlags.canPaste ?? true },
      { label: 'Select all', role: 'selectAll', enabled: editFlags.canSelectAll ?? true },
    ]);
  } else if (hasSelection && editFlags.canCopy !== false) {
    sections.push([
      { label: 'Copy', role: 'copy', enabled: editFlags.canCopy ?? true },
    ]);
  }

  if (safeParams.mediaType === 'image') {
    const imageItems = [];
    // An image with no pixels (not loaded, or broken) has nothing to copy
    if (safeParams.hasImageContents === true) {
      imageItems.push({
        label: 'Copy picture',
        click: () => actions.copyImageAt(safeParams.x ?? 0, safeParams.y ?? 0),
      });
    }
    const srcURL = typeof safeParams.srcURL === 'string' ? safeParams.srcURL.trim() : '';
    const workspacePic = srcURL ? parseWorkspacePictureUrl(srcURL, appPort) : null;
    if (srcURL) {
      if (workspacePic || isDownloadablePictureUrl(srcURL)) {
        imageItems.push({
          label: 'Save picture as…',
          click: () => actions.downloadURL(workspacePic ? workspacePic.downloadUrl : srcURL),
        });
      }
      imageItems.push({
        label: 'Copy picture address',
        click: () => actions.writeText(srcURL),
      });
    }
    if (workspacePic?.filePath) {
      imageItems.push({
        label: 'Copy file path',
        click: () => actions.writeText(workspacePic.filePath),
      });
    }
    if (imageItems.length > 0) sections.push(imageItems);
  }

  const linkURL = typeof safeParams.linkURL === 'string' ? safeParams.linkURL.trim() : '';
  if (linkURL) {
    const linkItems = [];
    if (isAppShellNavigation(linkURL, appPort)) {
      linkItems.push({
        label: 'Open link',
        click: () => actions.loadURL(linkURL),
      });
    } else {
      const external = externalLinkTarget(linkURL, appPort);
      if (external) {
        linkItems.push({
          label: 'Open link',
          click: () => actions.openExternal(external),
        });
      }
    }
    linkItems.push({
      label: 'Copy link address',
      click: () => actions.writeText(linkURL),
    });
    sections.push(linkItems);
  }

  if (sections.length === 0) return [];

  const template = [];
  for (let i = 0; i < sections.length; i++) {
    if (i > 0) template.push({ type: 'separator' });
    template.push(...sections[i]);
  }
  return template;
}
