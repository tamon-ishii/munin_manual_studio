import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  Layout,
  Model,
  TabNode,
  IJsonModel,
  Actions,
  DockLocation,
  TabSetNode,
} from "flexlayout-react";

export interface PanelDef {
  id: string;
  name: string;
  elementId: string;
}

export const PANELS: PanelDef[] = [
  { id: "file-tree", name: "ファイルツリー", elementId: "panel-tree" },
  { id: "editor", name: "原稿を編集", elementId: "panel-editor" },
  { id: "ai-tags", name: "AIタグ一覧", elementId: "panel-tasks" },
  { id: "terminal", name: "AIターミナル", elementId: "panel-terminal" },
];

export const STORAGE_KEY = "manual-studio-flexlayout-model-v4";

export const defaultLayoutJson: IJsonModel = {
  global: {
    tabEnableClose: true,
    tabEnableFloat: false,
    tabSetEnableDrop: true,
    tabSetEnableDrag: true,
    tabSetEnableMaximize: true,
    tabSetEnableTabStrip: true,
  },
  borders: [],
  layout: {
    type: "row",
    weight: 100,
    children: [
      {
        type: "tabset",
        id: "tabset-left",
        weight: 22,
        children: [
          {
            type: "tab",
            id: "file-tree",
            name: "ファイルツリー",
            component: "file-tree",
            enableClose: true,
          },
        ],
      },
      {
        type: "row",
        weight: 78,
        children: [
          {
            type: "tabset",
            id: "tabset-editor",
            weight: 75,
            children: [
              {
                type: "tab",
                id: "editor",
                name: "原稿を編集",
                component: "editor",
                enableClose: true,
              },
            ],
          },
          {
            type: "tabset",
            id: "tabset-bottom",
            weight: 25,
            children: [
              {
                type: "tab",
                id: "ai-tags",
                name: "AIタグ一覧",
                component: "ai-tags",
                enableClose: true,
              },
              {
                type: "tab",
                id: "terminal",
                name: "AIターミナル",
                component: "terminal",
                enableClose: true,
              },
            ],
          },
        ],
      },
    ],
  },
};

export interface WindowLayoutManager {
  resetLayout(): void;
  togglePanel(componentId: string, visible?: boolean): void;
  isPanelVisible(componentId: string): boolean;
  focusPanel(componentId: string): void;
}

const DomPanelHost: React.FC<{ elementId: string }> = ({ elementId }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const target = document.getElementById(elementId);
    const container = containerRef.current;
    if (!target || !container) return;

    target.style.display = "";
    target.hidden = false;
    container.appendChild(target);

    return () => {
      const pool = document.getElementById("layout-panel-pool");
      if (pool && target) {
        pool.appendChild(target);
      }
    };
  }, [elementId]);

  return <div ref={containerRef} className="flexlayout-panel-host" />;
};

function loadStoredModel(): Model {
  try {
    localStorage.removeItem("manual-studio-flexlayout-model");
    localStorage.removeItem("manual-studio-flexlayout-model-v2");
    localStorage.removeItem("manual-studio-flexlayout-model-v3");
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const str = JSON.stringify(parsed);
      if (
        !str.includes('"preview"') &&
        !str.includes('"ui-map"') &&
        !str.includes('"publish"') &&
        !str.includes('"appearance"')
      ) {
        return Model.fromJson(parsed);
      }
    }
  } catch (error) {
    console.warn("Failed to restore stored layout, using default layout:", error);
  }
  return Model.fromJson(defaultLayoutJson);
}

let activeLayoutManager: WindowLayoutManager | null = null;

export const FlexLayoutApp: React.FC<{
  onInitManager?: (manager: WindowLayoutManager) => void;
}> = ({ onInitManager }) => {
  const [model, setModel] = useState<Model>(() => loadStoredModel());
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveModel = useCallback((m: Model) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(m.toJson()));
      } catch (e) {
        console.warn("Failed to persist layout:", e);
      }
    }, 300);
  }, []);

  const resetLayout = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem("manual-studio-flexlayout-model");
      localStorage.removeItem("manual-studio-flexlayout-model-v2");
      localStorage.removeItem("manual-studio-flexlayout-model-v3");
    } catch {
      // ignore
    }
    const freshModel = Model.fromJson(defaultLayoutJson);
    setModel(freshModel);
  }, []);

  const isPanelVisible = useCallback(
    (componentId: string): boolean => {
      return model.getNodeById(componentId) !== undefined;
    },
    [model]
  );

  const focusPanel = useCallback(
    (componentId: string): void => {
      const node = model.getNodeById(componentId);
      if (node) {
        model.doAction(Actions.selectTab(componentId));
      } else {
        togglePanel(componentId, true);
      }
    },
    [model]
  );

  const togglePanel = useCallback(
    (componentId: string, visible?: boolean) => {
      const existing = model.getNodeById(componentId);
      const shouldShow = visible !== undefined ? visible : !existing;

      if (!shouldShow) {
        if (existing) {
          model.doAction(Actions.deleteTab(componentId));
        }
        return;
      }

      if (existing) {
        model.doAction(Actions.selectTab(componentId));
        return;
      }

      const panel = PANELS.find((p) => p.id === componentId);
      if (!panel) return;

      // Find an appropriate tabset to add to
      let targetTabsetId = "";
      const activeTabset = model.getActiveTabset();
      if (activeTabset) {
        targetTabsetId = activeTabset.getId();
      } else {
        // Find any existing tabset
        model.visitNodes((n) => {
          if (!targetTabsetId && n instanceof TabSetNode) {
            targetTabsetId = n.getId();
          }
        });
      }

      if (targetTabsetId) {
        model.doAction(
          Actions.addNode(
            {
              type: "tab",
              id: panel.id,
              name: panel.name,
              component: panel.id,
              enableClose: true,
            },
            targetTabsetId,
            DockLocation.CENTER,
            -1,
            true
          )
        );
      } else {
        // Fallback: reset if no tabset exists
        resetLayout();
      }
    },
    [model, resetLayout]
  );

  const onModelChange = useCallback(
    (m: Model) => {
      saveModel(m);
      updateViewMenu();
    },
    [saveModel]
  );

  const updateViewMenu = useCallback(() => {
    const dropdown = document.getElementById("view-menu-dropdown");
    if (!dropdown) return;

    dropdown.innerHTML = "";
    PANELS.forEach((panel) => {
      const label = document.createElement("label");
      label.className = "view-menu-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isPanelVisible(panel.id);
      cb.addEventListener("change", () => {
        togglePanel(panel.id, cb.checked);
      });

      const span = document.createElement("span");
      span.textContent = panel.name;

      label.appendChild(cb);
      label.appendChild(span);
      dropdown.appendChild(label);
    });

    const separator = document.createElement("div");
    separator.className = "view-menu-separator";
    dropdown.appendChild(separator);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "view-menu-reset-btn";
    resetBtn.textContent = "レイアウトを初期状態に戻す";
    resetBtn.addEventListener("click", () => {
      resetLayout();
      dropdown.hidden = true;
      const btn = document.getElementById("view-menu-button");
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
    dropdown.appendChild(resetBtn);
  }, [isPanelVisible, togglePanel, resetLayout]);

  useEffect(() => {
    const manager: WindowLayoutManager = {
      resetLayout,
      togglePanel,
      isPanelVisible,
      focusPanel,
    };
    activeLayoutManager = manager;
    onInitManager?.(manager);
    updateViewMenu();
  }, [resetLayout, togglePanel, isPanelVisible, focusPanel, onInitManager, updateViewMenu]);

  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    const panel = PANELS.find((p) => p.id === component);
    if (panel) {
      return <DomPanelHost elementId={panel.elementId} />;
    }
    return <div>Panel {component}</div>;
  }, []);

  return <Layout model={model} factory={factory} onModelChange={onModelChange} />;
};

export function setupWindowLayout(containerId = "app-layout"): WindowLayoutManager {
  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error(`FlexLayout container #${containerId} not found`);
  }

  // Setup View Menu button toggle
  const viewMenuBtn = document.getElementById("view-menu-button");
  const viewMenuDropdown = document.getElementById("view-menu-dropdown");
  if (viewMenuBtn && viewMenuDropdown) {
    viewMenuBtn.onclick = (e) => {
      e.stopPropagation();
      const willShow = viewMenuDropdown.hidden;
      viewMenuDropdown.hidden = !willShow;
      viewMenuBtn.setAttribute("aria-expanded", String(willShow));
    };

    document.addEventListener("click", (e) => {
      if (!viewMenuDropdown.hidden && !viewMenuDropdown.contains(e.target as Node) && e.target !== viewMenuBtn) {
        viewMenuDropdown.hidden = true;
        viewMenuBtn.setAttribute("aria-expanded", "false");
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !viewMenuDropdown.hidden) {
        viewMenuDropdown.hidden = true;
        viewMenuBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  let root: Root | null = null;
  root = createRoot(container);
  root.render(<FlexLayoutApp />);

  return {
    resetLayout: () => activeLayoutManager?.resetLayout(),
    togglePanel: (id, visible) => activeLayoutManager?.togglePanel(id, visible),
    isPanelVisible: (id) => activeLayoutManager?.isPanelVisible(id) ?? false,
    focusPanel: (id) => activeLayoutManager?.focusPanel(id),
  };
}
