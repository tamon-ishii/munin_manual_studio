import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { createRoot, Root } from "react-dom/client";
import { positionFloatingMenu } from "./floatingMenu";
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
  { id: "outline", name: "目次", elementId: "panel-outline" },
  { id: "capture-resources", name: "撮影リソース一覧", elementId: "panel-capture-resources" },
  { id: "editor", name: "原稿を編集", elementId: "panel-editor" },
  { id: "terminal", name: "AIターミナル", elementId: "panel-terminal" },
];

export const STORAGE_KEY = "manual-studio-flexlayout-model-v8";

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
          {
            type: "tab",
            id: "outline",
            name: "目次",
            component: "outline",
            enableClose: true,
          },
          {type:"tab",id:"capture-resources",name:"撮影リソース一覧",component:"capture-resources",enableClose:true},
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
    if (elementId === "panel-terminal") {
      window.dispatchEvent(new CustomEvent("manual-studio-terminal-open"));
    }

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
    localStorage.removeItem("manual-studio-flexlayout-model-v4");
    const current = localStorage.getItem(STORAGE_KEY);
    const raw = current ?? localStorage.getItem("manual-studio-flexlayout-model-v7") ?? localStorage.getItem("manual-studio-flexlayout-model-v5");
    if (raw) {
      const parsed = JSON.parse(raw);
      const str = JSON.stringify(parsed);
      if (
        !str.includes('"preview"') &&
        !str.includes('"ui-map"') &&
        !str.includes('"publish"') &&
        !str.includes('"appearance"')
      ) {
        const restored = Model.fromJson(parsed);
        const removedTabs: string[] = [];
        restored.visitNodes((node) => {
          if (node instanceof TabNode && node.getComponent() === "screenshots") {
            removedTabs.push(node.getId());
          }
        });
        removedTabs.forEach((id) => restored.doAction(Actions.deleteTab(id)));
        if (!current && !restored.getNodeById("outline")) {
          const left = restored.getNodeById("tabset-left");
          if (left instanceof TabSetNode) {
            restored.doAction(
              Actions.addNode(
                { type: "tab", id: "outline", name: "目次", component: "outline", enableClose: true },
                left.getId(),
                DockLocation.CENTER,
                1,
                false,
              ),
            );
          }
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(restored.toJson()));
        return restored;
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

  useEffect(() => {
    const container=document.getElementById('app-layout');
    if(!container)return;
    let drag:{id:string;pointer:number;x:number;y:number;tab:HTMLElement;draggable:boolean;moved:boolean}|undefined;
    let destination:{id:string;location:DockLocation;index:number}|undefined;
    const outline=document.createElement('div');
    outline.className='dock-pointer-outline';
    const finish=()=>{
      const previous=drag;
      drag=undefined;destination=undefined;outline.remove();
      if(previous){previous.tab.draggable=previous.draggable;if(container.hasPointerCapture(previous.pointer))container.releasePointerCapture(previous.pointer);}
    };
    const down=(event:PointerEvent)=>{
      if(event.button!==0||!(event.target instanceof Element)||event.target.closest('button,.flexlayout__tab_button_trailing,input'))return;
      const tab=event.target.closest<HTMLElement>('[id^="flexlayout-tabbutton-"]');
      if(!tab)return;
      const id=tab.id.slice('flexlayout-tabbutton-'.length);
      if(!(model.getNodeById(id) instanceof TabNode))return;
      drag={id,pointer:event.pointerId,x:event.clientX,y:event.clientY,tab,draggable:tab.draggable,moved:false};
      // Native HTML dragging uses Windows OLE and can cancel before a drop.
      tab.draggable=false;container.setPointerCapture(event.pointerId);
      model.doAction(Actions.selectTab(id));
      event.preventDefault();event.stopPropagation();
    };
    const move=(event:PointerEvent)=>{
      if(!drag||event.pointerId!==drag.pointer)return;
      if(!drag.moved&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<5)return;
      drag.moved=true;destination=undefined;outline.remove();
      const hit=document.elementFromPoint(event.clientX,event.clientY);
      const group=hit?.closest<HTMLElement>('.flexlayout__tabset')||[...container.querySelectorAll<HTMLElement>('.flexlayout__tabset')].find(element=>{const r=element.getBoundingClientRect();return event.clientX>=r.left&&event.clientX<r.right&&event.clientY>=r.top&&event.clientY<r.bottom;});
      if(!group)return;
      let target:TabSetNode|undefined;
      model.visitNodes(node=>{if(node instanceof TabSetNode&&node.getPath()===group.dataset.layoutPath)target=node;});
      if(!target||!target.isEnableDrop())return;
      const rect=group.getBoundingClientRect(),root=container.getBoundingClientRect();
      const x=(event.clientX-rect.x)/rect.width,y=(event.clientY-rect.y)/rect.height;
      const strip=hit?.closest('.flexlayout__tabset_tabbar_outer');
      let location=DockLocation.CENTER;
      if(!strip&&!target.isMaximized()){
        const nearest=Math.min(x,1-x,y,1-y);
        if(nearest<0.25)location=nearest===x?DockLocation.LEFT:nearest===1-x?DockLocation.RIGHT:nearest===y?DockLocation.TOP:DockLocation.BOTTOM;
      }
      const hovered=hit?.closest<HTMLElement>('[id^="flexlayout-tabbutton-"]');
      const index=hovered?target.getTabNodes().findIndex(node=>`flexlayout-tabbutton-${node.getId()}`===hovered.id):-1;
      destination={id:target.getId(),location,index};
      let left=rect.x-root.x,top=rect.y-root.y,width=rect.width,height=rect.height;
      if(location===DockLocation.LEFT||location===DockLocation.RIGHT){width/=2;if(location===DockLocation.RIGHT)left+=width;}
      if(location===DockLocation.TOP||location===DockLocation.BOTTOM){height/=2;if(location===DockLocation.BOTTOM)top+=height;}
      Object.assign(outline.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`});
      container.append(outline);event.preventDefault();
    };
    const up=(event:PointerEvent)=>{
      if(!drag||event.pointerId!==drag.pointer)return;
      const id=drag.id,drop=destination,moved=drag.moved;finish();
      if(moved&&drop)model.doAction(Actions.moveNode(id,drop.id,drop.location,drop.index,true));
    };
    const cancel=()=>finish();
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag){finish();event.preventDefault();}};
    container.addEventListener('pointerdown',down,true);
    container.addEventListener('pointermove',move);
    container.addEventListener('pointerup',up);
    container.addEventListener('pointercancel',cancel);
    container.addEventListener('lostpointercapture',cancel);
    document.addEventListener('keydown',key);
    return()=>{finish();container.removeEventListener('pointerdown',down,true);container.removeEventListener('pointermove',move);container.removeEventListener('pointerup',up);container.removeEventListener('pointercancel',cancel);container.removeEventListener('lostpointercapture',cancel);document.removeEventListener('keydown',key);};
  },[model]);

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
      localStorage.removeItem("manual-studio-flexlayout-model-v4");
      localStorage.removeItem("manual-studio-flexlayout-model-v5");
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
          if(componentId==='capture-resources'){
            const parent=existing.getParent();
            if(parent instanceof TabSetNode)try{localStorage.setItem('manual-studio-capture-dock-parent',parent.getId());}catch{/* Optional layout preference. */}
          }
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
      let savedParent:ReturnType<Model['getNodeById']>;
      if(componentId==='capture-resources')try{savedParent=model.getNodeById(localStorage.getItem('manual-studio-capture-dock-parent')||'');}catch{/* Use the default group. */}
      const preferredTabset = savedParent instanceof TabSetNode?savedParent:model.getNodeById(componentId === "file-tree" || componentId === "capture-resources" || componentId === "outline" ? "tabset-left" : "tabset-editor");
      const activeTabset = preferredTabset instanceof TabSetNode ? preferredTabset : model.getActiveTabset();
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
            componentId === "terminal" ? DockLocation.BOTTOM : DockLocation.CENTER,
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
  // Image/file drags, including hovering a hidden editor's tab, belong to the
  // document. FlexLayout otherwise retains an active session after editor drop.
  const documentDrag = (event: DragEvent) => {
    if ([...(event.dataTransfer?.types || [])].some(type=>type.startsWith('application/x-munin-'))) event.stopPropagation();
  };
  container.addEventListener('dragenter',documentDrag,true);
  container.addEventListener('dragleave',documentDrag,true);

  // Setup View Menu button toggle
  const viewMenuBtn = document.getElementById("view-menu-button");
  const viewMenuDropdown = document.getElementById("view-menu-dropdown");
  if (viewMenuBtn && viewMenuDropdown) {
    const positionViewMenu = () => {
      if (!viewMenuDropdown.hidden) positionFloatingMenu(viewMenuBtn, viewMenuDropdown, "right");
    };
    const scheduleViewMenuPosition = () => {
      positionViewMenu();
      requestAnimationFrame(positionViewMenu);
    };
    viewMenuBtn.onclick = (e) => {
      e.stopPropagation();
      const willShow = viewMenuDropdown.hidden;
      viewMenuDropdown.hidden = !willShow;
      viewMenuBtn.setAttribute("aria-expanded", String(willShow));
      if (willShow) scheduleViewMenuPosition();
    };
    window.addEventListener("resize", scheduleViewMenuPosition);

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
