---
feature: title-bare-command-untitled
status: delivered
updated: 2026-09-14
branch: fix/title-bare-command-untitled
commits: c0b2a9af..1c79d16c
---

# Title: bare command as first input must not lock "Untitled"

## Report

**What was built** — `ensureTitle` (packages/opencode/src/session/prompt.ts) no longer commits a placeholder title when it has no usable material: the guard changed from `input.arguments === undefined` to `!input.arguments?.trim()`, so a bare slash command as a new session's first input keeps `titleRevision === 0` instead of committing "Untitled" at revision 0→1 and permanently locking the title. The same request's existing prompt-phase path then takes over: the persisted message text becomes the fallback title and the detached `genTitle` upgrades it to `generated`. This aligns the commit side with `sanitizeGeneratedTitle`, which already rejects "Untitled" as an invalid title. Regression assertions in `test/session/title-first-turn.test.ts` that had pinned the buggy behavior (blank-argument command ⇒ `titleRevision: 1`, "Untitled") now require the generated outcome; `test/fixture/fixture.ts` cleanup yields 1s and retries once on Windows EBUSY so handle-latency no longer fails cleanup.

Known boundary (reviewer-verified, accepted): a bare command whose template resolves to empty text with no attachments is dropped by `hasSubstantiveContent` before any title call — the session stays at `Untitled` revision 0, which the next real input can still initialize (recoverable, unlike the pre-fix permanent lock). Blank-argument titles now derive from persisted command scaffolding (template text / `/cmd` token) rather than the lock; attachment-only messages still title from the filename.

**Verification**
- `bun test test/session/title-first-turn.test.ts` (packages/opencode) → 5 pass / 0 fail, 100 expect() calls.
- `bun typecheck` (packages/opencode) → exit 0.
- Title/command domain regression (8 files: title-first-turn, title-tool, title-authority, title-input, title-migration, prompt, orchestrator-title, prompt-skill-command-multi) → 82 tests, 81 pass; 1 fail = PRE-EXISTING (`title-input.test.ts:50`, URL-encoded attachment name decoding — reproduced identically on the unmodified base via stash).
- Baseline EBUSY failure on the same file set is resolved by the fixture retry (no regression introduced).
- Independent reviewer re-ran typecheck and the focused test file fresh; verified spec compliance, correctness (including whitespace-args + attachment flows via a throwaway test), and consistency; no critical findings.

**Journey log**
- The buggy behavior was pinned by an existing test assertion (blank-argument command expected `titleRevision: 1`); fixing required overturning that assertion, not just adding one.
- Windows EBUSY in fixture cleanup is not random flake: when `fs.rm`'s built-in retries (30×100ms) are exhausted the handle is being held persistently; one long-yield outer retry settles it. A `connection: close` response header did not help.
- `bun test -t` filtered runs behave differently from full-file runs (timing-sensitive SuppressedError in server teardown) — verify with full-file runs.
- The `rtk` wrapper prepends the workdir to git pathspecs; from `packages/opencode`, stash/checkout pathspecs must be package-relative.
- `git worktree add` is blocked in isolated agent sessions here; branch work happens in the main checkout on a feature branch, and cross-branch integration belongs to the orchestrator.

## [S1] Problem

A new session whose first input is a bare slash command (`/cmd` with no arguments) is permanently titled "Untitled". The command path (`session/prompt.ts`, `SessionPrompt.command`, the `if (!session.parentID && session.titleSource === "fallback" && session.titleRevision === 0)` block) calls `title()` BEFORE the message is persisted, and queries history with `agentID: "main"` only — so `history` is empty at that moment. `ensureTitle` guards only `input.arguments === undefined`; a bare command passes `arguments: ""`, so `normalizeTitleInput` runs on empty text, yields `fallback: "Untitled"` with `canGenerate: false`, and `setTitleIfDefault` commits "Untitled" at revision 0→1. `genTitle` never runs, and every later title gate requires `titleRevision === 0`, so the session can never be titled again. Empirically 5/5 Untitled sessions in the local DB are bare-command-first (`/dream`×3, `/mimo-models-update`, `/git-commit`); the buggy expectation is even pinned by an existing assertion in `test/session/title-first-turn.test.ts` (the `empty` case asserts `titleRevision: 1`).

## [S2] Design

One-line guard change in `ensureTitle` (`packages/opencode/src/session/prompt.ts`):

```ts
// before
if (!firstUser && input.arguments === undefined) return
// after
if (!firstUser && !input.arguments?.trim()) return
```

Semantics: when there is no eligible first user message AND the command arguments are blank, `ensureTitle` must not commit any title — revision stays 0. The same request's subsequent `prompt()` call then takes over via the existing `eligibleTitle` path (message persisted by then, `input.agentID` undefined → "main", revision still 0): the persisted message text becomes the fallback title and the detached `genTitle` upgrades it to `generated`. No new mechanism is introduced; the fix removes a premature empty commit so the existing second chance can fire.

Expected behavior matrix:

- command with blank arguments on a fresh session → title ends `generated` (fallback = persisted message text); never "Untitled"-locked.
- command with non-empty arguments → unchanged (arguments remain the title material).
- plain-text first prompt → unchanged.
- `writeTitle` anti-re-entry and "records completion" semantics untouched.

Rationale: `sanitizeGeneratedTitle` already rejects "Untitled" (and placeholders like "生成标题中") as invalid generated titles — the commit side must not treat it as valid fallback material either.

Environment override (recorded): `git worktree add` is blocked in this isolated agent session, so the work runs on branch `fix/title-bare-command-untitled` checked out from `develop_lijian` @ `c0b2a9af` in the main checkout (per user instruction), not in a linked worktree.

## [S3] Out of Scope

- Relaxing the `agentID === "main"` gates in `hasTitleInput` / `eligibleTitle` (internal-agent sessions such as checkpoint-writer keep their title semantics).
- Changing `Session.writeTitle` anti-duplicate or revision semantics.
- Any change to `genTitle` / salvage logic or model routing.

## Tasks

- [x] T1: Update `test/session/title-first-turn.test.ts` — blank-argument command expectations become "no initial commit (revision stays 0) and the prompt-phase title path completes to generated"; adjust downstream title-request counts — acceptance: updated assertions fail on current code with the documented lock symptom (covers: S2)
- [x] T2: Apply the guard change `!input.arguments?.trim()` in `ensureTitle` — acceptance: updated tests pass; blank-argument command ends `generated` (covers: S2; depends: T1)
- [x] T3: Verify — `bun typecheck` and full `bun test test/session/` (title files) from `packages/opencode` pass; record any PRE-EXISTING failures — acceptance: clean verification evidence (covers: S2; depends: T2)
