import { Clock, Effect } from "effect"
import { isMemoryWriteEnabled } from "@/memory/write-gate"
import { Database, and, asc, desc, eq, inArray, isNull, not, sql } from "@/storage"
import { ProjectID } from "@/project/schema"
import { Log } from "@/util"
import type { Config } from "@/config"
import { MessageTable, SessionTable } from "./session.sql"
import type { SessionID } from "./schema"

const log = Log.create({ service: "auto-dream" })

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DREAM_INTERVAL_DAYS = 7
const DEFAULT_DISTILL_INTERVAL_DAYS = 30
/** Two auto runs of the same kind for the same project never start closer than this. */
const MIN_SPAWN_GAP_MS = 10_000
/** The countdown that starts when a turn ends; any session activity resets it. */
export const IDLE_DEBOUNCE_MS = 5 * 60 * 1000
/** A run that never completed does not consume its interval — retry after this. */
export const EXEMPT_BACKOFF_MS = 60 * 60 * 1000
/**
 * `session` has no title index (`session.sql.ts:53-58`), so the anchor scan has
 * to be bounded instead of walking every session row of the month.
 */
const ANCHOR_CANDIDATE_LIMIT = 8

export const AUTO_DREAM_TITLE = "Auto Dream"
export const AUTO_DISTILL_TITLE = "Auto Distill"

const SYSTEM_SESSION_TITLES: ReadonlySet<string> = new Set([AUTO_DREAM_TITLE, AUTO_DISTILL_TITLE])

export function isSystemSession(session: { title: string }): boolean {
  return SYSTEM_SESSION_TITLES.has(session.title)
}

export const DREAM_TASK = [
  "Run one automatic dream memory consolidation pass for the current project.",
  "",
  "Use the memory files as the working index and the raw mimocode trajectory database as the source of truth.",
  "Use bash for read-only SQLite and filesystem inspection. Do not modify the database.",
  "Consolidate only durable, verified information into project memory.",
].join("\n")

export const DISTILL_TASK = [
  "Run one automatic distill pass for the current project.",
  "",
  "Review the past month of sessions and identify repeated manual workflows worth packaging.",
  "Use the raw mimocode trajectory database as the source of truth and memory files to spot cross-session patterns.",
  "Inventory existing skills, agents, and commands first so you reuse or extend instead of duplicating.",
  "Use bash for read-only SQLite and filesystem inspection. Do not modify the database.",
  "Produce a compact shortlist, then create only the high-confidence missing assets.",
].join("\n")

export type AutoRunKind = "dream" | "distill"

const AUTO_RUN: Record<AutoRunKind, { title: string; task: string; defaultIntervalDays: number }> = {
  dream: { title: AUTO_DREAM_TITLE, task: DREAM_TASK, defaultIntervalDays: DEFAULT_DREAM_INTERVAL_DAYS },
  distill: { title: AUTO_DISTILL_TITLE, task: DISTILL_TASK, defaultIntervalDays: DEFAULT_DISTILL_INTERVAL_DAYS },
}

/**
 * The finish reasons `classify.ts:136-153` treats as the end of a turn — `stop`,
 * `length`, `other` — with the step's own content deciding the rest. `tool-calls`
 * is a continue there (`classify.ts:118`), and `error` / `content-filter` end a
 * turn without producing anything a consolidation pass can use. `isTerminalFinish`
 * (`classify.ts:32`) is NOT this set: it only answers "may this overwrite a
 * delivered finish" and would permanently fail every truncated run.
 */
const COMPLETED_FINISHES: ReadonlySet<string> = new Set(["stop", "length", "other"])

export interface AnchorSnapshot {
  readonly hasAssistant: boolean
  readonly hasError: boolean
  readonly finish: string | null
  readonly hasFinalContent: boolean
}

export interface AnchorVerdict {
  readonly completed: boolean
  readonly reason: string
}

/**
 * Whether one auto-run session row is a usable "this project was consolidated"
 * anchor. Judged from persisted rows rather than `Session.messages()`: the read
 * path rewrites `error` into "Interrupted before resume" (`message-v2.ts:981`)
 * and the processor clears `finish` (`processor.ts:1067`), so the live
 * interfaces cannot report what actually happened. The order and the wording
 * mirror `classify.ts:124-153`, which is the repo's own "did this turn end".
 */
export function classifyAnchor(snapshot: AnchorSnapshot): AnchorVerdict {
  if (!snapshot.hasAssistant) return { completed: false, reason: "no assistant message" }
  if (snapshot.hasError) return { completed: false, reason: "assistant error" }
  if (!snapshot.finish) return { completed: false, reason: "no finish" }
  if (!COMPLETED_FINISHES.has(snapshot.finish))
    return { completed: false, reason: `finish=${snapshot.finish}` }
  if (!snapshot.hasFinalContent) return { completed: false, reason: "empty output" }
  return { completed: true, reason: "completed" }
}

export interface AnchorEvidence extends AnchorVerdict {
  readonly sessionID: SessionID
  readonly timeCreated: number
}

export interface SessionSummary {
  readonly projectID: ProjectID
  readonly title: string
  readonly parentID: SessionID | undefined
}

/**
 * A newer auto-run row that never completed must not silently consume the
 * interval, but it must not be retried in a tight loop either. `undefined` skips
 * the auto-run without consuming anything.
 */
export interface AutoRunInput {
  readonly kind: AutoRunKind
  readonly projectID: ProjectID
  readonly config: Config.Info
  readonly now: number
  /** Newest first. */
  readonly anchors: readonly AnchorEvidence[]
  readonly projectStartedAt: number | undefined
  readonly lastSpawnAt: number | undefined
  /** When an unfinished anchor was last observed; callers arm EXEMPT_BACKOFF_MS. */
  readonly backoffAt: number | undefined
}

export interface AutoRunSpawn {
  readonly kind: AutoRunKind
  readonly agent: AutoRunKind
  readonly title: string
  readonly task: string
}

interface AutoRunIntentBase {
  readonly kind: AutoRunKind
  readonly projectID: ProjectID
  readonly reason: string
  /** A newer auto-run row never completed → arm EXEMPT_BACKOFF_MS. */
  readonly exempt: boolean
  /** Anchors that were skipped, for the warn the caller prints. */
  readonly skippedAnchors: readonly AnchorEvidence[]
}

/**
 * `fire` decides the shape, so the caller cannot spawn without a request: the gate
 * narrows on `fire` and reads the payload with no extra check. The request
 * deliberately carries no model — the create path resolves `agent.dream.model` →
 * provider default, so a hardcoded model here would silently override it.
 */
export type AutoRunIntent =
  | (AutoRunIntentBase & { readonly fire: true; readonly spawn: AutoRunSpawn })
  | (AutoRunIntentBase & { readonly fire: false; readonly spawn: undefined })

/** The cheap guards, shared by the pure decision and the DB-reading predicates. */
function screenAutoRun(kind: AutoRunKind, projectID: ProjectID, cfg: Config.Info): string | undefined {
  // Memory writing off → a pass that rewrites project memory must not run either.
  if (!isMemoryWriteEnabled(cfg)) return "memory write disabled"
  // Everything outside a git repository lands in ProjectID.global (`project.ts:231-238`),
  // which mixes throwaway probe sessions with real work.
  if (projectID === ProjectID.global) return "global project has no git repository"
  const enabled = kind === "dream" ? cfg.dream?.auto === true : cfg.distill?.auto === true
  if (!enabled) return `${kind}.auto disabled`
  return undefined
}

export function decideAutoRun(input: AutoRunInput): AutoRunIntent {
  const base = (
    reason: string,
    extra?: { exempt?: boolean; skipped?: readonly AnchorEvidence[] },
  ): AutoRunIntentBase => ({
    kind: input.kind,
    projectID: input.projectID,
    reason,
    exempt: extra?.exempt === true,
    skippedAnchors: extra?.skipped ?? [],
  })
  const skip = (
    reason: string,
    extra?: { exempt?: boolean; skipped?: readonly AnchorEvidence[] },
  ): AutoRunIntent => ({ ...base(reason, extra), fire: false, spawn: undefined })

  const blocked = screenAutoRun(input.kind, input.projectID, input.config)
  if (blocked) return skip(blocked)
  if (input.lastSpawnAt !== undefined && input.now - input.lastSpawnAt < MIN_SPAWN_GAP_MS)
    return skip("spawn debounce")

  const spec = AUTO_RUN[input.kind]
  const intervalDays =
    (input.kind === "dream" ? input.config.dream?.interval_days : input.config.distill?.interval_days) ??
    spec.defaultIntervalDays
  const intervalMs = intervalDays * DAY_MS

  // First completed row is the anchor; anything newer than it is an attempt that
  // never finished and therefore does not count as "already consolidated".
  const anchorIndex = input.anchors.findIndex((anchor) => anchor.completed)
  const anchor = anchorIndex < 0 ? undefined : input.anchors[anchorIndex]
  const skipped = anchorIndex < 0 ? input.anchors : input.anchors.slice(0, anchorIndex)

  const due = anchor
    ? input.now - anchor.timeCreated >= intervalMs
    : input.projectStartedAt !== undefined && input.now - input.projectStartedAt >= intervalMs
  // Unfinished anchors are reported only by the branches below: on a not-due
  // verdict they were never examined for completion, so warning about them would be
  // noise.
  if (!due) {
    if (anchor)
      return skip(`last run ${Math.round((input.now - anchor.timeCreated) / DAY_MS)}d ago`)
    if (input.projectStartedAt === undefined) return skip("project has no sessions")
    return skip(`project ${Math.round((input.now - input.projectStartedAt) / DAY_MS)}d old`)
  }

  if (skipped.length > 0) {
    // First observation of an attempt that never finished: hold the pass back for
    // one hour instead of retrying in a tight loop. Once the backoff expires the
    // retry is the pass itself, so it falls through to the spawn below.
    if (input.backoffAt === undefined)
      return skip(`auto-${input.kind} run did not complete — retrying in 1h`, {
        exempt: true,
        skipped,
      })
    if (input.now - input.backoffAt < EXEMPT_BACKOFF_MS) return skip("backoff after an unfinished run", { skipped })
  }

  return {
    ...base("due"),
    fire: true,
    spawn: { kind: input.kind, agent: input.kind, title: spec.title, task: spec.task },
  }
}

// Table names are written out rather than interpolated: inside the select list
// (and in correlated subqueries under it) this drizzle build renders the
// interpolated `${Table.column}` chunks without the table, so `part.message_id =
// message.id` degenerated into `part.message_id = part.id` and matched nothing.
// A where clause does render them qualified — don't "clean up" these on that basis.
const HAS_ERROR = sql<number>`coalesce(json_type(message.data, '$.error'), 'null') <> 'null'`
const IS_ASSISTANT = sql`json_extract(message.data, '$.role') = 'assistant'`
// Mirrors the `lastModel` filter (`prompt.ts:2887-2895`): a user-authored row, not
// one the system injected for itself.
const IS_USER = sql`json_extract(message.data, '$.role') = 'user'
  and coalesce(json_extract(message.data, '$.agent'), '') <> 'system'
  and coalesce(json_extract(message.data, '$.model.providerID'), '') <> 'system'`
// Both content kinds `classify.ts:145-152` counts as an answer: a reasoning-only
// turn is a delivered turn there, so rejecting it here would exempt the same run
// every hour forever.
const HAS_FINAL_CONTENT = sql<number>`exists (
  select 1 from part
  where part.message_id = message.id
    and json_extract(part.data, '$.type') in ('text', 'reasoning')
    and coalesce(json_extract(part.data, '$.synthetic'), 0) = 0
    and coalesce(json_extract(part.data, '$.ignored'), 0) = 0
    and length(trim(coalesce(json_extract(part.data, '$.text'), ''))) > 0
)`

const readAnchorEvidence = (projectID: ProjectID, title: string): AnchorEvidence[] =>
  Database.use((db) => {
    const candidates = db
      .select({ id: SessionTable.id, timeCreated: SessionTable.time_created })
      .from(SessionTable)
      .where(and(eq(SessionTable.title, title), eq(SessionTable.project_id, projectID)))
      .orderBy(desc(SessionTable.time_created))
      .limit(ANCHOR_CANDIDATE_LIMIT)
      .all()

    return candidates.map((candidate) => {
      // Only the last assistant row is judged, like `classify.ts:126`: an error a
      // later step recovered from does not make a delivered pass un-completable.
      // Read newest-first so the scan stays one row instead of the whole session.
      const last = db
        .select({
          finish: sql<string | null>`json_extract(message.data, '$.finish')`,
          errored: HAS_ERROR,
          hasFinalContent: HAS_FINAL_CONTENT,
        })
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, candidate.id), IS_ASSISTANT))
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .limit(1)
        .get()
      const verdict = classifyAnchor({
        hasAssistant: last !== undefined,
        hasError: last ? last.errored !== 0 : false,
        finish: last?.finish ?? null,
        hasFinalContent: last ? last.hasFinalContent !== 0 : false,
      })
      return {
        sessionID: candidate.id,
        timeCreated: candidate.timeCreated,
        completed: verdict.completed,
        reason: verdict.reason,
      }
    })
  })

/** Newest-first auto-run session rows of one project, each with a completion verdict. */
export const anchorEvidence = (projectID: ProjectID, kind: AutoRunKind) =>
  Effect.sync(() => readAnchorEvidence(projectID, AUTO_RUN[kind].title))

/**
 * Start of the project's history: the earliest top-level session. Used only for
 * the first-ever run, where no anchor exists yet.
 */
export const projectStartedAt = (projectID: ProjectID) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select({ time_created: SessionTable.time_created })
        .from(SessionTable)
        .where(and(isNull(SessionTable.parent_id), eq(SessionTable.project_id, projectID)))
        .orderBy(asc(SessionTable.time_created))
        .limit(1)
        .get()?.time_created,
    ),
  )

/**
 * When the project last saw a user message — the sample behind the idle-debounce
 * log. Auto-run sessions are excluded: their own task prompt is a user message, so
 * counting it would report "seconds since the human typed" right after every pass
 * and corrupt the only measurement that can retune the debounce.
 */
export const lastUserMessageAt = (projectID: ProjectID) =>
  Effect.sync(() =>
    Database.use((db) => {
      const row = db
        .select({ at: sql<number | null>`max(${MessageTable.time_created})` })
        .from(MessageTable)
        .innerJoin(SessionTable, eq(SessionTable.id, MessageTable.session_id))
        .where(
          and(
            eq(SessionTable.project_id, projectID),
            IS_USER,
            not(inArray(SessionTable.title, [...SYSTEM_SESSION_TITLES])),
          ),
        )
        .get()
      return row?.at ?? undefined
    }),
  )

export const sessionSummary = (sessionID: SessionID) =>
  Effect.sync(() =>
    Database.use((db) => {
      const row = db
        .select({
          projectID: SessionTable.project_id,
          title: SessionTable.title,
          parentID: SessionTable.parent_id,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
      if (!row) return undefined
      return { projectID: row.projectID, title: row.title, parentID: row.parentID ?? undefined }
    }),
  )

const autoRunDue = (input: { kind: AutoRunKind; projectID: ProjectID; config: Config.Info }) =>
  Effect.gen(function* () {
    // Switch first: a disabled config must not even read the database.
    if (screenAutoRun(input.kind, input.projectID, input.config)) return false
    const now = yield* Clock.currentTimeMillis
    const anchors = yield* anchorEvidence(input.projectID, input.kind)
    const startedAt = yield* projectStartedAt(input.projectID)
    const decision = decideAutoRun({
      kind: input.kind,
      projectID: input.projectID,
      config: input.config,
      now,
      anchors,
      projectStartedAt: startedAt,
      lastSpawnAt: undefined,
      backoffAt: undefined,
    })
    for (const skipped of decision.skippedAnchors)
      log.warn(`auto-${input.kind} anchor exempted — ${skipped.reason}`, {
        sessionID: skipped.sessionID,
        projectID: input.projectID,
      })
    if (!decision.fire) log.info(`auto-${input.kind} skipped — ${decision.reason}`, { projectID: input.projectID })
    return decision.fire
  })

export function shouldAutoDream(cfg: Config.Info, projectID: ProjectID) {
  return autoRunDue({ kind: "dream", projectID, config: cfg })
}

export function shouldAutoDistill(cfg: Config.Info, projectID: ProjectID) {
  return autoRunDue({ kind: "distill", projectID, config: cfg })
}

export * as AutoDream from "./auto-dream"
