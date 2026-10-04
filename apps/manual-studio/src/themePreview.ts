/** Keep the isolated Markdown preview in the application's selected palette. */
export function setupPreviewTheme(iframe: HTMLIFrameElement): void {
  const apply = (): void => {
    try {
      const document = iframe.contentDocument;
      if (!document?.head) return;
      const palette = getComputedStyle(window.document.documentElement);
      const color = (name: string, fallback: string) => palette.getPropertyValue(name).trim() || fallback;
      let style = document.getElementById('manual-studio-preview-theme') as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement('style');
        style.id = 'manual-studio-preview-theme';
        document.head.append(style);
      }
      style.textContent = `
        :root { color-scheme: ${palette.colorScheme || 'light'}; }
        html, body { background: ${color('--surface-bg', '#fff')}; color: ${color('--text-primary', '#26342f')}; }
        h2, td, th { border-color: ${color('--border-color', '#dbe4df')}; }
        a { color: ${color('--accent', '#246b54')}; }
        pre, code { background: ${color('--surface-soft', '#f2f5f3')}; color: ${color('--text-primary', '#26342f')}; }
        blockquote { border-color: ${color('--accent', '#74a58a')}; color: ${color('--text-secondary', '#52665a')}; }
        ::selection { background: ${color('--selection-bg', '#dfe9dd')}; }
      `;
    } catch {
      // A preview being navigated/replaced may not expose its document yet.
    }
  };
  iframe.addEventListener('load', apply);
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'data-theme', 'data-theme-mode'],
  });
  apply();
}
