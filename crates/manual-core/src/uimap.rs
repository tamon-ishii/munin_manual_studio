use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UIMap {
    pub project_name: String,
    pub views: Vec<UIView>,
    pub total_elements: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIView {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub elements: Vec<UIElement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIElement {
    pub id: String,
    pub selector: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub parent_view: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIObservation {
    pub source: String,
    pub platform: String,
    #[serde(default)]
    pub observed_at: String,
    #[serde(default)]
    pub code_hash: Option<String>,
    pub views: Vec<UIView>,
}

fn observation_path(root: &Path) -> PathBuf {
    root.join("manual").join("ui_observations.json")
}

pub fn import_ui_observation(root: &Path, input: &Path) -> Result<UIMap, String> {
    let content = fs::read_to_string(input)
        .map_err(|error| format!("Failed to read UI observation {}: {error}", input.display()))?;
    let mut observation: UIObservation = serde_json::from_str(&content)
        .map_err(|error| format!("Invalid UI observation: {error}"))?;
    validate_observation(&mut observation)?;
    if observation.observed_at.is_empty() {
        observation.observed_at = super::task::utc_now();
    }
    let (html_files, script_files) = app_source_files(root);
    observation.code_hash = Some(source_hash(root, html_files.iter().chain(&script_files)));
    let path = observation_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(&observation).map_err(|error| error.to_string())?;
    fs::write(&path, json).map_err(|error| error.to_string())?;
    let map = refresh_ui_map(root);
    save_ui_map(root, &map)?;
    Ok(map)
}

fn validate_observation(observation: &mut UIObservation) -> Result<(), String> {
    if observation.source.trim().is_empty() || observation.platform.trim().is_empty() {
        return Err("UI observation requires source and platform".to_string());
    }
    if observation.views.is_empty() {
        return Err("UI observation requires at least one view".to_string());
    }
    let mut view_ids = HashSet::new();
    for view in &mut observation.views {
        if view.id.trim().is_empty() || view.name.trim().is_empty() {
            return Err("UI observation view requires id and name".to_string());
        }
        if !view_ids.insert(view.id.clone()) {
            return Err(format!("Duplicate UI observation view: {}", view.id));
        }
        view.observed_from = Some(observation.source.clone());
        let mut selectors = HashSet::new();
        for element in &mut view.elements {
            if element.id.trim().is_empty()
                || element.selector.trim().is_empty()
                || element.name.trim().is_empty()
                || element.role.trim().is_empty()
            {
                return Err(format!(
                    "UI observation element in {} requires id, selector, name and role",
                    view.id
                ));
            }
            if !selectors.insert(element.selector.clone()) {
                return Err(format!(
                    "Duplicate UI selector in {}: {}",
                    view.id, element.selector
                ));
            }
            element.parent_view = view.id.clone();
        }
    }
    Ok(())
}

pub fn extract_ui_map(root: &Path) -> UIMap {
    extract_ui_map_inner(root, false)
}

pub fn refresh_ui_map(root: &Path) -> UIMap {
    extract_ui_map_inner(root, true)
}

fn extract_ui_map_inner(root: &Path, refresh: bool) -> UIMap {
    let (html_files, script_files) = app_source_files(root);
    let code_hash = source_hash(root, html_files.iter().chain(&script_files));
    let observation_file = observation_path(root);
    let current_hash = source_hash(
        root,
        html_files
            .iter()
            .chain(&script_files)
            .chain(std::iter::once(&observation_file)),
    );

    // Maps without a hash are user-maintained overrides. Generated maps are
    // reused only while their scanned source files are unchanged.
    let custom_path = root.join("manual").join("ui_map.json");
    if !refresh && custom_path.is_file() {
        if let Ok(content) = fs::read_to_string(&custom_path) {
            if let Ok(map) = serde_json::from_str::<UIMap>(&content) {
                if map
                    .source_hash
                    .as_ref()
                    .is_none_or(|hash| hash == &current_hash)
                {
                    return map;
                }
            }
        }
    }

    let mut views: Vec<UIView> = Vec::new();
    let mut total_elements = 0;

    let section_re =
        Regex::new(r#"(?is)<section\s+[^>]*id=["']([^"']+)["']([^>]*)>(.*?)</section>"#).unwrap();
    let aria_re = Regex::new(r#"aria-labelledby=["']([^"']+)["']"#).unwrap();
    let tab_re = Regex::new(
        r#"(?is)<button\s+[^>]*id=["']([^"']+)["'][^>]*role=["']tab["'][^>]*>(.*?)</button>"#,
    )
    .unwrap();
    let btn_re =
        Regex::new(r#"(?is)<button\s+[^>]*id=["']([^"']+)["']([^>]*)>(.*?)</button>"#).unwrap();
    let input_re =
        Regex::new(r#"(?is)<(?:input|select)\s+[^>]*id=["']([^"']+)["']([^>]*)>"#).unwrap();
    let modal_re = Regex::new(
        r#"(?is)<div\s+[^>]*id=["']([^"']+)["'][^>]*class=["'][^"']*modal[^"']*["']([^>]*)>(.*?)</div>\s*</div>"#,
    )
    .unwrap();
    let modal_title_re =
        Regex::new(r#"(?is)<(?:strong|h2|h3|h4)\s+[^>]*class=["'][^"']*modal-title[^"']*["'][^>]*>(.*?)</(?:strong|h2|h3|h4)>"#).unwrap();
    let title_attr_re = Regex::new(r#"title=["']([^"']+)["']"#).unwrap();
    let tag_strip_re = Regex::new(r#"<[^>]+>"#).unwrap();

    let clean_text = |s: &str| -> String {
        let stripped = tag_strip_re.replace_all(s, " ");
        stripped.split_whitespace().collect::<Vec<_>>().join(" ")
    };

    let mut tab_names = std::collections::HashMap::new();

    for html_file in &html_files {
        let Ok(content) = fs::read_to_string(html_file) else {
            continue;
        };
        let views_before_file = views.len();

        // Extract tab names
        for cap in tab_re.captures_iter(&content) {
            let id = cap[1].to_string();
            let label = clean_text(&cap[2]);
            if !label.is_empty() {
                tab_names.insert(id, label);
            }
        }

        // Extract sections / views
        for cap in section_re.captures_iter(&content) {
            let view_id = cap[1].to_string();
            let attrs = &cap[2];
            let inner = &cap[3];
            let label_id = aria_re.captures(attrs).map(|m| m[1].to_string());
            let view_name = label_id
                .as_ref()
                .and_then(|id| tab_names.get(id))
                .cloned()
                .unwrap_or_else(|| view_id.clone());

            let mut elements = Vec::new();

            for bcap in btn_re.captures_iter(inner) {
                let el_id = bcap[1].to_string();
                let attrs = &bcap[2];
                let raw_text = &bcap[3];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());
                let name = clean_text(raw_text);

                if !name.is_empty() || title.is_some() {
                    elements.push(UIElement {
                        id: el_id.clone(),
                        selector: format!("#{el_id}"),
                        name: if !name.is_empty() {
                            name
                        } else {
                            title.clone().unwrap_or_else(|| el_id.clone())
                        },
                        role: "button".to_string(),
                        title,
                        parent_view: view_id.clone(),
                    });
                }
            }

            for icap in input_re.captures_iter(inner) {
                let el_id = icap[1].to_string();
                let attrs = &icap[2];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());

                elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: title.clone().unwrap_or_else(|| el_id.clone()),
                    role: "input".to_string(),
                    title,
                    parent_view: view_id.clone(),
                });
            }

            total_elements += elements.len();
            views.push(UIView {
                id: view_id,
                name: view_name,
                description: None,
                elements,
                observed_from: None,
            });
        }

        // Modals as views
        for mcap in modal_re.captures_iter(&content) {
            let modal_id = mcap[1].to_string();
            let modal_inner = &mcap[3];
            let modal_name = modal_title_re
                .captures(modal_inner)
                .map(|m| clean_text(&m[1]))
                .unwrap_or_else(|| modal_id.clone());

            let mut modal_elements = Vec::new();
            for bcap in btn_re.captures_iter(modal_inner) {
                let el_id = bcap[1].to_string();
                let attrs = &bcap[2];
                let raw_text = &bcap[3];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());
                let name = clean_text(raw_text);

                modal_elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: if !name.is_empty() {
                        name
                    } else {
                        title.clone().unwrap_or_else(|| el_id.clone())
                    },
                    role: "button".to_string(),
                    title,
                    parent_view: modal_id.clone(),
                });
            }

            for icap in input_re.captures_iter(modal_inner) {
                let el_id = icap[1].to_string();
                let attrs = &icap[2];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());

                modal_elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: title.clone().unwrap_or_else(|| el_id.clone()),
                    role: "input".to_string(),
                    title,
                    parent_view: modal_id.clone(),
                });
            }

            total_elements += modal_elements.len();
            views.push(UIView {
                id: modal_id,
                name: modal_name,
                description: Some("ダイアログ/モーダル".to_string()),
                elements: modal_elements,
                observed_from: None,
            });
        }

        // If no structured views (sections/modals) were found, collect all buttons and inputs
        if views.len() == views_before_file {
            let mut elements = Vec::new();
            for bcap in btn_re.captures_iter(&content) {
                let el_id = bcap[1].to_string();
                let attrs = &bcap[2];
                let raw_text = &bcap[3];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());
                let name = clean_text(raw_text);
                elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: if !name.is_empty() {
                        name
                    } else {
                        title.clone().unwrap_or_else(|| el_id.clone())
                    },
                    role: "button".to_string(),
                    title,
                    parent_view: "main-view".to_string(),
                });
            }

            for icap in input_re.captures_iter(&content) {
                let el_id = icap[1].to_string();
                let attrs = &icap[2];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());

                elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: title.clone().unwrap_or_else(|| el_id.clone()),
                    role: "input".to_string(),
                    title,
                    parent_view: "main-view".to_string(),
                });
            }

            if !elements.is_empty() {
                total_elements += elements.len();
                views.push(UIView {
                    id: "main-view".to_string(),
                    name: "Main View".to_string(),
                    description: Some("メイン画面".to_string()),
                    elements,
                    observed_from: None,
                });
            }
        }
    }

    // Also scan TS/JS files for DOM elements (getElementById, querySelector)
    let ts_elem_re =
        Regex::new(r#"(?:getElementById|querySelector)\(["']#?([a-zA-Z0-9_-]+)["']\)"#).unwrap();
    let mut ts_elements = Vec::new();
    let known_ids: HashSet<String> = views
        .iter()
        .flat_map(|v| v.elements.iter().map(|e| e.id.clone()))
        .collect();

    for p in &script_files {
        if let Ok(src) = fs::read_to_string(p) {
            for cap in ts_elem_re.captures_iter(&src) {
                let el_id = cap[1].to_string();
                if !known_ids.contains(&el_id)
                    && !ts_elements.iter().any(|e: &UIElement| e.id == el_id)
                {
                    ts_elements.push(UIElement {
                        id: el_id.clone(),
                        selector: format!("#{el_id}"),
                        name: el_id.clone(),
                        role: "component".to_string(),
                        title: None,
                        parent_view: "dynamic".to_string(),
                    });
                }
            }
        }
    }

    if !ts_elements.is_empty() {
        total_elements += ts_elements.len();
        if let Some(first_view) = views.first_mut() {
            first_view.elements.extend(ts_elements);
        } else {
            views.push(UIView {
                id: "dynamic-view".to_string(),
                name: "Dynamic View".to_string(),
                description: Some("スクリプト制御要素".to_string()),
                elements: ts_elements,
                observed_from: None,
            });
        }
    }

    if let Ok(content) = fs::read_to_string(&observation_file) {
        if let Ok(observation) = serde_json::from_str::<UIObservation>(&content) {
            if observation.code_hash.as_deref() != Some(code_hash.as_str()) {
                // The application changed after this runtime observation.
                return UIMap {
                    project_name: project_name(root),
                    views,
                    total_elements,
                    source_hash: Some(current_hash),
                };
            }
            for observed in observation.views {
                if let Some(existing) = views.iter_mut().find(|view| view.id == observed.id) {
                    existing.name = observed.name;
                    existing.observed_from = Some(observation.source.clone());
                    for element in observed.elements {
                        if let Some(current) = existing
                            .elements
                            .iter_mut()
                            .find(|current| current.selector == element.selector)
                        {
                            *current = element;
                        } else {
                            existing.elements.push(element);
                        }
                    }
                } else {
                    views.push(observed);
                }
            }
            total_elements = views.iter().map(|view| view.elements.len()).sum();
        }
    }

    UIMap {
        project_name: project_name(root),
        views,
        total_elements,
        source_hash: Some(current_hash),
    }
}

fn project_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("app")
        .to_string()
}

fn app_source_files(root: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut html_files = source_files(root, &["html"], 3);
    // Keep the existing sample-project behavior: its UI can live in the parent.
    if !root.join("index.html").is_file() {
        if let Some(parent_index) = root.parent().map(|parent| parent.join("index.html")) {
            if parent_index.is_file() && !html_files.contains(&parent_index) {
                html_files.insert(0, parent_index);
            }
        }
    }
    (html_files, source_files(root, &["ts", "js"], 4))
}

fn source_files(root: &Path, extensions: &[&str], depth: usize) -> Vec<PathBuf> {
    let mut files: Vec<_> = WalkDir::new(root)
        .max_depth(depth)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_dir()
                || !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | "manual" | "docs" | "target" | "node_modules" | "dist")
                )
        })
        .filter_map(Result::ok)
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| extensions.contains(&ext))
        })
        .collect();
    files.sort();
    files
}

fn source_hash<'a>(root: &Path, files: impl Iterator<Item = &'a PathBuf>) -> String {
    let mut hasher = Sha256::new();
    for path in files {
        if let Ok(content) = fs::read(path) {
            hasher.update(
                path.strip_prefix(root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .as_bytes(),
            );
            hasher.update([0]);
            hasher.update(content.len().to_le_bytes());
            hasher.update(content);
        }
    }
    format!("{:x}", hasher.finalize())
}

pub fn save_ui_map(root: &Path, ui_map: &UIMap) -> Result<(), String> {
    let dest_dir = root.join("manual");
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let path = dest_dir.join("ui_map.json");
    let json = serde_json::to_string_pretty(ui_map).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Convert markits::UiElement into uimap::UIElement with a stable UID
pub fn convert_markits_elements(
    elements: &[markits::UiElement],
    parent_view: &str,
) -> Vec<UIElement> {
    elements
        .iter()
        .enumerate()
        .map(|(index, el)| {
            let role = if el.role.trim().is_empty() {
                "element"
            } else {
                el.role.as_str()
            };
            let clean_name = el.name.trim();
            let uid = if clean_name.is_empty() {
                format!("{}-{}", role, index + 1)
            } else {
                let sanitized: String = clean_name
                    .chars()
                    .map(|c| {
                        if c.is_alphanumeric() || c == '-' || c == '_' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
                format!("{}-{}-{}", role, sanitized.trim_matches('_'), index + 1)
            };
            let selector = if !clean_name.is_empty() {
                format!("{}[name=\"{}\"]", role, clean_name)
            } else {
                format!("#{uid}")
            };
            UIElement {
                id: uid,
                selector,
                name: if clean_name.is_empty() {
                    format!("{role} #{}", index + 1)
                } else {
                    clean_name.to_string()
                },
                role: role.to_string(),
                title: if !clean_name.is_empty() {
                    Some(clean_name.to_string())
                } else {
                    None
                },
                parent_view: parent_view.to_string(),
            }
        })
        .collect()
}

/// Import or update UIMap from an image containing MarkIts UIMap metadata or an external JSON file.
pub fn import_from_markits_image(root: &Path, image_path: &Path) -> Result<UIMap, String> {
    let abs_path = if image_path.is_absolute() {
        image_path.to_path_buf()
    } else {
        root.join(image_path)
    };
    if !abs_path.is_file() {
        return Err(format!("Image file not found: {}", abs_path.display()));
    }
    let markits_elements = markits::raster::load_uimap_from_path(&abs_path).map_err(|e| {
        format!(
            "Failed to load UIMap from image {}: {e}",
            abs_path.display()
        )
    })?;
    if markits_elements.is_empty() {
        return Err(format!(
            "No UI elements found in image metadata for {}",
            abs_path.display()
        ));
    }

    let view_id = abs_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image-view")
        .to_string();
    let view_name = abs_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&view_id)
        .to_string();

    let elements = convert_markits_elements(&markits_elements, &view_id);
    let view = UIView {
        id: view_id.clone(),
        name: view_name,
        description: Some(format!("Imported from {}", abs_path.display())),
        elements,
        observed_from: Some(abs_path.to_string_lossy().to_string()),
    };

    let mut map = extract_ui_map(root);
    if let Some(existing) = map.views.iter_mut().find(|v| v.id == view_id) {
        *existing = view;
    } else {
        map.views.push(view);
    }
    map.total_elements = map.views.iter().map(|v| v.elements.len()).sum();
    save_ui_map(root, &map)?;
    Ok(map)
}

/// Import or update UIMap by scanning UI elements directly on the desktop using MarkIts.
pub fn import_from_desktop(
    root: &Path,
    bounds: Option<(f64, f64, f64, f64)>,
) -> Result<UIMap, String> {
    let detected = markits::ui_elements::capture_desktop_detailed_elements(0, 0, bounds);
    if detected.is_empty() {
        return Err("No desktop UI elements detected".to_string());
    }
    let markits_elements: Vec<markits::UiElement> = detected.into_iter().map(Into::into).collect();

    let view_id = "desktop-view".to_string();
    let elements = convert_markits_elements(&markits_elements, &view_id);
    let view = UIView {
        id: view_id.clone(),
        name: "Desktop View".to_string(),
        description: Some("Scanned from active desktop UI".to_string()),
        elements,
        observed_from: Some("desktop".to_string()),
    };

    let mut map = extract_ui_map(root);
    if let Some(existing) = map.views.iter_mut().find(|v| v.id == view_id) {
        *existing = view;
    } else {
        map.views.push(view);
    }
    map.total_elements = map.views.iter().map(|v| v.elements.len()).sum();
    save_ui_map(root, &map)?;
    Ok(map)
}
