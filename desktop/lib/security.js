/**
 * Pure renderer-origin and IPC-sender checks used by the Electron main
 * process. Keep these independent from Electron so hostile URL cases can be
 * tested without launching a window.
 */

export function exactLocalOrigin(port) {
  return `http://localhost:${String(port)}`;
}

export function isExactLocalOrigin(candidate, port) {
  if (!Number.isInteger(Number(port)) || Number(port) <= 0 || Number(port) > 65535) return false;
  try {
    const url = new URL(String(candidate));
    if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.username || url.password) return false;
    return url.origin === exactLocalOrigin(port);
  } catch {
    return false;
  }
}

export function isTrustedIpcEvent(event, mainWindow, assignedPort) {
  const webContents = mainWindow?.webContents;
  if (!webContents || !event || event.sender !== webContents) return false;
  if (!event.senderFrame || event.senderFrame !== webContents.mainFrame) return false;
  return isExactLocalOrigin(event.senderFrame.url, assignedPort);
}

/**
 * The renderer is a single-page app served from `/`; in-app routes live in the
 * hash. Any other path on the local origin is not part of the app, and loading
 * it strands the window (the desktop app has no back button).
 */
export function isAppShellNavigation(candidate, port) {
  if (!isExactLocalOrigin(candidate, port)) return false;
  const { pathname } = new URL(String(candidate));
  return pathname === '/' || pathname === '/index.html';
}

/**
 * Validates whether a local URL is an explicit document preview meant to render
 * in the user's external browser (`/api/workspace/:id/documents/file?open=1`).
 */
export function isDocumentBrowserOpenUrl(candidate, assignedPort) {
  if (!Number.isInteger(Number(assignedPort)) || Number(assignedPort) <= 0 || Number(assignedPort) > 65535) return false;
  try {
    const url = new URL(String(candidate));
    if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.username || url.password) return false;
    if (url.origin !== exactLocalOrigin(assignedPort)) return false;
    if (!/^\/api\/workspace\/[^/]+\/documents\/file$/.test(url.pathname)) return false;
    return url.searchParams.get('open') === '1';
  } catch {
    return false;
  }
}

/**
 * Web and mail links a user clicks in rendered content open in the system
 * handler, never inside the app window. Local-network and credentialed URLs
 * are refused so a link cannot reach the dashboard server or smuggle secrets,
 * except explicit local document preview URLs opened with `open=1`.
 */
export function externalLinkTarget(candidate, assignedPort) {
  try {
    const url = new URL(String(candidate));
    if (url.protocol === 'mailto:') return url.href;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLocalhost = host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1' || /^127\./.test(host);
    if (isLocalhost) {
      if (assignedPort !== undefined && isDocumentBrowserOpenUrl(url.href, assignedPort)) {
        return url.href;
      }
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
