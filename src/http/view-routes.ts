import type { Hono, Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  computeFileEtag,
  createFileByteStream,
  defaultViewTokenStore,
  isSegmentsAllowedInScope,
  issueWorkspaceViewLink,
  matchesIfNoneMatch,
  openScopedViewFile,
  parseSingleByteRange,
  parseViewRequestPath,
  viewMimeType,
  ViewLinkInputError,
  ViewNotFoundError,
  type OpenScopedFileResult,
  type ViewTokenStore,
} from '../services/workspace-file-stream.js';

/**
 * Validates that the Host header corresponds to loopback/localhost only.
 * Rejects external DNS hostnames like evil.test, arbitrary IPs, or unbracketed IPv6.
 */
export function isAllowedLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const trimmed = hostHeader.trim();
  if (!trimmed) return true;

  let hostname = trimmed;
  if (trimmed.startsWith('[')) {
    const closeIndex = trimmed.indexOf(']');
    if (closeIndex === -1) return false;
    hostname = trimmed.slice(1, closeIndex);
    const rest = trimmed.slice(closeIndex + 1);
    if (rest && !/^:\d+$/.test(rest)) return false;
  } else {
    const colonCount = (trimmed.match(/:/g) || []).length;
    if (colonCount > 1) return false;
    if (colonCount === 1) {
      hostname = trimmed.split(':')[0]!;
    }
  }

  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Guards mutating view endpoints against cross-site requests.
 * Rejects Sec-Fetch-Site: cross-site and non-local Origin/Referer headers (including Origin: null).
 */
export function isTrustedSameOriginPost(c: Context): boolean {
  const secFetchSite = c.req.header('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    return false;
  }

  const origin = c.req.header('origin');
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      if (!isLocalHostname(parsed.hostname)) return false;
    } catch {
      return false;
    }
  }

  const referer = c.req.header('referer');
  if (referer !== undefined) {
    try {
      const parsed = new URL(referer);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      if (!isLocalHostname(parsed.hostname)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

const notFoundResponse = () =>
  new Response('Not Found', {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });

export function registerViewRoutes(
  app: Hono,
  resolveWorkspace: (id: string) => Promise<string | null>,
  options?: { store?: ViewTokenStore }
): void {
  const store = options?.store ?? defaultViewTokenStore;

  // 1. Same-origin view link generation endpoint
  const bounded = bodyLimit({ maxSize: 16_000 });
  const viewLinkBodySchema = z
    .object({
      name: z.string().trim().min(1).max(1024),
    })
    .strict();

  app.post('/api/workspace/:id/documents/view-link', bounded, async (c) => {
    if (!isAllowedLocalHost(c.req.header('host'))) {
      return c.json({ error: 'Forbidden: invalid Host header.' }, 403);
    }

    if (!isTrustedSameOriginPost(c)) {
      return c.json({ error: 'Forbidden cross-site request.' }, 403);
    }

    let parsedBody: z.infer<typeof viewLinkBodySchema>;
    try {
      const raw = await c.req.json();
      parsedBody = viewLinkBodySchema.parse(raw);
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues[0]?.message ?? 'Invalid request body.'
          : 'Invalid request body.';
      return c.json({ error: message }, 400);
    }

    const id = c.req.param('id');
    const root = await resolveWorkspace(id);
    if (!root) {
      return c.json({ error: 'Workspace not found.' }, 404);
    }

    try {
      const result = await issueWorkspaceViewLink({
        workspaceId: id,
        workspaceRoot: root,
        name: parsedBody.name,
        store,
      });
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof z.ZodError || err instanceof ViewLinkInputError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof ViewNotFoundError) {
        return c.json({ error: 'Document not found.' }, 404);
      }
      return c.json({ error: 'Could not create view link.' }, 500);
    }
  });

  // 2. Read-only streaming /view and /view/* route
  const handleViewRequest = async (c: Context) => {
    if (!isAllowedLocalHost(c.req.header('host'))) {
      return new Response('Forbidden: invalid Host header', {
        status: 403,
        headers: { 'X-Content-Type-Options': 'nosniff' },
      });
    }

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          Allow: 'GET, HEAD',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }

    const incomingUrl = (c.env as { incoming?: { url?: string } } | undefined)?.incoming?.url;
    const rawTarget =
      typeof incomingUrl === 'string' && incomingUrl.startsWith('/')
        ? incomingUrl.split(/[?#]/)[0]!
        : c.req.url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/, '').split(/[?#]/)[0]!;

    const parsed = parseViewRequestPath(rawTarget);
    if (!parsed) return notFoundResponse();

    const entry = store.get(parsed.token);
    if (!entry) return notFoundResponse();

    if (!isSegmentsAllowedInScope(parsed.segments, entry)) return notFoundResponse();

    const fileName = parsed.segments[parsed.segments.length - 1]!;
    const mime = viewMimeType(fileName);
    if (!mime) return notFoundResponse();

    let opened: OpenScopedFileResult;
    try {
      opened = await openScopedViewFile(entry.workspaceRoot, parsed.segments);
    } catch (err) {
      if (err instanceof ViewNotFoundError) {
        return notFoundResponse();
      }
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
      });
    }

    let handedToStream = false;
    try {
      const etag = computeFileEtag(opened.size, opened.mtimeNs);
      const commonHeaders: Record<string, string> = {
        'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      };

      if (matchesIfNoneMatch(c.req.header('if-none-match'), etag)) {
        return new Response(null, {
          status: 304,
          headers: commonHeaders,
        });
      }

      const rangeHeader = c.req.header('range');
      if (rangeHeader) {
        const range = parseSingleByteRange(rangeHeader, opened.size);
        if (range.kind === 'unsatisfiable') {
          return new Response(null, {
            status: 416,
            headers: {
              ...commonHeaders,
              'Content-Range': `bytes */${opened.size}`,
            },
          });
        }
        const start = range.start;
        const end = range.end;
        const contentLength = end - start + 1;
        const headers: Record<string, string> = {
          ...commonHeaders,
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${opened.size}`,
          'Content-Length': String(contentLength),
        };
        if (c.req.method === 'HEAD') {
          return new Response(null, { status: 206, headers });
        }
        handedToStream = true;
        const stream = createFileByteStream(opened.handle, start, end, c.req.raw?.signal);
        return new Response(stream, { status: 206, headers });
      }

      const headers: Record<string, string> = {
        ...commonHeaders,
        'Content-Type': mime,
        'Content-Length': String(opened.size),
      };

      if (c.req.method === 'HEAD' || opened.size === 0) {
        return new Response(null, { status: 200, headers });
      }

      handedToStream = true;
      const stream = createFileByteStream(opened.handle, 0, opened.size - 1, c.req.raw?.signal);
      return new Response(stream, { status: 200, headers });
    } finally {
      if (!handedToStream) {
        await opened.handle.close().catch(() => {});
      }
    }
  };

  app.all('/view', handleViewRequest);
  app.all('/view/*', handleViewRequest);
}
