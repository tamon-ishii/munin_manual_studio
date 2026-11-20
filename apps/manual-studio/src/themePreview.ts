import { alertIconStyles } from './alertIcons';

/** Keep the isolated Markdown preview in the application's selected palette. */
export function setupPreviewTheme(iframe: HTMLIFrameElement): void {
  const apply = (): void => {
    try {
      const document = iframe.contentDocument;
      if (!document?.head) return;
      const palette = getComputedStyle(window.document.documentElement);
      const dark = palette.colorScheme === 'dark';
      document.documentElement.toggleAttribute('data-alert-icons', window.document.documentElement.hasAttribute('data-alert-icons'));
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
        body { font-size: ${color('--preview-font-size', '16px')}; }
        body img { max-width: min(100%, var(--munin-image-width, 100%)); height: auto; }
        figure[data-munin-image] { max-width: min(100%, var(--munin-image-width, 100%)) !important; }
        figure[data-munin-image][data-width] {
          width: calc(var(--munin-image-width, 100%) * attr(data-width type(<number>), 100) / 100) !important;
        }
        figure[data-munin-image][data-width] > img { width: 100%; }
        h1 { font-size: 1.875em; }
        h2, td, th { border-color: ${color('--border-color', '#dbe4df')}; }
        a { color: ${color('--accent', '#246b54')}; }
        pre, code { background: ${color('--surface-soft', '#f2f5f3')}; color: ${color('--text-primary', '#26342f')}; }
        blockquote { border-color: ${color('--accent', '#74a58a')}; color: ${color('--text-secondary', '#52665a')}; }
        .markdown-alert-note { --preview-alert-color: ${dark ? '#79b8ff' : '#175ba4'}; }
        .markdown-alert-tip { --preview-alert-color: ${dark ? '#72d6a0' : '#226c44'}; }
        .markdown-alert-important { --preview-alert-color: ${dark ? '#c6a5fa' : '#7045a2'}; }
        .markdown-alert-warning { --preview-alert-color: ${dark ? '#f4c567' : '#805615'}; }
        .markdown-alert-caution { --preview-alert-color: ${dark ? '#ffa49e' : '#a1363d'}; }
        blockquote[class^="markdown-alert-"] {
          margin: 18px 0;
          padding: 12px 16px;
          border-inline-start: 4px solid var(--preview-alert-color);
          border-radius: 6px;
          background: color-mix(in srgb, ${color('--surface-bg', '#fff')} 96%, var(--preview-alert-color));
          color: ${color('--text-primary', '#26342f')};
        }
        blockquote[class^="markdown-alert-"]::before {
          color: var(--preview-alert-color);
          line-height: 21px;
          margin-block-end: 7px;
        }
        blockquote[class^="markdown-alert-"] > :first-child { margin-block-start: 0; }
        blockquote[class^="markdown-alert-"] > :last-child { margin-block-end: 0; }
        ::selection { background: ${color('--selection-bg', '#dfe9dd')}; }
        ${alertIconStyles(true)}
      `;
    } catch {
      // A preview being navigated/replaced may not expose its document yet.
    }
  };
  iframe.addEventListener('load', apply);
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'data-theme', 'data-theme-mode', 'data-alert-icons'],
  });
  apply();
}

export function setupPreviewImageSizing(iframe: HTMLIFrameElement, editorHost: HTMLElement): void {
  const contentWidth = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  };
  const apply = () => {
    const body = iframe.contentDocument?.body;
    const editor = editorHost.querySelector<HTMLElement>('.ProseMirror');
    const width = body && iframe.clientWidth && editor?.clientWidth
      ? Math.min(contentWidth(body), contentWidth(editor))
      : 0;
    for (const element of [body, editorHost]) {
      if (!element) continue;
      if (width > 0) element.style.setProperty('--munin-image-width', `${width}px`);
      else element.style.removeProperty('--munin-image-width');
    }
  };
  const observer = new ResizeObserver(apply);
  observer.observe(iframe);
  observer.observe(editorHost);
  let body: HTMLElement | null = null;
  iframe.addEventListener('load', () => {
    if (body) observer.unobserve(body);
    body = iframe.contentDocument?.body ?? null;
    if (body) observer.observe(body);
    apply();
  });
}
