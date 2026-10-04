import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';

const [startUrl, maxPagesRaw, outputPath] = process.argv.slice(2);
const start = new URL(startUrl);
const localDirectory = start.protocol === 'file:' ? new URL('.', start).pathname : null;
const maxPages = Number(maxPagesRaw);
const options = { headless: true };
if (process.env.MODULELOOM_CHROME_PATH) options.executablePath = process.env.MODULELOOM_CHROME_PATH;
else options.channel = 'chrome';

const browser = await chromium.launch(options);
const views = [];
const warnings = [];
const queue = [start.href];
const visited = new Set();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(5000);
  const inspect = async (id, name) => {
    const elements = await page.evaluate((viewId) => {
      const seen = new Set();
      const output = [];
      for (const el of document.querySelectorAll('button, a, input, select, textarea, [role="tab"], [role="dialog"]')) {
        if (el.getClientRects().length === 0) continue;
        const selector = el.id ? `#${CSS.escape(el.id)}` : el.getAttribute('data-testid')
          ? `[data-testid="${CSS.escape(el.getAttribute('data-testid'))}"]` : null;
        if (!selector || seen.has(selector)) continue;
        seen.add(selector);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || ({ a: 'link', input: 'input', select: 'select', textarea: 'textbox' }[tag] || tag);
        const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('placeholder') || el.id || '').trim().slice(0, 120);
        output.push({ id: el.id || el.getAttribute('data-testid'), selector, name: name || selector, role, title: el.getAttribute('title'), parent_view: viewId });
        if (output.length >= 100) break;
      }
      return output;
    }, id);
    views.push({ id, name, description: page.url(), elements });
  };

  while (queue.length && visited.size < maxPages) {
    const target = queue.shift();
    if (visited.has(target)) continue;
    visited.add(target);
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      const index = views.length;
      const pageName = (await page.title()) || new URL(page.url()).pathname || 'Home';
      await inspect(`web-${index}`, pageName);
      const links = await page.locator('nav a[href], [role="navigation"] a[href]').evaluateAll((nodes) =>
        nodes.map((node) => node.href).filter(Boolean));
      for (const link of links) {
        const resolved = new URL(link);
        resolved.hash = '';
        if (resolved.origin === start.origin && resolved.protocol === start.protocol
            && (!localDirectory || resolved.pathname.startsWith(localDirectory))
            && !/\/(logout|delete|remove)(\/|$)/i.test(resolved.pathname) && !visited.has(resolved.href)) {
          queue.push(resolved.href);
        }
      }
      const tabCount = Math.min(await page.locator('[role="tab"]').count(), 20);
      for (let tab = 0; tab < tabCount; tab += 1) {
        try {
          const locator = page.locator('[role="tab"]').nth(tab);
          const label = (await locator.innerText()).trim() || `Tab ${tab + 1}`;
          await locator.click();
          await inspect(`web-${index}-tab-${tab + 1}`, `${pageName}: ${label}`);
        } catch (error) {
          warnings.push(`Tab ${tab + 1} at ${target}: ${error.message}`);
        }
      }
    } catch (error) {
      warnings.push(`${target}: ${error.message}`);
    }
  }
} finally {
  await browser.close();
}
await writeFile(outputPath, JSON.stringify({ source: startUrl, platform: 'web-playwright', views, warnings }));
