// Rolling hash chain over the messages a request actually sends.
//
// Why: a subagent's first request can come back with `cache.read === 0` while
// the parent session's previous request hit 98-100% at the same moment, and a
// provider-side eviction does not explain it. Comparing "the prefix each side
// built" at the two construction sites cannot answer that, because neither of
// them is what reads from the provider cache: the cache holds the bytes of the
// PREVIOUS request. So the chain is taken on the final message array, right
// before the SDK call, and the latest chain per agent is kept in memory: a later
// request can then be matched against them and the first divergent message index
// falls out.
//
// Bucket: entries are keyed by the ROOT session (`parentSessionID ?? sessionID`).
// A checkpoint writer runs in a child session of the session it is writing about
// (checkpoint.ts `session.create({ parentID })`), so keying by the request's own
// session would put the writer in a bucket that never contains the parent's
// chains — i.e. exactly the comparison this exists for would always be empty.
//
// Bound: this runs BEFORE `ProviderTransform.message` (invoked later from
// `transformParams`), which may drop or split messages and marks the tail
// messages for caching. A comparison taken here is therefore exact for the head
// and systematically optimistic about the last 2-3 messages.
//
// Cost: one JSON.stringify plus one sha256 per message per request — tens of
// milliseconds on a multi-megabyte context. That is why the result is logged at
// debug level: it is a diagnostic to switch on, not a line for every user log.
//
// The ring is deliberately tiny and process-local. It exists to make one
// question answerable in the logs — "does this request share a byte-identical
// head with the one that was just cached, and if not, at which message?" — and
// nothing else reads it.
import { createHash } from "node:crypto"
import type { ModelMessage } from "ai"

/** Sessions tracked at once; least recently written session is dropped first. */
const MAX_SESSIONS = 64
/** Agents remembered per session, so parallel subagents cannot evict the parent. */
const MAX_AGENTS = 8
/** Hex chars kept per link: collision-free enough for comparisons, 1/4 the size. */
const LINK_HEX = 16

type Entry = {
  readonly agentID: string
  readonly links: readonly string[]
  readonly requestHash: string
  readonly systemHash: string
  readonly toolsHash: string
}

const bySession = new Map<string, Map<string, Entry>>()

export type Match = {
  readonly agentID: string
  /** Messages that hash identically from the start of both chains. */
  readonly shared: number
  /** Messages in that previous request. */
  readonly prevCount: number
  /** The whole request (model + system + tools + every message) matched. */
  readonly same: boolean
  readonly systemSame: boolean
  readonly toolsSame: boolean
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, LINK_HEX)
}

function link(previous: string, message: ModelMessage) {
  // The message object is hashed as the transport will see it. Key order is
  // stable because both sides of a comparison come out of the same renderer; a
  // reordered key would read as a divergence, which is the safe direction to be
  // wrong in.
  return digest(`${previous}\n${JSON.stringify(message)}`)
}

export type Chain = {
  readonly requestHash: string
  readonly systemHash: string
  readonly toolsHash: string
  readonly msgCount: number
  /**
   * The latest request of every agent seen in this session, including this one's
   * predecessor, with the length of the shared byte-identical head. Empty on the
   * first request of a session.
   */
  readonly matches: readonly Match[]
}

/**
 * Records one outgoing request and reports how its head compares to what this
 * session sent before.
 *
 * `tools` takes one signature per active tool — name, description and schema —
 * because the tool block sits at the very front of the provider cache and tool
 * descriptions are parameterised by agent, so an identical set of tool *names*
 * says nothing about the bytes.
 *
 * `sessionID` must be the root session, not the request's own: see the header.
 */
export function record(input: {
  sessionID: string
  agentID: string
  model: string
  system: readonly string[]
  tools: readonly string[]
  messages: readonly ModelMessage[]
}): Chain {
  const links: string[] = []
  let previous = ""
  for (const message of input.messages) {
    previous = link(previous, message)
    links.push(previous)
  }
  const systemHash = digest(input.system.join("\n"))
  const toolsHash = digest(input.tools.join("\n"))
  // The model belongs in the hash: two requests for different models are never
  // the same cache entry, so reporting `same` across them would be a lie.
  const requestHash = digest([input.model, systemHash, toolsHash, previous].join("\n"))

  const agents = bySession.get(input.sessionID) ?? new Map<string, Entry>()
  const matches = [...agents.values()].map((entry) => {
    let shared = 0
    while (
      shared < entry.links.length &&
      shared < links.length &&
      entry.links[shared] === links[shared]
    ) {
      shared += 1
    }
    return {
      agentID: entry.agentID,
      shared,
      prevCount: entry.links.length,
      same: entry.requestHash === requestHash,
      systemSame: entry.systemHash === systemHash,
      toolsSame: entry.toolsHash === toolsHash,
    }
  })

  // Re-insert so map order is recency order, which is what the caps evict by.
  agents.delete(input.agentID)
  agents.set(input.agentID, { agentID: input.agentID, links, requestHash, systemHash, toolsHash })
  for (const oldest of agents.keys()) {
    if (agents.size <= MAX_AGENTS) break
    agents.delete(oldest)
  }
  bySession.delete(input.sessionID)
  bySession.set(input.sessionID, agents)
  for (const oldest of bySession.keys()) {
    if (bySession.size <= MAX_SESSIONS) break
    bySession.delete(oldest)
  }

  return { requestHash, systemHash, toolsHash, msgCount: links.length, matches }
}

/** Test seam: the ring is process state. */
export function reset() {
  bySession.clear()
}
