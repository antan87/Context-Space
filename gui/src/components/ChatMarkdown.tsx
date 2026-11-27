import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { safeCopyToClipboard } from '../lib/clipboard.js';
import { SourceBlock } from './sourceLines.js';
import type { Element, Root } from 'hast';
import { sourceLineRange, type LineRange } from '../features/board/lineNotes.js';
import { Diagram } from './Diagram.js';
import { cn } from '../lib/utils.js';
import { classifyMarkdownLink, headingSlug, type MarkdownLinkContext } from './markdownLinks.js';

const remarkPlugins = [remarkGfm];

// Every URL is classified by `classifyMarkdownLink` below; nothing reaches the
// DOM unchecked, so the default transform (which blanks Windows paths) is not needed.
const keepUrl = (url: string) => url;

/** Lets links in a document open workspace files in the surrounding viewer. */
export interface MarkdownDocumentLinks extends MarkdownLinkContext {
  onOpenFile: (path: string, line?: number, opener?: HTMLElement | null) => void;
  fileUrl: (path: string) => string;
}

const MarkdownInLinkContext = createContext(false);

function markdownImageLabel(path: string, alt?: string): string {
  const cleanAlt = (alt ?? '').trim();
  if (cleanAlt) return cleanAlt;
  const clean = path.replace(/[\\/]+$/, '');
  const base = clean.split(/[\\/]/).pop() ?? clean;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

type SourceLayout = (blocks: LineRange[], children: React.ReactNode) => React.ReactNode;

interface ChatMarkdownProps {
  renderSource?: SourceLayout;
  content: string;
  links?: MarkdownDocumentLinks;
  /**
   * The text sits on a card of the board, where a press on a link must not start a drag or a pan, and where only what opens
   * is a link: the web, and the files of the workspace. Mail and in-page links, anything else, and pictures are plain text,
   * and a heading is a bold line. The copy button of a code block does not start a drag either.
   */
  onCard?: boolean;
  /**
   * On a card: the card shows only the start of the text, so some of its links and buttons may be in the part that is cut off,
   * where they cannot be seen. None of them is a stop for the keyboard (the whole text is one press away, where all of them are).
   */
  cut?: boolean;
  /** Compact dialog/panel variant: keeps headings semantic and links intact, while scaling headings calmly to <= 15 px. */
  compact?: boolean;
}

function nodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function CodeBlock({ children, onCard = false, cut = false, ...props }: React.ComponentProps<'pre'> & { node?: unknown; onCard?: boolean; cut?: boolean }) {
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
          tabIndex={cut ? -1 : undefined}
          className={cn('absolute right-2 top-2 flex size-6 cursor-pointer items-center justify-center rounded border border-border/70 bg-background/80 text-muted-foreground opacity-0 backdrop-blur-xs transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', onCard && 'nodrag nopan')}
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

interface MarkdownRenderConfig {
  renderSource?: SourceLayout;
  links?: MarkdownDocumentLinks;
  onCard: boolean;
  cut: boolean;
  compact: boolean;
  scrollToAnchor: (id: string) => void;
}

const MarkdownRenderContext = createContext<MarkdownRenderConfig>({
  onCard: false,
  cut: false,
  compact: false,
  scrollToAnchor: () => {},
});

function makeHeading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function MarkdownHeading({ node, children, className, ...props }: React.ComponentProps<typeof Tag> & { node?: Element }) {
    const { onCard, compact } = useContext(MarkdownRenderContext);
    // On a card a heading is only a bold line: the card has its own title, and its ids would repeat from card to card.
    if (onCard) return <p className="font-semibold">{children}</p>;
    const compactClass = compact
      ? Tag === 'h1'
        ? 'mt-3 mb-1 first:mt-0 text-[15px] font-semibold leading-5 text-foreground'
        : 'mt-2.5 mb-1 first:mt-0 text-[14px] font-semibold leading-5 text-foreground'
      : undefined;
    return <SourceBlock node={node}><Tag id={headingSlug(nodeText(children)) || undefined} {...props} className={cn(className, compactClass)}>{children}</Tag></SourceBlock>;
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MarkdownAnchor({ node: _node, href, children, className, ...props }: React.ComponentProps<'a'> & { node?: unknown }) {
  const { links, onCard, cut, scrollToAnchor } = useContext(MarkdownRenderContext);
  const target = classifyMarkdownLink(href, links);
  // On a card only the web and the workspace's files are links: the rest is the text it says.
  if (onCard && !(target.kind === 'external' && !target.href.startsWith('mailto:')) && !(target.kind === 'workspace-file' && links)) return <>{children}</>;
  const linkClass = onCard ? cn(className, 'nodrag nopan') : className;
  const tabIndex = onCard && cut ? -1 : undefined;
  const wrapped = <MarkdownInLinkContext.Provider value={true}>{children}</MarkdownInLinkContext.Provider>;
  if (target.kind === 'anchor') {
    return <a {...props} className={linkClass} tabIndex={tabIndex} href={`#${target.id}`} onClick={(event) => {
      // The app routes on the hash, so letting this through would leave the page.
      event.preventDefault();
      scrollToAnchor(target.id);
    }}>{wrapped}</a>;
  }
  if (target.kind === 'external') {
    return <a {...props} className={linkClass} tabIndex={tabIndex} href={target.href} target="_blank" rel="noopener noreferrer">
      {wrapped}<ExternalLink aria-hidden="true" className="ml-0.5 inline size-3 align-baseline" /><span className="sr-only"> (opens outside the app)</span>
    </a>;
  }
  if (target.kind === 'workspace-file' && links) {
    return <a {...props} className={linkClass} tabIndex={tabIndex} href={links.fileUrl(target.path)} onClick={(event) => {
      event.preventDefault();
      links.onOpenFile(target.path, target.line, event.currentTarget);
    }}>{wrapped}</a>;
  }
  return <LocalPath label={target.kind === 'inert' ? target.label : target.path}>{wrapped}</LocalPath>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MarkdownImage({ node: _node, src, alt, className, ...props }: React.ComponentProps<'img'> & { node?: unknown }) {
  const { links, onCard } = useContext(MarkdownRenderContext);
  const insideLink = useContext(MarkdownInLinkContext);
  if (onCard) return <>{`[image${alt ? `: ${alt}` : ''}]`}</>;
  const target = classifyMarkdownLink(typeof src === 'string' ? src : undefined, links && { ...links, resolveReferences: false });
  if (target.kind === 'external' && !target.href.startsWith('mailto:')) return <img {...props} className={className} src={target.href} alt={alt ?? ''} />;
  if (target.kind === 'workspace-file' && links) {
    const fileUrl = links.fileUrl(target.path);
    if (!fileUrl || insideLink) return <img {...props} className={className} src={fileUrl} alt={alt ?? ''} />;
    const label = markdownImageLabel(target.path, alt);
    return (
      <button
        type="button"
        data-markdown-image=""
        data-path={target.path}
        aria-label={label}
        title={label}
        className="not-prose my-2 inline-flex min-h-6 min-w-6 max-w-full cursor-pointer items-center justify-center rounded align-middle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={(event) => {
          links.onOpenFile(target.path, undefined, event.currentTarget);
        }}
      >
        <img {...props} className={cn(className, '!my-0 max-w-full rounded')} src={fileUrl} alt={alt ?? ''} />
      </button>
    );
  }
  return <LocalPath label={target.kind === 'inert' ? target.label : ''}>{`[image${alt ? `: ${alt}` : ''}]`}</LocalPath>;
}

function MarkdownPre(props: React.ComponentProps<'pre'> & { node?: Element }) {
  const { onCard, cut } = useContext(MarkdownRenderContext);
  const code = React.Children.toArray(props.children)[0];
  if (React.isValidElement<{ className?: string }>(code) && code.props.className?.split(' ').includes('language-mermaid')) {
    return <SourceBlock node={props.node}><Diagram source={nodeText(props.children).replace(/\r?\n$/, '')} cut={cut}
      code={<CodeBlock {...props} onCard={onCard} cut={cut} />} /></SourceBlock>;
  }
  return <SourceBlock node={props.node}><CodeBlock {...props} onCard={onCard} cut={cut} /></SourceBlock>;
}

// Read the same HAST that is about to render, stopping where SourceBlock owns a whole block.
type SourceLayoutData = NonNullable<Element['data']> & { readerSourceBlocks?: LineRange[] };
const sourceBlockTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'hr', 'blockquote', 'ul', 'ol', 'table']);
function rehypeSourceLayout() {
  return (tree: Root) => {
    const blocks: LineRange[] = [];
    const visit = (node: Root['children'][number]) => {
      if (node.type !== 'element') return;
      const range = sourceBlockTags.has(node.tagName) ? sourceLineRange(node.position) : null;
      if (range) blocks.push(range);
      else node.children.forEach(visit);
    };
    tree.children.forEach(visit);
    blocks.sort((a, b) => a.line - b.line);
    const data: SourceLayoutData = { readerSourceBlocks: blocks };
    tree.children = [{ type: 'element', tagName: 'div', properties: {}, data, children: tree.children.filter(node => node.type !== 'doctype') }];
  };
}
const sourceLayoutPlugins = [rehypeSourceLayout];
function MarkdownSourceLayout({ node, children, ...props }: React.ComponentProps<'div'> & { node?: Element }) {
  const { renderSource } = useContext(MarkdownRenderContext);
  const blocks = (node?.data as SourceLayoutData | undefined)?.readerSourceBlocks;
  // This provider boundary adds no wrapper to the rendered document.
  if (renderSource && Array.isArray(blocks)) return <>{renderSource(blocks, children)}</>;
  return <div {...props}>{children}</div>;
}

// Keep components identity constant across prop/link updates so live links are not unmounted while focused or returning focus.
const MARKDOWN_COMPONENTS: Components = {
  h1: makeHeading('h1'),
  h2: makeHeading('h2'),
  h3: makeHeading('h3'),
  h4: makeHeading('h4'),
  h5: makeHeading('h5'),
  h6: makeHeading('h6'),
  a: MarkdownAnchor,
  img: MarkdownImage,
  pre: MarkdownPre,
  hr: ({ node, ...props }) => <SourceBlock node={node}><hr {...props} /></SourceBlock>,
  p: ({ node, children, ...props }) => <SourceBlock node={node}><p {...props}>{children}</p></SourceBlock>,
  blockquote: ({ node, children, ...props }) => <SourceBlock node={node}><blockquote {...props}>{children}</blockquote></SourceBlock>,
  ul: ({ node, children, ...props }) => <SourceBlock node={node}><ul {...props}>{children}</ul></SourceBlock>,
  ol: ({ node, children, ...props }) => <SourceBlock node={node}><ol {...props}>{children}</ol></SourceBlock>,
  table: ({ node, children, ...props }) => <SourceBlock node={node}><table {...props}>{children}</table></SourceBlock>,
};

const SOURCE_MARKDOWN_COMPONENTS: Components = { ...MARKDOWN_COMPONENTS, div: MarkdownSourceLayout };

export const ChatMarkdown: React.FC<ChatMarkdownProps> = ({ content, links, onCard = false, cut = false, compact = false, renderSource }) => {
  const container = useRef<HTMLDivElement>(null);
  const scrollToAnchor = useCallback((id: string) => {
    container.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
  }, []);
  const renderConfig = useMemo<MarkdownRenderConfig>(
    () => ({ links, onCard, cut, compact, scrollToAnchor, renderSource }),
    [links, onCard, cut, compact, scrollToAnchor, renderSource],
  );

  return (
    <div ref={container} className="prose prose-sm max-w-none text-foreground prose-a:text-primary prose-code:text-foreground prose-headings:text-foreground prose-pre:border prose-pre:border-border prose-pre:bg-muted/50 prose-strong:text-foreground prose-li:marker:text-muted-foreground">
      <MarkdownRenderContext.Provider value={renderConfig}>
        <ReactMarkdown rehypePlugins={renderSource ? sourceLayoutPlugins : undefined} remarkPlugins={remarkPlugins} urlTransform={keepUrl} components={renderSource ? SOURCE_MARKDOWN_COMPONENTS : MARKDOWN_COMPONENTS}>
          {content}
        </ReactMarkdown>
      </MarkdownRenderContext.Provider>
    </div>
  );
};
