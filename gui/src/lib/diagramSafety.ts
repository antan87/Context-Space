/** This precheck is defence in depth; the frame's CSP is the network boundary. */
export const DIAGRAM_RESOURCE_REASON = 'It asks to load something from outside.';

export function diagramResourceReason(source: string): string | null {
  const metadataResource = /@\{[^}]*\b(?:img|icon)\s*:/i.test(source);
  const resource = /url\s*\(|@import\b|\bhref\b|\bhttps?:|\bdata:|["']\s*\/\//i.test(source);
  return metadataResource || resource ? DIAGRAM_RESOURCE_REASON : null;
}
