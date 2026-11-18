import { Cause, Clock, Context, Effect, Fiber, Layer, Scope } from "effect"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { InstanceState } from "@/effect"
import { ProjectID } from "@/project/schema"
import { Log } from "@/util"
import { SessionStatus } from "./status"
import {
  EXEMPT_BACKOFF_MS,
  IDLE_DEBOUNCE_MS,
  anchorEvidence,
  decideAutoRun,
  isSystemSession,
  lastUserMessageAt,
  projectStartedAt,
  sessionSummary,
  type AutoRunKind,
  type AutoRunSpawn,
} from "./auto-dream"
import type { SessionID } from "./schema"

const log = Log.create({ service: "auto-dream-gate" })

const KINDS: readonly AutoRunKind[] = ["dream", "distill"]

export interface SpawnRequest extends AutoRunSpawn {
  readonly projectID: ProjectID
}

export type Spawn = (request: SpawnRequest) => Effect.Effect<void, unknown>

export interface Interface {
  /**
   * Wire the idle gate for this instance. Idempotent: the first call wins, later
   * calls from the same instance are ignored. The spawn callback is supplied by
   * the session prompt module — importing it here would close the
   * prompt → app-runtime → AppLayer → SessionPrompt initialization cycle.
   */
  readonly arm: (spawn: Spawn) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@mimocode/AutoDreamGate") {}

type Gate = {
  readonly scope: Scope.Scope
  armed: boolean
  spawn: Spawn | undefined
  /** Captured at arm time: InstanceRef belongs to the caller, not the layer build. */
  context: Context.Context<never> | undefined
  unsubscribe: (() => void) | undefined
  timer: Fiber.Fiber<void> | undefined
  readonly projects: Set<ProjectID>
  readonly spawnAt: Map<string, number>
  readonly backoffAt: Map<string, number>
}

const slotOf = (projectID: ProjectID, kind: AutoRunKind) => `${projectID}:${kind}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const config = yield* Config.Service

    const state = yield* InstanceState.make(
      Effect.fn("AutoDreamGate.state")(function* () {
        const scope = yield* Scope.Scope
        const gate: Gate = {
          scope,
          armed: false,
          spawn: undefined,
          context: undefined,
          unsubscribe: undefined,
          timer: undefined,
          projects: new Set(),
          spawnAt: new Map(),
          backoffAt: new Map(),
        }
        // Without this the timer survives instance teardown and re-creates the
        // disposed cache through InstanceState.get when it eventually fires.
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            gate.unsubscribe?.()
            gate.unsubscribe = undefined
            const timer = gate.timer
            gate.timer = undefined
            if (timer) yield* Fiber.interrupt(timer)
          }),
        )
        return gate
      }),
    )

    const interruptTimer = (gate: Gate): Effect.Effect<void> =>
      Effect.gen(function* () {
        const timer = gate.timer
        gate.timer = undefined
        if (timer) yield* Fiber.interrupt(timer)
      })

    const evaluate = (gate: Gate, spawn: Spawn): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Deadline re-check: the countdown says "nothing happened for 5 minutes",
        // not "everything is idle". A session may still be running (or have gone
        // busy before this instance mounted) and must block the run.
        const live = yield* status.list()
        if (live.size > 0) {
          log.info("auto dream gate reached deadline — sessions still busy", { sessions: [...live.keys()] })
          yield* resetTimer(gate, "deadline with sessions still busy")
          return
        }

        const cfg = yield* config.get()
        const now = yield* Clock.currentTimeMillis
        const projects = [...gate.projects]
        if (projects.length === 0) {
          // Nothing was armed for a project, so this deadline has nothing to decide.
          log.info("auto dream gate reached deadline — no project to evaluate")
          return
        }
        log.info("auto dream gate reached deadline", { projects })

        for (const projectID of projects) {
          const quietSince = yield* lastUserMessageAt(projectID)
          const sinceLastUserMessageMs = quietSince === undefined ? undefined : now - quietSince
          const startedAt = yield* projectStartedAt(projectID)
          const evidence = {
            dream: yield* anchorEvidence(projectID, "dream"),
            distill: yield* anchorEvidence(projectID, "distill"),
          }
          // Sampled before the decision so the observation period also records the
          // runs that were skipped — otherwise only real runs would be measured.
          log.info("auto dream gate evaluating project", { projectID, sinceLastUserMessageMs })

          for (const kind of KINDS) {
            const slot = slotOf(projectID, kind)
            const decision = decideAutoRun({
              kind,
              projectID,
              config: cfg,
              now,
              anchors: evidence[kind],
              projectStartedAt: startedAt,
              lastSpawnAt: gate.spawnAt.get(slot),
              backoffAt: gate.backoffAt.get(slot),
            })
            for (const skipped of decision.skippedAnchors)
              log.warn(`auto-${kind} anchor exempted — ${skipped.reason}`, {
                sessionID: skipped.sessionID,
                projectID,
              })
            if (decision.exempt) gate.backoffAt.set(slot, now)
            if (!decision.fire) {
              log.info(`auto-${kind} skipped — ${decision.reason}`, { projectID })
              continue
            }
            gate.spawnAt.set(slot, now)
            gate.backoffAt.delete(slot)
            log.info(`auto-${kind} starting`, {
              projectID,
              sessionTitle: decision.spawn.title,
              sinceLastUserMessageMs,
            })
            yield* spawn({ ...decision.spawn, projectID }).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  if (!Cause.hasInterruptsOnly(cause))
                    log.error(`auto-${kind} spawn failed`, { projectID, error: Cause.pretty(cause) })
                }),
              ),
              Effect.forkIn(gate.scope),
            )
          }
        }
      })

    const resetTimer = (gate: Gate, reason: "session idle" | "deadline with sessions still busy"): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* interruptTimer(gate)
        const spawn = gate.spawn
        if (!spawn) return
        const fiber = yield* Effect.gen(function* () {
          yield* Effect.sleep(IDLE_DEBOUNCE_MS)
          // Cleared before evaluating so a re-arm cannot interrupt its own fiber.
          gate.timer = undefined
          yield* evaluate(gate, spawn)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (!Cause.hasInterruptsOnly(cause))
                log.error("auto dream gate evaluation failed", { error: Cause.pretty(cause) })
            }),
          ),
          Effect.forkIn(gate.scope),
        )
        gate.timer = fiber
        log.info(`auto dream gate countdown started — ${reason}`, {
          projects: [...gate.projects],
          debounceMs: IDLE_DEBOUNCE_MS,
        })
      })

    const detach = (gate: Gate, effect: Effect.Effect<void>) => {
      const context = gate.context
      if (!context || !gate.armed) return
      Effect.runForkWith(context)(
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (!Cause.hasInterruptsOnly(cause))
                log.error("auto dream gate status handling failed", { error: Cause.pretty(cause) })
            }),
          ),
          Effect.forkIn(gate.scope),
        ),
      )
    }

    const onStatus = (gate: Gate, sessionID: SessionID, type: string) =>
      Effect.gen(function* () {
        const summary = yield* sessionSummary(sessionID)
        // Deleted session — nothing to attribute the event to.
        if (!summary) return
        // An auto-run (or child) session belongs to a turn, not to the user: if it
        // drove the countdown, every completed dream run would schedule the next one.
        if (summary.parentID !== undefined || isSystemSession(summary)) {
          log.debug("auto dream gate ignoring internal session status", { sessionID, type })
          return
        }
        gate.projects.add(summary.projectID)
        if (type === "idle") {
          yield* resetTimer(gate, "session idle")
          return
        }
        yield* interruptTimer(gate)
        log.info("auto dream gate reset — a session stopped being idle", { sessionID, status: type })
      })

    const arm = (spawn: Spawn) =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const dreamOn = cfg.dream?.auto === true
        const distillOn = cfg.distill?.auto === true
        if (!dreamOn && !distillOn) {
          // This runs on the first step of every turn and both switches default to
          // false, so the default configuration must not log at info level.
          log.debug("auto dream gate not armed — both auto switches are off")
          return
        }
        const gate = yield* InstanceState.get(state)
        if (gate.armed) return
        // Claimed before the next yield: two turns racing to arm must not both
        // install a subscription. Rolled back below if the wiring defects.
        gate.armed = true
        if (dreamOn && cfg.dream?.interval_days === 0)
          log.warn("dream.interval_days is 0 — every idle period triggers a consolidation pass", {
            debounceMs: IDLE_DEBOUNCE_MS,
          })
        if (distillOn && cfg.distill?.interval_days === 0)
          log.warn("distill.interval_days is 0 — every idle period triggers a distill pass", {
            debounceMs: IDLE_DEBOUNCE_MS,
          })

        gate.spawn = spawn
        gate.context = yield* Effect.context()
        // Everything below can defect, and a defect must not leave the instance
        // disarmed for the rest of the process with nothing in the log: roll the
        // claim back so the next turn arms again.
        yield* Effect.gen(function* () {
          // Subscribe before seeding: a session that goes busy between the snapshot
          // and the subscription would otherwise never be seen as busy.
          gate.unsubscribe = yield* bus.subscribeCallback(SessionStatus.Event.Status, (event) => {
            detach(gate, onStatus(gate, event.properties.sessionID, event.properties.status.type))
          })
          // Sessions that were already running when this instance mounted never emit
          // a busy event; their project still has to be in the set so the deadline is
          // evaluated for it.
          const running = [...(yield* status.list()).keys()]
          for (const sessionID of running) {
            const summary = yield* sessionSummary(sessionID)
            if (summary) gate.projects.add(summary.projectID)
          }
          log.info("auto dream gate armed", {
            projects: [...gate.projects],
            busy: running,
            debounceMs: IDLE_DEBOUNCE_MS,
            exemptBackoffMs: EXEMPT_BACKOFF_MS,
          })
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              gate.armed = false
              gate.unsubscribe?.()
              gate.unsubscribe = undefined
              if (!Cause.hasInterruptsOnly(cause))
                log.error("auto dream gate arming failed", { error: Cause.pretty(cause) })
            }),
          ),
        )
      })

    return Service.of({ arm })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
)

export * as AutoDreamGate from "./auto-dream-gate"
