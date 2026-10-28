import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { MCP } from "../../src/mcp"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("host policy prevents project MCP execution on initial and restored instance loads", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const host = path.join(dir, "host")
      const project = path.join(dir, "project")
      const script = path.join(dir, "server.mjs")
      await Bun.write(
        script,
        `
import fs from "node:fs"
import readline from "node:readline"
fs.writeFileSync(process.env.EXAMPLE_MARKER, "started")
const lines = readline.createInterface({ input: process.stdin })
lines.on("close", () => process.exit(0))
lines.on("line", (line) => {
  const request = JSON.parse(line)
  if (request.id == null) return
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "example", version: "1" } }
    : { tools: [] }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n")
})
`,
      )
      const config = (name: string) => ({
        type: "local",
        command: [process.execPath, script],
        environment: { EXAMPLE_MARKER: path.join(dir, `${name}.marker`) },
      })
      await Bun.write(path.join(host, "mimocode.json"), JSON.stringify({ mcp: { trusted: config("trusted") } }))
      await Bun.write(path.join(project, "mimocode.json"), JSON.stringify({ mcp: { root: config("root") } }))
      await Bun.write(
        path.join(project, ".mimocode", "mimocode.jsonc"),
        JSON.stringify({ mcp: { hidden: config("hidden") } }),
      )
      await Bun.write(
        path.join(project, ".claude.json"),
        JSON.stringify({
          mcpServers: { claude: { command: process.execPath, args: [script], env: config("claude").environment } },
        }),
      )
      return { host, project }
    },
  })
  const previousPolicy = process.env.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS
  const previousDir = process.env.MIMOCODE_CONFIG_DIR
  process.env.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS = "1"
  process.env.MIMOCODE_CONFIG_DIR = tmp.extra.host
  try {
    for (let load = 0; load < 2; load++) {
      await Instance.provide({
        directory: tmp.extra.project,
        fn: async () => {
          const status = await MCP.Service.use((mcp) => mcp.status()).pipe(
            Effect.provide(MCP.defaultLayer),
            Effect.runPromise,
          )
          expect(status).toEqual({ trusted: { status: "connected" } })
          expect(await Bun.file(path.join(tmp.path, "trusted.marker")).text()).toBe("started")
          for (const name of ["root", "hidden", "claude"]) {
            expect(await Bun.file(path.join(tmp.path, `${name}.marker`)).exists()).toBe(false)
          }
          await Instance.dispose()
        },
      })
      await fs.rm(path.join(tmp.path, "trusted.marker"))
    }
  } finally {
    await Instance.disposeAll()
    if (previousPolicy == null) delete process.env.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS
    else process.env.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS = previousPolicy
    if (previousDir == null) delete process.env.MIMOCODE_CONFIG_DIR
    else process.env.MIMOCODE_CONFIG_DIR = previousDir
  }
})
