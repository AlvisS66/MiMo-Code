import "./node-bun-shim"
import { PluginHost } from "../../../src/plugin/host"
import { ConfigHost } from "../../../src/config/host"

PluginHost.provideSdk()
console.log(
  JSON.stringify({
    onlyConfigDir: PluginHost.onlyConfigDir(),
    projectExecution: ConfigHost.allowsExecution("/tmp/example/mimocode.json"),
    hostExecution: ConfigHost.allowsExecution("MIMOCODE_CONFIG_CONTENT"),
  }),
)
