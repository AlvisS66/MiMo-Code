export * as ConfigHost from "./host"

import path from "path"
import { Flag } from "@/flag/flag"
import * as Filesystem from "@/util/filesystem"

// Desktop can provide a partial Bun shim on Node; only the plugin capability
// distinguishes a runtime that supports unrestricted external configuration.
export function canServePluginSdk() {
  return typeof Bun !== "undefined" && typeof Bun.plugin === "function"
}

export function onlyConfigDir() {
  return !canServePluginSdk() || Flag.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS
}

export function inConfigDir(source: string) {
  const root = Flag.MIMOCODE_CONFIG_DIR
  if (!root || !path.isAbsolute(source)) return false
  const rel = path.relative(Filesystem.resolve(root), Filesystem.resolve(source))
  // Different Windows drives produce an absolute relative path.
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)
}

export function allowsExecution(source: string) {
  if (!onlyConfigDir()) return true
  if (source === "MIMOCODE_CONFIG_CONTENT" || source === "MIMOCODE_CONFIG_DEFAULTS") return true
  return inConfigDir(source)
}
