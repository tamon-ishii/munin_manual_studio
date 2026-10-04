import { chromium } from 'playwright-core';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [inputPath, capturedPath] = process.argv.slice(2);
const scenario = JSON.parse(await readFile(inputPath, 'utf8'));
const url = new URL(scenario.base_url);
if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
  throw new Error('Scenario base_url must use http, https, or file');
}

const browserOptions = { headless: true };
if (process.env.MODULELOOM_CHROME_PATH) {
  browserOptions.executablePath = process.env.MODULELOOM_CHROME_PATH;
} else {
  browserOptions.channel = 'chrome';
}
const browser = await chromium.launch(browserOptions);
const captured = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  for (const [index, step] of scenario.steps.entries()) {
    try {
      if ('goto' in step) {
        if (typeof step.goto !== 'string' || !step.goto) throw new Error('goto needs a URL or path');
        await page.goto(new URL(step.goto, url).href);
      } else if ('click' in step) {
        if (typeof step.click !== 'string' || !step.click) throw new Error('click needs a selector');
        await page.locator(step.click).click();
      } else if ('fill' in step) {
        const { selector, value } = step.fill ?? {};
        if (typeof selector !== 'string' || typeof value !== 'string') {
          throw new Error('fill needs selector and value strings');
        }
        await page.locator(selector).fill(value);
      } else if ('expect_visible' in step) {
        if (typeof step.expect_visible !== 'string' || !step.expect_visible) {
          throw new Error('expect_visible needs a selector');
        }
        await page.locator(step.expect_visible).waitFor({ state: 'visible' });
      } else if ('screenshot' in step) {
        const { task, selector } = step.screenshot ?? {};
        if (typeof task !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(task)) {
          throw new Error('screenshot needs a valid task ID');
        }
        const destination = path.join(capturedPath, `${task}.png`);
        await mkdir(path.dirname(destination), { recursive: true });
        if (selector === undefined) {
          await page.screenshot({ path: destination, animations: 'disabled' });
        } else if (typeof selector === 'string' && selector) {
          await page.locator(selector).screenshot({ path: destination, animations: 'disabled' });
        } else {
          throw new Error('screenshot selector must be a nonempty string');
        }
        captured.push(task);
      } else {
        throw new Error('unsupported step');
      }
    } catch (error) {
      throw new Error(`Step ${index + 1} failed: ${error.message}`);
    }
  }
} finally {
  await browser.close();
}
process.stdout.write(`${JSON.stringify({ captured, steps: scenario.steps.length })}\n`);
