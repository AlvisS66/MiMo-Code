---
feature: remove-read-state-gate
status: in-progress
updated: 2026-09-14
branch: feat/remove-read-state-gate
commits: 
---

# Remove Read-before-Edit Hard Gate

## Report

## [S1] Problem

`assertFileRead` forces `edit` / `notebook-edit` to fail unless the exact file path was previously opened with the `read` tool in the same conversation. Real agent workflows no longer match that contract:

1. Models increasingly inspect files via bash (`cat` / `sed` / `python`), which never records a `read` tool part, so the subsequent `edit` fails with a recoverable error and burns a turn.
2. Agents that read a path in the main worktree and then edit the same logical file inside their own worktree hit a path mismatch — `canon()` compares absolute paths, so the gate rejects a legitimate edit.
3. Compaction / history loss can drop the original `read` parts, re-triggering the gate on a file the model has already seen.

The gate does not protect file integrity: `edit` still loads current disk contents and exact-matches `old_string` before writing. `write` documents the same rule but never enforces it; `apply_patch` has no gate. The hard check is inconsistent, easy to bypass via bash, and hostile to worktree workflows.

## [S2] Design

Remove the hard gate entirely.

- Delete `packages/opencode/src/tool/read-state.ts`.
- Drop `assertFileRead` from `edit` (including the create-file exemption comment) and `notebook-edit`.
- Soften tool descriptions to advisory language: prefer reading the file first so edits match current contents; no claim of hard failure.
- Leave `write` / `multiedit` advisory text as-is (write already only claimed enforcement it never had).
- Leave compaction guidance ("re-read any file you need before editing") — that is about context loss, not tool enforcement.
- Leave the `default.txt` mention of tool-layer benefits; drop only the "read-state tracking" claim if it becomes inaccurate.

Permission / path guards (`assertWriteAllowed`, `askEditUnlessMemory`, memory path guard) stay unchanged.

## [S3] Out of Scope

- Expanding bash outputs into a synthetic read-state.
- Making `write` enforce a read gate.
- Changing exact-string match, fuzzy-edit flag, or apply_patch behavior.
- Compaction message rewording beyond what is needed for accuracy.

## Tasks
- [ ] T1: Remove assertFileRead call sites from edit and notebook-edit — acceptance: both tools edit existing files without a prior `read` tool call in the session (covers: S2)
- [ ] T2: Delete read-state module and fix leftover references — acceptance: no production import of `assertFileRead` / `read-state` remains; tool .txt files no longer promise a hard failure (covers: S2)
- [ ] T3: Verify with typecheck + focused tool tests — acceptance: `bun typecheck` passes from `packages/opencode`; edit/notebook-edit tests still pass (covers: S2; depends: T1, T2)
