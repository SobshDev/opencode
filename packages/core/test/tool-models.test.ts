import { describe, expect } from "bun:test"
import { Catalog } from "@opencode-ai/core/catalog"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ModelsTool } from "@opencode-ai/core/tool/models"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect } from "effect"
import { it } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const supported = ModelV2.Info.make({
  ...ModelV2.Info.empty(ProviderV2.ID.make("anthropic"), ModelV2.ID.make("claude-sonnet")),
  name: "Claude Sonnet",
  api: {
    id: ModelV2.ID.make("claude-sonnet"),
    type: "aisdk",
    package: "@ai-sdk/anthropic",
    settings: { apiKey: "secret" },
  },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: { authorization: "secret" }, body: {} },
})
const unsupported = ModelV2.Info.make({
  ...ModelV2.Info.empty(ProviderV2.ID.make("native"), ModelV2.ID.make("private")),
  name: "Private Native",
})
const outputOnly = ModelV2.Info.make({
  ...supported,
  id: ModelV2.ID.make("output-only"),
  name: "Output Only",
  api: { ...supported.api, id: ModelV2.ID.make("output-only") },
  capabilities: { tools: true, input: ["image"], output: ["text"] },
})
const unresolved = ModelV2.Info.make({
  ...supported,
  id: ModelV2.ID.make("unresolved"),
  name: "Unresolved",
  api: { ...supported.api, id: ModelV2.ID.make("unresolved") },
})

const catalog = Catalog.Service.of({
  transform: () => Effect.die("unused"),
  reload: () => Effect.die("unused"),
  provider: {
    get: () => Effect.die("unused"),
    all: () => Effect.die("unused"),
    available: () => Effect.die("unused"),
  },
  model: {
    get: () => Effect.die("unused"),
    all: () => Effect.die("unused"),
    available: () => Effect.succeed([supported, unsupported, outputOnly, unresolved]),
    default: () => Effect.die("unused"),
    small: () => Effect.die("unused"),
  },
})

const context = {
  sessionID: SessionV2.ID.make("ses_models_tool_test"),
  ...toolIdentity,
  location: Location.Ref.make({ directory: AbsolutePath.make("/models-tool") }),
  abort: new AbortController().signal,
  toolCallID: "call-models",
}

describe("ModelsTool", () => {
  it.effect("projects a safe callable catalog without a per-target allowlist", () =>
    Effect.gen(function* () {
      const tool = ModelsTool.make(catalog, (model) => Effect.succeed(model.id !== unresolved.id))
      expect(Tool.permission(tool, ModelsTool.name)).toBe("models")
      expect(Tool.definition(ModelsTool.name, tool)).toMatchObject({
        name: ModelsTool.name,
        description: ModelsTool.description,
      })

      const output = yield* Tool.settle(
        tool,
        {
          type: "tool-call",
          id: "call-models",
          name: ModelsTool.name,
          input: { query: "claude", tools: true },
        },
        context,
      )
      expect(output.structured).toEqual({
        items: [
          {
            ref: { providerID: "anthropic", id: "claude-sonnet" },
            name: "Claude Sonnet",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            status: "active",
            limits: { context: 0, output: 0 },
            cost: [],
          },
        ],
      })
      expect(JSON.stringify(output)).not.toContain("secret")
      expect(output.content).toEqual([{ type: "text", text: JSON.stringify(output.structured) }])
    }),
  )
})
