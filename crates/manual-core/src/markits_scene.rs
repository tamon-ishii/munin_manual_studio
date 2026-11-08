//! Scale saved MarkIts annotations when a screenshot changes dimensions.
use serde_json::{json, Value};
use base64::Engine;

/// Keep the editable scene alongside rendered pixels for later recapture.
pub(crate) fn render_tracked(scene: &Value, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let uimap = markits::raster::extract_png_uimap(bytes);
    let scene = markits::raster::with_image_canvas_and_uimap(
        &scene.to_string(),
        image.width(),
        image.height(),
        uimap.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    let rendered =
        markits::raster::render_composed_png_bytes(&scene, bytes).map_err(|e| e.to_string())?;
    let rendered = markits::raster::embed_png_text_chunk(&rendered, "markits:annotations", &scene)
        .map_err(|e| e.to_string())?;
    // Reopening must draw the editable scene over the unmarked source pixels.
    let mime = match image::guess_format(bytes).map_err(|e| e.to_string())? {
        image::ImageFormat::Jpeg => "image/jpeg",
        _ => "image/png",
    };
    let source = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
    markits::raster::embed_png_text_chunk(&rendered, "markits:source_image", &source)
        .map_err(|e| e.to_string())
}

pub(crate) fn scale_markits_scene(
    scene: &mut Value,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let canvas = scene
        .get("canvas")
        .and_then(Value::as_object)
        .ok_or("MarkIts注釈にcanvas情報がありません")?;
    let old_width = canvas
        .get("width")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .ok_or("MarkIts注釈のcanvas幅が不正です")?;
    let old_height = canvas
        .get("height")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .ok_or("MarkIts注釈のcanvas高さが不正です")?;
    let sx = width as f64 / old_width;
    let sy = height as f64 / old_height;
    let root = scene.as_object_mut().ok_or("MarkIts注釈の形式が不正です")?;
    root.insert("canvas".into(), json!({"width":width,"height":height}));
    if let Some(annotations) = root.get_mut("annotations").and_then(Value::as_array_mut) {
        for annotation in annotations {
            let Some(fields) = annotation.as_object_mut() else {
                continue;
            };
            if let Some(values) = fields.get_mut("target").and_then(Value::as_array_mut) {
                if values.len() == 4 {
                    for (index, factor) in [sx, sy, sx, sy].into_iter().enumerate() {
                        if let Some(value) = values[index].as_f64() {
                            values[index] = json!(value * factor);
                        }
                    }
                }
            }
            for key in ["start", "control", "end"] {
                if let Some(values) = fields.get_mut(key).and_then(Value::as_array_mut) {
                    if values.len() == 2 {
                        for (index, factor) in [sx, sy].into_iter().enumerate() {
                            if let Some(value) = values[index].as_f64() {
                                values[index] = json!(value * factor);
                            }
                        }
                    }
                }
            }
            for (key, factor) in [
                ("stroke_width", sx.min(sy)),
                ("rx", sx),
                ("ry", sy),
                ("max_width", sx),
            ] {
                if let Some(value) = fields.get(key).and_then(Value::as_f64) {
                    fields.insert(key.into(), json!(value * factor));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn badge_rectangle_formatting_preserves_annotation_indices_and_can_be_hidden() {
        let scene = json!({"canvas":{"width":200,"height":150},"annotations":[
            {"type":"badge","target":[30,50,60,30],"step":1,"target_box":true,"target_style":"danger","stroke_width":7},
            {"type":"badge","target":[110,50,60,30],"step":2}
        ]});
        let svg = markits::renderer::render_from_json(&scene.to_string()).unwrap();
        assert_eq!(svg.matches("data-badge-target=").count(), 1);
        assert!(svg.contains("stroke-width=\"7\""));
        assert!(svg.contains("data-badge-index=\"0\""));
        assert!(svg.contains("data-badge-index=\"1\""));
        let mut hidden = scene;
        hidden["annotations"][0]["target_box"] = json!(false);
        let svg = markits::renderer::render_from_json(&hidden.to_string()).unwrap();
        assert!(!svg.contains("data-badge-target="));
    }

    #[test]
    fn tracked_marks_can_be_removed_using_the_saved_source() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(100, 80)
            .write_to(&mut png, image::ImageFormat::Png).unwrap();
        let original = png.into_inner();
        let scene = json!({"annotations":[{"type":"badge","target":[30,30,20,20],"step":1,"style":"step"}]});
        let rendered = render_tracked(&scene, &original).unwrap();
        assert_ne!(image::load_from_memory(&rendered).unwrap().to_rgba8(), image::load_from_memory(&original).unwrap().to_rgba8());
        let source = markits::raster::extract_png_text_chunk(&rendered, "markits:source_image").unwrap();
        let restored = base64::engine::general_purpose::STANDARD.decode(source.split_once(',').unwrap().1).unwrap();
        assert_eq!(restored, original);
        let cleared = render_tracked(&json!({"annotations":[]}), &restored).unwrap();
        assert_eq!(image::load_from_memory(&cleared).unwrap().to_rgba8(), image::load_from_memory(&original).unwrap().to_rgba8());
        let saved: Value = serde_json::from_str(&markits::raster::extract_png_text_chunk(&cleared, "markits:annotations").unwrap()).unwrap();
        assert_eq!(saved["annotations"], json!([]));
    }

    #[test]
    fn scales_geometry_and_preserves_labels_and_unknown_fields() {
        let mut scene = json!({"canvas":{"width":100,"height":50},"annotations":[{
            "target":[10,5,20,15],"start":[10,5],"control":[20,10],"end":[30,15],
            "stroke_width":4,"rx":10,"ry":5,"max_width":40,"label":"Keep me","custom":true
        }, null, {"target":[1,2,3],"start":[1]}]});
        scale_markits_scene(&mut scene, 200, 25).unwrap();
        assert_eq!(scene["canvas"], json!({"width":200,"height":25}));
        let annotation = &scene["annotations"][0];
        assert_eq!(annotation["target"], json!([20.0, 2.5, 40.0, 7.5]));
        assert_eq!(annotation["start"], json!([20.0, 2.5]));
        assert_eq!(annotation["control"], json!([40.0, 5.0]));
        assert_eq!(annotation["end"], json!([60.0, 7.5]));
        assert_eq!(annotation["stroke_width"], json!(2.0));
        assert_eq!(annotation["rx"], json!(20.0));
        assert_eq!(annotation["ry"], json!(2.5));
        assert_eq!(annotation["max_width"], json!(80.0));
        assert_eq!(annotation["label"], "Keep me");
        assert_eq!(annotation["custom"], true);
        assert_eq!(
            scene["annotations"][2],
            json!({"target":[1,2,3],"start":[1]})
        );
    }

    #[test]
    fn invalid_canvas_fails_without_modifying_the_scene() {
        for mut scene in [
            Value::Null,
            json!({}),
            json!({"canvas":{"width":0,"height":50}}),
            json!({"canvas":{"width":100,"height":-1}}),
        ] {
            let before = scene.clone();
            assert!(scale_markits_scene(&mut scene, 200, 100).is_err());
            assert_eq!(scene, before);
        }
    }
}
