export type FloatingMenuAlign = "left" | "right";

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 5;

export function positionFloatingMenu(
  trigger: HTMLElement,
  menu: HTMLElement,
  align: FloatingMenuAlign = "right",
): void {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);

  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.bottom = "auto";
  menu.style.maxWidth = `${maxWidth}px`;
  menu.style.maxHeight = `${Math.max(80, viewportHeight - VIEWPORT_MARGIN * 2)}px`;

  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const width = Math.min(menuRect.width, maxWidth);

  let left: number;
  if (align === "right") {
    const rightAligned = triggerRect.right - width;
    left = rightAligned >= VIEWPORT_MARGIN ? rightAligned : triggerRect.left;
  } else {
    const leftAligned = triggerRect.left;
    left = leftAligned + width <= viewportWidth - VIEWPORT_MARGIN
      ? leftAligned
      : triggerRect.right - width;
  }
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft));

  const spaceBelow = viewportHeight - triggerRect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN;
  const spaceAbove = triggerRect.top - TRIGGER_GAP - VIEWPORT_MARGIN;
  let top: number;
  let maxHeight: number;
  if (menuRect.height <= spaceBelow || spaceBelow >= spaceAbove) {
    maxHeight = Math.max(80, spaceBelow);
    const renderedHeight = Math.min(menuRect.height, maxHeight);
    top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(triggerRect.bottom + TRIGGER_GAP, viewportHeight - renderedHeight - VIEWPORT_MARGIN),
    );
  } else {
    maxHeight = Math.max(80, spaceAbove);
    const renderedHeight = Math.min(menuRect.height, maxHeight);
    top = Math.max(VIEWPORT_MARGIN, triggerRect.top - TRIGGER_GAP - renderedHeight);
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.round(maxHeight)}px`;
}

export function bindFloatingDetailsMenu(
  details: HTMLDetailsElement,
  menuSelector: string,
  align: FloatingMenuAlign = "right",
): void {
  const summary = details.querySelector<HTMLElement>(":scope > summary");
  const menu = details.querySelector<HTMLElement>(menuSelector);
  if (!summary || !menu) return;

  const placeholder = document.createComment("floating-menu-placeholder");
  let portaled = false;
  let resizeObserver: ResizeObserver | null = null;
  let rafId = 0;

  if (details.id) menu.dataset.menuOwner = details.id;

  const mountPortal = () => {
    if (portaled) return;
    menu.parentNode?.insertBefore(placeholder, menu);
    document.body.appendChild(menu);
    menu.dataset.floatingMenuOpen = "true";
    portaled = true;
  };

  const unmountPortal = () => {
    if (!portaled) return;
    delete menu.dataset.floatingMenuOpen;
    if (placeholder.parentNode) {
      placeholder.parentNode.insertBefore(menu, placeholder);
      placeholder.remove();
    } else {
      details.appendChild(menu);
    }
    portaled = false;
  };

  const update = () => {
    if (!details.open) return;
    positionFloatingMenu(summary, menu, align);
  };

  const scheduleUpdate = () => {
    update();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      update();
    });
  };

  const syncOpenState = () => {
    if (details.open) {
      mountPortal();
      scheduleUpdate();
      if (!resizeObserver && typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(scheduleUpdate);
        resizeObserver.observe(summary);
        const host = details.closest<HTMLElement>(".flexlayout__tab, .app-layout") ?? details.parentElement;
        if (host) resizeObserver.observe(host);
      }
    } else {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      resizeObserver?.disconnect();
      resizeObserver = null;
      unmountPortal();
    }
  };

  const onScroll = (event: Event) => {
    if (!details.open) return;
    if (event.target instanceof Node && menu.contains(event.target)) return;
    update();
  };

  const observer = new MutationObserver(syncOpenState);
  observer.observe(details, { attributes: true, attributeFilter: ["open"] });
  details.addEventListener("toggle", syncOpenState);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", onScroll, true);

  const onMenuClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("button")) details.open = false;
  };
  const onEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && details.open) {
      details.open = false;
      summary.focus();
    }
  };
  details.addEventListener("click", onMenuClick);
  menu.addEventListener("click", onMenuClick);
  details.addEventListener("keydown", onEscape);
  menu.addEventListener("keydown", onEscape);
  document.addEventListener("click", (event) => {
    const target = event.target as Node;
    if (details.open && !details.contains(target) && !menu.contains(target)) {
      details.open = false;
    }
  });
}
