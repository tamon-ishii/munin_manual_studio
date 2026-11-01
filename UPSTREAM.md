# Upstream source

This project contains Manual Studio and a MarkIts Git submodule.

MarkIts upstream repository: https://github.com/tamon-ishii/markits

`crates/markits` tracks upstream `main` and is pinned to commit `e83354d` (desktop 0.7.6). The integration supports direct capture with `--capture`, direct image editing, capture cancellation and return to Munin, and a simplified editing toolbar. Integration PNGs retain UIMap, annotations, crop backgrounds and recording metadata for subsequent edits. Munin reuses MarkIts's capture, rendering and metadata APIs; ordinary MarkIts exports and Munin's published HTML assets omit editing metadata. MarkIts copyright and license notices remain in `crates/markits/LICENSE` and the relevant source files.
