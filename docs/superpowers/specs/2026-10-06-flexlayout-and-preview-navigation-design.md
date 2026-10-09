# Design Spec: FlexLayout Docking Window Layout & Preview Navigation

## 1. Background & Objectives

Munin Manual Studio (`apps/manual-studio`) is a desktop/web application for drafting Markdown manuals, capturing screenshots, and publishing documentation.

Currently:
1. The window uses a fixed CSS grid layout with custom resizers (`paneResizers.ts`) and fixed workspace tab switching (`chooseTab`). Users cannot freely dock, tile, split, or rearrange panels (e.g., placing the editor and preview side-by-side while keeping the file tree and AI tag list docked below or on the right).
2. Clicking links inside the preview iframe (`#markdown-preview`) triggers raw browser navigation. Because the iframe runs on the same origin as the application, clicking relative links or anchors causes the SPA router to serve `index.html`, nesting the entire ManualStudio UI inside the preview pane.
3. There is no navigation toolbar (Back `◀`, Forward `▶`, Reload `⟳`) to return to previous preview states or pages after navigating.

### Goals
- Introduce `flexlayout-react` to provide a multi-tab docking layout manager.
- Enable users to freely split, dock, tab, and resize all core panels: File Tree, Markdown Editor, Preview, AI Tags, UI Map, AI Settings & Output, and Appearance.
- Persist customized window layouts in `localStorage` and provide a "レイアウト初期化" (Reset Layout) action.
- Add a "表示 (View)" menu in the header with toggles for every panel.
- Intercept preview iframe links, preventing nested ManualStudio loading while enabling document navigation for markdown links and smooth-scrolling for anchors.
- Add a preview navigation toolbar with Back `◀`, Forward `▶`, and Refresh `⟳` buttons backed by a navigation history stack.

---

## 2. Architecture & Technology Stack

### 2.1 Dependencies
Add the following packages to `package.json` (or `apps/manual-studio`):
- `react`: `^18.3.1` (or `^19.0.0`)
- `react-dom`: `^18.3.1` (or `^19.0.0`)
- `@types/react`: `^18.3.12`
- `@types/react-dom`: `^18.3.1`
- `flexlayout-react`: `^0.11.1`

### 2.2 React DOM Portal Bridge
To maintain full backwards-compatibility with `main.ts`'s 2,300+ lines of DOM event listeners, Milkdown editor instances, CodeMirror bindings, and Tauri IPC subscriptions:
- A new TypeScript/React module `src/windowLayout.tsx` mounts a React root at `#app-layout`.
- Rather than rewriting existing panels into stateful React components, FlexLayout's `factory(node)` attaches each existing panel DOM node into the corresponding FlexLayout tab content container.
- When tabs are closed or moved, panel DOM nodes remain alive in memory, preserving editor scroll position, caret state, and active inputs.

---

## 3. Panels & Default Layout

### 3.1 Panel Definitions
The following panel IDs and titles are registered:

| Component ID | Title | Default Location | Description |
|---|---|---|---|
| `file-tree` | ファイルツリー | Left Dock (260px) | File tree, create page/folder buttons, batch AI generate |
| `editor` | Markdownエディタ | Center Left (1fr) | Formatting toolbar, Milkdown/CodeMirror editor, cursor pos |
| `preview` | プレビュー | Center Right (1fr) | Preview toolbar (Back/Forward), iframe, Mermaid renderer |
| `ai-tags` | AIタグ一覧 | Bottom Tabset | List of `<!-- ai:task -->` tags and generation reviews |
| `ui-map` | 画面一覧 / UI Map | Bottom Tabset | UI map exploration, recorded desktop observations |
| `publish` | AI設定・出力 | Bottom Tabset | AI CLI/API configuration, launch commands, draft build |
| `appearance` | 外観設定 | Bottom Tabset | Font size adjustment and color theme picker |

### 3.2 Default Layout Model
```json
{
  "global": {
    "tabEnableClose": true,
    "tabEnableFloat": false,
    "tabSetEnableDrop": true,
    "tabSetEnableDrag": true,
    "tabSetEnableMaximize": true
  },
  "borders": [],
  "layout": {
    "type": "row",
    "weight": 100,
    "children": [
      {
        "type": "tabset",
        "weight": 22,
        "width": 260,
        "children": [
          { "type": "tab", "id": "file-tree", "name": "ファイルツリー", "component": "file-tree", "enableClose": false }
        ]
      },
      {
        "type": "row",
        "weight": 78,
        "children": [
          {
            "type": "row",
            "weight": 65,
            "children": [
              {
                "type": "tabset",
                "weight": 50,
                "children": [
                  { "type": "tab", "id": "editor", "name": "Markdownエディタ", "component": "editor", "enableClose": false }
                ]
              },
              {
                "type": "tabset",
                "weight": 50,
                "children": [
                  { "type": "tab", "id": "preview", "name": "プレビュー", "component": "preview", "enableClose": false }
                ]
              }
            ]
          },
          {
            "type": "tabset",
            "weight": 35,
            "children": [
              { "type": "tab", "id": "ai-tags", "name": "AIタグ一覧", "component": "ai-tags" },
              { "type": "tab", "id": "ui-map", "name": "画面一覧 / UI Map", "component": "ui-map" },
              { "type": "tab", "id": "publish", "name": "AI設定・出力", "component": "publish" },
              { "type": "tab", "id": "appearance", "name": "外観設定", "component": "appearance" }
            ]
          }
        ]
      }
    ]
  }
}
```

---

## 4. Preview Navigation & Link Interception

### 4.1 Root Cause of Nested ManualStudio
The preview iframe rendered HTML with links without click handling. Clicking relative links like `docs/other.md` or anchor links `#section` triggered standard browser navigation within the iframe, which hit Vite/Tauri SPA routing and loaded `index.html` (the full app) recursively.

### 4.2 Solution: Preview Navigation Controller (`previewNavigation.ts`)
1. **Link Click Interception**:
   - On iframe `load`, attach a click event listener on `contentDocument`.
   - For every `<a>` tag click, call `event.preventDefault()`.
   - **Internal Markdown Links** (`.md`, relative paths): Resolve relative to current document path and invoke `openPage(resolvedPath, true)` with history push.
   - **Anchor Links** (`#...`): Locate the target element by `id` or name and call `scrollIntoView({ behavior: 'smooth' })`.
   - **External Links** (`http://`, `https://`): Open using system browser (Tauri shell or `window.open(url, '_blank')`).
2. **Navigation History Stack**:
   - Maintain a history stack of visited pages and anchor targets:
     ```ts
     interface PreviewHistoryEntry {
       page: string;
       anchor?: string;
     }
     ```
   - Provide `canGoBack`, `canGoForward`, `goBack()`, `goForward()`.
3. **Preview Header Toolbar**:
   - Above the iframe, render:
     - `[ ◀ ]` (Back, disabled when history index === 0)
     - `[ ▶ ]` (Forward, disabled when at latest history entry)
     - `[ ⟳ ]` (Refresh preview)
     - `[ Page title / Path indicator ]`

---

## 5. Header View Menu & Layout Persistence

### 5.1 "表示 (View)" Menu
In `.app-header`:
- Add a dropdown button `表示 ▾` (`#view-menu-button`).
- Dropdown popup contains:
  - Checkboxes for each panel: `ファイルツリー`, `Markdownエディタ`, `プレビュー`, `AIタグ一覧`, `画面一覧 / UI Map`, `AI設定・出力`, `外観設定`.
  - Toggling a checkbox adds or selects the tab in FlexLayout (or closes it if unchecked).
  - A separator and a button: `レイアウトを初期状態に戻す` (Reset to Default Layout).

### 5.2 Persistence
- FlexLayout model changes are debounced (300ms) and saved to `localStorage.getItem("manual-studio-flexlayout-model")`.
- When loading, if a saved model JSON exists, validate it and load it with `Model.fromJson`. If parsing or structure fails, fallback to `defaultLayout`.
- Resetting layout removes the stored key and reloads `defaultLayout`.

---

## 6. Theme & Styling Integration

- FlexLayout uses theme styles (light/dark) configured via `flexlayout-react/style/light.css` / `dark.css`.
- Map Munin Manual Studio CSS variables to FlexLayout classes:
  - `.flexlayout__tabset_header`: `background: var(--surface-bg); border-bottom: 1px solid var(--border-color);`
  - `.flexlayout__tab_button--selected`: `background: var(--accent-soft); color: var(--accent); border-bottom: 2px solid var(--accent);`
  - `.flexlayout__splitter`: `background: var(--border-color);`
  - `.flexlayout__splitter:hover`: `background: var(--accent);`
- Whenever `applyTheme()` in `theme.ts` is invoked, FlexLayout tabsets and splitters immediately inherit the updated palette.

---

## 7. Error Handling & Edge Cases

1. **Corrupted Stored Layout**:
   If user's `localStorage` has an outdated or malformed layout JSON, catch errors in `Model.fromJson` and cleanly restore `defaultLayout`.
2. **Iframe Scroll Synchronization**:
   Ensure scroll sync between Milkdown editor and preview continues to function when either pane is resized or detached.
3. **Closing Essential Panels**:
   Essential panels (`file-tree`, `editor`, `preview`) have `enableClose: true` allowed by user request, but can be restored instantly via the View menu or Layout Reset.
4. **Detached Mode (`?editor=1`)**:
   Preserve existing detached window mode for popout editor instances by only rendering editor/preview if `detached` flag is active.

---

## 8. Verification & Testing Plan

1. **Compilation & Type Checking**:
   - `npm run manual:build` (`tsc -p apps/manual-studio/tsconfig.json && vite build ...`) must pass cleanly with 0 TypeScript errors.
2. **Docking & Splitting Validation**:
   - Drag tab to split vertically / horizontally.
   - Resize splitters and verify responsive sizing.
   - Verify all panels render interactive controls properly without DOM loss.
3. **Preview Link & Navigation Validation**:
   - Click a link to another `.md` file inside the preview; verify it opens the markdown page instead of nesting ManualStudio.
   - Click preview Back button (`◀`); verify it returns to previous document.
   - Click preview Forward button (`▶`); verify it advances.
   - Click internal `#anchor`; verify smooth scroll.
4. **Theme Switch Verification**:
   - Switch themes (Forest, Charcoal, etc.) and check tab bar and splitter colors.
5. **Persistence & Reset Validation**:
   - Rearrange panels, refresh browser/app, verify layout is restored.
   - Click "レイアウトを初期状態に戻す" in View menu; verify default layout is restored.
