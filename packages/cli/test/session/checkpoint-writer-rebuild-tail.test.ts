import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Actor } from "../../src/actor/spawn"
import { Command } from "../../src/command"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Provider } from "../../src/provider"
import { Session } from "../../src/session"
import { SessionCheckpoint, renderTailAppendix } from "../../src/session/checkpoint"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { SessionPrompt } from "../../src/session/prompt"
import type { MessageV2 } from "../../src/session/message-v2"
import type { MessageID, SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import {
  startScriptedLLMServer,
  textStopResponse,
  toolCallsResponse,
  type LLMCapture,
} from "../lib/scripted-llm-server"

void Log.init({ print: false })

// A fresh SessionPrompt and Actor layer per test installs the process-global
// prefixCaptureRef and spawnRef the writer needs; other test files reset both.
const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Actor.defaultLayer,
    Session.defaultLayer,
    Config.defaultLayer,
    Provider.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    SessionCheckpoint.defaultLayer,
  ),
)

const FILES = ["alpha.txt", "beta.txt"]
const fileBody = (name: string) => Array.from({ length: 300 }, (_, i) => `${name} body line ${i}`).join("\n")
const HIGH_USAGE = 260_000
// Distinct tokens so the reply stays clear of the consecutive-repeat detector.
const LARGE_REPLY = [
  "large-reply-start",
  ...Array.from({ length: 16_000 }, (_, i) => ((i * 2_654_435_761) >>> 0).toString(36)),
].join(" ")
const WRITER_MARKER = "checkpoint-writer mode"
const BOUNDARY_LABEL = "Summary of previous conversation from checkpoint files:"

function usageStop(text: string, usage: number) {
  const chunk = (delta: Record<string, unknown>, finish?: string) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-usage",
      object: "chat.completion.chunk",
      choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
      ...(finish ? { usage: { prompt_tokens: usage, completion_tokens: 1, total_tokens: usage + 1 } } : {}),
    })}\n\n`
  return [chunk({ role: "assistant" }), chunk({ content: text }), chunk({}, "stop"), "data: [DONE]\n\n"]
}

function config(origin: string, fork: boolean): Partial<Config.Info> {
  return {
    enabled_providers: ["test"],
    model: "test/model",
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        models: {
          model: {
            name: "Test",
            tool_call: true,
            limit: { context: 400_000, output: 10_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agent: { build: { model: "test/model" } },
    permission: { read: "allow" },
    checkpoint: { thresholds: ["50%"], fork },
    lsp: false,
    formatter: false,
  }
}

type Captured = LLMCapture["messages"][number]

function text(message: Captured) {
  if (typeof message.content === "string") return message.content
  return (message.content as { type: string; text?: string }[]).map((part) => part.text ?? JSON.stringify(part)).join("\n")
}

function indexOf(messages: Captured[], needle: string) {
  const index = messages.findIndex(
    (message) =>
      text(message).includes(needle) && (needle === BOUNDARY_LABEL || !text(message).includes(BOUNDARY_LABEL)),
  )
  expect(index, needle).toBeGreaterThanOrEqual(0)
  return index
}

function seedCheckpoint(sessionID: SessionID, watermark: MessageID) {
  return Effect.promise(async () => {
    await fs.mkdir(path.dirname(checkpointPath(sessionID)), { recursive: true })
    await Bun.write(checkpointPath(sessionID), "# Session checkpoint\n\n## §1 Active intent\nRun the checks.\n")
    Database.use((db) =>
      db.update(SessionTable).set({ last_checkpoint_message_id: watermark }).where(eq(SessionTable.id, sessionID)).run(),
    )
  })
}

describe("checkpoint writer after a rebuild", () => {
  for (const fork of [true, false])
    it.live(
      fork
        ? "mirrors the parent window in messages and carries the tail as a prompt appendix (fork: true)"
        : "receives the boundary, the full tail from the database, then the live messages (fork: false)",
      () =>
        Effect.gen(function* () {
          const server = startScriptedLLMServer([
            { lines: textStopResponse("starting") },
            {
              lines: toolCallsResponse(
                FILES.map((file, index) => ({
                  id: `call-${index}`,
                  name: "read",
                  args: JSON.stringify({ file_path: file }),
                })),
              ),
            },
            { lines: textStopResponse("checks passed") },
            { lines: textStopResponse("live reply") },
            { lines: usageStop(LARGE_REPLY, HIGH_USAGE) },
            { lines: textStopResponse("ok") },
          ])
          yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
          yield* provideTmpdirInstance(
            (dir) =>
              Effect.gen(function* () {
                for (const file of FILES) yield* Effect.promise(() => Bun.write(path.join(dir, file), fileBody(file)))
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const checkpoint = yield* SessionCheckpoint.Service
                const session = yield* sessions.create({ title: "writer after rebuild" })
                const say = (value: string) =>
                  prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: value }] })

                yield* say("start the task")
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                yield* seedCheckpoint(session.id, watermark.info.id)
                yield* say("run the checks on alpha and beta")
                yield* prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                yield* say("after rebuild")
                yield* say("produce the large step")
                const before = server.captures.length
                // The large step reported usage past the 50% threshold, so this turn starts the writer.
                yield* say("next")
                const findWriter = () =>
                  server.captures
                    .slice(before)
                    .find((capture) => capture.messages.some((message) => text(message).includes(WRITER_MARKER)))
                for (let attempt = 0; attempt < 200 && !findWriter(); attempt++) yield* Effect.sleep("50 millis")
                const writer = findWriter()
                expect(writer).toBeDefined()

                const stored = yield* sessions.messages({ sessionID: session.id })
                const boundary = stored.find((message) => message.parts.some((part) => part.type === "checkpoint"))!
                const largeStep = stored.find((message) =>
                  message.parts.some((part) => part.type === "text" && part.text === "produce the large step"),
                )!
                expect(boundary.info.id < largeStep.info.id).toBe(true)

                const messages = writer!.messages.filter((message) => message.role !== "system")
                if (fork) {
                  // fork:true — the message prefix mirrors the parent request
                  // window: boundary + live turns only, no tail messages (the
                  // parent request never contains the tail, so a spliced
                  // capture would diverge from the cached prefix).
                  const order = [
                    indexOf(messages, BOUNDARY_LABEL),
                    indexOf(messages, "after rebuild"),
                    indexOf(messages, "live reply"),
                    indexOf(messages, "produce the large step"),
                    indexOf(messages, WRITER_MARKER),
                  ]
                  expect(order).toEqual([...order].sort((a, b) => a - b))
                  expect(new Set(order).size).toBe(order.length)
                  // Tail content must not appear as standalone MESSAGES. The
                  // writer's own task message is excluded (its appendix
                  // carries the tail verbatim by design), and so is the
                  // boundary message (its synthetic text legitimately quotes
                  // tail user input and activity verbatim).
                  const plain = messages.filter(
                    (message) =>
                      !text(message).includes(WRITER_MARKER) && !text(message).includes(BOUNDARY_LABEL),
                  )
                  expect(plain.map((message) => text(message))).toEqual([
                    "after rebuild",
                    "live reply",
                    "produce the large step",
                  ])
                  for (const tailOnly of [
                    "run the checks on alpha and beta",
                    "alpha.txt body line 299",
                    "beta.txt body line 299",
                    "checks passed",
                  ])
                    expect(plain.some((message) => text(message).includes(tailOnly))).toBe(false)
                  // The tail rides inside the writer prompt as a serialized
                  // appendix: verbatim user/assistant text, tool-call lines,
                  // and the head of each read output (400-char per-item cap —
                  // line 299 of a 300-line output is elided with a recall
                  // marker).
                  const appendix = text(
                    writer!.messages.find((message) => text(message).includes(WRITER_MARKER))!,
                  )
                  expect(appendix).toContain("RAW CONVERSATION RECORD — REBUILD TAIL")
                  expect(appendix).toContain("run the checks on alpha and beta")
                  expect(appendix).toContain("checks passed")
                  expect(appendix).toContain("alpha.txt body line 0")
                  expect(appendix).toContain("beta.txt body line 0")
                  expect(appendix).not.toContain("alpha.txt body line 299")
                  expect(appendix).not.toContain("beta.txt body line 299")
                  expect(appendix).toContain("truncated")
                  // Prefix-cache parity, structurally: the writer's inherited
                  // messages (everything except its trailing task message)
                  // are entry-for-entry a prefix of the parent's request
                  // messages — the definition of a cache hit. The parent
                  // capture is the latest non-writer request before the
                  // writer fired (the "next" turn, whose window saw one more
                  // message than the writer's watermark slice).
                  const writerIdx = server.captures.indexOf(writer!)
                  const parentCapture = server.captures
                    .slice(0, writerIdx)
                    .filter((c) => !c.messages.some((m) => text(m).includes(WRITER_MARKER)))
                    .at(-1)
                  expect(parentCapture).toBeDefined()
                  const writerPrefix = writer!.messages.slice(0, -1)
                  expect(parentCapture!.messages.length).toBeGreaterThanOrEqual(writerPrefix.length)
                  expect(writerPrefix).toEqual(parentCapture!.messages.slice(0, writerPrefix.length))
                } else {
                  // fork:false — cold start keeps the full-fidelity tail as
                  // messages between the boundary and the live turns.
                  const order = [
                    indexOf(messages, BOUNDARY_LABEL),
                    indexOf(messages, "run the checks on alpha and beta"),
                    indexOf(messages, "alpha.txt body line 299"),
                    indexOf(messages, "beta.txt body line 299"),
                    indexOf(messages, "checks passed"),
                    indexOf(messages, "after rebuild"),
                    indexOf(messages, "live reply"),
                    indexOf(messages, "produce the large step"),
                    indexOf(messages, WRITER_MARKER),
                  ]
                  expect(order).toEqual([...order].sort((a, b) => a - b))
                  expect(new Set(order).size).toBe(order.length)
                  // The appendix is the fork:true channel only — if it ever
                  // shows up here too, the tail is billed to the prompt twice.
                  expect(JSON.stringify(messages)).not.toContain("RAW CONVERSATION RECORD")
                  const outputs = stored
                    .flatMap((message) => message.parts)
                    .flatMap((part) =>
                      part.type === "tool" && part.tool === "read" && part.state.status === "completed"
                        ? [part.state.output]
                        : [],
                    )
                  expect(outputs).toHaveLength(FILES.length)
                  for (const output of outputs)
                    expect(messages.some((message) => message.role === "tool" && text(message) === output)).toBe(true)
                }
                // computeBoundary still picks the large step's user message as the writer's watermark.
                expect(JSON.stringify(messages)).not.toContain("large-reply-start")
                // Teardown disposes the instance; let the writer finish its run first.
                expect(yield* checkpoint.waitForWriter(session.id)).toBe("success")
              }),
            { git: true, config: config(server.origin, fork) },
          )
        }),
      120_000,
    )
})

// --- renderTailAppendix (pure function) ---

const TAIL_SID = "s_tail" as SessionID

function tailMsg(id: string, role: "user" | "assistant", parts: Array<Record<string, unknown>>): MessageV2.WithParts {
  return {
    info: { id: id as MessageID, sessionID: TAIL_SID, role, time: { created: 0 }, agent: "build" },
    parts,
  } as unknown as MessageV2.WithParts
}

function tailToolPart(output: string, tool = "read"): Record<string, unknown> {
  return {
    type: "tool",
    tool,
    state: { input: { file_path: "/tmp/example" }, status: "completed", output },
  }
}

describe("renderTailAppendix", () => {
  const tail = (messages: MessageV2.WithParts[]) => ({ boundary: "msg_boundary" as MessageID, messages })

  test("returns empty for no tail, zero budget, or empty messages", () => {
    expect(renderTailAppendix(undefined, 25_000)).toBe("")
    expect(renderTailAppendix(tail([tailMsg("u0", "user", [{ type: "text", text: "hi" }])]), 0)).toBe("")
    expect(renderTailAppendix(tail([]), 25_000)).toBe("")
  })

  test("renders verbatim text, tool call + capped output with truncation marker, file placeholder", () => {
    const out = renderTailAppendix(
      tail([
        tailMsg("u0", "user", [
          { type: "text", text: "  run the checks  " },
          { type: "file", mime: "image/png", url: "file:///tmp/example/design.png", filename: "design.png" },
        ]),
        tailMsg("a1", "assistant", [
          { type: "text", text: "checks passed", synthetic: false },
          tailToolPart(Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")),
        ]),
      ]),
      25_000,
    )
    expect(out).toContain("RAW CONVERSATION RECORD — REBUILD TAIL")
    expect(out).toContain("[user | u0]")
    expect(out).toContain("run the checks")
    expect(out).toContain("[file: design.png]")
    expect(out).toContain("[assistant | a1]")
    expect(out).toContain("checks passed")
    expect(out).toContain("tool read(")
    expect(out).toContain("line 0")
    expect(out).not.toContain("line 299")
    expect(out).toContain("messageID=a1")
    // The writer's runtime whitelist has no history tool — the truncation
    // marker must not point at one, or the model burns a rejected call.
    expect(out).not.toContain("history tool")
  })

  test("FIFO drops the oldest entries when the budget is hit", () => {
    const big = (tag: string) => tailMsg(tag, "user", [{ type: "text", text: `${tag} ${"x".repeat(4_000)}` }])
    const out = renderTailAppendix(tail([big("old1"), big("old2"), big("new1")]), 1_500)
    expect(out).not.toContain("old1")
    expect(out).not.toContain("old2")
    expect(out).toContain("new1")
    // Dropping must be announced: the header switches to "newest N of M" and
    // an explicit marker names what was lost, so the writer never mistakes
    // the kept suffix for the full tail range.
    expect(out).toContain("newest 1 of 3 message(s)")
    expect(out).toContain("2 older message(s) dropped to fit tail budget")
  })

  test("file placeholder never falls back to the url (base64 data URLs must not eat the budget)", () => {
    // claude-import stores imported user images as file parts with a base64
    // data url and NO filename — the placeholder must stay one short line.
    const dataUrl = `data:image/png;base64,${"A".repeat(40_000)}`
    const out = renderTailAppendix(
      tail([
        tailMsg("u0", "user", [
          { type: "text", text: "look at this" },
          { type: "file", mime: "image/png", url: dataUrl },
        ]),
      ]),
      25_000,
    )
    expect(out).toContain("[file: image/png]")
    expect(out).not.toContain("base64")
    expect(out).toContain("look at this")
  })

  test("a single oversized newest entry is head-truncated, not dropped", () => {
    const huge = tailMsg("u0", "user", [{ type: "text", text: "x".repeat(400_000) }])
    const out = renderTailAppendix(tail([huge]), 1_000)
    expect(out).toContain("RAW CONVERSATION RECORD — REBUILD TAIL")
    expect(out).toContain("[user | u0]")
    expect(out).toContain("head-truncated")
    // No entries dropped (total === 1), so the header must still disclose the
    // head truncation instead of claiming a verbatim conversation.
    expect(out).toContain("The 1 message(s) below")
    expect(out).toContain("the newest message is head-truncated to fit tail budget")
    // "verbatim" would contradict the head truncation disclosed right below.
    expect(out).not.toContain("verbatim")
  })

  test("skips synthetic text parts", () => {
    const out = renderTailAppendix(
      tail([
        tailMsg("u0", "user", [
          { type: "text", text: "harness reminder", synthetic: true },
          { type: "text", text: "real words" },
        ]),
      ]),
      25_000,
    )
    expect(out).not.toContain("harness reminder")
    expect(out).toContain("real words")
  })
})
