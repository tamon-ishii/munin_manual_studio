export interface PreviewNavigator {
  pushPage(page: string): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  setupIframeInterception(iframe: HTMLIFrameElement): void;
  attachToolbar(container: HTMLElement): void;
  updateToolbarState(): void;
}

export function resolveRelativeMarkdownLink(currentPage: string, href: string): string | null {
  href = href.trim();
  if (!href || href.startsWith("#") || href.startsWith("/")) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) return null; // Protocol schemes like http:, mailto:

  // Strip query string and fragment
  let cleanHref: string;
  try { cleanHref = decodeURIComponent(href.split(/[?#]/)[0]); } catch { return null; }
  if (!cleanHref) return null;

  // Only resolve links pointing to markdown files
  if (!/\.(?:md|markdown)$/i.test(cleanHref)) return null;

  // Split current directory
  const currentParts = currentPage.replace(/\\/g, "/").split("/");
  currentParts.pop(); // Remove filename to get base directory

  const hrefParts = cleanHref.replace(/\\/g, "/").split("/");
  const resolvedParts = [...currentParts];

  for (const part of hrefParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolvedParts.length === 0) return null;
      resolvedParts.pop();
    } else {
      resolvedParts.push(part);
    }
  }

  return resolvedParts.join("/");
}

export function createPreviewNavigator(options: {
  getCurrentPage: () => string | null;
  openPage: (page: string) => Promise<void>;
  refreshPreview: () => Promise<void>;
  onError?: (error: unknown) => void;
}): PreviewNavigator {
  const historyStack: string[] = [];
  let historyIndex = -1;
  let isNavigatingHistory = false;

  let backButton: HTMLButtonElement | null = null;
  let forwardButton: HTMLButtonElement | null = null;
  let refreshButton: HTMLButtonElement | null = null;
  let pageIndicator: HTMLElement | null = null;

  function canGoBack(): boolean {
    return historyIndex > 0;
  }

  function canGoForward(): boolean {
    return historyIndex >= 0 && historyIndex < historyStack.length - 1;
  }

  function updateToolbarState(): void {
    if (backButton) backButton.disabled = !canGoBack();
    if (forwardButton) forwardButton.disabled = !canGoForward();
    if (pageIndicator) {
      const page = options.getCurrentPage();
      pageIndicator.textContent = page || "プレビュー";
      pageIndicator.title = page || "";
    }
  }

  function pushPage(page: string): void {
    if (!page) return;
    if (isNavigatingHistory) {
      updateToolbarState();
      return;
    }
    if (historyIndex >= 0 && historyStack[historyIndex] === page) {
      updateToolbarState();
      return;
    }

    // Truncate forward history
    if (historyIndex < historyStack.length - 1) {
      historyStack.splice(historyIndex + 1);
    }

    historyStack.push(page);
    historyIndex = historyStack.length - 1;
    updateToolbarState();
  }

  async function navigateHistory(offset: number): Promise<void> {
    if (isNavigatingHistory) return;
    const nextIndex = historyIndex + offset;
    const targetPage = historyStack[nextIndex];
    if (!targetPage) return;
    isNavigatingHistory = true;
    try {
      await options.openPage(targetPage);
      // A cancelled unsaved-changes dialog must leave the history position intact.
      if (options.getCurrentPage() === targetPage) historyIndex = nextIndex;
    } finally {
      isNavigatingHistory = false;
      updateToolbarState();
    }
  }

  async function goBack(): Promise<void> {
    if (canGoBack()) await navigateHistory(-1);
  }

  async function goForward(): Promise<void> {
    if (canGoForward()) await navigateHistory(1);
  }

  function handle(operation: () => Promise<void>): void {
    void operation().catch(error => options.onError?.(error));
  }

  const interceptedDocuments = new WeakSet<Document>();

  function setupIframeInterception(iframe: HTMLIFrameElement): void {
    try {
      const doc = iframe.contentDocument;
      if (!doc || interceptedDocuments.has(doc)) return;
      interceptedDocuments.add(doc);
      // pulldown-cmark emits headings without IDs. Assign stable fragment targets.
      const usedIds = new Set(Array.from(doc.querySelectorAll('[id]'), node => node.id));
      doc.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach(heading => {
        if (heading.id) return;
        const base = (heading.textContent || '').trim().toLowerCase()
          .replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-') || 'section';
        let id = base, suffix = 1;
        while (usedIds.has(id)) id = `${base}-${suffix++}`;
        usedIds.add(id); heading.id = id;
      });

      function scrollToFragment(href: string): void {
        const fragment = href.indexOf('#');
        if (fragment < 0) return;
        let targetId: string;
        try { targetId = decodeURIComponent(href.slice(fragment + 1)); } catch { return; }
        const element = doc!.getElementById(targetId)
          || Array.from(doc!.getElementsByName(targetId))[0];
        element?.scrollIntoView({ behavior: 'instant', block: 'start' });
      }

      doc.addEventListener('keydown', event => {
        const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[data-preview-href]');
        if (event.key === 'Enter' && anchor) { event.preventDefault(); anchor.click(); }
      });

      // Intercept any click inside preview iframe to prevent browser navigation
      doc.addEventListener("click", (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest("a") as HTMLAnchorElement | null;
        if (!anchor) return;

        const href = (anchor.getAttribute("data-preview-href") ?? anchor.getAttribute("href"))?.trim();
        if (!href) return;

        event.preventDefault();
        event.stopPropagation();

        if (href.startsWith("#")) {
          scrollToFragment(href);
          return;
        }

        const currentPage = options.getCurrentPage();
        if (currentPage) {
          const resolvedPath = resolveRelativeMarkdownLink(currentPage, href);
          if (resolvedPath) {
            handle(async () => {
              if (resolvedPath === options.getCurrentPage()) { scrollToFragment(href); return; }
              await options.openPage(resolvedPath);
              if (options.getCurrentPage() !== resolvedPath || !href.includes('#')) return;
              // renderPreview assigns srcdoc before its load event; wait for the new document.
              const scroll = () => {
                const nextDoc = iframe.contentDocument;
                let id: string;
                try { id = decodeURIComponent(href.slice(href.indexOf('#') + 1)); } catch { return; }
                const element = nextDoc?.getElementById(id) || nextDoc?.getElementsByName(id)[0];
                element?.scrollIntoView({behavior:'instant', block:'start'});
              };
              if (iframe.contentDocument !== doc && iframe.contentDocument?.readyState === 'complete') scroll();
              else iframe.addEventListener('load', () => requestAnimationFrame(scroll), {once:true});
            });
            return;
          }
        }

        if (/^https?:\/\//i.test(href)) {
          window.open(href, "_blank", "noopener,noreferrer");
        }
      });
    } catch {
      // Cross-origin or detached iframe safety
    }
  }

  function attachToolbar(container: HTMLElement): void {
    container.innerHTML = `
      <div class="preview-toolbar" role="toolbar" aria-label="プレビュー操作">
        <div class="preview-toolbar-nav">
          <button type="button" id="preview-nav-back" class="preview-toolbar-btn" title="前の原稿に戻る" aria-label="前の原稿に戻る" disabled>◀</button>
          <button type="button" id="preview-nav-forward" class="preview-toolbar-btn" title="次の原稿に進む" aria-label="次の原稿に進む" disabled>▶</button>
          <button type="button" id="preview-nav-refresh" class="preview-toolbar-btn" title="プレビューを再読込" aria-label="プレビューを再読込">⟳</button>
        </div>
        <span id="preview-nav-page" class="preview-toolbar-title" title="プレビュー">プレビュー</span>
      </div>
    `;

    backButton = container.querySelector<HTMLButtonElement>("#preview-nav-back");
    forwardButton = container.querySelector<HTMLButtonElement>("#preview-nav-forward");
    refreshButton = container.querySelector<HTMLButtonElement>("#preview-nav-refresh");
    pageIndicator = container.querySelector<HTMLElement>("#preview-nav-page");

    backButton?.addEventListener("click", () => handle(goBack));
    forwardButton?.addEventListener("click", () => handle(goForward));
    refreshButton?.addEventListener("click", () => handle(options.refreshPreview));

    updateToolbarState();
  }

  return {
    pushPage,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    setupIframeInterception,
    attachToolbar,
    updateToolbarState,
  };
}
