use std::collections::HashMap;
use std::sync::{atomic::{AtomicU8, Ordering}, Arc, Mutex, Weak};

#[derive(Default)]
pub struct EditorContextMenus(Mutex<HashMap<String, Weak<AtomicU8>>>);

/// Extend WebKit's menu instead of replacing its clipboard, spelling and link actions.
#[tauri::command]
pub fn set_editor_context_menu_state(
    window: tauri::WebviewWindow,
    menus: tauri::State<'_, EditorContextMenus>,
    active: bool,
    enabled: bool,
) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{gio, ContextMenuExt, HitTestResultExt, WebViewExt};
        let mut menus = menus.0.lock().map_err(|error| error.to_string())?;
        let value = if !active { 0 } else if enabled { 2 } else { 1 };
        if let Some(state) = menus.get(window.label()).and_then(Weak::upgrade) {
            state.store(value, Ordering::Relaxed);
            return Ok(true);
        }
        let state = Arc::new(AtomicU8::new(value));
        menus.insert(window.label().to_string(), Arc::downgrade(&state));
        let owner = window.clone();
        window.with_webview(move |webview| {
            webview.inner().connect_context_menu(move |_, menu, _, hit| {
                let value = state.load(Ordering::Relaxed);
                if value == 0 || !hit.context_is_editable() { return false; }
                let action = gio::SimpleAction::new("manual-studio-ai-selection", None);
                action.set_enabled(value == 2);
                let owner = owner.clone();
                action.connect_activate(move |_, _| {
                    let _ = owner.eval("window.dispatchEvent(new Event('manual-studio-editor-context-ai'))");
                });
                menu.append(&webkit2gtk::ContextMenuItem::new_separator());
                menu.append(&webkit2gtk::ContextMenuItem::from_gaction(
                    &action, "選択範囲をAIで修正", None,
                ));
                false
            });
        }).map_err(|error| error.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, menus, active, enabled);
        Ok(false)
    }
}
