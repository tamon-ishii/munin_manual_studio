//! Capture and rendering are executed by Studio; the AI only returns structured plans.
use serde_json::{json,Value};
use std::{fs,io::Write,path::Path};

pub fn generate(root:&Path,page:&str,context:&Value,mut ai:impl FnMut(&str,&Value)->Result<Value,String>)->Result<Value,String>{
    let canonical=root.canonicalize().map_err(|e|e.to_string())?;
    let windows=crate::terminal_tools::invoke_isolated(root,&json!({"root":root,"action":"windows"}))?;
    generate_with(root,page,context,&windows,|id,output|{
        let relative=output.strip_prefix(&canonical).map_err(|_|"撮影先がプロジェクトの外を指しています。".to_string())?.to_string_lossy().replace('\\',"/");
        crate::terminal_tools::invoke_isolated(root,&json!({"root":root,"action":"capture","window":id,"output":relative})).map(|_|())
    },&mut ai)
}

fn generate_with(root:&Path,page:&str,context:&Value,windows:&Value,mut capture:impl FnMut(&str,&Path)->Result<(),String>,ai:&mut impl FnMut(&str,&Value)->Result<Value,String>)->Result<Value,String>{
    let checkpoint=crate::agent::cancellation_checkpoint(root);
    let check=||crate::agent::check_cancelled(root,&checkpoint);
    let plan_schema=json!({"type":"object","properties":{"captures":{"type":"array","items":{"type":"object","properties":{"window":{"type":"string"},"caption":{"type":"string"}},"required":["window","caption"],"additionalProperties":false}}},"required":["captures"],"additionalProperties":false});
    crate::agent::log_progress(root,"起動済みアプリから撮影対象を選んでいます。");
    let plan=ai(&format!("Return a capture plan using ONLY the supplied data. Do not call any tools, commands, or write files. Studio will perform the actual captures and MarkIts rendering. Select 1 to 3 existing windows relevant to the requested manuscript. Use exact window IDs. If none match, return an empty captures array.\nInput: {}",json!({"context":context,"windows":windows})),&plan_schema)?;
    check()?;
    let planned=plan["captures"].as_array().filter(|items|!items.is_empty()&&items.len()<=3).ok_or("撮影対象を選べませんでした。対象アプリの必要な画面を開いてから再試行してください。")?;
    let private=crate::config::project_path(root,".munin")?;fs::create_dir_all(&private).map_err(|e|e.to_string())?;
    let temporary=tempfile::Builder::new().prefix("selection-capture-").tempdir_in(&private).map_err(|e|e.to_string())?;
    let mut images=Vec::new();let mut sources=Vec::new();let mut destinations=Vec::new();
    for (index,item) in planned.iter().enumerate(){
        check()?;
        let id=item["window"].as_str().filter(|id|windows.as_array().is_some_and(|windows|windows.iter().any(|window|window["id"].as_str()==Some(id)))).ok_or("AIが一覧にない撮影対象を指定しました。")?;
        crate::agent::log_progress(root,&format!("MarkItsで画面を撮影中（{} / {}）。",index+1,planned.len()));
        let source=temporary.path().join(format!("source-{index}.png"));capture(id,&source)?;
        check()?;
        let (bytes,info)=markits::raster::read_image(&source).map_err(|e|e.to_string())?;
        let filename=format!("{}.png",crate::screenshots::new_id("capture"));
        let (destination,link)=crate::config::asset_destination(root,&crate::editor::document_path(root,page)?,&filename)?;
        images.push(json!({"index":index+1,"caption":item["caption"],"link":link,"width":info.width,"height":info.height,"uimap":info.uimap}));
        sources.push(bytes);destinations.push(destination);
    }
    let schema=json!({"type":"object","properties":{"content":{"type":"string"},"images":{"type":"array","items":{"type":"object","properties":{"index":{"type":"integer"},"annotations":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","enum":["rect","badge","callout","arrow"]},"target":{"type":"string"},"step":{"type":"integer"},"text":{"type":"string"},"style":{"type":"string"}},"required":["type","target"],"additionalProperties":false}}},"required":["index","annotations"],"additionalProperties":false}}},"required":["content","images"],"additionalProperties":false});
    crate::agent::log_progress(root,"撮影した画面に合わせて本文とマークを作成中。");
    let generated=ai(&format!("Use ONLY supplied manuscript and screenshot metadata. Do not call tools, execute commands, capture screens, or write files. Actual screenshots have already been captured by Studio. Return replacement Markdown in content, linking the supplied image link paths. Return one images entry per screenshot with its index and MarkIts annotations targeting actual UIMap names. Use numbered badges and rectangles for relevant controls. Never guess coordinates or invent UI targets. If a screenshot has no suitable UIMap targets, use an empty annotations array. Preserve factual accuracy and only rewrite the selected fragment.\nInput: {}",json!({"context":context,"screenshots":images})),&schema)?;
    check()?;
    let mut content=generated["content"].as_str().filter(|s|!s.trim().is_empty()).ok_or("AIから本文が返されませんでした。")?.to_string();
    let marks=generated["images"].as_array().filter(|items|items.len()==images.len()).ok_or("AIから撮影画像の注釈情報が返されませんでした。")?;
    let mut rendered=Vec::new();
    for (index,image) in images.iter().enumerate(){
        let entries:Vec<_>=marks.iter().filter(|item|item["index"].as_u64()==Some((index+1) as u64)).collect();
        if entries.len()!=1{return Err("AIの画像番号が不正です。".into());}
        let annotations=entries[0]["annotations"].as_array().filter(|items|items.len()<=30).ok_or("AIの注釈が不正です。")?;
        if annotations.is_empty(){crate::agent::log_progress(root,&format!("画像{}は注釈対象を特定できなかったため、マークなしで候補に含めます。",index+1));}
        let scene=json!({"annotations":normalize_annotations(annotations)});
        rendered.push(markits::raster::render_composed_png_bytes(&scene.to_string(),&sources[index]).map_err(|e|format!("MarkItsの注釈を描画できません: {e}"))?);
        let link=image["link"].as_str().unwrap_or("");
        if !content.contains(link){content.push_str(&format!("\n\n![撮影画像{}](<{link}>)\n",index+1));}
    }
    check()?;
    for (destination,bytes) in destinations.iter().zip(rendered){
        fs::create_dir_all(destination.parent().unwrap()).map_err(|e|e.to_string())?;
        fs::OpenOptions::new().write(true).create_new(true).open(destination).and_then(|mut file|file.write_all(&bytes)).map_err(|e|e.to_string())?;
    }
    crate::agent::log_progress(root,"撮影・MarkItsの画像描画が完了しました。本文は差分確認後に反映します。");
    Ok(json!({"content":content}))
}

// The AI schema has shared optional fields, whereas MarkIts rejects fields
// belonging to a different shape. Preserve numbering as a separate badge.
fn normalize_annotations(annotations:&[Value])->Vec<Value>{
    let mut result=Vec::new();
    for annotation in annotations {
        let kind=annotation["type"].as_str().unwrap_or("");
        let mut shape=serde_json::Map::new();
        for key in ["type","target","style"] {
            if let Some(value)=annotation.get(key).filter(|v|!v.is_null()){shape.insert(key.into(),value.clone());}
        }
        if matches!(kind,"badge"|"arrow"|"callout") {
            if let Some(text)=annotation.get("text").filter(|v|!v.is_null()){shape.insert("text".into(),text.clone());}
        }
        if matches!(kind,"badge"|"arrow") {
            if let Some(step)=annotation.get("step").filter(|v|!v.is_null()){shape.insert("step".into(),step.clone());}
        }
        result.push(Value::Object(shape));
        if matches!(kind,"rect"|"callout") {
            if let Some(step)=annotation.get("step").filter(|v|!v.is_null()) {
                result.push(json!({"type":"badge","target":annotation["target"],"step":step}));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn host_captures_and_marks_without_ai_commands_or_manuscript_changes(){
        let root=tempfile::tempdir().unwrap();fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/index.md"),"Original manuscript").unwrap();
        let windows=json!([{"id":"window-one","title":"Target app"}]);
        let mut calls=0;
        let result=generate_with(root.path(),"index.md",&json!({"instruction":"保存ボタンを撮影して説明"}),&windows,|id,path|{
            assert_eq!(id,"window-one");
            let mut bytes=std::io::Cursor::new(Vec::new());image::DynamicImage::new_rgb8(200,120).write_to(&mut bytes,image::ImageFormat::Png).unwrap();
            let png=markits::raster::embed_png_uimap(bytes.get_ref(),&[markits::UiElement::new("button","保存",30.,30.,80.,30.)]).unwrap();
            fs::write(path,png).map_err(|e|e.to_string())
        },&mut |prompt,_schema|{
            calls+=1;
            if calls==1{assert!(prompt.contains("Do not call any tools"));Ok(json!({"captures":[{"window":"window-one","caption":"保存操作"}]}))}
            else{
                assert!(prompt.contains("Actual screenshots have already been captured"));
                let data:Value=serde_json::from_str(prompt.split("\nInput: ").nth(1).unwrap()).unwrap();
                let link=data["screenshots"][0]["link"].as_str().unwrap();
                assert_eq!(data["screenshots"][0]["uimap"][0]["name"],"保存");
                Ok(json!({"content":format!("保存します。\n\n![保存](<{link}>)"),"images":[{"index":1,"annotations":[{"type":"rect","target":"保存"},{"type":"badge","target":"保存","step":1}]}]}))
            }
        }).unwrap();
        assert_eq!(calls,2);assert!(result["content"].as_str().unwrap().contains("assets/capture-"));
        assert_eq!(fs::read_to_string(root.path().join("docs/index.md")).unwrap(),"Original manuscript");
        let files:Vec<_>=fs::read_dir(root.path().join("docs/assets")).unwrap().map(|entry|entry.unwrap().path()).collect();
        assert_eq!(files.len(),1);
        let marked=image::open(&files[0]).unwrap().to_rgb8();assert!(marked.pixels().any(|pixel|pixel.0!=[0,0,0]));
        assert!(!fs::read_dir(root.path().join(".munin")).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().starts_with("selection-capture-")));
    }
    #[test]
    fn invalid_window_plan_cannot_trigger_capture(){
        let root=tempfile::tempdir().unwrap();
        let error=generate_with(root.path(),"index.md",&json!({}),&json!([{"id":"valid"}]),|_,_|panic!("must not capture unknown window"),&mut |_,_|Ok(json!({"captures":[{"window":"invalid","caption":"wrong"}]}))).unwrap_err();
        assert!(error.contains("一覧にない"));
    }
}
