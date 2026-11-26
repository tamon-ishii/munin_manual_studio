//! File-based MarkIts tools and a project-specific briefing for interactive AI CLIs.
use crate::config::{project_path,read_config};
use serde_json::{json,Value};
use std::{fs,path::Path};

pub(crate) fn invoke_isolated(root:&Path,request:&Value)->Result<Value,String>{
    let temporary=tempfile::tempdir().map_err(|e|e.to_string())?;
    let input=temporary.path().join("request.json");let output=temporary.path().join("response.json");
    fs::write(&input,serde_json::to_vec(request).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let executable=std::env::current_exe().map_err(|e|e.to_string())?;
    let result=crate::agent::run_process(root,&executable.to_string_lossy(),&["--studio-tools".into(),input.to_string_lossy().into_owned(),output.to_string_lossy().into_owned()])?;
    if !result.status.success(){return Err(format!("MarkItsの撮影ツールが終了しました: {}",String::from_utf8_lossy(&result.stderr)));}
    let response:Value=serde_json::from_slice(&fs::read(output).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if response["ok"]!=true{return Err(response["error"].as_str().unwrap_or("MarkIts tool failed").to_string());}
    Ok(response["result"].clone())
}

pub fn prepare(root:&Path)->Result<Value,String>{
    prepare_in(root,None)
}

fn write_terminal_markdown(path: &Path, content: &str) -> std::io::Result<()> {
    // Windows PowerShell defaults to the system code page for files without a BOM.
    if cfg!(windows) {
        fs::write(path, format!("\u{feff}{content}"))
    } else {
        fs::write(path, content)
    }
}

pub fn prepare_in(root:&Path,working_directory:Option<&str>)->Result<Value,String>{
    let root=crate::platform::canonical_clean(root).map_err(|e|e.to_string())?;
    let working_directory=crate::pty::working_directory(&root,working_directory)?;
    let directory=crate::platform::strip_windows_verbatim(&project_path(&root,".munin/ai-terminal")?);
    fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    let config=read_config(&root);
    let executable=std::env::current_exe().map_err(|e|e.to_string())?;
    let manifest=json!({"project":root,"working_directory":working_directory,"executable":executable,"docs":config.docs,"assets":config.assets,"target_application":crate::target_application::context(&root),"actions":["windows","capture","attach-uimap","register-capture","inspect","annotate","target-launch","operations-schema","operations-validate","operations-inspect","operations-attach","operations-run","operations-resume"]});
    fs::write(directory.join("tools.json"),serde_json::to_vec_pretty(&manifest).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    write_terminal_markdown(&directory.join("guide.md"),include_str!("terminal_guide.md")).map_err(|e|e.to_string())?;
    fs::write(directory.join("operation-script.schema.json"),include_str!("operation_script.schema.json")).map_err(|e|e.to_string())?;
    write_terminal_markdown(&directory.join("markits-manual.md"),include_str!("../../markits/docs/AI_MANUAL.md")).map_err(|e|e.to_string())?;
    let prompt=format!("Read the guide at {} and the tools.json beside it before replying. Use bundled MarkIts tools for actual app screenshots, annotations and AI-authored operation scripts (operations-schema, operations-validate, operations-run). Register every requested or manual-bound screenshot in Studio Capture Resources with register-capture before editing, including background captures. If the matching UIMap is a separate file, run attach-uimap first and register its output. Verify the returned resource ID and report missing UIMap or operation metadata. The current working directory may differ from the manual project; generate manuals in the project specified by tools.json. Ask which application and workflow to document if not specified.",directory.join("guide.md").display());
    Ok(json!({"prompt":format!("{prompt} Read text files as UTF-8. In PowerShell, use Get-Content -Raw -Encoding UTF8 -LiteralPath."),"guide":directory.join("guide.md"),"working_directory":working_directory}))
}

fn path(root:&Path,request:&Value,key:&str)->Result<std::path::PathBuf,String>{
    project_path(root,request[key].as_str().filter(|s|!s.is_empty()).ok_or_else(||format!("{key} is required"))?)
}
fn output_path(root:&Path,request:&Value)->Result<std::path::PathBuf,String>{
    let output=path(root,request,"output")?;
    if output.extension().and_then(|s|s.to_str())!=Some("png"){return Err("Output must be a PNG file".into());}
    if output.exists(){return Err("Output already exists; choose a new filename".into());}
    if let Some(parent)=output.parent(){fs::create_dir_all(parent).map_err(|e|e.to_string())?;}
    Ok(output)
}

fn write_new_png(output: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(output.parent().ok_or("Invalid PNG output path")?)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.persist_noclobber(output).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn execute(request:&Value)->Result<Value,String>{
    let root=Path::new(request["root"].as_str().ok_or("root is required")?);
    if !root.is_dir(){return Err("Project directory does not exist".into());}
    match request["action"].as_str().unwrap_or(""){
        "target-launch"=>crate::target_application::launch(root),
        "windows"=>serde_json::to_value(markits::window_capture::list_windows()?).map_err(|e|e.to_string()),
        action @ ("operations-schema" | "operations-validate" | "operations-inspect" | "operations-attach" | "operations-run" | "operations-resume") => crate::operation_script::execute(root,action,request),
        "capture"=>{
            let window=request["window"].as_str().filter(|s|!s.trim().is_empty()).ok_or("Choose a window ID from windows first")?;
            if !markits::window_capture::list_windows()?.iter().any(|item|item.id==window){return Err("Window ID was not found; refresh windows".into());}
            let output=output_path(root,request)?;
            markits::window_capture::activate_window(window)?;
            let detect_ui=request["detect_ui"]!=false;
            let captured=markits::window_capture::capture_window(window,0,&output,detect_ui,detect_ui.then_some(window))?;
            Ok(json!({"output":request["output"],"window":captured}))
        },
        "attach-uimap" => {
            let image = path(root, request, "image")?;
            let (bytes, _) = markits::raster::read_image(&image).map_err(|error| error.to_string())?;
            let map_path = path(root, request, "uimap")?;
            let elements = markits::raster::load_uimap_from_path(&map_path).map_err(|error| error.to_string())?;
            let tagged = markits::raster::embed_png_uimap(&bytes, &elements).map_err(|error| error.to_string())?;
            write_new_png(&output_path(root, request)?, &tagged)?;
            Ok(json!({"output":request["output"],"uimap_elements":elements.len()}))
        },
        "register-capture" => {
            let original = path(root, request, "image")?;
            let bytes = fs::read(original).map_err(|error| error.to_string())?;
            let name = request["name"].as_str().map(str::trim).filter(|name| !name.is_empty()).unwrap_or("AI撮影画像");
            let resource = crate::capture_resources::register(root, &bytes, name)?;
            let uimap_elements = markits::raster::extract_png_uimap(&bytes).map_or(0, |elements| elements.len());
            Ok(json!({"resource_id": resource.id, "name": resource.name, "uimap_elements": uimap_elements, "recorded": resource.recorded, "window_recapture": resource.window_recapture}))
        },
        "inspect"=>{
            let info=markits::raster::inspect_image(&path(root,request,"image")?).map_err(|e|e.to_string())?;
            Ok(json!({"width":info.width,"height":info.height,"uimap":info.uimap}))
        },
        "annotate"=>{
            let input=path(root,request,"image")?;
            let output=output_path(root,request)?;
            let (bytes,_)=markits::raster::read_image(&input).map_err(|e|e.to_string())?;
            let scene=request.get("scene").ok_or("scene is required")?;
            let margin=match request.get("crop_margin") {Some(value)=>Some(value.as_u64().filter(|v|*v<=4096).ok_or("Invalid crop_margin")? as u32),None=>None};
            let mut rendered=markits::raster::render_composed_png_bytes_with_crop(&scene.to_string(),&bytes,margin).map_err(|e|e.to_string())?;
            if request["strip_metadata"]==true{rendered=markits::image_metadata::strip_markits_metadata(&rendered).map_err(|e|e.to_string())?;}
            write_new_png(&output, &rendered)?;
            Ok(json!({"output":request["output"]}))
        },
        action=>Err(format!("Unknown MarkIts tool action: {action}")),
    }
}

pub fn run_files(input:&Path,output:&Path)->Result<(),String>{
    if input==output{return Err("Request and response paths must be different".into());}
    let result=fs::read(input).map_err(|e|e.to_string()).and_then(|bytes|serde_json::from_slice::<Value>(bytes.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&bytes)).map_err(|e|e.to_string())).and_then(|request|execute(&request));
    let response=match result{Ok(value)=>json!({"ok":true,"result":value}),Err(error)=>json!({"ok":false,"error":error})};
    fs::write(output,serde_json::to_vec_pretty(&response).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn briefing_contains_real_tools_and_preserves_project_instructions(){
        let root=tempfile::tempdir().unwrap();
        fs::write(root.path().join("AGENTS.md"),"Existing project instructions").unwrap();
        let prepared=prepare(root.path()).unwrap();
        assert!(prepared["prompt"].as_str().unwrap().contains(prepared["guide"].as_str().unwrap()));
        let directory=root.path().join(".munin/ai-terminal");
        let guide=fs::read_to_string(directory.join("guide.md")).unwrap();
        let markits_manual=fs::read_to_string(directory.join("markits-manual.md")).unwrap();
        assert_eq!(guide.starts_with('\u{feff}'), cfg!(windows));
        assert_eq!(markits_manual.starts_with('\u{feff}'), cfg!(windows));
        assert_eq!(guide.trim_start_matches('\u{feff}'), include_str!("terminal_guide.md"));
        assert!(prepared["prompt"].as_str().unwrap().contains("Get-Content -Raw -Encoding UTF8 -LiteralPath"));
        assert!(guide.contains("--studio-tools"));assert!(guide.contains("WINDOW_ID_FROM_WINDOWS"));
        assert!(markits_manual.contains("MarkIts AI Manual"));
        let manifest:Value=serde_json::from_slice(&fs::read(directory.join("tools.json")).unwrap()).unwrap();
        assert!(manifest["actions"].as_array().unwrap().contains(&json!("operations-run")));
        let schema:Value=serde_json::from_slice(&fs::read(directory.join("operation-script.schema.json")).unwrap()).unwrap();
        assert_eq!(schema["properties"]["version"]["const"],1);
        assert_eq!(Path::new(manifest["project"].as_str().unwrap()).canonicalize().unwrap(),root.path().canonicalize().unwrap());
        assert_eq!(fs::read_to_string(root.path().join("AGENTS.md")).unwrap(),"Existing project instructions");
        let work=root.path().join("application source");fs::create_dir(&work).unwrap();
        let changed=prepare_in(root.path(),Some("application source")).unwrap();
        assert_eq!(Path::new(changed["working_directory"].as_str().unwrap()).canonicalize().unwrap(),work.canonicalize().unwrap());
    }
    #[test]
    fn file_tools_inspect_and_annotate_with_real_markits_and_keep_original(){
        let root=tempfile::tempdir().unwrap();
        let image=root.path().join("source.png");
        image::DynamicImage::new_rgb8(200,120).save(&image).unwrap();
        let plain = fs::read(&image).unwrap();
        let plain_registration = execute(&json!({"root":root.path(),"action":"register-capture","image":"source.png"})).unwrap();
        assert_eq!(plain_registration["uimap_elements"], 0);
        let plain_id = plain_registration["resource_id"].as_str().unwrap();
        let published = crate::capture_resources::generate(root.path(), plain_id, None, None).unwrap();
        let edit_source = crate::capture_resources::editing_source(root.path(), &published.path).unwrap().unwrap();
        assert_eq!(fs::read(edit_source).unwrap(), plain);
        fs::write(root.path().join("uimap.json"), r#"[{"role":"button","name":"Save","x":30,"y":30,"width":80,"height":30}]"#).unwrap();
        let attach = json!({"root":root.path(),"action":"attach-uimap","image":"source.png","uimap":"uimap.json","output":"editable.png"});
        assert_eq!(execute(&attach).unwrap()["uimap_elements"], 1);
        assert_eq!(fs::read(&image).unwrap(), plain);
        let attached = fs::read(root.path().join("editable.png")).unwrap();
        assert_eq!(markits::raster::extract_png_uimap(&attached).unwrap()[0].name, "Save");
        let original=markits::raster::embed_png_uimap(&fs::read(&image).unwrap(),&[markits::UiElement::new("button","保存",30.,30.,80.,30.)]).unwrap();
        fs::write(&image,&original).unwrap();
        let registration = json!({"root":root.path(),"action":"register-capture","image":"source.png","name":"Save dialog"});
        let registered = execute(&registration).unwrap();
        let resource_id = registered["resource_id"].as_str().unwrap();
        assert_eq!(registered["uimap_elements"], 1);
        assert_eq!(registered["recorded"], false);
        let source = crate::capture_resources::source(root.path(), resource_id).unwrap();
        assert_eq!(fs::read(source).unwrap(), original);
        assert_eq!(execute(&registration).unwrap()["resource_id"], resource_id);
        let inspected=execute(&json!({"root":root.path(),"action":"inspect","image":"source.png"})).unwrap();
        assert_eq!(inspected["width"],200);assert_eq!(inspected["uimap"][0]["name"],"保存");
        let request=json!({"root":root.path(),"action":"annotate","image":"source.png","output":"assets/step-1.png","scene":{"annotations":[{"type":"rect","target":"保存","style":"primary"},{"type":"badge","target":"保存","step":1,"style":"step"}]}});
        let input=root.path().join("request.json");let output=root.path().join("response.json");
        let mut bytes=vec![0xef,0xbb,0xbf];bytes.extend(serde_json::to_vec(&request).unwrap());fs::write(&input,bytes).unwrap();
        run_files(&input,&output).unwrap();
        let response:Value=serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();assert_eq!(response["ok"],true,"{response}");
        let rendered=fs::read(root.path().join("assets/step-1.png")).unwrap();
        assert_ne!(image::load_from_memory(&rendered).unwrap().to_rgb8(),image::load_from_memory(&original).unwrap().to_rgb8());
        assert_eq!(fs::read(&image).unwrap(),original);
        assert!(execute(&request).unwrap_err().contains("already exists"));
        assert!(execute(&json!({"root":root.path(),"action":"inspect","image":"../outside.png"})).is_err());
        fs::write(&input,"not JSON").unwrap();run_files(&input,&output).unwrap();
        let failure:Value=serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();assert_eq!(failure["ok"],false);
    }
}
