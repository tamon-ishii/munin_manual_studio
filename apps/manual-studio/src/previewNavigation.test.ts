import assert from "node:assert/strict";
import { resolveRelativeMarkdownLink, createPreviewNavigator } from "./previewNavigation";

// Test 1: resolveRelativeMarkdownLink
assert.equal(resolveRelativeMarkdownLink("guide.md", "usage.md"), "usage.md");
assert.equal(resolveRelativeMarkdownLink("docs/guide.md", "usage.md"), "docs/usage.md");
assert.equal(resolveRelativeMarkdownLink("sub/intro.md", "../other.md"), "other.md");
assert.equal(resolveRelativeMarkdownLink("sub/deep/intro.md", "../other.md"), "sub/other.md");
assert.equal(resolveRelativeMarkdownLink("guide.md", "#section"), null);
assert.equal(resolveRelativeMarkdownLink("guide.md", "https://example.com"), null);
assert.equal(resolveRelativeMarkdownLink("guide.md", "image.png"), null);

// Test 2: History stack navigation
const historyLog: string[] = [];
let currentPage: string | null = null;
const navigator = createPreviewNavigator({
  getCurrentPage: () => currentPage,
  openPage: async (page) => {
    currentPage = page;
    historyLog.push(`open:${page}`);
  },
  refreshPreview: async () => {
    historyLog.push("refresh");
  },
});

assert.equal(navigator.canGoBack(), false);
assert.equal(navigator.canGoForward(), false);

// Push page 1
navigator.pushPage("page1.md");
currentPage = "page1.md";
assert.equal(navigator.canGoBack(), false);
assert.equal(navigator.canGoForward(), false);

// Push page 2
navigator.pushPage("page2.md");
currentPage = "page2.md";
assert.equal(navigator.canGoBack(), true);
assert.equal(navigator.canGoForward(), false);

// Push page 3
navigator.pushPage("page3.md");
currentPage = "page3.md";
assert.equal(navigator.canGoBack(), true);
assert.equal(navigator.canGoForward(), false);

// Go back -> page2
await navigator.goBack();
assert.equal(currentPage, "page2.md");
assert.equal(navigator.canGoBack(), true);
assert.equal(navigator.canGoForward(), true);

// Go back -> page1
await navigator.goBack();
assert.equal(currentPage, "page1.md");
assert.equal(navigator.canGoBack(), false);
assert.equal(navigator.canGoForward(), true);

// Go forward -> page2
await navigator.goForward();
assert.equal(currentPage, "page2.md");
assert.equal(navigator.canGoBack(), true);
assert.equal(navigator.canGoForward(), true);

console.log("previewNavigation tests passed successfully!");
