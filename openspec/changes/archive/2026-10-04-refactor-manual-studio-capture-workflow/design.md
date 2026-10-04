# Design: Manual Studio Capture Workflow

## Boundaries and ownership

- `editorHistory.ts`, `fileTree.ts`, and `paneResizers.ts` hold focused editor and layout behavior outside the main event wiring.
- `manualTransport.ts` validates transport responses; `markdownTags.ts` owns Markdown tag edits.
- `captureSession.ts` snapshots the project root, page, task ID, and editor selection for one capture generation. The recording workflow separately retains the launch program and arguments. Changing or cancelling the session invalidates that generation.
- `markitsWorkflow.ts` sequences image preservation, document insertion/save, capture-source registration, refresh, and progress reporting.
- `main.ts` connects the modules and checks document, project, list, generation, and capture-session ownership before applying asynchronous results.

## Capture lifecycle

Capture work is tied to a specific session. Late replies from a superseded or cancelled session must not insert an image or modify the new target. The completed MarkIts handoff can be retried: preserve the annotated image without overwriting an existing capture, and perform insertion only while the owning session remains current. Completion accepts an empty annotation array only when a completed screenshot handoff proves the user finished editing; ordinary annotation-spec imports still require marks. Preserve the screenshot and its UI metadata, and clean up handoff files only after the capture completes.

The Studio window is hidden immediately before actual capture and restored by the scoped caller afterward. This does not hide the window while AI source preparation is running. Submit errors and step progress appear above the dialog's final action, and launch arguments remain attached to the capture configuration.

## Verification boundary

`npm run manual:check` runs the repository's scripted workflow, browser, build, and Rust checks. Browser UI tests replace native calls; they do not launch and operate MarkIts Desktop. The native handoff smoke check is a separate Linux/X11 integration path. Neither establishes that the full native Studio GUI workflow was verified across desktop environments. AI generation preparation time is not claimed as fixed by this refactor.
