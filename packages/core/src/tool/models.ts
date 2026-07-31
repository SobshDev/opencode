export * as ModelsTool from "./models"

import { ModelCall } from "@opencode-ai/schema/model-call"
import { Effect, Layer } from "effect"
import { AgentV2 } from "../agent"
import { CallableModels } from "../callable-model"
import { Catalog } from "../catalog"
import { makeLocationNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { SessionStore } from "../session/store"
import { SessionRunnerModel } from "../session/runner/model"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "models"

export const description = [
  "Search the models available to this session for delegation with model_call.",
  "Use query to match provider, model, family, or variant names; providerID and tools provide exact filters.",
  "Results contain only safe public capabilities and never include credentials, request headers, or provider settings.",
  "Use nextCursor as cursor to continue a paginated search.",
].join("\n")

type ModelOutput = typeof ModelCall.ListResult.Encoded

export const toModelOutput = (output: ModelOutput) => JSON.stringify(output)

export const make = (
  catalog: Catalog.Interface,
  resolvable: (model: ModelV2.Info, context: Tool.Context) => Effect.Effect<boolean>,
) =>
  Tool.make({
    description,
    input: ModelCall.ListInput,
    output: ModelCall.ListResult,
    toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
    execute: (input, context) =>
      Effect.gen(function* () {
        const models = yield* Effect.filter(
          (yield* catalog.model.available()).filter(
            (model) => model.capabilities.input.includes("text") && model.capabilities.output.includes("text"),
          ),
          (model) => resolvable(model, context),
        )
        return CallableModels.search(models.map(CallableModels.fromModel), input)
      }),
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const catalog = yield* Catalog.Service
    const agents = yield* AgentV2.Service
    const models = yield* SessionRunnerModel.Service
    const sessions = yield* SessionStore.Service
    yield* tools
      .register({
        [name]: make(catalog, (model, context) =>
          Effect.gen(function* () {
            const session = yield* sessions.get(context.sessionID)
            if (!session) return false
            const agent = yield* agents.select(context.agent)
            return yield* models
              .resolve(
                {
                  ...session,
                  model: ModelV2.Ref.make({
                    providerID: model.providerID,
                    id: model.id,
                  }),
                },
                agent.info,
              )
              .pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              )
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/models",
  layer,
  deps: [ToolRegistry.node, Catalog.node, AgentV2.node, SessionRunnerModel.node, SessionStore.node],
})
