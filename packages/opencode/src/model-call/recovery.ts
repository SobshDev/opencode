import { ModelCallV2 } from "@opencode-ai/core/model-call"
import { ModelCallOrchestration } from "@opencode-ai/core/model-call/orchestration"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelCall } from "@opencode-ai/schema/model-call"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { isDeepStrictEqual } from "node:util"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import type { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { modelCallPartID, type ModelCallPromptOps } from "@/tool/model-call"

export interface Interface {
  readonly register: (services: {
    calls: ModelCallV2.Interface
    provider: Provider.Interface
    prompts: Pick<ModelCallPromptOps, "admitExact" | "cancel" | "consumed" | "releaseExact" | "wake">
    sessions: Session.Interface
  }) => Effect.Effect<void>
  readonly init: () => Effect.Effect<void, unknown>
  readonly recover: (record: ModelCallV2.Info) => Effect.Effect<ModelCallV2.Info, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelCallRecovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let calls: ModelCallV2.Interface
    let sessions: Session.Interface
    let provider: Provider.Interface
    let prompts: Pick<ModelCallPromptOps, "admitExact" | "cancel" | "consumed" | "releaseExact" | "wake">
    let registered = false

    const ready = Effect.sync(() => {
      if (!registered) throw new Error("SessionPrompt has not registered legacy model-call recovery")
    })

    const deliver = Effect.fn("ModelCallRecovery.deliver")(function* (record: ModelCallV2.Info) {
      if (!record.background || !ModelCallV2.isTerminal(record.status) || record.deliveredAt !== undefined)
        return record
      const result = ModelCallV2.result(record)
      const parent = yield* sessions.get(record.parentSessionID).pipe(Effect.option)
      if (Option.isNone(parent))
        return yield* calls
          .delivered(record.id)
          .pipe(Effect.catchTag("ModelCall.NotFoundError", () => Effect.succeed(record)))
      const messageID = MessageID.ascending(record.completionMessageID)
      const admission = yield* prompts.admitExact({
        messageID,
        sessionID: record.parentSessionID,
        agent: parent.value.agent ?? record.agent,
        ...(parent.value.model === undefined
          ? {}
          : {
              model: {
                providerID: parent.value.model.providerID,
                modelID: parent.value.model.id,
              },
              variant: parent.value.model.variant,
            }),
        noReply: true,
        parts: [
          {
            id: modelCallPartID(messageID),
            type: "text",
            synthetic: true,
            internal: { type: "model-call-result", result },
            text: [
              `<model_call_result call_id="${result.callID}" status="${result.status}">`,
              JSON.stringify(result),
              "</model_call_result>",
            ].join("\n"),
          },
        ],
      })
      if (!admission.claimed) return yield* calls.get(record.id)
      const completion = { sessionID: record.parentSessionID, messageID }
      const wakeUntilConsumed: () => Effect.Effect<void> = Effect.fn("ModelCallRecovery.wakeUntilConsumed")(
        function* () {
          if (yield* prompts.consumed(completion)) return
          yield* prompts.wake(record.parentSessionID)
          if (yield* prompts.consumed(completion)) return
          yield* Effect.sleep("25 millis")
          return yield* wakeUntilConsumed()
        },
      )
      return yield* wakeUntilConsumed().pipe(
        Effect.andThen(calls.delivered(record.id)),
        Effect.tap(() => prompts.releaseExact({ sessionID: record.parentSessionID, messageID })),
        Effect.onError(() => prompts.releaseExact({ sessionID: record.parentSessionID, messageID })),
      )
    })

    const persist = Effect.fn("ModelCallRecovery.persist")(function* (record: ModelCallV2.Info) {
      const result = ModelCallV2.result(record)
      const child = yield* sessions.get(record.childSessionID).pipe(Effect.option)
      if (Option.isSome(child))
        yield* sessions.setMetadata({
          sessionID: record.childSessionID,
          metadata: {
            modelCall: {
              ...origin(record),
              ...result,
            },
          },
        })
      return yield* deliver(record)
    })

    const fail = Effect.fn("ModelCallRecovery.fail")(function* (
      record: ModelCallV2.Info,
      error: ModelCall.Error,
      output?: { text?: string; usage?: ModelCall.Usage },
    ) {
      return yield* calls.failed(record.id, error, output).pipe(Effect.flatMap(persist))
    })

    const prepare: (record: ModelCallV2.Info) => Effect.Effect<ModelCallV2.Info, unknown> = Effect.fn(
      "ModelCallRecovery.prepare",
    )(function* (record) {
      if (ModelCallV2.isTerminal(record.status)) return record
      const existing = Option.getOrUndefined(yield* sessions.get(record.childSessionID).pipe(Effect.option))
      if (existing) {
        if (
          existing.parentID !== record.parentSessionID ||
          existing.agent !== record.agent ||
          existing.directory !== record.location.directory ||
          existing.workspaceID !== record.location.workspaceID ||
          !isDeepStrictEqual(existing.origin, origin(record)) ||
          existing.model?.providerID !== record.actualModel.providerID ||
          existing.model.id !== record.actualModel.id ||
          ModelCallOrchestration.normalizeVariant(existing.model.variant) !==
            ModelCallOrchestration.normalizeVariant(record.actualModel.variant) ||
          record.permission.version !== "legacy" ||
          !isDeepStrictEqual(existing.permission ?? [], record.permission.rules)
        )
          return yield* fail(
            record,
            {
              code: "preparation_conflict",
              message: "The reserved child Session exists with conflicting immutable lineage or model settings",
            },
            { usage: usage(existing) },
          )
        return record
      }
      const created = yield* sessions
        .create({
          id: record.childSessionID,
          parentID: record.parentSessionID,
          title: title(record),
          agent: record.agent,
          model: record.actualModel,
          origin: origin(record),
          metadata: {
            modelCall: {
              ...origin(record),
              actualModel: record.actualModel,
              mode: record.background ? "background" : "foreground",
              status: record.status,
            },
          },
          permission: record.permission.version === "legacy" ? structuredClone(record.permission.rules) : undefined,
          workspaceID: record.location.workspaceID,
        })
        .pipe(Effect.exit)
      if (Exit.isFailure(created)) {
        const winner = yield* sessions.get(record.childSessionID).pipe(Effect.option)
        if (Option.isSome(winner)) return yield* prepare(record)
        return yield* Effect.failCause(created.cause)
      }
      return record
    })

    const resolve = Effect.fn("ModelCallRecovery.resolve")(function* (record: ModelCallV2.Info) {
      const model = yield* provider.getModel(record.actualModel.providerID, record.actualModel.id)
      yield* provider.getLanguage(model)
      if (!model.capabilities.input.text || !model.capabilities.output.text) {
        return yield* Effect.fail(
          new Error(`Model is not text-callable: ${record.actualModel.providerID}/${record.actualModel.id}`),
        )
      }
      if (
        record.actualModel.variant !== undefined &&
        record.actualModel.variant !== "default" &&
        !Object.hasOwn(model.variants ?? {}, record.actualModel.variant)
      ) {
        return yield* Effect.fail(
          new Error(
            `Model variant not found: ${record.actualModel.providerID}/${record.actualModel.id}/${record.actualModel.variant}`,
          ),
        )
      }
      return model
    })

    const settle: (
      record: ModelCallV2.Info,
      response: SessionV1.WithParts,
    ) => Effect.Effect<ModelCallV2.Info, unknown> = Effect.fn("ModelCallRecovery.settle")(function* (record, response) {
      const current = yield* calls.get(record.id)
      if (ModelCallV2.isTerminal(current.status)) return yield* persist(current)
      if (response.info.role !== "assistant") {
        return yield* fail(current, {
          code: "MODEL_CALL_FAILED",
          message: "Model call did not produce an assistant response",
        })
      }
      const text = response.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
      const child = yield* sessions.get(current.childSessionID)
      const childUsage = usage(child)
      const provenance = ModelCallOrchestration.compareProvenance(current.actualModel, {
        providerID: response.info.providerID,
        id: response.info.modelID,
        ...(response.info.variant === undefined ? {} : { variant: response.info.variant }),
      })
      if (!provenance.matches)
        return yield* fail(current, provenance.error, {
          text,
          usage: childUsage,
        })
      if (response.info.error?.name === "MessageAbortedError") {
        return yield* calls.cancelled(current.id, { usage: childUsage }).pipe(Effect.flatMap(persist))
      }
      if (response.info.error && response.info.error.name !== "StructuredOutputError") {
        return yield* fail(current, callError(response.info.error), { text, usage: childUsage })
      }

      if (current.outputSchema !== undefined) {
        const validation = ModelCallOrchestration.validateStructured(
          current.outputSchema,
          response.info.structured === undefined ? text : response.info.structured,
        )
        if (validation.error && current.validationAttempts === 0) {
          const correcting = yield* calls.requestCorrection(current.id, validation.error)
          return yield* resume(correcting, true)
        }
        if (validation.error) {
          return yield* fail(
            current,
            {
              code: validation.code ?? "structured_output_invalid",
              message: validation.error,
            },
            {
              ...(validation.code === "structured_output_too_large" ? {} : { text }),
              usage: childUsage,
            },
          )
        }
        return yield* calls
          .completed(current.id, {
            text,
            structured: validation.structured,
            usage: childUsage,
          })
          .pipe(Effect.flatMap(persist))
      }

      return yield* calls
        .completed(current.id, {
          text,
          usage: childUsage,
        })
        .pipe(Effect.flatMap(persist))
    })

    const resume: (record: ModelCallV2.Info, correction: boolean) => Effect.Effect<ModelCallV2.Info, unknown> =
      Effect.fn("ModelCallRecovery.resume")(function* (record, correction) {
        const model = yield* resolve(record)
        const messageID = MessageID.ascending(correction ? record.correctionPromptID : record.childPromptID)
        const input = childPrompt(record, model.capabilities.toolcall, correction)
        const admission = yield* prompts.admitExact({ ...input, noReply: true })
        const queued = record.status === "preparing" ? yield* calls.queued(record.id) : record
        const started = queued.status === "queued" && admission.claimed ? yield* calls.started(record.id) : queued
        const awaitTerminal: () => Effect.Effect<ModelCallV2.Info, ModelCallV2.NotFoundError> = Effect.fn(
          "ModelCallRecovery.awaitTerminal",
        )(function* () {
          const current = yield* calls.get(started.id)
          if (!ModelCallV2.isTerminal(current.status)) {
            return yield* Effect.sleep("25 millis").pipe(Effect.andThen(awaitTerminal()))
          }
          if (current.status === "cancelled" || current.status === "interrupted") {
            yield* prompts.cancel(current.childSessionID)
          }
          return current
        })
        const outcome = yield* (
          admission.claimed
            ? Effect.raceFirst(
                prompts
                  .wake(started.childSessionID)
                  .pipe(Effect.map((response) => ({ type: "response" as const, response }))),
                awaitTerminal().pipe(Effect.map((terminal) => ({ type: "terminal" as const, terminal }))),
              )
            : awaitTerminal().pipe(Effect.map((terminal) => ({ type: "terminal" as const, terminal })))
        ).pipe(
          Effect.onError(() =>
            prompts.releaseExact({
              sessionID: record.childSessionID,
              messageID,
            }),
          ),
        )
        const result =
          outcome.type === "terminal" ? yield* persist(outcome.terminal) : yield* settle(started, outcome.response)
        yield* prompts.releaseExact({ sessionID: record.childSessionID, messageID })
        return result
      })

    const recover = Effect.fn("ModelCallRecovery.recover")(function* (input: ModelCallV2.Info) {
      yield* ready
      const initial = ModelCallOrchestration.decideRecovery({
        stage: "record",
        status: input.status,
        slotReserved: input.slot !== undefined,
      })
      if (initial.action === "deliver") return yield* deliver(input)
      const reserved =
        initial.action === "prepare" && initial.reserveSlot
          ? yield* calls.reserve({
              parentSessionID: input.parentSessionID,
              parentAssistantMessageID: input.parentAssistantMessageID,
              parentToolCallID: input.parentToolCallID,
              agent: input.agent,
              requestedModel: input.requestedModel,
              actualModel: input.actualModel,
              location: input.location,
              permission: input.permission,
              prompt: input.prompt,
              ...(input.system === undefined ? {} : { system: input.system }),
              ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
              runtime: input.runtime,
              background: input.requestedBackground,
            })
          : input
      const afterReservation = ModelCallOrchestration.decideRecovery({
        stage: "record",
        status: reserved.status,
        slotReserved: reserved.slot !== undefined,
      })
      if (afterReservation.action === "deliver") return yield* deliver(reserved)
      if (reserved.slot === undefined) {
        return yield* fail(reserved, {
          code: "preparation_failed",
          message: "Model call did not reserve a direct-child slot",
        })
      }
      const record = yield* prepare(reserved)
      const afterPreparation = ModelCallOrchestration.decideRecovery({
        stage: "record",
        status: record.status,
        slotReserved: record.slot !== undefined,
      })
      if (afterPreparation.action === "deliver") return yield* deliver(record)
      const correction = record.validationAttempts > 0
      const messageID = MessageID.ascending(correction ? record.correctionPromptID : record.childPromptID)
      const message = Option.getOrUndefined(
        yield* sessions.findMessage(record.childSessionID, (item) => item.info.id === messageID),
      )
      const assistantMatch = Option.getOrUndefined(
        yield* sessions.findMessage(
          record.childSessionID,
          (item) => item.info.role === "assistant" && item.info.parentID === messageID,
        ),
      )
      const assistant = isAssistantMessage(assistantMatch) ? assistantMatch : undefined
      const observation = ModelCallOrchestration.observeChildLifecycle({
        status: record.status,
        prompt: {
          exists: message !== undefined,
          // Legacy persists the assistant row immediately before provider work. Its
          // presence makes the outcome unknown after a crash, so never retry it.
          promoted: assistant !== undefined,
        },
        assistant: {
          exists: assistant !== undefined,
          completed: assistant?.info.time.completed !== undefined,
          error: assistant?.info.error !== undefined,
          finish: assistant?.info.finish,
          continuation:
            assistant?.parts.some(
              (part) =>
                part.type === "tool" &&
                !part.metadata?.providerExecuted &&
                !(part.state.status === "error" && part.state.metadata?.interrupted === true),
            ) ?? false,
          continuationFinishes: ["tool-calls", "unknown"],
        },
      })
      const decision = ModelCallOrchestration.decideRecovery(observation)
      if (decision.action === "settle") {
        if (!assistant) return yield* Effect.die(new Error("Recovery selected settlement without a terminal response"))
        return yield* settle(record, assistant)
      }
      if (decision.action === "interrupt") {
        const child = yield* sessions.get(record.childSessionID)
        return yield* calls
          .interrupted(record.id, usage(child), {
            code: "unknown_outcome",
            message: "The child prompt was promoted without a terminal response; provider work will not be retried",
            outcomeUnknown: true,
          })
          .pipe(Effect.flatMap(persist))
      }
      return yield* resume(record, correction)
    })

    const state = yield* InstanceState.make(
      Effect.fn("ModelCallRecovery.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const workspaceID = yield* InstanceState.workspaceID
        const records = (yield* calls.recoverable("legacy")).filter(
          (record) =>
            record.location.directory === AbsolutePath.make(ctx.directory) &&
            record.location.workspaceID === workspaceID,
        )
        yield* Effect.forEach(
          records,
          (record) =>
            recover(record).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.gen(function* () {
                      const child = yield* sessions.get(record.childSessionID).pipe(Effect.option)
                      yield* calls
                        .failed(
                          record.id,
                          {
                            code: "recovery_failed",
                            message: Cause.pretty(cause),
                            outcomeUnknown: record.status === "running",
                          },
                          Option.isNone(child) ? undefined : { usage: usage(child.value) },
                        )
                        .pipe(Effect.flatMap(persist), Effect.ignore)
                    }),
              ),
              Effect.forkIn(scope, { startImmediately: true }),
            ),
          { discard: true },
        )
      }),
    )

    return Service.of({
      register: (services) =>
        Effect.sync(() => {
          calls = services.calls
          provider = services.provider
          prompts = services.prompts
          sessions = services.sessions
          registered = true
        }),
      init: () => (registered ? InstanceState.get(state).pipe(Effect.asVoid) : Effect.void),
      recover,
    })
  }),
)

function childPrompt(
  record: ModelCallV2.Info,
  nativeStructured: boolean,
  correction: boolean,
): SessionPrompt.PromptInput {
  const messageID = MessageID.ascending(correction ? record.correctionPromptID : record.childPromptID)
  return {
    messageID,
    sessionID: record.childSessionID,
    model: {
      providerID: record.actualModel.providerID,
      modelID: record.actualModel.id,
    },
    variant: record.actualModel.variant ?? "default",
    agent: record.agent,
    ...(record.system === undefined ? {} : { system: record.system }),
    ...(record.outputSchema === undefined || !nativeStructured
      ? {}
      : {
          format: {
            type: "json_schema" as const,
            schema: record.outputSchema,
            retryCount: 0,
          },
        }),
    parts: [
      {
        id: modelCallPartID(messageID),
        type: "text",
        text: correction
          ? ModelCallOrchestration.correctionPrompt(record.outputSchema!)
          : ModelCallOrchestration.initialPrompt({
              prompt: record.prompt,
              outputSchema: record.outputSchema,
              nativeStructured,
            }),
      },
    ],
  }
}

function isAssistantMessage(
  message: SessionV1.WithParts | undefined,
): message is SessionV1.WithParts & { info: SessionV1.Assistant } {
  return message?.info.role === "assistant"
}

function origin(record: ModelCallV2.Info): ModelCall.Origin {
  return {
    type: "model_call",
    callID: record.id,
    parentSessionID: record.parentSessionID,
    parentAssistantMessageID: SessionMessage.ID.make(record.parentAssistantMessageID),
    parentToolCallID: record.parentToolCallID,
    requestedModel: record.requestedModel,
    ...(record.outputSchema === undefined ? {} : { outputSchema: record.outputSchema }),
  }
}

function title(record: ModelCallV2.Info) {
  return `${record.actualModel.providerID}/${record.actualModel.id}: ${record.prompt.split(/\r?\n/)[0]?.slice(0, 80) ?? "Model call"}`
}

function usage(session: Session.Info): ModelCall.Usage {
  return {
    cost: session.cost ?? 0,
    tokens: session.tokens ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
}

function callError(error: NonNullable<SessionV1.Assistant["error"]>): ModelCall.Error {
  return {
    code: error.name,
    message:
      "message" in error.data && typeof error.data.message === "string" ? error.data.message : "Model call failed",
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [],
})

export * as ModelCallRecovery from "./recovery"
