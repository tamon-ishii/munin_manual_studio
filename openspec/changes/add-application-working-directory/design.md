# Design

## Context

Project launch profiles live in `.munin/launch_commands.json`. Tauri currently starts both test launches and recording targets with the project root as the working directory. Recorded desktop scenarios and AI-authored screenshot recipes store the executable and arguments.

## Goals / Non-Goals

**Goals:** Persist an optional working folder per application and consistently use it for direct launch and screenshot scenario replay. Keep old JSON profiles and scenarios valid.

**Non-Goals:** Resolve shell commands, change executable selection, or make the working folder a project-wide setting.

## Decisions

- Add an optional `workingDirectory` profile field and render it beside the executable path with a native folder picker. Empty means the project root; this preserves existing behavior and avoids writing project-root paths into older registrations.
- Pass the value through the launch-check and capture commands. Resolve a relative folder against the project root, validate that it exists and is a directory, then set it as the process current directory.
- Store the effective folder in newly recorded screenshot scenarios so replay uses the same startup context. Scenario files without the field continue to use the project root.
- Include the field in the AI-assisted app registration form, while keeping it user-editable and defaulting to the project root behavior.

## Risks / Trade-offs

- A saved folder may move or be unavailable on another device → fail before launching and leave the registration editable.
- Absolute local paths are not portable → retain the project-root default and allow users to choose a path on each device.
