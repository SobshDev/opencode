import { CallableModels } from "@opencode-ai/core/callable-model"
import { Model } from "@opencode-ai/schema/model"
import { ModelCall } from "@opencode-ai/schema/model-call"
import { Effect } from "effect"
import { Provider } from "@/provider/provider"
import { Tool } from "./tool"

export const Parameters = ModelCall.ListInput

export const ModelsTool = Tool.define(
  "models",
  Effect.gen(function* () {
    const provider = yield* Provider.Service

    return {
      description: [
        "Search the models available to this session for delegation with model_call.",
        "Use query to match provider, model, family, or variant names; providerID and tools provide exact filters.",
        "Results contain only safe public capabilities and never include credentials, request headers, or provider settings.",
        "Use nextCursor as cursor to continue a paginated search.",
      ].join("\n"),
      parameters: Parameters,
      execute: (input: ModelCall.ListInput) =>
        Effect.gen(function* () {
          const providers = yield* provider.list()
          const models = Object.values(providers).flatMap((item) =>
            Object.values(item.models).filter(
              (model) => model.capabilities.input.text && model.capabilities.output.text,
            ),
          )
          const callable = (yield* Effect.forEach(
            models,
            (model) =>
              provider
                .getModel(model.providerID, model.id)
                .pipe(
                  Effect.flatMap(provider.getLanguage),
                  Effect.matchCause({ onFailure: () => undefined, onSuccess: () => model }),
                ),
            { concurrency: "unbounded" },
          )).filter((model) => model !== undefined)
          const output = CallableModels.search(callable.map(toCallableModel), input)
          return {
            title: "Available models",
            metadata: {
              count: output.items.length,
              ...(output.nextCursor === undefined ? {} : { nextCursor: output.nextCursor }),
            },
            output: JSON.stringify(output),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function toCallableModel(model: Provider.Model): CallableModels.SearchEntry {
  const released = Date.parse(model.release_date)
  return {
    item: {
      ref: {
        id: model.id,
        providerID: model.providerID,
      },
      ...(model.family === undefined ? {} : { family: Model.Family.make(model.family) }),
      name: model.name,
      capabilities: {
        tools: model.capabilities.toolcall,
        input: Object.entries(model.capabilities.input)
          .filter((entry) => entry[1])
          .map((entry) => entry[0]),
        output: Object.entries(model.capabilities.output)
          .filter((entry) => entry[1])
          .map((entry) => entry[0]),
      },
      variants: Object.keys(model.variants ?? {})
        .toSorted()
        .map((id) => Model.VariantID.make(id)),
      cost: [
        {
          input: model.cost.input,
          output: model.cost.output,
          cache: {
            read: model.cost.cache.read,
            write: model.cost.cache.write,
          },
        },
        ...(model.cost.tiers?.map((cost) => ({
          tier: {
            type: cost.tier.type,
            size: cost.tier.size,
          },
          input: cost.input,
          output: cost.output,
          cache: {
            read: cost.cache.read,
            write: cost.cache.write,
          },
        })) ?? []),
        ...(model.cost.experimentalOver200K
          ? [
              {
                tier: {
                  type: "context" as const,
                  size: 200_000,
                },
                input: model.cost.experimentalOver200K.input,
                output: model.cost.experimentalOver200K.output,
                cache: {
                  read: model.cost.experimentalOver200K.cache.read,
                  write: model.cost.experimentalOver200K.cache.write,
                },
              },
            ]
          : []),
      ],
      status: model.status,
      limits: {
        context: model.limit.context,
        ...(model.limit.input === undefined ? {} : { input: model.limit.input }),
        output: model.limit.output,
      },
    },
    released: Number.isFinite(released) ? released : 0,
  }
}
