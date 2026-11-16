/** The editor's theme follows the app's: the `dark` class on the page, which ThemeProvider sets and removes. One helper for every editor. */

export const isAppDark = (root: HTMLElement = document.documentElement): boolean => root.classList.contains('dark');

export const editorThemeName = (dark: boolean = isAppDark()): 'vs-dark' | 'vs' => (dark ? 'vs-dark' : 'vs');

/** Calls `onChange` with the new theme name whenever the app switches theme. Returns the way to stop. */
export function watchEditorTheme(onChange: (theme: 'vs-dark' | 'vs') => void, root: HTMLElement = document.documentElement): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  let last = isAppDark(root);
  const observer = new MutationObserver(() => {
    const now = isAppDark(root);
    if (now === last) return;
    last = now;
    onChange(editorThemeName(now));
  });
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
