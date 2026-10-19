import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { safeCopyToClipboard } from '../lib/clipboard.js';
import { cn } from '../lib/utils.js';
import { classifyMarkdownLink, headingSlug, type MarkdownLinkContext } from './markdownLinks.js';

const remarkPlugins = [remarkGfm];

// Every URL is classified by `classifyMarkdownLink` below; nothing reaches the
// DOM unchecked, so the default transform (which blanks Windows paths) is not needed.
const keepUrl = (url: string) => url;

/** Lets links in a document open workspace files in the surrounding viewer. */
export interface MarkdownDocumentLinks extends MarkdownLinkContext {
  onOpenFile: (path: string) => void;
  fileUrl: (path: string) => string;
}

interface ChatMarkdownProps {
  content: string;
  links?: MarkdownDocumentLinks;
}

function nodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function CodeBlock({ children, ...props }: React.ComponentProps<'pre'> & { node?: unknown }) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);
  const text = nodeText(children).replace(/\r?\n$/, '');

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  return (
    <div className="group/code relative my-3">
      <pre {...props} className={cn('m-0 overflow-x-auto rounded-lg border border-border/80 bg-muted/60 p-3.5 pr-9 text-xs font-mono text-foreground', props.className)}>
        {children}
      </pre>
      {text && (
        <button
          type="button"
          aria-label={copied ? 'Code copied' : 'Copy code block'}
          title={copied ? 'Copied' : 'Copy code'}
          className="absolute right-2 top-2 flex size-6 cursor-pointer items-center justify-center rounded border border-border/70 bg-background/80 text-muted-foreground opacity-0 backdrop-blur-xs transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            void safeCopyToClipboard(text).then((ok) => {
              setCopied(ok);
              if (ok) {
                if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
                copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
              }
            });
          }}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}

function LocalPath({ label, children }: { label: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <span className="underline decoration-dotted underline-offset-2" title={label ? `Local path — not available in the app: ${label}` : undefined}>{children}</span>
      {label && (
        <button
          type="button"
          className="not-prose inline-flex size-4 translate-y-0.5 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={copied ? 'Path copied' : `Copy path ${label}`}
          title={copied ? 'Copied' : 'Copy path'}
          onClick={() => { void safeCopyToClipboard(label).then((ok) => { setCopied(ok); if (ok) setTimeout(() => setCopied(false), 1500); }); }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      )}
    </span>
  );
}

export const ChatMarkdown: React.FC<ChatMarkdownProps> = ({ content, links }) => {
  const container = useRef<HTMLDivElement>(null);

  const components = useMemo<Components>(() => {
    const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ({ node: _node, children, ...props }: React.ComponentProps<typeof Tag> & { node?: unknown }) =>
        <Tag id={headingSlug(nodeText(children)) || undefined} {...props}>{children}</Tag>;

    return {
      h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      a: ({ node: _node, href, children, ...props }) => {
        const target = classifyMarkdownLink(href, links);
        if (target.kind === 'anchor') {
          return <a {...props} href={`#${target.id}`} onClick={(event) => {
            // The app routes on the hash, so letting this through would leave the page.
            event.preventDefault();
            container.current?.querySelector(`[id="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: 'start' });
          }}>{children}</a>;
        }
        if (target.kind === 'external') {
          return <a {...props} href={target.href} target="_blank" rel="noopener noreferrer">
            {children}<ExternalLink aria-hidden="true" className="ml-0.5 inline size-3 align-baseline" /><span className="sr-only"> (opens outside the app)</span>
          </a>;
        }
        if (target.kind === 'workspace-file' && links) {
          return <a {...props} href={links.fileUrl(target.path)} onClick={(event) => {
            event.preventDefault();
            links.onOpenFile(target.path);
          }}>{children}</a>;
        }
        return <LocalPath label={target.kind === 'inert' ? target.label : target.path}>{children}</LocalPath>;
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      img: ({ node: _node, src, alt, ...props }) => {
        const target = classifyMarkdownLink(typeof src === 'string' ? src : undefined, links);
        if (target.kind === 'external' && !target.href.startsWith('mailto:')) return <img {...props} src={target.href} alt={alt ?? ''} />;
        if (target.kind === 'workspace-file' && links) return <img {...props} src={links.fileUrl(target.path)} alt={alt ?? ''} />;
        return <LocalPath label={target.kind === 'inert' ? target.label : ''}>{`[image${alt ? `: ${alt}` : ''}]`}</LocalPath>;
      },
      pre: CodeBlock,
    };
  }, [links]);

  return (
    <div ref={container} className="prose prose-sm max-w-none text-foreground prose-a:text-primary prose-code:text-foreground prose-headings:text-foreground prose-pre:border prose-pre:border-border prose-pre:bg-muted/50 prose-strong:text-foreground prose-li:marker:text-muted-foreground">
      <ReactMarkdown remarkPlugins={remarkPlugins} urlTransform={keepUrl} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
};
