import * as path from 'node:path';
import { readPlanningNotes, savePlanningNotes } from '../core/planning-notes.js';
import type { Hono, Context, Handler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { addWorkDocument, getWorkContext, readWorkDocument, updateWorkDocument, updateWorkGuidance } from '../core/work-guidance.js';
import { loadWorkspaceLifecycle, updateLifecyclePlan } from '../core/lifecycle.js';
import { listRootDocuments, readRootDocument } from '../core/root-documents.js';
import { refreshPlanningContext } from '../core/planning-refresh.js';
import { loadFeatureConfig } from '../core/workspace.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';

/** The workspace-relative folders that hold a repository's checkout. A repository outside the workspace folder has none. */
async function repositoryFolders(root: string): Promise<string[]> {
  try {
    const feature = await loadFeatureConfig(root);
    if (!feature) return [];
    return feature.repos.flatMap((repoPath) => {
      const relative = path.relative(root, resolveFeatureRepoPath(feature, root, repoPath));
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? [relative.split(path.sep).join('/')] : [];
    });
  } catch {
    // The listing of documents does not depend on the manifest being readable; without it every data file is listed.
    return [];
  }
}

/** Mounted behind the server's existing local-origin boundary. */
export function registerWorkGuidanceRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  const bounded = bodyLimit({ maxSize: 600_000 });
  const handle = (action: (workspacePath: string, c: Context) => Promise<object>): Handler => async (c) => {
    try {
      const root = await resolveWorkspace(z.string().min(1).parse(c.req.param('id')));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json(await action(root, c));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, error instanceof z.ZodError ? 400 : /changed.*session|Reload/.test(message) ? 409 : 400);
    }
  };
  app.get('/api/workspace/:id/planning-notes', handle((root) => readPlanningNotes(root)));
  app.get('/api/workspace/:id/documents', handle(async (root, c) => {
    const folder = c.req.query('folder') ?? '';
    const recursive = c.req.query('recursive') === '1';
    return listRootDocuments(root, folder, recursive, { repoFolders: await repositoryFolders(root) });
  }));
  app.get('/api/workspace/:id/documents/preview', handle(async (root, c) => {
    const { bytes: _bytes, ...document } = await readRootDocument(root, c.req.query('name') ?? '');
    return document;
  }));
  app.get('/api/workspace/:id/documents/file', async (c) => {
    try {
      const root = await resolveWorkspace(c.req.param('id'));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      const download = c.req.query('download') === '1';
      const open = c.req.query('open') === '1';
      const document = await readRootDocument(root, c.req.query('name') ?? '', download);
      c.header('Content-Type', document.mime);
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Cache-Control', 'no-store');
      if (open) {
        // "Open in browser" renders the document as authored: scripts, remote stylesheets, webfonts
        // and images all work, which is the whole point, since the in-app preview deliberately
        // blocks all of them.
        //
        // The `sandbox` CSP directive without `allow-same-origin` is what keeps this safe. It puts
        // the document on an opaque origin, so it cannot read this app's cookies or localStorage,
        // and it inherits no privileges from being served here. Deliberately absent:
        // `allow-same-origin` (would undo the isolation) and `allow-popups-to-escape-sandbox` (a new
        // tab that is no longer constrained at all).
        //
        // Residual risk, stated plainly: an opaque origin can still *send* cross-origin requests, so
        // this document could issue a blind POST to the local API. CORS stops it reading any
        // response, and the local dashboard has no session to ride, but it is not a hard boundary
        // against a hostile document. Opening one is always an explicit user action on a file the
        // user chose.
        c.header('Content-Security-Policy', [
          'sandbox allow-scripts allow-popups allow-forms allow-modals',
          "default-src * data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
        ].join('; '));
      } else {
        // Default delivery stays locked down: never executes, never renders in the app origin.
        c.header('Content-Security-Policy', "sandbox; default-src 'none'");
      }
      const filename = document.name.split('/').pop() ?? document.name;
      // `download=1` always attaches, `open=1` always renders, and otherwise only non-HTML,
      // non-download kinds render in place.
      const inline = !download && (open || (document.kind !== 'download' && document.kind !== 'html'));
      c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`);
      return c.body(new Uint8Array(document.bytes));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unable to open document.' }, 400);
    }
  });
  app.put('/api/workspace/:id/planning-notes', bounded, handle(async (root, c) => {
    const input = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().max(500_000) }).parse(await c.req.json());
    return { ...(await savePlanningNotes(root, input.revision, input.content)), ...(await refreshPlanningContext(root)) };
  }));
  app.get('/api/workspace/:id/work', handle(async (root) => {
    // Only to move an older lifecycle into the plan. The brief shows no branches, so it skips the fleet's git work.
    await loadWorkspaceLifecycle(root, { includeFleet: false });
    return getWorkContext(root);
  }));
  app.put('/api/workspace/:id/work', bounded, handle(async (root, c) => {
    await updateWorkGuidance(root, await c.req.json());
    return { ...(await getWorkContext(root)), ...(await refreshPlanningContext(root)) };
  }));
  app.post('/api/workspace/:id/work/documents', bounded, handle(async (root, c) => {
    const { revision, ...input } = await c.req.json();
    await addWorkDocument(root, z.number().int().nonnegative().parse(revision), input);
    return { ...(await getWorkContext(root)), ...(await refreshPlanningContext(root)) };
  }));
  app.patch('/api/workspace/:id/work/documents/:documentId', bounded, handle(async (root, c) => {
    const { revision, ...input } = await c.req.json();
    await updateWorkDocument(root, z.string().uuid().parse(c.req.param('documentId')), z.number().int().nonnegative().parse(revision), input);
    return { ...(await getWorkContext(root)), ...(await refreshPlanningContext(root)) };
  }));
  app.get('/api/workspace/:id/work/documents/:documentId', handle((root, c) => readWorkDocument(root, z.string().uuid().parse(c.req.param('documentId')))));
  app.put('/api/workspace/:id/lifecycle/plan', bounded, handle(async (root, c) => {
    const lifecycle = await updateLifecyclePlan(root, await c.req.json());
    return { lifecycle, ...(await refreshPlanningContext(root)) };
  }));
}
