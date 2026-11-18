import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { AutoDream } from "../../src/session/auto-dream"
import { Session as SessionNs } from "../../src/session"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectID } from "../../src/project/schema"
import { Database } from "../../src/storage"
import { InstanceState } from "../../src/effect"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Bus.defaultLayer, Config.defaultLayer, SessionNs.defaultLayer),
)

const DAY_MS = 24 * 60 * 60 * 1000

const currentProjectID = Effect.map(InstanceState.context, (ctx) => ctx.project.id)

// Both auto-runs refuse to fire on a project younger than their interval, so a
// backdated top-level session is what makes these cases non-vacuous: the interval
// brake is released, and the ONLY remaining reason to return false is the switch.
// 60 days clears dream (7d) and distill (30d) alike.
const seedOldProject = Effect.fn("seedOldProject")(function* () {
  const ssn = yield* SessionNs.Service
  const info = yield* ssn.create({})
  yield* Effect.sync(() =>
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({ time_created: Date.now() - 60 * DAY_MS })
        .where(eq(SessionTable.id, info.id))
        .run(),
    ),
  )
  return info
})

// W6. Dream rewrites project memory; distill mines memory for patterns and then
// auto-produces artifacts in the background. Neither may run while memory writing
// is off.
//
// The switch is the first statement of the decision chain, ahead of the
// non-git ("global") short circuit, so these four hold regardless of the project
// id they pass. They run in a directory outside git, which means the id is
// `global` — a project the chain would reject one step later anyway. The
// non-git short circuit itself is covered by the "real project" case below,
// which the switch cannot be masking.
describe("shouldAutoDream × memory write switch", () => {
  it.live(
    "disable_write: true → no auto dream, even on a project old enough to be due",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* seedOldProject()
          const cfg = yield* (yield* Config.Service).get()
          expect(yield* AutoDream.shouldAutoDream(cfg, yield* currentProjectID)).toBe(false)
        }),
      { outsideGit: true, config: { memory: { disable_write: true } } },
    ),
  )

  // dream.auto is opt-in upstream, so this pins that the switch overrides the
  // feature's own enable flag rather than merely coinciding with it.
  it.live(
    "disable_write: true beats an explicit dream.auto: true",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* seedOldProject()
          const cfg = yield* (yield* Config.Service).get()
          expect(yield* AutoDream.shouldAutoDream(cfg, yield* currentProjectID)).toBe(false)
        }),
      { outsideGit: true, config: { dream: { auto: true }, memory: { disable_write: true } } },
    ),
  )

  // Same switch, but inside a git repository: here the id is a real project, so
  // `false` cannot come from the non-git short circuit — it is the switch.
  it.live(
    "disable_write: true → false for a real project too",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* seedOldProject()
          const cfg = yield* (yield* Config.Service).get()
          const projectID = yield* currentProjectID
          expect(projectID).not.toBe(ProjectID.global)
          expect(yield* AutoDream.shouldAutoDream(cfg, projectID)).toBe(false)
        }),
      { git: true, config: { dream: { auto: true }, memory: { disable_write: true } } },
    ),
  )
})

describe("shouldAutoDistill × memory write switch", () => {
  it.live(
    "disable_write: true → no auto distill, even on a project old enough to be due",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* seedOldProject()
          const cfg = yield* (yield* Config.Service).get()
          expect(yield* AutoDream.shouldAutoDistill(cfg, yield* currentProjectID)).toBe(false)
        }),
      { outsideGit: true, config: { memory: { disable_write: true } } },
    ),
  )

  it.live(
    "disable_write: true beats an explicit distill.auto: true",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* seedOldProject()
          const cfg = yield* (yield* Config.Service).get()
          expect(yield* AutoDream.shouldAutoDistill(cfg, yield* currentProjectID)).toBe(false)
        }),
      { outsideGit: true, config: { distill: { auto: true }, memory: { disable_write: true } } },
    ),
  )
})

// The enabled polarity used to be unpinnable here: a process-global spawn
// throttle sat in front of the interval check, so the result depended on which
// other test file had run first. The throttle now lives in the idle gate's
// instance state, which makes "due → true" deterministic.
describe("auto-run decision chain (enabled)", () => {
  it.live("a real project that is due fires", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* seedOldProject()
          const cfg = yield* (yield* Config.Service).get()
          expect(yield* AutoDream.shouldAutoDream(cfg, yield* currentProjectID)).toBe(true)
        }),
      { git: true, config: { dream: { auto: true } } },
    ),
  )
})
