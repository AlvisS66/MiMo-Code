---
feature: project-config-execution
status: in-progress
updated: 2026-10-28
source: codex/fix-project-config-execution
---

# Project configuration execution boundary

## Report

## [S1] Problem

Opening a project in MiMo Desktop initializes the Node engine and connects MCP servers from merged project configuration. A downloaded project's local MCP command can run without a task or permission decision. Project LSP and formatter configuration shares the same missing source boundary.

## [S2] Design

### [S2.1] Host execution policy

Reuse the existing plugin and hook policy: Node, including a partial Bun shim, always restricts executable configuration; Bun restricts it when `MIMOCODE_ONLY_CONFIG_DIR_PLUGINS` is enabled. Accept MCP, LSP and formatter configuration only from files whose resolved paths are inside `MIMOCODE_CONFIG_DIR`, or from host-owned `MIMOCODE_CONFIG_CONTENT` and `MIMOCODE_CONFIG_DEFAULTS`. Preserve ordinary Bun CLI configuration behavior.

### [S2.2] Filter before merging

Discard entire MCP, LSP and formatter sections from other sources while loading each source, before configuration merging, including enabled toggles, environment and initialization overrides. Preserve ordinary project settings. Apply the same source check to Claude MCP compatibility and managed configuration. Preserve individual file decisions through global aggregation: a global symlink resolving to an allowed host file stays allowed, while a host symlink escaping to a project stays rejected. Rejected entries must neither execute nor replace allowed entries or their provenance. This policy is evaluated on every project instance load, including restored projects.

### [S2.3] Verification

Exercise actual configuration loading across root and nested JSON/JSONC files, Claude compatibility, allowed host configuration, host overrides, absent host directories and symlinks. Use a real harmless MCP subprocess that writes a temporary marker to prove restricted project loading cannot execute it, including a second instance load. Verify Node behavior with and without a partial Bun shim, and existing configuration and plugin tests.

## [S3] Out of Scope

HTML preview and privileged desktop bridges are the report's second vulnerability. Desktop UI and Windows installer sources are not present in this repository; verification here covers the shared engine and its Node build.

## Tasks

- [x] T1: Share the host source policy and filter executable configuration — acceptance: rejected sections cannot enter effective configuration or override allowed host entries (covers: S2.1, S2.2).
- [x] T2: Add and run regression tests — acceptance: restricted loading never writes a project MCP marker, allowed host MCP still connects, Node shim and source boundary cases pass (depends: T1, covers: S2.3).
- [ ] T3: Verify compatibility and independently review the diff — acceptance: relevant tests and typecheck complete; review findings are resolved (depends: T2).

## Journey log
