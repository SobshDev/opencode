import { describe, expect, test } from "bun:test"
import { CallableModels } from "@opencode-ai/core/callable-model"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const info = (input: {
  providerID: string
  id: string
  name: string
  released: number
  tools?: boolean
  family?: string
}) => {
  const providerID = ProviderV2.ID.make(input.providerID)
  const id = ModelV2.ID.make(input.id)
  return ModelV2.Info.make({
    ...ModelV2.Info.empty(providerID, id),
    name: input.name,
    ...(input.family === undefined ? {} : { family: ModelV2.Family.make(input.family) }),
    api: {
      id,
      type: "aisdk",
      package: "@ai-sdk/openai",
      settings: { apiKey: "api-secret" },
    },
    capabilities: {
      tools: input.tools ?? false,
      input: ["text"],
      output: ["text"],
    },
    request: {
      headers: { authorization: "header-secret" },
      body: { apiKey: "body-secret" },
    },
    variants: [
      {
        id: ModelV2.VariantID.make("fast"),
        headers: { authorization: "variant-secret" },
        body: { reasoning: "low" },
      },
    ],
    time: { released: input.released },
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
    limit: { context: 100, input: 90, output: 10 },
  })
}

describe("CallableModels", () => {
  test("projects only safe model metadata", () => {
    const model = CallableModels.project(
      info({
        providerID: "openai",
        id: "gpt-5",
        name: "GPT-5",
        family: "gpt",
        released: 5,
        tools: true,
      }),
    )

    expect(model).toEqual({
      ref: { providerID: ProviderV2.ID.make("openai"), id: ModelV2.ID.make("gpt-5") },
      name: "GPT-5",
      family: ModelV2.Family.make("gpt"),
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [ModelV2.VariantID.make("fast")],
      status: "active",
      limits: { context: 100, input: 90, output: 10 },
      cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
    })
    expect(JSON.stringify(model)).not.toContain("secret")
    expect(JSON.stringify(model)).not.toContain("apiKey")
  })

  test("searches, filters, ranks, and paginates deterministically", () => {
    const models = [
      info({ providerID: "openai", id: "gpt-4", name: "GPT-4", released: 4 }),
      info({
        providerID: "anthropic",
        id: "catalog/claude-sonnet",
        name: "Claude Sonnet",
        family: "claude",
        released: 3,
        tools: true,
      }),
      info({
        providerID: "anthropic",
        id: "claude-opus",
        name: "Claude Opus",
        family: "claude",
        released: 5,
        tools: true,
      }),
    ]

    expect(
      CallableModels.search(models.map(CallableModels.fromModel), {
        query: "claude",
        providerID: ProviderV2.ID.make("anthropic"),
        tools: true,
        limit: 1,
      }),
    ).toMatchObject({
      items: [{ ref: { id: ModelV2.ID.make("claude-opus") } }],
      nextCursor: "model:1",
    })
    expect(
      CallableModels.search(models.map(CallableModels.fromModel), {
        query: "claude",
        providerID: ProviderV2.ID.make("anthropic"),
        tools: true,
        limit: 1,
        cursor: "model:1",
      }),
    ).toEqual({
      items: [CallableModels.project(models[1])],
    })
    expect(
      CallableModels.search(models.map(CallableModels.fromModel), {
        query: "anthropic/catalog/claude-sonnet",
      }).items[0]?.ref.id,
    ).toBe(ModelV2.ID.make("catalog/claude-sonnet"))
  })
})
