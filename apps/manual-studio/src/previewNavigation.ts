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
  if (!href || href.startsWith("#") || href.startsWith("/")) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) return null; // Protocol schemes like http:, mailto:

  // Strip query string and fragment
  const cleanHref = href.split("?")[0].split("#")[0].trim();
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
      if (resolvedParts.length > 0) resolvedParts.pop();
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

  async function goBack(): Promise<void> {
    if (!canGoBack()) return;
    isNavigatingHistory = true;
    try {
      historyIndex--;
      const targetPage = historyStack[historyIndex];
      await options.openPage(targetPage);
    } finally {
      isNavigatingHistory = false;
      updateToolbarState();
    }
  }

  async function goForward(): Promise<void> {
    if (!canGoForward()) return;
    isNavigatingHistory = true;
    try {
      historyIndex++;
      const targetPage = historyStack[historyIndex];
      await options.openPage(targetPage);
    } finally {
      isNavigatingHistory = false;
      updateToolbarState();
    }
  }

  function setupIframeInterception(iframe: HTMLIFrameElement): void {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;

      // Intercept any click inside preview iframe to prevent browser navigation
      doc.addEventListener("click", (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest("a") as HTMLAnchorElement | null;
        if (!anchor) return;

        const href = anchor.getAttribute("href");
        if (!href) return;

        event.preventDefault();
        event.stopPropagation();

        if (href.startsWith("#")) {
          const targetId = decodeURIComponent(href.slice(1));
          const element = doc.getElementById(targetId) || doc.querySelector(`[name="${CSS.escape(targetId)}"]`);
          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "start" });
          }
          return;
        }

        const currentPage = options.getCurrentPage();
        if (currentPage) {
          const resolvedPath = resolveRelativeMarkdownLink(currentPage, href);
          if (resolvedPath) {
            void options.openPage(resolvedPath);
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

    backButton?.addEventListener("click", () => void goBack());
    forwardButton?.addEventListener("click", () => void goForward());
    refreshButton?.addEventListener("click", () => void options.refreshPreview());

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
