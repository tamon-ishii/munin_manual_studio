/* Paste into the affected WebView2 DevTools console. No document text is collected. */
(() => {
  window.muninDisplayProbe?.stop();
  const samples = [];
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      classes: [...element.classList].filter((name) => /^(milkdown|ProseMirror)/.test(name)),
      role: element.getAttribute('role'),
      titleLength: (element.getAttribute('title') || '').length,
      valueLength: element instanceof HTMLTextAreaElement ? element.value.length : undefined,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scrollHeight: element.scrollHeight,
      position: style.position,
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
    };
  };
  const snapshot = (target, trigger) => {
    if (!(target instanceof Element)) return;
    const ancestors = [];
    for (let node = target; node && ancestors.length < 6; node = node.parentElement) {
      ancestors.push(describe(node));
    }
    samples.push({
      elapsedMs: Math.round(performance.now()), trigger,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio,
        visualScale: window.visualViewport?.scale },
      ancestors,
      floating: [...document.querySelectorAll('#milkdown-editor *,[role="tooltip"]')]
        .filter((node) => {
          const style = getComputedStyle(node);
          return ['absolute', 'fixed'].includes(style.position) && node.getClientRects().length
            && style.visibility !== 'hidden' && style.opacity !== '0';
        })
        .slice(0, 20).map(describe),
    });
    if (samples.length > 100) samples.shift();
  };
  let lastTarget;
  let timer;
  let frame;
  // Hover delay alone misses overlays that appear and disappear while moving.
  const mutations = new MutationObserver((records) => {
    if (!records.some(({ target }) => target instanceof Element &&
      (target.closest('#milkdown-editor') || target.closest('[role="tooltip"]')))) return;
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      snapshot(lastTarget || document.activeElement, 'overlay-change');
    });
  });
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-show', 'style', 'class', 'hidden'] });
  const hover = (event) => {
    lastTarget = event.target;
    clearTimeout(timer);
    timer = setTimeout(() => snapshot(lastTarget, 'hover'), 800);
  };
  const key = (event) => {
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyY') {
      event.preventDefault();
      clearTimeout(timer);
      snapshot(lastTarget || document.activeElement, 'manual');
      console.info('Display sample captured:', samples.length);
    }
  };
  document.addEventListener('pointerover', hover, true);
  document.addEventListener('keydown', key, true);
  window.muninDisplayProbe = {
    report: () => ({ userAgent: navigator.userAgent, samples: structuredClone(samples) }),
    stop: () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      mutations.disconnect();
      document.removeEventListener('pointerover', hover, true);
      document.removeEventListener('keydown', key, true);
    },
  };
  console.info('Display probe active. Hover affected UI; Ctrl+Shift+Y captures it. muninDisplayProbe.report() returns the report; .stop() stops collection.');
})();
