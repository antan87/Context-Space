function elementOf(node: EventTarget | Node | null): Element | null {
  if (!node || !('nodeType' in node)) return null;
  return node.nodeType === 1 ? node as Element : (node as Node).parentElement;
}

/** Capture keys only for the reader; neither a stale selection nor an open note owns other input. */
export function readerOwnsKey(reader: HTMLElement | null, target: EventTarget | null, focused: Element | null, body: HTMLElement): boolean {
  if (!reader) return false;
  const owns = (el: Element) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || (el as HTMLElement).isContentEditable || el.closest('.xterm, .monaco-editor, [data-code-window]')) return false;
    return el === body || reader.contains(el);
  };
  const endpoint = elementOf(target);
  return Boolean(endpoint || focused) && (!endpoint || owns(endpoint)) && (!focused || owns(focused));
}

/** Null means leave native copying alone (notably a deliberate selection inside a note). */
export function readerCopyText(body: HTMLElement, selection: Selection | null, markdown: boolean, renderedText: (fragment: DocumentFragment) => string): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
  const startUI = elementOf(range.startContainer)?.closest('[data-line-note-ui]');
  const endUI = elementOf(range.endContainer)?.closest('[data-line-note-ui]');
  if (startUI && startUI === endUI) return null;
  const fragment = range.cloneContents();
  const controls = fragment.querySelectorAll('[data-line-note-ui]');
  if (markdown && !controls.length) return null;
  controls.forEach(el => el.remove());
  return markdown ? renderedText(fragment) : fragment.textContent ?? '';
}

/** Native selection text has different heading/paragraph breaks from innerText. */
export function renderedFragmentText(fragment: DocumentFragment, context?: HTMLElement | null): string {
  const copy = document.createElement('div');
  copy.append(fragment.cloneNode(true));
  // Preserve the document's typography, without loading media in the temporary rendering.
  copy.className = context?.className ?? '';
  copy.querySelectorAll('img, svg, iframe, video, audio, object, embed, link, script, style').forEach(el => el.remove());
  copy.style.cssText = 'position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;white-space:normal';
  if (context) copy.style.width = `${context.getBoundingClientRect().width}px`;
  copy.setAttribute('aria-hidden', 'true');
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const anchor = selection?.anchorNode, anchorOffset = selection?.anchorOffset ?? 0;
  const focus = selection?.focusNode, focusOffset = selection?.focusOffset ?? 0;
  const focused = document.activeElement as HTMLElement | null;
  document.body.append(copy);
  try {
    if (!selection) return copy.textContent ?? '';
    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode(); let last = first;
    if (!first) return '';
    let next; while ((next = walker.nextNode())) last = next;
    const range = document.createRange();
    range.setStart(first, 0); range.setEnd(last!, last!.textContent?.length ?? (last as Text).length);
    selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  } finally {
    try {
      if (selection) {
        selection.removeAllRanges();
        if (ranges.length === 1 && anchor && focus) selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
        else for (const range of ranges) selection.addRange(range);
      }
    } finally {
      copy.remove();
      if (focused?.isConnected && document.activeElement !== focused) focused.focus?.({ preventScroll: true });
    }
  }
}
