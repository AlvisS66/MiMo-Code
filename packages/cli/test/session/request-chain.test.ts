import { beforeEach, describe, expect, test } from "bun:test"
import * as RequestChain from "../../src/session/request-chain"

const message = (text: string) => ({ role: "user" as const, content: text })

function record(input: {
  sessionID?: string
  agentID?: string
  model?: string
  system?: string[]
  tools?: string[]
  messages: ReturnType<typeof message>[]
}) {
  return RequestChain.record({
    sessionID: input.sessionID ?? "ses_test",
    agentID: input.agentID ?? "build",
    model: input.model ?? "test/model",
    system: input.system ?? ["sys"],
    tools: input.tools ?? ["read"],
    messages: input.messages,
  })
}

describe("request chain", () => {
  beforeEach(() => RequestChain.reset())

  test("reports the shared head against a previous request of another agent", () => {
    const parent = [message("a"), message("b"), message("c"), message("d")]
    record({ agentID: "build", messages: parent })
    // A forked subagent inherits the head and appends its own task message.
    const writer = [...parent.slice(0, 3), message("task")]
    const chain = record({ agentID: "checkpoint-writer-1", messages: writer })

    expect(chain.matches).toHaveLength(1)
    expect(chain.matches[0]).toMatchObject({ agentID: "build", shared: 3, prevCount: 4, same: false })
    expect(chain.msgCount).toBe(4)
  })

  test("an identical request is reported as the same and shares every message", () => {
    const messages = [message("a"), message("b")]
    const first = record({ messages })
    const second = record({ messages })

    expect(second.requestHash).toBe(first.requestHash)
    expect(second.matches[0]).toMatchObject({
      shared: 2,
      prevCount: 2,
      same: true,
      systemSame: true,
      toolsSame: true,
    })
  })

  test("system, tools and model participate in the request hash but not in the shared head", () => {
    const base = {
      messages: [message("a"), message("b")],
      system: ["sys"],
      tools: ["read"],
      model: "test/model",
    }
    const first = record(base)

    const otherSystem = record({ ...base, system: ["sys", "extra"] })
    expect(otherSystem.requestHash).not.toBe(first.requestHash)
    expect(otherSystem.matches[0]).toMatchObject({ shared: 2, systemSame: false, toolsSame: true })

    RequestChain.reset()
    const second = record(base)
    const otherTools = record({ ...base, tools: ["read", "write"] })
    expect(otherTools.requestHash).not.toBe(second.requestHash)
    expect(otherTools.matches[0]).toMatchObject({ shared: 2, systemSame: true, toolsSame: false })

    RequestChain.reset()
    const third = record(base)
    const otherModel = record({ ...base, model: "test/other" })
    // Same messages, system and tools, different model: the message comparison
    // still lines up, but the requests are not the same cache entry.
    expect(otherModel.requestHash).not.toBe(third.requestHash)
    expect(otherModel.matches[0]).toMatchObject({
      shared: 2,
      same: false,
      systemSame: true,
      toolsSame: true,
    })
  })

  test("a change inside the head localizes the first divergent message", () => {
    record({ messages: [message("a"), message("b"), message("c")] })
    const chain = record({ messages: [message("a"), message("b-changed"), message("c")] })

    expect(chain.matches[0].shared).toBe(1)
  })

  test("keeps one chain per agent, so parallel subagents cannot evict the parent", () => {
    record({ agentID: "build", messages: [message("parent")] })
    for (const index of [1, 2, 3, 4, 5]) {
      record({ agentID: `general-${index}`, messages: [message(`sub-${index}`)] })
    }
    const chain = record({ agentID: "checkpoint-writer-1", messages: [message("task")] })

    // The parent's chain survives a burst of subagent requests in the same session.
    expect(chain.matches.map((match) => match.agentID)).toContain("build")
  })

  test("agents sharing a root session see each other's chains", () => {
    // A writer runs in a child session but records under the root session, so a
    // chained comparison across the two is possible at all.
    record({ sessionID: "ses_root", agentID: "build", messages: [message("a"), message("b")] })
    const chain = record({ sessionID: "ses_root", agentID: "checkpoint-writer-1", messages: [message("a")] })

    expect(chain.matches[0]).toMatchObject({ agentID: "build", shared: 1 })
  })

  test("sessions do not see each other's chains", () => {
    record({ sessionID: "ses_a", messages: [message("a")] })
    const chain = record({ sessionID: "ses_b", messages: [message("a")] })

    expect(chain.matches).toHaveLength(0)
  })
})
