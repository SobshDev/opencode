export * as ModelCallTool from "./model-call"

import { ModelCall } from "@opencode-ai/schema/model-call"
import { Cause, Effect, Layer, Scope } from "effect"
import { isDeepStrictEqual } from "node:util"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import { ModelCallV2 } from "../model-call"
import { ModelCallOrchestration } from "../model-call/orchestration"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import { SessionExecution } from "../session/execution"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionRunnerModel } from "../session/runner/model"
import { ApplicationTools } from "./application-tools"
import { Tool } from "./tool"

export const name = "model_call"

export const description = [
  "Delegate a prompt to an exact available model in a fresh child Session.",
  "The child inherits this Session's agent, system context, tools, permissions, step policy, Location, and live workspace.",
  "It does not receive this conversation's messages or summaries.",
  "Use models first to discover canonical providerID/model IDs and variants. Selection is exact and never falls back.",
  "Foreground calls wait for the child. Background calls return immediately and deliver one typed result to this Session later.",
].join("\n")

const toModelOutput = (output: typeof ModelCall.CallResult.Encoded) => JSON.stringify(output)
const unknownOutcome = {
  code: "unknown_outcome" as const,
  message: "The child prompt was in flight when execution was interrupted",
  outcomeUnknown: true,
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const calls = yield* ModelCallV2.Service
    const sessions = yield* SessionV2.Service
    const locations = yield* LocationServiceMap.Service
    const execution = yield* SessionExecution.Service
    const database = yield* Database.Service
    const db = database.db
    const scope = yield* Scope.Scope

    const resolveTarget = Effect.fn("ModelCallTool.resolveTarget")(function* (
      parent: SessionV2.Info,
      context: Tool.Context,
      requestedModel: ModelV2.Ref,
    ) {
      return yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const resolver = yield* SessionRunnerModel.Service
        const agents = yield* AgentV2.Service
        const agent = yield* agents.select(context.agent)
        const selected = (yield* catalog.model.available()).find(
          (model) =>
            model.providerID === requestedModel.providerID &&
            model.id === requestedModel.id &&
            model.capabilities.input.includes("text") &&
            model.capabilities.output.includes("text"),
        )
        if (!selected)
          return yield* new SessionRunnerModel.ModelUnavailableError({
            providerID: requestedModel.providerID,
            modelID: requestedModel.id,
          })
        yield* resolver.resolve({ ...parent, model: requestedModel }, agent.info)
        const variant =
          requestedModel.variant === undefined || requestedModel.variant === "default"
            ? selected.request.variant
            : requestedModel.variant
        return ModelV2.Ref.make({
          providerID: requestedModel.providerID,
          id: requestedModel.id,
          ...(variant === undefined ? {} : { variant: ModelV2.VariantID.make(variant) }),
        })
      }).pipe(Effect.provide(locations.get(context.location)))
    })

    const assertPermission = Effect.fn("ModelCallTool.assertPermission")(function* (
      input: ModelCall.CallInput,
      context: Tool.Context,
    ) {
      yield* PermissionV2.Service.pipe(
        Effect.flatMap((permission) =>
          permission.assert({
            action: name,
            resources: [`${input.model.providerID}/${input.model.id}`],
            save: [`${input.model.providerID}/${input.model.id}`],
            sessionID: context.sessionID,
            agent: context.agent,
            source: {
              type: "tool",
              messageID: context.assistantMessageID,
              callID: context.toolCallID,
            },
            metadata: {
              model: input.model,
              background: input.background ?? false,
            },
          }),
        ),
        Effect.provide(locations.get(context.location)),
      )
    })

    const prepare: (record: ModelCallV2.Info) => Effect.Effect<ModelCallV2.Info, unknown> = Effect.fn(
      "ModelCallTool.prepare",
    )(function* (record) {
      if (ModelCallV2.isTerminal(record.status)) return record
      if (record.slot === undefined) {
        const reserved = yield* calls.reserve({
          parentSessionID: record.parentSessionID,
          parentAssistantMessageID: record.parentAssistantMessageID,
          parentToolCallID: record.parentToolCallID,
          agent: record.agent,
          requestedModel: record.requestedModel,
          actualModel: record.actualModel,
          location: record.location,
          permission: record.permission,
          prompt: record.prompt,
          ...(record.outputSchema === undefined ? {} : { outputSchema: record.outputSchema }),
          runtime: record.runtime,
          background: record.requestedBackground,
        })
        if (reserved.slot === undefined && !ModelCallV2.isTerminal(reserved.status))
          return yield* calls.failed(reserved.id, {
            code: "preparation_conflict",
            message: "The model call could not reserve a direct-child slot",
          })
        return yield* prepare(reserved)
      }
      if (record.permission.version !== "v2")
        return yield* calls.failed(record.id, {
          code: "preparation_conflict",
          message: "The reserved model call does not contain a V2 permission snapshot",
        })
      const expectedOrigin = {
        type: "model_call" as const,
        callID: record.id,
        parentSessionID: record.parentSessionID,
        parentAssistantMessageID: record.parentAssistantMessageID,
        parentToolCallID: record.parentToolCallID,
        requestedModel: record.requestedModel,
        ...(record.outputSchema === undefined ? {} : { outputSchema: record.outputSchema }),
      }
      const existing = yield* sessions.get(record.childSessionID).pipe(
        Effect.map((session) => session as SessionV2.Info | undefined),
        Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
      )
      const child =
        existing ??
        (yield* sessions.create({
          id: record.childSessionID,
          parentID: record.parentSessionID,
          title: `Model call · ${record.actualModel.providerID}/${record.actualModel.id}`,
          origin: expectedOrigin,
          agent: record.agent,
          model: record.actualModel,
          location: record.location,
          permission: record.permission.rules,
        }))
      if (
        child.parentID !== record.parentSessionID ||
        child.agent !== record.agent ||
        child.location.directory !== record.location.directory ||
        child.location.workspaceID !== record.location.workspaceID ||
        !isDeepStrictEqual(child.origin, expectedOrigin) ||
        !isDeepStrictEqual(child.permission ?? [], record.permission.rules) ||
        child.model?.providerID !== record.actualModel.providerID ||
        child.model.id !== record.actualModel.id ||
        (child.model.variant ?? "default") !== (record.actualModel.variant ?? "default")
      )
        return yield* calls.failed(record.id, {
          code: "preparation_conflict",
          message: "The reserved child Session exists with conflicting immutable lineage or model settings",
        })
      yield* sessions.prompt({
        id: record.childPromptID,
        sessionID: record.childSessionID,
        prompt: {
          // The runner requests responseFormat too, but not every protocol lowers it to a native JSON mode.
          text: ModelCallOrchestration.initialPrompt({
            prompt: record.prompt,
            outputSchema: record.outputSchema,
          }),
        },
        delivery: "queue",
        resume: false,
      })
      if (record.validationAttempts > 0)
        yield* sessions.prompt({
          id: record.correctionPromptID,
          sessionID: record.childSessionID,
          prompt: { text: ModelCallOrchestration.correctionPrompt(record.outputSchema!) },
          delivery: "queue",
          resume: false,
        })
      return yield* calls.queued(record.id)
    })

    const assistantFor = Effect.fn("ModelCallTool.assistantFor")(function* (
      record: ModelCallV2.Info,
      promptID: SessionMessage.ID,
    ) {
      const messages = yield* sessions.messages({ sessionID: record.childSessionID, order: "asc" })
      const promptIndex = messages.findIndex((message) => message.type === "user" && message.id === promptID)
      const assistant =
        promptIndex < 0
          ? undefined
          : messages
              .slice(promptIndex + 1)
              .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
              .at(-1)
      if (!assistant)
        return {
          observation: {
            exists: false,
            completed: false,
            error: false,
          } satisfies ModelCallOrchestration.AssistantTurnObservation,
        }
      return {
        observation: {
          exists: true,
          completed: assistant.time.completed !== undefined,
          error: assistant.error !== undefined,
          finish: assistant.finish,
          continuation: assistant.content.some((part) => part.type === "tool" && part.provider?.executed !== true),
          continuationFinishes: ["tool-calls"],
        } satisfies ModelCallOrchestration.AssistantTurnObservation,
        message: assistant,
      }
    })

    const activePromptID = (record: ModelCallV2.Info) =>
      record.validationAttempts > 0 ? record.correctionPromptID : record.childPromptID

    const deliver = Effect.fn("ModelCallTool.deliver")(function* (record: ModelCallV2.Info) {
      if (!record.background || !ModelCallV2.isTerminal(record.status) || record.deliveredAt !== undefined)
        return record
      const finish = () =>
        calls.delivered(record.id).pipe(Effect.catchTag("ModelCall.NotFoundError", () => Effect.succeed(record)))
      const output = ModelCallV2.result(record)
      const text = [
        `Model call ${record.id} (${record.actualModel.providerID}/${record.actualModel.id}) ${record.status}.`,
        toModelOutput(output),
      ].join("\n")
      const admitted = yield* sessions
        .internal({
          id: record.completionMessageID,
          sessionID: record.parentSessionID,
          prompt: Prompt.make({
            text,
            internal: { type: "model-call-result", result: output },
          }),
          delivery: "steer",
          resume: false,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
        )
      if (!admitted) return yield* finish()
      const wakeUntilPromoted = (): Effect.Effect<ModelCallV2.Info> =>
        Effect.gen(function* () {
          const parentExists = yield* sessions.get(record.parentSessionID).pipe(
            Effect.as(true),
            Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
          )
          if (!parentExists) return yield* finish()
          const admitted = yield* SessionInput.find(db, record.completionMessageID)
          if (admitted?.promotedSeq !== undefined) return yield* finish()
          yield* execution.wake(record.parentSessionID)
          const promoted = yield* SessionInput.find(db, record.completionMessageID)
          if (promoted?.promotedSeq !== undefined) return yield* finish()
          yield* Effect.sleep("100 millis")
          return yield* wakeUntilPromoted()
        })
      return yield* wakeUntilPromoted()
    })

    const fail = Effect.fn("ModelCallTool.fail")(function* (
      record: ModelCallV2.Info,
      error: ModelCall.Error,
      text?: string,
    ) {
      const child = yield* sessions.get(record.childSessionID).pipe(
        Effect.map((session) => session as SessionV2.Info | undefined),
        Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
      )
      return yield* calls.failed(record.id, error, {
        ...(text === undefined ? {} : { text }),
        ...(child === undefined
          ? {}
          : {
              usage: {
                cost: child.cost,
                tokens: child.tokens,
              },
            }),
      })
    })

    const usageFor = Effect.fn("ModelCallTool.usageFor")(function* (record: ModelCallV2.Info) {
      const child = yield* sessions.get(record.childSessionID).pipe(
        Effect.map((session) => session as SessionV2.Info | undefined),
        Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
      )
      if (!child) return
      return {
        cost: child.cost,
        tokens: child.tokens,
      }
    })

    const settle = (record: ModelCallV2.Info): Effect.Effect<ModelCallV2.Info, unknown> =>
      Effect.gen(function* () {
        const current = yield* calls.get(record.id)
        if (ModelCallV2.isTerminal(current.status)) return yield* deliver(current)
        const assistant = yield* assistantFor(current, activePromptID(current))
        if (ModelCallOrchestration.classifyAssistantTurn(assistant.observation) !== "terminal" || !assistant.message)
          return yield* calls
            .interrupted(current.id, yield* usageFor(current), unknownOutcome)
            .pipe(Effect.flatMap(deliver))
        const terminal = assistant.message
        const text = terminal.content
          .filter((part): part is SessionMessage.AssistantText => part.type === "text")
          .map((part) => part.text)
          .join("")
        const provenance = ModelCallOrchestration.compareProvenance(current.actualModel, terminal.model)
        if (!provenance.matches) return yield* fail(current, provenance.error, text).pipe(Effect.flatMap(deliver))
        if (terminal.error)
          return yield* fail(
            current,
            {
              code: "child_failed",
              message: terminal.error.message,
            },
            text,
          ).pipe(Effect.flatMap(deliver))
        const structured = ModelCallOrchestration.validateStructured(current.outputSchema, text)
        if (structured.error && current.outputSchema && current.validationAttempts === 0) {
          const correcting = yield* calls.requestCorrection(current.id, structured.error)
          yield* sessions.prompt({
            id: correcting.correctionPromptID,
            sessionID: correcting.childSessionID,
            prompt: { text: ModelCallOrchestration.correctionPrompt(correcting.outputSchema!) },
            delivery: "queue",
            resume: false,
          })
          yield* sessions.resume(correcting.childSessionID)
          return yield* settle(correcting)
        }
        if (structured.error)
          return yield* fail(
            current,
            {
              code: structured.code ?? "structured_output_invalid",
              message: structured.error,
            },
            structured.code === "structured_output_too_large" ? undefined : text,
          ).pipe(Effect.flatMap(deliver))
        const child = yield* sessions.get(current.childSessionID)
        return yield* calls
          .completed(current.id, {
            text,
            ...(structured.structured === undefined ? {} : { structured: structured.structured }),
            usage: {
              cost: child.cost,
              tokens: child.tokens,
            },
          })
          .pipe(Effect.flatMap(deliver))
      }).pipe(Effect.withSpan("ModelCallTool.settle"))

    const work = Effect.fn("ModelCallTool.work")(function* (record: ModelCallV2.Info) {
      const prepared = yield* prepare(record)
      if (ModelCallV2.isTerminal(prepared.status)) return yield* deliver(prepared)
      const started = yield* calls.started(prepared.id)
      yield* sessions.resume(started.childSessionID)
      return yield* settle(started)
    })

    const run = (record: ModelCallV2.Info) =>
      work(record).pipe(
        Effect.catch((error) =>
          fail(record, {
            code: "execution_failed",
            message: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.flatMap(deliver), Effect.orDie),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? calls
                .find(record.id)
                .pipe(
                  Effect.flatMap((current) =>
                    current && ModelCallV2.isTerminal(current.status) ? deliver(current) : Effect.failCause(cause),
                  ),
                )
            : fail(record, {
                code: "execution_failed",
                message: Cause.pretty(cause),
              }).pipe(Effect.flatMap(deliver), Effect.orDie),
        ),
      )

    const awaitForeground = (callID: ModelCall.CallID): Effect.Effect<ModelCallV2.Info, ModelCallV2.NotFoundError> =>
      calls
        .get(callID)
        .pipe(
          Effect.flatMap((record) =>
            ModelCallV2.isTerminal(record.status) || record.background
              ? Effect.succeed(record)
              : Effect.sleep("50 millis").pipe(Effect.andThen(awaitForeground(callID))),
          ),
        )

    const recover = Effect.fn("ModelCallTool.recover")(function* (record: ModelCallV2.Info) {
      const initial = ModelCallOrchestration.decideRecovery({
        stage: "record",
        status: record.status,
        slotReserved: record.slot !== undefined,
      })
      if (initial.action === "deliver") return yield* deliver(record)
      const prepared = yield* prepare(record)
      const afterPreparation = ModelCallOrchestration.decideRecovery({
        stage: "record",
        status: prepared.status,
        slotReserved: prepared.slot !== undefined,
      })
      if (afterPreparation.action === "deliver") return yield* deliver(prepared)
      const promptID = activePromptID(prepared)
      const assistant = yield* assistantFor(prepared, promptID)
      const admitted = yield* SessionInput.find(db, promptID)
      const decision = ModelCallOrchestration.decideRecovery(
        ModelCallOrchestration.observeChildLifecycle({
          status: prepared.status,
          assistant: assistant.observation,
          prompt: {
            exists: admitted !== undefined,
            promoted: admitted?.promotedSeq !== undefined,
          },
        }),
      )
      if (decision.action === "settle") {
        if (!assistant.message) return yield* Effect.die("Recovery selected settlement without an assistant response")
        return yield* settle(prepared)
      }
      if (decision.action === "interrupt")
        return yield* calls
          .interrupted(prepared.id, yield* usageFor(prepared), unknownOutcome)
          .pipe(Effect.flatMap(deliver))
      return yield* run(prepared)
    })

    yield* applications
      .register({
        [name]: Tool.make({
          description,
          input: ModelCall.CallInput,
          output: ModelCall.CallResult,
          outputPolicy: "preserve",
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const outputSchema = input.output_schema
              if (outputSchema) {
                const validation = ModelCallOrchestration.validateOutputSchema(outputSchema)
                if (!validation.valid) return yield* new Tool.Failure({ message: validation.error })
              }
              const parent = yield* sessions.get(context.sessionID)
              const actualModel = yield* resolveTarget(parent, context, input.model)
              yield* assertPermission(input, context)
              const reserved = yield* calls.reserve({
                parentSessionID: context.sessionID,
                parentAssistantMessageID: context.assistantMessageID,
                parentToolCallID: context.toolCallID,
                agent: context.agent,
                requestedModel: input.model,
                actualModel,
                location: context.location,
                permission: {
                  version: "v2",
                  rules: parent.permission ?? [],
                },
                prompt: input.prompt,
                ...(input.output_schema === undefined ? {} : { outputSchema: input.output_schema }),
                runtime: "v2",
                background: input.background ?? false,
              })
              if (ModelCallV2.isTerminal(reserved.status))
                return ModelCallV2.result(reserved.background ? yield* deliver(reserved) : reserved)
              const prepared = yield* prepare(reserved)
              if (ModelCallV2.isTerminal(prepared.status))
                return ModelCallV2.result(prepared.background ? yield* deliver(prepared) : prepared)
              const started = yield* calls.started(prepared.id)
              yield* run(started).pipe(Effect.forkIn(scope, { startImmediately: true }))
              if (started.background) return ModelCallV2.result(started)
              const completed = yield* awaitForeground(started.id).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    const current = yield* calls
                      .cancelled(started.id, {
                        foregroundOnly: true,
                        usage: yield* usageFor(started),
                      })
                      .pipe(Effect.orDie)
                    if (current.status === "cancelled") yield* sessions.interrupt(current.childSessionID)
                  }),
                ),
              )
              return ModelCallV2.result(completed)
            }).pipe(
              Effect.mapError((error) =>
                error instanceof Tool.Failure
                  ? error
                  : new Tool.Failure({
                      message: error instanceof Error ? error.message : String(error),
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)

    yield* Effect.forEach(
      yield* calls.recoverable("v2"),
      (record) =>
        (record.background ? recover(record) : calls.detach(record.id).pipe(Effect.flatMap(recover))).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        ),
      { discard: true },
    )
  }),
)

export const node = makeGlobalNode({
  name: "tool/model-call",
  layer,
  deps: [
    ApplicationTools.node,
    ModelCallV2.node,
    SessionV2.node,
    SessionExecution.node,
    LocationServiceMap.node,
    Database.node,
  ],
})
