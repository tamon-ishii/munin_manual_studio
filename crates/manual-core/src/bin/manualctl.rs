fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--studio-tools") {
        let result=args.get(2).zip(args.get(3)).ok_or("--studio-tools requires request and response file paths".to_string())
            .and_then(|(input,output)|manual_core::terminal_tools::run_files(std::path::Path::new(input),std::path::Path::new(output)));
        if let Err(error)=result {eprintln!("{error}");std::process::exit(2);}
        return;
    }
    if args.get(1).map(String::as_str) == Some("--pty-daemon") {
        manual_core::pty::run_daemon();
        return;
    }
    let result = if args.get(1).map(String::as_str) == Some("--request") {
        args.get(2)
            .ok_or("--request requires JSON".into())
            .and_then(|raw| serde_json::from_str(raw).map_err(|error| error.to_string()))
            .and_then(manual_core::request)
    } else {
        let mut root = ".";
        let mut options = Vec::new();
        let mut index = 2;
        while index < args.len() {
            let key = args[index].as_str();
            if matches!(
                key,
                "--draft" | "--clear" | "--refresh" | "--check" | "--ai" | "--detect-ui" | "--crop"
            ) {
                options.push((key, ""));
                index += 1;
                continue;
            }
            let Some(value) = args.get(index + 1) else {
                eprintln!("Missing value for {key}");
                std::process::exit(2);
            };
            if key == "--root" {
                root = value;
            } else {
                options.push((key, value.as_str()));
            }
            index += 2;
        }
        match args.get(1).map(String::as_str) {
            None | Some("--help" | "-h") => {
                println!("Usage: manualctl ACTION --root PROJECT [OPTIONS]\nActions: state, editor-read, editor-save, editor-preview, selection-generate, document-review, screenshots-list, screenshots-recapture, scenario-run, build, ...");
                return;
            }
            Some(action) => manual_core::run(std::path::Path::new(root), action, &options),
        }
    };
    match result {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
