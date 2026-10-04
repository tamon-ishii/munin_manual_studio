---
name: moduleloom-diagnostics
description: Use ModuleLoom's code diagnostics CLI to guide Python code changes and verify that relevant findings are resolved. Apply when working in the ModuleLoom repository or when a project has the moduleloom-analyze CLI available.
---

# ModuleLoom diagnostics

Use the CLI's structured findings as evidence while editing Python code. Fix findings relevant to the user's request, then run the same diagnostic after the edit.

## Locate and run the CLI

In the ModuleLoom repository, the local binary is `target/debug/analyze` (spell `target` exactly). If it is missing or analyzer source has changed, build it with `cargo build -p moduleloom-analyzer --bin analyze`. In another project, use an available `moduleloom-analyze` executable. Pass the Python project directory as the final argument.

```bash
target/debug/analyze --diagnostics --findings-only .
target/debug/analyze --diagnostics --findings-only --rule 'ty/*' .
```

`--diagnostics` produces JSON; `--findings-only` keeps the output focused on `findings` and `quality_warnings`. Use `--rule 'prefix/*'` to narrow a large result, or omit it when surveying the project. Read each finding's `rule`, `severity`, `location`, `message`, `evidence`, and `verification.recheck_rule`. Check the referenced code before changing it. Keep the original diagnostic result or counts for comparison.

## Edit and verify

- Preserve the user's requested scope and existing worktree changes. Treat `info` findings such as `missing-type-annotation` as review hints, not automatic defects.
- Address the cause in source code. Avoid suppressing a rule or changing thresholds merely to hide a finding unless the user asks for that.
- Rerun the relevant CLI rule after editing, and use the project's normal tests or checker when they cover the changed behavior. For ty findings, also run `uv run ty check` when ty is installed in the project.
- Check `quality_warnings`: an empty findings list does not prove the type check ran if ty was unavailable or failed. Report unresolved findings and tool warnings plainly.
- When reporting results, give the command, remaining relevant finding count, verification outcome, and the path of any full JSON artifact. Do not paste a large JSON report into the response.
