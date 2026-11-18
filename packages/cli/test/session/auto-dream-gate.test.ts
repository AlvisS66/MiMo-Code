import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { ProjectID } from "../../src/project/schema"
import { Session as SessionNs } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage"
import { Log } from "../../src/util"
import {
  AUTO_DREAM_TITLE,
  DREAM_TASK,
  EXEMPT_BACKOFF_MS,
  IDLE_DEBOUNCE_MS,
  anchorEvidence,
  classifyAnchor,
  decideAutoRun,
  lastUserMessageAt,
  shouldAutoDream,
  type AnchorEvidence,
  type AutoRunInput,
} from "../../src/session/auto-dream"
import { AutoDreamGate, type SpawnRequest } from "../../src/session/auto-dream-gate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

// Built from the same layer values on purpose: the gate subscribes to the bus the
// status service publishes on, and both have to resolve one `SessionStatus`
// instance. `SessionStatus.defaultLayer` is not used because the test drives
// `status` directly, and a second build would be a second set of sessions.
const bus = Bus.layer
const status = SessionStatus.layer.pipe(Layer.provide(bus))
const config = Config.defaultLayer
const gate = AutoDreamGate.layer.pipe(Layer.provide(status), Layer.provide(bus), Layer.provide(config))

const it = testEffect(
  Layer.mergeAll(status, gate, config, SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

// The gate reacts from a bus subscriber and a forked timer, so the test fiber has
// to hand both their scheduling turns: publish → subscriber → `resetTimer` fork
// must settle before `TestClock.adjust` can advance past the sleep.
const settle = Effect.gen(function* () {
  yield* Effect.yieldNow
  yield* Effect.yieldNow
  yield* Effect.yieldNow
})

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_000 * DAY_MS
const projectID = ProjectID.make("prj_auto_dream_test")
const enabled: Config.Info = { dream: { auto: true, interval_days: 7 } }

const evidence = (input: { ageDays: number; completed: boolean }): AnchorEvidence => ({
  sessionID: SessionID.make("ses_auto_dream_anchor"),
  timeCreated: NOW - input.ageDays * DAY_MS,
  completed: input.completed,
  reason: input.completed ? "completed" : "assistant error",
})

const decide = (input: Partial<AutoRunInput> = {}) =>
  decideAutoRun({
    kind: "dream",
    projectID,
    config: enabled,
    now: NOW,
    anchors: [],
    projectStartedAt: NOW - 60 * DAY_MS,
    lastSpawnAt: undefined,
    backoffAt: undefined,
    ...input,
  })

describe("decideAutoRun", () => {
  // The whole point of dropping the trigger from the prompt step: the spawn
  // request must not carry a model, so the create path resolves
  // agent.dream.model and then the provider default.
  test("spawn request carries exactly the task, no model override", () => {
    const decision = decide()
    expect(decision.fire).toBe(true)
    expect(decision.spawn).toEqual({
      kind: "dream",
      agent: "dream",
      title: AUTO_DREAM_TITLE,
      task: DREAM_TASK,
    })
    expect(decision.spawn && "model" in decision.spawn).toBe(false)
  })

  test("never fires for the global (non-git) project", () => {
    const decision = decide({ projectID: ProjectID.global })
    expect(decision.fire).toBe(false)
    expect(decision.reason).toContain("global")
  })

  test("never fires while memory writing is disabled", () => {
    const decision = decide({ config: { ...enabled, memory: { disable_write: true } } })
    expect(decision.fire).toBe(false)
    expect(decision.reason).toContain("memory write disabled")
  })

  test("respects dream.auto and distill.auto independently", () => {
    expect(decide({ config: { dream: { interval_days: 7 } } }).fire).toBe(false)
    expect(decide({ config: { distill: { auto: true, interval_days: 30 } } }).fire).toBe(false)
  })

  test("waits for the interval measured from the last completed run", () => {
    const recent = decide({ anchors: [evidence({ ageDays: 1, completed: true })] })
    expect(recent.fire).toBe(false)
    expect(recent.reason).toContain("last run")
    expect(decide({ anchors: [evidence({ ageDays: 8, completed: true })] }).fire).toBe(true)
  })

  test("waits for the project to age when no run has ever completed", () => {
    expect(decide({ projectStartedAt: NOW - 1 * DAY_MS }).fire).toBe(false)
    expect(decide({ projectStartedAt: undefined }).fire).toBe(false)
    expect(decide({ projectStartedAt: NOW - 30 * DAY_MS }).fire).toBe(true)
  })

  // A row that never completed must not consume the interval, but it must not be
  // retried in a tight loop either: exempt once, then retry after the backoff.
  test("exempts an unfinished newer run and arms the 1h backoff", () => {
    const anchors = [evidence({ ageDays: 0.5, completed: false }), evidence({ ageDays: 30, completed: true })]
    const first = decide({ anchors })
    expect(first.fire).toBe(false)
    expect(first.exempt).toBe(true)
    expect(first.skippedAnchors).toHaveLength(1)
    expect(first.reason).toContain("did not complete")

    const backedOff = decide({ anchors, backoffAt: NOW - 1_000 })
    expect(backedOff.fire).toBe(false)
    expect(backedOff.exempt).toBe(false)
    expect(backedOff.reason).toContain("backoff")

    expect(decide({ anchors, backoffAt: NOW - EXEMPT_BACKOFF_MS - 1 }).fire).toBe(true)
  })

  test("honours the per-project spawn debounce", () => {
    const decision = decide({ lastSpawnAt: NOW - 5_000 })
    expect(decision.fire).toBe(false)
    expect(decision.reason).toContain("debounce")
  })
})

// Every timing case above feeds these two constants back in as its own input, so a
// wrong value would keep them all green. Pin the design numbers once.
describe("timing constants", () => {
  test("pins the idle window and the exempt backoff", () => {
    expect(IDLE_DEBOUNCE_MS).toBe(5 * 60 * 1000)
    expect(EXEMPT_BACKOFF_MS).toBe(60 * 60 * 1000)
  })
})

describe("classifyAnchor", () => {
  const base = { hasAssistant: true, hasError: false, finish: "stop" as string | null, hasFinalContent: true }

  test("counts a delivered turn as complete", () => {
    expect(classifyAnchor(base).completed).toBe(true)
  })

  // Reverse guard: truncation still produced the consolidation, so it must not be
  // retried forever. isTerminalFinish() would reject this and re-run hourly.
  test("counts length and other as complete when text was produced", () => {
    expect(classifyAnchor({ ...base, finish: "length" }).completed).toBe(true)
    expect(classifyAnchor({ ...base, finish: "other" }).completed).toBe(true)
  })

  test("rejects every shape that did not finish the pass", () => {
    expect(classifyAnchor({ ...base, hasAssistant: false }).reason).toBe("no assistant message")
    expect(classifyAnchor({ ...base, hasError: true }).reason).toBe("assistant error")
    expect(classifyAnchor({ ...base, finish: null }).reason).toBe("no finish")
    expect(classifyAnchor({ ...base, finish: "tool-calls" }).completed).toBe(false)
    expect(classifyAnchor({ ...base, finish: "content-filter" }).completed).toBe(false)
    expect(classifyAnchor({ ...base, finish: "error" }).completed).toBe(false)
    expect(classifyAnchor({ ...base, finish: "cancelled" }).completed).toBe(false)
    expect(classifyAnchor({ ...base, hasFinalContent: false }).reason).toBe("empty output")
  })
})

// TestClock starts at epoch 0, so "N days ago" is a negative timestamp here.
const backdate = (sessionID: SessionID, ageDays: number) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({ time_created: -ageDays * DAY_MS })
        .where(eq(SessionTable.id, sessionID))
        .run(),
    ),
  )

const seedAutoSession = (input: { title?: string; ageDays: number }) =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const info = yield* sessions.create({ title: input.title })
    yield* backdate(info.id, input.ageDays)
    return info
  })

const insertAssistant = (input: {
  sessionID: SessionID
  finish?: string
  error?: MessageV2.Assistant["error"]
  text?: string
  reasoning?: string
  at?: number
}) =>
  Effect.sync(() =>
    Database.use((db) => {
      const id = MessageID.ascending()
      const at = input.at ?? 0
      const info = MessageV2.Assistant.parse({
        id,
        sessionID: input.sessionID,
        role: "assistant",
        time: { created: at, completed: at },
        parentID: MessageID.make("msg_auto_dream_parent"),
        modelID: "test-model",
        providerID: "test",
        mode: "default",
        agent: "dream",
        path: { cwd: "/tmp/example", root: "/tmp/example" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: input.finish,
        error: input.error,
      })
      db.insert(MessageTable)
        .values({ id, session_id: input.sessionID, agent_id: "main", data: info, time_created: at, time_updated: at })
        .run()
      if (input.text !== undefined) {
        const part = MessageV2.TextPart.parse({
          id: PartID.ascending(),
          messageID: id,
          sessionID: input.sessionID,
          type: "text",
          text: input.text,
          synthetic: false,
        })
        db.insert(PartTable)
          .values({
            id: part.id,
            message_id: id,
            session_id: input.sessionID,
            data: part,
            time_created: at,
            time_updated: at,
          })
          .run()
      }
      if (input.reasoning !== undefined) {
        const part = MessageV2.ReasoningPart.parse({
          id: PartID.ascending(),
          messageID: id,
          sessionID: input.sessionID,
          type: "reasoning",
          text: input.reasoning,
          time: { start: at, end: at },
        })
        db.insert(PartTable)
          .values({
            id: part.id,
            message_id: id,
            session_id: input.sessionID,
            data: part,
            time_created: at,
            time_updated: at,
          })
          .run()
      }
    }),
  )

const insertUser = (input: { sessionID: SessionID; agent: string; at?: number }) =>
  Effect.sync(() =>
    Database.use((db) => {
      const id = MessageID.ascending()
      const at = input.at ?? 0
      const info = MessageV2.User.parse({
        id,
        sessionID: input.sessionID,
        role: "user",
        time: { created: at },
        agent: input.agent,
        model: { providerID: "test", modelID: "test-model" },
      })
      db.insert(MessageTable)
        .values({ id, session_id: input.sessionID, agent_id: "main", data: info, time_created: at, time_updated: at })
        .run()
    }),
  )

// The completion verdict has to come from the persisted rows: the read path
// rewrites `error` into "Interrupted before resume" and the processor clears
// `finish`, so anything that goes through Session.messages() would see a
// different message than what actually happened.
describe("anchorEvidence", () => {
  it.effect("reads raw finish and error instead of the rewritten message", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const completed = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 1 })
          yield* insertAssistant({ sessionID: completed.id, finish: "stop", text: "consolidated" })

          const interrupted = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 2 })
          yield* insertAssistant({
            sessionID: interrupted.id,
            finish: "stop",
            text: "partial",
            error: new MessageV2.AbortedError({ message: "interrupted" }).toObject(),
          })

          const halfWay = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 3 })
          yield* insertAssistant({ sessionID: halfWay.id, finish: "tool-calls", text: "still working" })

          const truncated = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 4 })
          yield* insertAssistant({ sessionID: truncated.id, finish: "length", text: "ran out of room" })

          const empty = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 5 })

          // A reasoning-only turn is a delivered turn in `classify.ts:145-152`, so it
          // has to anchor the interval instead of exempting the project hourly.
          const reasoningOnly = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 6 })
          yield* insertAssistant({ sessionID: reasoningOnly.id, finish: "stop", reasoning: "thought it through" })

          // An error a later step recovered from must not un-complete the pass: only
          // the last assistant row is judged.
          const recovered = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 7 })
          yield* insertAssistant({
            sessionID: recovered.id,
            finish: "error",
            error: new MessageV2.AbortedError({ message: "transient" }).toObject(),
            at: 1,
          })
          yield* insertAssistant({ sessionID: recovered.id, finish: "stop", text: "consolidated", at: 2 })

          const anchors = yield* anchorEvidence(completed.projectID, "dream")
          expect(anchors.map((anchor) => [anchor.sessionID, anchor.completed, anchor.reason])).toEqual([
            [completed.id, true, "completed"],
            [interrupted.id, false, "assistant error"],
            [halfWay.id, false, "finish=tool-calls"],
            [truncated.id, true, "completed"],
            [empty.id, false, "no assistant message"],
            [reasoningOnly.id, true, "completed"],
            [recovered.id, true, "completed"],
          ])
        }),
      { git: true },
    ),
  )

  // Integration: the failed newer run is skipped, the older completed run still
  // anchors the interval, and the project is due — but the exemption holds the
  // pass back instead of spending the interval on nothing.
  it.effect("an unfinished newer run does not consume the interval", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const older = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 30 })
          yield* insertAssistant({ sessionID: older.id, finish: "stop", text: "consolidated" })
          const failed = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 0.5 })
          yield* insertAssistant({ sessionID: failed.id, finish: "error" })

          const cfg = yield* (yield* Config.Service).get()
          expect(yield* shouldAutoDream(cfg, older.projectID)).toBe(false)
        }),
      { git: true, config: { dream: { auto: true, interval_days: 7 } } },
    ),
  )
})

// The idle-duration sample is the only measurement that can retune the window, so
// an auto-run's own task prompt must not read as human activity: it would collapse
// the sample to the run's own age right after every pass.
describe("lastUserMessageAt", () => {
  it.effect("ignores the prompt an auto-run wrote for itself", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const human = yield* seedAutoSession({ ageDays: 1 })
          yield* insertUser({ sessionID: human.id, agent: "main", at: 10 })
          const auto = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 0 })
          yield* insertUser({ sessionID: auto.id, agent: "dream", at: 20 })

          expect(yield* lastUserMessageAt(human.projectID)).toBe(10)
        }),
      { git: true },
    ),
  )
})

const spawnRecorder = () => {
  const spawns: SpawnRequest[] = []
  return {
    spawns,
    spawn: (request: SpawnRequest) => Effect.sync(() => void spawns.push(request)),
  }
}

const gateConfig = { dream: { auto: true, interval_days: 0 } }

describe("AutoDreamGate", () => {
  it.effect("spawns after the instance has been idle for the debounce", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* seedAutoSession({ ageDays: 30 })
          const status = yield* SessionStatus.Service
          const gate = yield* AutoDreamGate.Service
          const recorder = spawnRecorder()

          yield* gate.arm(recorder.spawn)
          yield* status.set(session.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS)
          yield* settle

          expect(recorder.spawns).toHaveLength(1)
          expect(recorder.spawns[0].projectID).toBe(session.projectID)
          expect(recorder.spawns[0].title).toBe(AUTO_DREAM_TITLE)
        }),
      { git: true, config: gateConfig },
    ),
  )

  it.effect("a busy session restarts the countdown", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* seedAutoSession({ ageDays: 30 })
          const status = yield* SessionStatus.Service
          const gate = yield* AutoDreamGate.Service
          const recorder = spawnRecorder()

          yield* gate.arm(recorder.spawn)
          yield* status.set(session.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS - 1_000)
          yield* settle
          yield* status.set(session.id, { type: "busy" })
          yield* settle

          // Past the original deadline: only a reset can keep the pass from firing.
          yield* TestClock.adjust(1_000)
          yield* settle
          expect(recorder.spawns).toHaveLength(0)

          yield* status.set(session.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS - 1_000)
          yield* settle
          expect(recorder.spawns).toHaveLength(0)
          yield* TestClock.adjust(1_000)
          yield* settle
          expect(recorder.spawns).toHaveLength(1)
        }),
      { git: true, config: gateConfig },
    ),
  )

  it.effect("a reconnect (retry) restarts the countdown", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* seedAutoSession({ ageDays: 30 })
          const status = yield* SessionStatus.Service
          const gate = yield* AutoDreamGate.Service
          const recorder = spawnRecorder()

          yield* gate.arm(recorder.spawn)
          yield* status.set(session.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS - 1_000)
          yield* settle
          yield* status.set(session.id, { type: "retry", attempt: 1, message: "reconnecting", next: 0 })
          yield* settle
          yield* TestClock.adjust(1_000)
          yield* settle

          expect(recorder.spawns).toHaveLength(0)

          // The retry only defers the pass: the next idle starts a fresh countdown,
          // which also proves the subscription is live, so the zero above is not a
          // deaf-bus false pass.
          yield* status.set(session.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS)
          yield* settle
          expect(recorder.spawns).toHaveLength(1)
        }),
      { git: true, config: gateConfig },
    ),
  )

  // One countdown per instance, not per session: activity in a second session has
  // to hold back the pass the first session scheduled.
  it.effect("a second session's activity restarts the shared countdown", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const first = yield* seedAutoSession({ ageDays: 30 })
          const second = yield* seedAutoSession({ ageDays: 30 })
          const status = yield* SessionStatus.Service
          const gate = yield* AutoDreamGate.Service
          const recorder = spawnRecorder()

          yield* gate.arm(recorder.spawn)
          yield* status.set(first.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS - 1_000)
          yield* settle
          yield* status.set(second.id, { type: "busy" })
          yield* settle
          yield* TestClock.adjust(1_000)
          yield* settle
          expect(recorder.spawns).toHaveLength(0)

          yield* status.set(second.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS)
          yield* settle
          expect(recorder.spawns).toHaveLength(1)
        }),
      { git: true, config: gateConfig },
    ),
  )

  // Deadline re-check: a session that was already running before the gate mounted
  // never emits a busy event, so the countdown alone would let the pass start
  // next to it.
  it.effect("a session that is still running blocks the deadline", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const idle = yield* seedAutoSession({ ageDays: 30 })
          const running = yield* seedAutoSession({ ageDays: 30 })
          const status = yield* SessionStatus.Service
          const gate = yield* AutoDreamGate.Service
          const recorder = spawnRecorder()

          yield* status.set(running.id, { type: "busy" })
          yield* settle
          yield* gate.arm(recorder.spawn)
          yield* status.set(idle.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS)
          yield* settle

          expect(recorder.spawns).toHaveLength(0)

          yield* status.set(running.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS)
          yield* settle
          expect(recorder.spawns).toHaveLength(1)
        }),
      { git: true, config: gateConfig },
    ),
  )

  // Without this filter every completed dream run would schedule the next one:
  // its own session goes idle right after it finishes.
  it.effect("an auto-run session going idle does not arm the gate", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const dream = yield* seedAutoSession({ title: AUTO_DREAM_TITLE, ageDays: 30 })
          // A completed run, so the second half of this test is not held back by the
          // "unfinished run" exemption instead of by the idle gate.
          yield* insertAssistant({ sessionID: dream.id, finish: "stop", text: "consolidated", at: -30 * DAY_MS })
          const user = yield* seedAutoSession({ ageDays: 30 })
          const status = yield* SessionStatus.Service
          const gate = yield* AutoDreamGate.Service
          const recorder = spawnRecorder()

          yield* gate.arm(recorder.spawn)
          yield* status.set(dream.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS)
          yield* settle

          expect(recorder.spawns).toHaveLength(0)

          // A user session in the same project does arm it, which proves the
          // subscription is live and the zero above is the filter, not a deaf bus.
          yield* status.set(user.id, { type: "idle" })
          yield* settle
          yield* TestClock.adjust(IDLE_DEBOUNCE_MS)
          yield* settle
          expect(recorder.spawns).toHaveLength(1)
        }),
      { git: true, config: gateConfig },
    ),
  )
})
