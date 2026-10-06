# FlexLayout Docking Layout & Preview Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `flexlayout-react` docking window layout across Munin Manual Studio and fix preview iframe navigation with link interception and a Back/Forward toolbar.

**Architecture:** Integrate React and `flexlayout-react` via a lightweight DOM Portal Bridge (`windowLayout.tsx`) that mounts into `#app-layout` and reparents existing panels without rewriting 2,300+ lines of `main.ts`. Implement `previewNavigation.ts` to intercept preview iframe link clicks and provide a Back/Forward history toolbar. Add a header "表示 (View)" dropdown to toggle panel visibility and reset layouts, with persistence in `localStorage`.

**Tech Stack:** React 19 / 18, `react-dom`, `flexlayout-react`, TypeScript 5.7, Vite 6, Tauri 2, CSS Custom Properties.

**Spec:** [docs/superpowers/specs/2026-10-06-flexlayout-and-preview-navigation-design.md](file:///home/ishii/PycharmProjects/munin_manual_studio/docs/superpowers/specs/2026-10-06-flexlayout-and-preview-navigation-design.md)

## Global Constraints

- Do not rewrite existing `main.ts` logic for Milkdown editor, CodeMirror, Tauri IPC listeners, or capture workflows.
- FlexLayout panels must preserve DOM nodes in memory when switched or docked so that editor caret, undo history, and inputs remain intact.
- Preview iframe must never navigate to raw URLs that cause SPA recursion (nesting ManualStudio inside the iframe).
- Persistence key in `localStorage`: `manual-studio-flexlayout-model`.
- TypeScript strict mode must pass cleanly (`npm run manual:build` exit code 0).

## Review Focus

1. **Preview link recursion**: Clicking `<a href="other.md">` inside `#markdown-preview` must invoke document opening (`openPage`) instead of navigating the iframe to `index.html`.
2. **Anchor links**: Clicking `<a href="#section">` inside `#markdown-preview` must scroll smoothly to `#section` without reloading the page or altering iframe location.
3. **External links**: Clicking `<a href="https://example.com">` must open externally and never replace the iframe content or violate CSP.
4. **Corrupted layout recovery**: If `localStorage` contains invalid or legacy JSON, `windowLayout.tsx` must catch the error and fallback to `defaultLayout` without crashing the application.
5. **DOM element availability**: All existing DOM element IDs queried by `main.ts` (e.g. `page-list`, `markdown-editor`, `markdown-preview`, `task-list`, etc.) must remain accessible in the DOM at all times.

---

### Task 1: Dependencies & TypeScript Configuration Setup

**Files:**
- Modify: `package.json`
- Modify: `apps/manual-studio/tsconfig.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: npm package registry
- Produces: React and `flexlayout-react` packages installed, JSX support enabled in TypeScript compiler.

- [ ] **Step 1: Install `react`, `react-dom`, `@types/react`, `@types/react-dom`, and `flexlayout-react`**

Run: `npm install react react-dom flexlayout-react && npm install -D @types/react @types/react-dom`

- [ ] **Step 2: Update `tsconfig.json` and `apps/manual-studio/tsconfig.json` to enable `"jsx": "react-jsx"`**

In `tsconfig.json` and/or `apps/manual-studio/tsconfig.json`, add `"jsx": "react-jsx"` to `compilerOptions`.

- [ ] **Step 3: Verify build passes with React types available**

Run: `npx tsc -p apps/manual-studio/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json apps/manual-studio/tsconfig.json
git commit -m "build: install react and flexlayout-react with tsx configuration"
```

---

### Task 2: Preview Navigation & Link Interception (`previewNavigation.ts`)

**Files:**
- Create: `apps/manual-studio/src/previewNavigation.ts`
- Create: `apps/manual-studio/src/previewNavigation.test.ts` (or standalone script for verification)

**Interfaces:**
- Consumes: `openPage: (page: string) => Promise<void>`, `refreshPreview: () => Promise<void>`
- Produces:
  ```ts
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
  export function createPreviewNavigator(options: {
    getCurrentPage: () => string | null;
    openPage: (page: string) => Promise<void>;
    refreshPreview: () => Promise<void>;
  }): PreviewNavigator;
  export function resolveRelativeMarkdownLink(currentPage: string, href: string): string | null;
  ```

- [ ] **Step 1: Write unit test for relative markdown link resolution and history stack**

In `apps/manual-studio/src/previewNavigation.test.ts`, test:
- `resolveRelativeMarkdownLink("guide.md", "usage.md")` -> `"usage.md"`
- `resolveRelativeMarkdownLink("sub/intro.md", "../other.md")` -> `"other.md"`
- `resolveRelativeMarkdownLink("guide.md", "#section")` -> `null` (anchor handled separately)
- History stack `pushPage`, `goBack`, `goForward`, `canGoBack`, `canGoForward`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node -e "import('./apps/manual-studio/src/previewNavigation.ts')"`
Expected: FAIL (module does not exist yet).

- [ ] **Step 3: Implement `previewNavigation.ts`**

Implement `resolveRelativeMarkdownLink`, `createPreviewNavigator` with:
- Iframe link interception: on `click` in `iframe.contentDocument`, prevent default. If anchor `#...`, `scrollIntoView()`. If markdown link, resolve path and call `openPage`. If external link, open in browser.
- Toolbar controls: `[ ◀ 戻る ]`, `[ ▶ 進む ]`, `[ ⟳ 再読込 ]`, and page name badge.

- [ ] **Step 4: Verify test passes**

Run test verification script: `npx tsx apps/manual-studio/src/previewNavigation.test.ts` (or node runner).
Expected: All assertions pass.

- [ ] **Step 5: Commit**

```bash
git add apps/manual-studio/src/previewNavigation.ts apps/manual-studio/src/previewNavigation.test.ts
git commit -m "feat(preview): add preview navigation controller and link interceptor"
```

---

### Task 3: HTML & CSS Restructuring for FlexLayout Panels

**Files:**
- Modify: `apps/manual-studio/index.html`
- Modify: `apps/manual-studio/src/style.css`

**Interfaces:**
- Consumes: Panel element IDs (`file-tree`, `editor`, `preview`, `ai-tags`, `ui-map`, `publish`, `appearance`)
- Produces:
  - Separate `#panel-editor` and `#panel-preview` containers in `index.html`.
  - `#panel-pool` container holding all panel elements for FlexLayout tab mounting.
  - Header `表示 ▾` dropdown button (`#view-menu-button`) and menu (`#view-menu-dropdown`).
  - FlexLayout CSS theme overrides in `style.css` mapped to design variables.

- [ ] **Step 1: Update `index.html`**

1. In `.app-header .header-workspace`, add the `表示 ▾` button:
   ```html
   <div class="view-menu-container">
     <button type="button" id="view-menu-button" aria-haspopup="true" aria-expanded="false">表示 ▾</button>
     <div id="view-menu-dropdown" class="view-menu-dropdown" hidden>
       <!-- populated dynamically by windowLayout -->
     </div>
   </div>
   ```
2. Split `#panel-editor` into:
   - `#panel-editor`: Contains `panel-header`, `editor-tools`, `editor-column` (textarea, Milkdown host, cursor).
   - `#panel-preview`: Contains preview toolbar (`#preview-nav-bar`) and `iframe#markdown-preview`.
3. Wrap all dockable panels in a dedicated pool `<div id="layout-panel-pool" style="display:none">`:
   - `sidebar` -> `#panel-tree`
   - `#panel-editor`
   - `#panel-preview`
   - `#panel-tasks`
   - `#panel-uimap`
   - `#panel-publish`
   - `#panel-appearance`
4. `#app-layout` will be the mount target for FlexLayout.

- [ ] **Step 2: Update `style.css`**

1. Import `flexlayout-react/style/light.css` at the top of `style.css`.
2. Add custom styles for FlexLayout tabs, tabset headers, splitters matching theme variables (`--surface-bg`, `--surface-soft`, `--border-color`, `--accent`, `--text-primary`).
3. Add styles for `.preview-nav-bar` (toolbar above iframe with back/forward/refresh buttons and path label).
4. Add styles for `.view-menu-dropdown` (floating card with panel checkboxes and reset button).
5. Remove or obsolete `#sidebar-resizer` and `#editor-resizer` rules.

- [ ] **Step 3: Run build to verify HTML and CSS bundle without syntax errors**

Run: `npm run manual:build`
Expected: Passes cleanly.

- [ ] **Step 4: Commit**

```bash
git add apps/manual-studio/index.html apps/manual-studio/src/style.css
git commit -m "feat(ui): split editor/preview panels and add view menu and flexlayout styles"
```

---

### Task 4: FlexLayout Window Layout Manager (`windowLayout.tsx`)

**Files:**
- Create: `apps/manual-studio/src/windowLayout.tsx`

**Interfaces:**
- Consumes: `#layout-panel-pool` children, `localStorage`
- Produces:
  ```ts
  export interface WindowLayoutManager {
    resetLayout(): void;
    togglePanel(componentId: string, visible?: boolean): void;
    isPanelVisible(componentId: string): boolean;
    focusPanel(componentId: string): void;
  }
  export function setupWindowLayout(containerId?: string): WindowLayoutManager;
  ```

- [ ] **Step 1: Write `windowLayout.tsx`**

1. Define `defaultLayoutJson` with:
   - Left: `file-tree` (width 260)
   - Center-top left: `editor`
   - Center-top right: `preview`
   - Center-bottom tabset: `ai-tags`, `ui-map`, `publish`, `appearance`
2. Implement React component `FlexLayoutApp`:
   - State for `model` initialized from `localStorage.getItem("manual-studio-flexlayout-model")` or `defaultLayoutJson`.
   - Debounced save on `model.onModelChange`.
   - `factory(node)`: attaches DOM element from `#layout-panel-pool` into the tab container using a DOM node portal/host component.
3. Expose manager methods:
   - `resetLayout()`: restores `defaultLayoutJson` and clears `localStorage`.
   - `togglePanel()`: adds or selects tab if hidden, or closes if visible.
   - `isPanelVisible()`: checks if node exists in model.
   - `focusPanel()`: selects tab in model.
4. Populate `#view-menu-dropdown`:
   - Renders checkboxes for each panel with labels.
   - Updates checkbox states when tabs are closed/opened.
   - Adds "レイアウトを初期状態に戻す" button calling `resetLayout()`.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc -p apps/manual-studio/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/manual-studio/src/windowLayout.tsx
git commit -m "feat(layout): implement FlexLayout React window layout manager"
```

---

### Task 5: Integration with `main.ts` & Cleanup of Legacy Resizers

**Files:**
- Modify: `apps/manual-studio/src/main.ts`

**Interfaces:**
- Consumes: `setupWindowLayout` from `windowLayout.tsx`, `createPreviewNavigator` from `previewNavigation.ts`
- Produces: Main application lifecycle initializes FlexLayout and preview navigation seamlessly.

- [ ] **Step 1: Update `main.ts`**

1. Import `setupWindowLayout` and `createPreviewNavigator`.
2. Initialize `setupWindowLayout()` at startup (unless `recordingControlMode` or `detached` has special constraints).
3. Initialize `createPreviewNavigator`:
   - Wire `openPage` to call `previewNavigator.pushPage(page)`.
   - On iframe load, call `previewNavigator.setupIframeInterception(iframe)`.
   - Wire preview navigation toolbar into `#panel-preview`.
4. Update `chooseTab(name)`:
   - Instead of manually setting `.panel.hidden`, call `layoutManager.focusPanel(tabToComponentId(name))` so selecting a tab activates that tab inside FlexLayout.
5. Deprecate / remove `setupPaneResizers` calls as FlexLayout handles splitters natively.

- [ ] **Step 2: Verify application builds**

Run: `npm run manual:build`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/manual-studio/src/main.ts
git commit -m "feat(main): integrate FlexLayout manager and preview navigation into main lifecycle"
```

---

### Task 6: End-to-End Verification & Edge Cases

**Files:**
- Modify: (as needed for any styling or layout adjustments)

**Interfaces:**
- Consumes: Vite dev server, automated workflow check
- Produces: Fully verified docking layout and preview navigation.

- [ ] **Step 1: Run project checks and workflow test**

Run: `npm run manual:check` and `npm run manual:test-workflow`
Expected: PASS.

- [ ] **Step 2: Verify edge cases**

1. Verify layout persistence in `localStorage`: reload preserves panel layout.
2. Verify layout reset button restores original configuration.
3. Verify preview link navigation: clicking markdown link opens page; clicking anchor scrolls; clicking external link opens externally; no iframe recursion.
4. Verify theme change applies seamlessly to FlexLayout tab headers and splitters.

- [ ] **Step 3: Commit and finalize**

```bash
git add -A
git commit -m "chore: verify and finalize FlexLayout window docking and preview navigation"
```
