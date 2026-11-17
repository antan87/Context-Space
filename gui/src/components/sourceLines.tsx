import { createContext, useContext, type ReactNode } from 'react';
import { sourceLineRange } from '../features/board/lineNotes.js';
import { SourceLinesContext } from './sourceLinesContext.js';
const SourceDepth = createContext(0);
export function SourceBlock({ node, children }: { node?: { position?: { start: { line: number }; end: { line: number } } }; children: ReactNode }) {
  const decorate = useContext(SourceLinesContext);
  const depth = useContext(SourceDepth);
  const range = sourceLineRange(node?.position);
  if (!decorate || !range) return children;
  return <SourceDepth value={depth + 1}>{depth === 0 ? decorate(range, children) : <div data-source-line={range.line} data-source-end={range.endLine}>{children}</div>}</SourceDepth>;
}
