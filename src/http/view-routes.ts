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
 * What the trusted page's frame sends the app when Escape is pressed in it.
 * Must match the message in gui/src/features/work-guidance/previewPolicy.ts.
 */
export const ESCAPE_MESSAGE = 'contextspace:escape';

/**
 * Injected into HTML documents served inside an iframe to fit wider pages and relay Escape.
 */
export const FIT_SCRIPT = `(function(){var frame=0,seen=new WeakSet(),watcher=window.ResizeObserver?new ResizeObserver(later):null;function watch(el){if(watcher&&!seen.has(el)){seen.add(el);watcher.observe(el)}}function fit(){var body=document.body,root=document.documentElement;if(!body)return;watch(root);watch(body);for(var i=0;i<body.children.length&&i<40;i++)watch(body.children[i]);body.style.zoom='';var room=root.clientWidth,wide=Math.max(root.scrollWidth,body.scrollWidth);if(room>0&&wide>room+1)body.style.zoom=String(Math.max(0.5,room/wide))}function later(){cancelAnimationFrame(frame);frame=requestAnimationFrame(fit)}addEventListener('resize',later);addEventListener('load',later,true);document.addEventListener('DOMContentLoaded',later);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(later);[150,600,1800].forEach(function(ms){setTimeout(later,ms)});addEventListener('keydown',function(event){if(event.key==='Escape'&&!event.defaultPrevented)parent.postMessage('${ESCAPE_MESSAGE}','*')})})()`;

/**
 * Creates a stream that injects FIT_SCRIPT into HTML responses right after <head> or <html>.
 * Scans only up to 64 KB, then passes all subsequent chunks directly with zero overhead.
 */
export function createHtmlRelayStream(
  sourceStream: ReadableStream<Uint8Array>,
  scriptContent: string = FIT_SCRIPT,
): ReadableStream<Uint8Array> {
  const scriptTag = `<script>${scriptContent}</script>`;
  const scriptBytes = Buffer.from(scriptTag, 'utf-8');
  let injected = false;
  let bufferedChunks: Uint8Array[] = [];
  let bufferedLen = 0;
  const MAX_HEAD_SCAN_BYTES = 64 * 1024;

  const reader = sourceStream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (injected) {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
        return;
      }

      while (!injected) {
        const { value, done } = await reader.read();
        if (done) {
          const combined = Buffer.concat(bufferedChunks);
          const str = combined.toString('utf-8');
          const headIndex = str.search(/<head\b[^>]*>/i);
          if (headIndex !== -1) {
            const match = str.match(/<head\b[^>]*>/i)![0];
            const insertPos = headIndex + match.length;
            controller.enqueue(
              Buffer.concat([
                combined.subarray(0, insertPos),
                scriptBytes,
                combined.subarray(insertPos),
              ]),
            );
          } else {
            const htmlIndex = str.search(/<html\b[^>]*>/i);
            if (htmlIndex !== -1) {
              const match = str.match(/<html\b[^>]*>/i)![0];
              const insertPos = htmlIndex + match.length;
              controller.enqueue(
                Buffer.concat([
                  combined.subarray(0, insertPos),
                  scriptBytes,
                  combined.subarray(insertPos),
                ]),
              );
            } else {
              controller.enqueue(Buffer.concat([scriptBytes, combined]));
            }
          }
          injected = true;
          controller.close();
          return;
        }

        bufferedChunks.push(value);
        bufferedLen += value.length;

        const combined = Buffer.concat(bufferedChunks);
        const str = combined.toString('utf-8');
        const headMatch = str.match(/<head\b[^>]*>/i);
        if (headMatch && headMatch.index !== undefined) {
          const insertPos = headMatch.index + headMatch[0].length;
          const headChunk = Buffer.concat([
            combined.subarray(0, insertPos),
            scriptBytes,
          ]);
          controller.enqueue(headChunk);
          const rest = combined.subarray(insertPos);
          if (rest.length > 0) {
            controller.enqueue(rest);
          }
          bufferedChunks = [];
          injected = true;
          return;
        }

        if (bufferedLen >= MAX_HEAD_SCAN_BYTES) {
          controller.enqueue(Buffer.concat([scriptBytes, combined]));
          bufferedChunks = [];
          injected = true;
          return;
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

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
        const isDownload = c.req.query('download') === '1';
        const headers: Record<string, string> = {
          ...commonHeaders,
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${opened.size}`,
          'Content-Length': String(contentLength),
          ...(isDownload
            ? { 'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"` }
            : {}),
        };
        if (c.req.method === 'HEAD') {
          return new Response(null, { status: 206, headers });
        }
        handedToStream = true;
        const stream = createFileByteStream(opened.handle, start, end, c.req.raw?.signal);
        return new Response(stream, { status: 206, headers });
      }

      const isIframe = c.req.header('sec-fetch-dest') === 'iframe' || c.req.query('frame') === '1';
      const isHtml = mime.startsWith('text/html');
      const isDownload = c.req.query('download') === '1';

      const headers: Record<string, string> = {
        ...commonHeaders,
        'Content-Type': mime,
        ...(isDownload
          ? { 'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"` }
          : {}),
      };

      if (!isIframe || !isHtml) {
        headers['Content-Length'] = String(opened.size);
      }

      if (c.req.method === 'HEAD' || opened.size === 0) {
        return new Response(null, { status: 200, headers });
      }

      handedToStream = true;
      const rawStream = createFileByteStream(opened.handle, 0, opened.size - 1, c.req.raw?.signal);
      const stream = isIframe && isHtml ? createHtmlRelayStream(rawStream) : rawStream;
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
