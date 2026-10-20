# Proposal

## Why

Some applications depend on their startup folder to find project files, plugins, or configuration. Registered apps currently store only the executable and arguments, so test launches and screenshot recordings always start in the manual project root.

## What Changes

- Add a per-application working-folder setting with a folder picker.
- Use the configured folder for launch checks, manual recordings, and replayable screenshot scenarios; keep the project root as the default for existing profiles.
- Preserve backward compatibility for saved profiles and scenarios without a working folder.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `application-launch-settings`: store and use an optional working folder for each registered application.

## Impact

Affects application registration, Tauri launch commands, screenshot recording and scenario replay, and their verification scripts. Existing project settings migrate by reading the new field as empty.
