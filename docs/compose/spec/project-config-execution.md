---
feature: project-config-execution
status: in-progress
updated: 2026-10-28
source: codex/fix-project-config-execution
---

# Project configuration execution boundary

## Report

**What was built** — Desktop's Node engine, including hosts with a partial Bun shim, now rejects MCP, LSP and formatter configuration outside its host sources. Ordinary project settings and Bun CLI behavior are preserved. Allowed host file decisions survive global aggregation; project entries cannot enable servers or inject command environment overrides. The updated Node engine must be integrated into the desktop client before Windows UI verification.

**Verification** — From `packages/cli`, `bun test --timeout 30000 test/config test/plugin/host-sdk.test.ts test/plugin/host-node.test.ts test/mcp/project-config-execution.test.ts` passed with 202 tests, 4 existing platform skips and 435 assertions. From the repository root, `bun run typecheck` passed across all workspaces and scripts. From `packages/cli`, `MODELS_DEV_API_JSON=./test/tool/fixtures/models-api.json bun run script/build-node.ts` succeeded. Built-engine smoke checks exercised `GET /command` and `/config` on native Node and a partial Bun shim, with initial and restored instances: host MCP connected, project markers were absent, and allowed global symlink MCP/LSP/formatter settings survived. `git diff --check` passed; scoped lint reported 0 errors and 21 existing warnings on unchanged code. Independent review approved implementation commit `6cd61b0d9` after the source aggregation finding was fixed; an additional reviewer check covered trusted and untrusted legacy TOML migration.

## [S1] Problem

Opening a project in MiMo Desktop initializes the Node engine and connects MCP servers from merged project configuration. A downloaded project's local MCP command can run without a task or permission decision. Project LSP and formatter configuration shares the same missing source boundary.

## [S2] Design

### [S2.1] Host execution policy

Reuse the existing plugin and hook policy: Node, including a partial Bun shim, always restricts executable configuration; Bun restricts it when `MIMOCODE_ONLY_CONFIG_DIR_PLUGINS` is enabled. Accept MCP, LSP and formatter configuration only from files whose resolved paths are inside `MIMOCODE_CONFIG_DIR`, or from host-owned `MIMOCODE_CONFIG_CONTENT` and `MIMOCODE_CONFIG_DEFAULTS`. Preserve ordinary Bun CLI configuration behavior.

### [S2.2] Filter before merging

Discard entire MCP, LSP and formatter sections from other sources while loading each source, before configuration merging, including enabled toggles, environment and initialization overrides. Preserve ordinary project settings. Apply the same source check to Claude MCP compatibility and managed configuration. Preserve individual file decisions through global aggregation: a global symlink resolving to an allowed host file stays allowed, while a host symlink escaping to a project stays rejected. Rejected entries must neither execute nor replace allowed entries or their provenance. This policy is evaluated on every project instance load, including restored projects.

### [S2.3] Verification

Exercise actual configuration loading across root and nested JSON/JSONC files, Claude compatibility, allowed host configuration, host overrides, absent host directories and symlinks. Use a real harmless MCP subprocess that writes a temporary marker to prove restricted project loading cannot execute it, including a second instance load. Verify Node behavior with and without a partial Bun shim, and existing configuration and plugin tests.

### [S2.4] Legacy migration boundary

Read legacy TOML configuration using its original source decision. If the migration destination is outside allowed host sources, preserve the legacy file and skip migration writes and deletion. This keeps an allowed global symlink into the host directory usable after invalidation and restart. Model-only reads also load and normalize legacy model settings, without migration writes, deletion or starter configuration writes. Continue normal migration when the destination is allowed, including ordinary Bun CLI mode. Rejected legacy executable sections remain unavailable at runtime.

## [S3] Out of Scope

HTML preview and privileged desktop bridges are the report's second vulnerability. Desktop UI and Windows installer sources are not present in this repository; verification here covers the shared engine and its Node build.

## Tasks

- [x] T1: Share the host source policy and filter executable configuration — acceptance: rejected sections cannot enter effective configuration or override allowed host entries (covers: S2.1, S2.2).
- [x] T2: Add and run regression tests — acceptance: restricted loading never writes a project MCP marker, allowed host MCP still connects, Node shim and source boundary cases pass (depends: T1, covers: S2.3).
- [ ] T3: Verify compatibility and independently review the diff — acceptance: relevant tests and typecheck complete; review findings are resolved (depends: T2, T4).
- [ ] T4: Preserve legacy sources when migration would cross the host boundary — acceptance: allowed TOML symlink configuration survives source invalidation, restricted destinations receive no migration write or deletion, and allowed migrations still complete (covers: S2.4).

## Journey log

Review caught a trust decision being applied again to an aggregated global directory, which incorrectly rejected a legitimate global symlink into the host directory. Filtering now happens at each original source load; both symlink directions have regressions. The original project configuration tests failed before the fix, and a real harmless MCP fixture confirmed root, hidden and Claude project servers connected before the policy was extended.
