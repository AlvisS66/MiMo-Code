import { afterEach, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { HostModelTransport } from "../../src/provider/host-transport"

afterEach(() => HostModelTransport.set(undefined))
test("embedding transport preserves independent identities across asynchronous model calls", async () => {
  const local = new AsyncLocalStorage<string>()
  const users: string[] = []
  HostModelTransport.set({
    userMessage: input => { users.push(input.userMessageID) },
    modelCall: (scope, next) => local.run(scope.assistantMessageID!, next),
  })
  HostModelTransport.userMessage({ sessionID: "s-a", userMessageID: "u-a", parts: [] })
  const values = await Promise.all(["a", "b"].map(id => HostModelTransport.modelCall({
    sessionID: `s-${id}`, userMessageID: `u-${id}`, assistantMessageID: `a-${id}`,
    agent: "build", providerID: "test", modelID: "model", sdk: "test", ephemeral: false,
  }, async () => { await Promise.resolve(); return local.getStore() })))
  expect(values).toEqual(["a-a", "a-b"])
  expect(users).toEqual(["u-a"])
  expect(local.getStore()).toBeUndefined()
})
test("without an embedder the model result and failure are unchanged", async () => {
  const scope = { sessionID: "s", userMessageID: "u", agent: "build", providerID: "test", modelID: "model", sdk: "test", ephemeral: false }
  const value = {}
  expect(await HostModelTransport.modelCall(scope, async () => value)).toBe(value)
  const error = new Error("test failure")
  await expect(HostModelTransport.modelCall(scope, async () => { throw error })).rejects.toBe(error)
})
