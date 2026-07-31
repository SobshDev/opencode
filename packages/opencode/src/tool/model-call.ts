import { ModelCallV2 } from "@opencode-ai/core/model-call"
import { ModelCallOrchestration } from "@opencode-ai/core/model-call/orchestration"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@opencode-ai/schema/agent"
import { ModelCall } from "@opencode-ai/schema/model-call"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { isDeepStrictEqual } from "node:util"
import { Cause, Effect, Exit, Option, Scope } from "effect"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import type { SessionPrompt } from "@/session/prompt"
import { Tool } from "./tool"

export interface ModelCallPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
  admit(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
  admitExact(input: SessionPrompt.PromptInput): Effect.Effect<{
    message: SessionV1.WithParts
    claimed: boolean
  }>
  releaseExact(input: { sessionID: SessionID; messageID: MessageID }): Effect.Effect<void>
  consumed(input: { sessionID: SessionID; messageID: MessageID }): Effect.Effect<boolean>
  wake(sessionID: SessionID): Effect.Effect<SessionV1.WithParts>
}

type Prepared = {
  record: ModelCallV2.Info
  callID: ModelCall.CallID
  childSessionID: SessionID
  parentSessionID: SessionID
  requestedModel: ModelCall.CallInput["model"]
  mode: ModelCall.Mode
  agent: string
  origin: ModelCall.Origin
  input: ModelCall.CallInput
  title: string
  nativeStructured: boolean
}

export const Parameters = ModelCall.CallInput
export const MAX_STRUCTURED_BYTES = ModelCallOrchestration.MAX_STRUCTURED_BYTES

export const ModelCallTool = Tool.define(
  "model_call",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const calls = yield* ModelCallV2.Service
    const scope = yield* Scope.Scope

    const prepare = Effect.fn("ModelCallTool.prepare")(function* (input: ModelCall.CallInput, ctx: Tool.Context) {
      if (!ctx.callID) {
        return yield* Effect.fail(new Error("model_call requires a provider tool-call ID"))
      }
      const title = callTitle(input)
      yield* ctx.ask({
        permission: "model_call",
        patterns: [`${input.model.providerID}/${input.model.id}`],
        always: [`${input.model.providerID}/${input.model.id}`],
        metadata: {
          model: input.model,
          background: input.background === true,
          title,
        },
      })
      const model = yield* provider.getModel(input.model.providerID, input.model.id)
      yield* provider.getLanguage(model)
      if (
        input.model.variant !== undefined &&
        input.model.variant !== "default" &&
        !Object.hasOwn(model.variants ?? {}, input.model.variant)
      ) {
        return yield* Effect.fail(
          new Error(`Model variant not found: ${input.model.providerID}/${input.model.id}/${input.model.variant}`),
        )
      }
      if (!model.capabilities.input.text || !model.capabilities.output.text) {
        return yield* Effect.fail(new Error(`Model is not text-callable: ${input.model.providerID}/${input.model.id}`))
      }
      if (input.output_schema !== undefined) {
        const validation = ModelCallOrchestration.validateOutputSchema(input.output_schema)
        if (!validation.valid) return yield* Effect.fail(new Error(validation.error))
      }

      const parent = yield* sessions.get(ctx.sessionID)
      const caller = ctx.messages.findLast((message) => message.info.role === "user")
      const system = caller?.info.role === "user" ? caller.info.system : undefined
      const mode = input.background === true ? "background" : "foreground"
      const reserved = yield* calls.reserve({
        parentSessionID: ctx.sessionID,
        parentAssistantMessageID: SessionMessage.ID.make(ctx.messageID),
        parentToolCallID: ctx.callID,
        agent: Agent.ID.make(ctx.agent),
        requestedModel: input.model,
        actualModel: normalizeActualModel(input.model),
        location: ctx.location,
        permission: {
          version: "legacy",
          rules: structuredClone(parent.permission ?? []),
        },
        prompt: input.prompt,
        ...(system === undefined ? {} : { system }),
        ...(input.output_schema === undefined ? {} : { outputSchema: input.output_schema }),
        runtime: "legacy",
        background: input.background === true,
      })
      const origin: ModelCall.Origin = {
        type: "model_call",
        callID: reserved.id,
        parentSessionID: ctx.sessionID,
        parentAssistantMessageID: SessionMessage.ID.make(ctx.messageID),
        parentToolCallID: reserved.parentToolCallID,
        requestedModel: input.model,
        ...(input.output_schema === undefined ? {} : { outputSchema: input.output_schema }),
      }
      const existing = Option.getOrUndefined(yield* sessions.get(reserved.childSessionID).pipe(Effect.option))
      if (!ModelCallV2.isTerminal(reserved.status) && reserved.slot === undefined) {
        return yield* Effect.die(new Error("Model call did not reserve a direct-child slot"))
      }
      const child =
        ModelCallV2.isTerminal(reserved.status) || existing
          ? existing
          : yield* Effect.gen(function* () {
              const created = yield* sessions
                .create({
                  id: reserved.childSessionID,
                  parentID: ctx.sessionID,
                  title,
                  agent: ctx.agent,
                  model: reserved.actualModel,
                  origin,
                  metadata: {
                    modelCall: {
                      ...origin,
                      actualModel: reserved.actualModel,
                      mode,
                      status: reserved.status,
                    },
                  },
                  permission:
                    reserved.permission.version === "legacy" ? structuredClone(reserved.permission.rules) : undefined,
                  workspaceID: reserved.location.workspaceID,
                })
                .pipe(Effect.exit)
              if (Exit.isSuccess(created)) return created.value
              const winner = yield* sessions.get(reserved.childSessionID).pipe(Effect.option)
              if (Option.isSome(winner)) return winner.value
              yield* (
                Cause.hasInterrupts(created.cause)
                  ? calls.interrupted(reserved.id)
                  : calls.failed(reserved.id, executionError(created.cause))
              ).pipe(Effect.ignore)
              return yield* Effect.failCause(created.cause)
            })
      const record =
        child &&
        !ModelCallV2.isTerminal(reserved.status) &&
        (child.parentID !== ctx.sessionID ||
          child.agent !== ctx.agent ||
          child.directory !== reserved.location.directory ||
          child.workspaceID !== reserved.location.workspaceID ||
          !isDeepStrictEqual(child.origin, origin) ||
          child.model?.providerID !== reserved.actualModel.providerID ||
          child.model.id !== reserved.actualModel.id ||
          ModelCallOrchestration.normalizeVariant(child.model.variant) !==
            ModelCallOrchestration.normalizeVariant(reserved.actualModel.variant) ||
          reserved.permission.version !== "legacy" ||
          !isDeepStrictEqual(child.permission ?? [], reserved.permission.rules))
          ? yield* calls.failed(reserved.id, {
              code: "preparation_conflict",
              message: "The reserved child Session exists with conflicting immutable invocation settings",
            })
          : reserved
      const prepared: Prepared = {
        record,
        callID: record.id,
        childSessionID: record.childSessionID,
        parentSessionID: ctx.sessionID,
        requestedModel: input.model,
        mode,
        agent: ctx.agent,
        origin,
        input,
        title,
        nativeStructured: model.capabilities.toolcall,
      }
      yield* ctx.metadata({
        title,
        metadata: toolMetadata(ModelCallV2.result(record)),
      })
      return prepared
    })

    const executeTurn = Effect.fn("ModelCallTool.executeTurn")(function* (
      prepared: Prepared,
      ops: ModelCallPromptOps,
      correction: boolean,
    ) {
      if (correction) yield* ops.admit(modelCallPromptInput(prepared, true))
      const response = yield* ops.wake(prepared.childSessionID)
      if (response.info.role !== "assistant") {
        return yield* Effect.fail(new Error("Model call did not produce an assistant response"))
      }

      const actualModel = {
        providerID: response.info.providerID,
        id: response.info.modelID,
        ...(response.info.variant === undefined || response.info.variant === "default"
          ? {}
          : { variant: ModelV2.VariantID.make(response.info.variant) }),
      }
      const text = response.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
      const child = yield* sessions.get(prepared.childSessionID)
      const provenance = ModelCallOrchestration.compareProvenance(prepared.record.actualModel, actualModel)
      const result: ModelCall.CallResult = {
        callID: prepared.callID,
        parentSessionID: prepared.parentSessionID,
        childSessionID: prepared.childSessionID,
        requestedModel: prepared.requestedModel,
        actualModel,
        mode: prepared.mode,
        status: !provenance.matches
          ? "failed"
          : response.info.error?.name === "MessageAbortedError"
            ? "cancelled"
            : response.info.error === undefined
              ? "completed"
              : "failed",
        text,
        ...(response.info.structured === undefined ? {} : { structured: response.info.structured }),
        ...(!provenance.matches
          ? {
              error: provenance.error,
            }
          : response.info.error === undefined
            ? {}
            : { error: callError(response.info.error) }),
        usage: {
          cost: child.cost ?? 0,
          tokens: child.tokens ?? {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      }
      return result
    })

    const execute = Effect.fn("ModelCallTool.executeChild")(function* (prepared: Prepared, ops: ModelCallPromptOps) {
      const first = yield* executeTurn(prepared, ops, false)
      if (prepared.input.output_schema === undefined) return first
      if (first.error && first.error.code !== "StructuredOutputError") return first

      const firstValidation = ModelCallOrchestration.validateStructured(
        prepared.input.output_schema,
        first.structured === undefined ? (first.text ?? "") : first.structured,
      )
      if (!firstValidation.error) {
        return {
          ...first,
          status: "completed" as const,
          structured: firstValidation.structured,
          error: undefined,
        }
      }

      yield* calls.requestCorrection(prepared.callID, firstValidation.error)
      const second = yield* executeTurn(prepared, ops, true)
      if (second.error && second.error.code !== "StructuredOutputError") {
        return second
      }
      const secondValidation = ModelCallOrchestration.validateStructured(
        prepared.input.output_schema,
        second.structured === undefined ? (second.text ?? "") : second.structured,
      )
      if (secondValidation.error) {
        return {
          ...second,
          status: "failed" as const,
          text: secondValidation.code === "structured_output_too_large" ? undefined : second.text,
          structured: undefined,
          error: {
            code: secondValidation.code ?? "structured_output_invalid",
            message: secondValidation.error,
          },
        }
      }
      return {
        ...second,
        status: "completed" as const,
        structured: secondValidation.structured,
        error: undefined,
      }
    })

    const transition = Effect.fn("ModelCallTool.transition")(function* (result: ModelCall.CallResult) {
      if (result.status === "completed") {
        return yield* calls.completed(result.callID, {
          text: result.text ?? "",
          ...(result.structured === undefined ? {} : { structured: result.structured }),
          usage: result.usage ?? {
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        })
      }
      if (result.status === "failed") {
        return yield* calls.failed(
          result.callID,
          result.error ?? {
            code: "MODEL_CALL_FAILED",
            message: "Model call failed",
          },
          {
            ...(result.text === undefined ? {} : { text: result.text }),
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          },
        )
      }
      if (result.status === "cancelled") {
        return yield* calls.cancelled(result.callID, result.usage === undefined ? undefined : { usage: result.usage })
      }
      if (result.status === "interrupted") {
        return yield* calls.interrupted(result.callID, result.usage, result.error)
      }
      return yield* calls.get(result.callID)
    })

    const persist = Effect.fn("ModelCallTool.persist")(function* (prepared: Prepared, result: ModelCall.CallResult) {
      const record = yield* transition(result)
      const output =
        record.status === result.status
          ? {
              ...result,
              mode: record.background ? ("background" as const) : ("foreground" as const),
              ...(record.error === undefined ? {} : { error: record.error }),
            }
          : ModelCallV2.result(record)
      yield* sessions.setMetadata({
        sessionID: prepared.childSessionID,
        metadata: {
          modelCall: {
            ...prepared.origin,
            ...output,
          },
        },
      })
      return output
    })

    const inject = Effect.fn("ModelCallTool.inject")(function* (
      prepared: Prepared,
      result: ModelCall.CallResult,
      ctx: Tool.Context,
      ops: ModelCallPromptOps,
    ) {
      const parent = yield* sessions.get(prepared.parentSessionID).pipe(Effect.option)
      if (Option.isNone(parent)) {
        yield* calls.delivered(prepared.callID).pipe(
          Effect.catchTag("ModelCall.NotFoundError", () => Effect.void),
          Effect.asVoid,
        )
        return
      }
      yield* ctx.metadata({
        title: prepared.title,
        metadata: toolMetadata(result),
      })
      const admission = yield* ops.admitExact({
        messageID: MessageID.ascending(prepared.record.completionMessageID),
        sessionID: prepared.parentSessionID,
        agent: parent.value.agent ?? prepared.agent,
        ...(parent.value.model === undefined
          ? {}
          : {
              model: {
                providerID: parent.value.model.providerID,
                modelID: parent.value.model.id,
              },
              variant: parent.value.model.variant,
            }),
        parts: [
          {
            id: modelCallPartID(MessageID.ascending(prepared.record.completionMessageID)),
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
      if (!admission.claimed) return
      const completion = {
        sessionID: prepared.parentSessionID,
        messageID: MessageID.ascending(prepared.record.completionMessageID),
      }
      const wakeUntilConsumed: () => Effect.Effect<void> = Effect.fn("ModelCallTool.wakeUntilConsumed")(function* () {
        if (yield* ops.consumed(completion)) return
        yield* ops.wake(prepared.parentSessionID)
        if (yield* ops.consumed(completion)) return
        yield* Effect.sleep("25 millis")
        return yield* wakeUntilConsumed()
      })
      yield* wakeUntilConsumed().pipe(
        Effect.andThen(calls.delivered(prepared.callID)),
        Effect.tap(() =>
          ops.releaseExact({
            sessionID: completion.sessionID,
            messageID: completion.messageID,
          }),
        ),
        Effect.onError(() =>
          ops.releaseExact({
            sessionID: completion.sessionID,
            messageID: completion.messageID,
          }),
        ),
      )
    })

    const run = Effect.fn("ModelCallTool.run")(function* (input: ModelCall.CallInput, ctx: Tool.Context) {
      const prepared = yield* prepare(input, ctx)
      const ops = ctx.extra?.promptOps as ModelCallPromptOps | undefined
      if (!ops) {
        yield* calls.failed(prepared.callID, {
          code: "MODEL_CALL_ORCHESTRATION_FAILED",
          message: "ModelCallTool requires promptOps in ctx.extra",
        })
        return yield* Effect.fail(new Error("ModelCallTool requires promptOps in ctx.extra"))
      }

      if (ModelCallV2.isTerminal(prepared.record.status)) {
        const result = ModelCallV2.result(prepared.record)
        if (prepared.record.background && prepared.record.deliveredAt === undefined) {
          yield* inject(prepared, result, ctx, ops)
        }
        const output = ModelCallV2.result(yield* calls.get(prepared.callID))
        return {
          title: prepared.title,
          metadata: toolMetadata(output),
          output: JSON.stringify(output),
        }
      }

      const admission =
        prepared.record.status === "preparing" || prepared.record.status === "queued"
          ? yield* ops.admitExact(modelCallPromptInput(prepared, false))
          : undefined
      const queued = prepared.record.status === "preparing" ? yield* calls.queued(prepared.callID) : prepared.record
      const shouldLaunch = queued.status === "queued" && admission?.claimed !== false
      const running = shouldLaunch ? yield* calls.started(prepared.callID) : queued
      const current = { ...prepared, record: running }
      if (ModelCallV2.isTerminal(running.status)) {
        if (running.status === "cancelled" || running.status === "interrupted") {
          yield* ops.cancel(running.childSessionID)
        }
        if (admission?.claimed) {
          yield* ops.releaseExact({
            sessionID: running.childSessionID,
            messageID: MessageID.ascending(running.childPromptID),
          })
        }
        const result = ModelCallV2.result(running)
        if (running.background && running.deliveredAt === undefined) yield* inject(current, result, ctx, ops)
        const output = ModelCallV2.result(yield* calls.get(running.id))
        return {
          title: prepared.title,
          metadata: toolMetadata(output),
          output: JSON.stringify(output),
        }
      }
      if (shouldLaunch && running.status === "running") {
        const externalTerminal = (): Effect.Effect<ModelCall.CallResult, ModelCallV2.NotFoundError> =>
          calls
            .get(prepared.callID)
            .pipe(
              Effect.flatMap((record) =>
                ModelCallV2.isTerminal(record.status)
                  ? (record.status === "cancelled" || record.status === "interrupted"
                      ? ops.cancel(record.childSessionID)
                      : Effect.void
                    ).pipe(Effect.as(ModelCallV2.result(record)))
                  : Effect.sleep("25 millis").pipe(Effect.andThen(externalTerminal())),
              ),
            )
        const worker = Effect.raceFirst(execute(current, ops), externalTerminal()).pipe(
          Effect.matchCauseEffect({
            onSuccess: (result) => persist(current, result),
            onFailure: (cause) =>
              Effect.gen(function* () {
                const result = failedResult(current, cause)
                const child = yield* sessions.get(current.childSessionID).pipe(Effect.option)
                return yield* persist(current, {
                  ...result,
                  ...(Option.isNone(child)
                    ? {}
                    : {
                        usage: {
                          cost: child.value.cost ?? 0,
                          tokens: child.value.tokens ?? {
                            input: 0,
                            output: 0,
                            reasoning: 0,
                            cache: { read: 0, write: 0 },
                          },
                        },
                      }),
                })
              }),
          }),
          Effect.tap(() =>
            Effect.all(
              [current.record.childPromptID, current.record.correctionPromptID].map((messageID) =>
                ops.releaseExact({
                  sessionID: current.childSessionID,
                  messageID: MessageID.ascending(messageID),
                }),
              ),
              { discard: true },
            ),
          ),
          Effect.flatMap((result) => (result.mode === "background" ? inject(current, result, ctx, ops) : Effect.void)),
        )
        yield* worker.pipe(Effect.forkIn(scope, { startImmediately: true }))
      }

      if (running.background) {
        const result = ModelCallV2.result(running)
        return {
          title: prepared.title,
          metadata: toolMetadata(result),
          output: JSON.stringify(result),
        }
      }

      const awaitResult = (): Effect.Effect<ModelCallV2.Info, ModelCallV2.NotFoundError> =>
        calls
          .get(prepared.callID)
          .pipe(
            Effect.flatMap((record) =>
              record.background || ModelCallV2.isTerminal(record.status)
                ? Effect.succeed(record)
                : Effect.sleep("25 millis").pipe(Effect.andThen(awaitResult())),
            ),
          )
      const abort = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) {
          resume(Effect.void)
          return
        }
        const handler = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })
      const record = yield* Effect.raceFirst(
        awaitResult(),
        abort.pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const latest = yield* calls.get(prepared.callID)
              if (latest.background || ModelCallV2.isTerminal(latest.status)) return latest
              const child = yield* sessions.get(prepared.childSessionID)
              const cancelled = yield* calls.cancelled(prepared.callID, {
                foregroundOnly: true,
                usage: sessionUsage(child),
              })
              if (cancelled.status !== "cancelled") return cancelled
              yield* ops.cancel(prepared.childSessionID)
              return yield* Effect.interrupt
            }),
          ),
        ),
      ).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const latest = yield* calls.get(prepared.callID).pipe(Effect.orDie)
            if (latest.background || ModelCallV2.isTerminal(latest.status)) return
            const child = yield* sessions.get(prepared.childSessionID).pipe(Effect.orDie)
            const cancelled = yield* calls
              .cancelled(prepared.callID, {
                foregroundOnly: true,
                usage: sessionUsage(child),
              })
              .pipe(Effect.orDie)
            if (cancelled.status !== "cancelled") return
            yield* ops.cancel(prepared.childSessionID)
          }),
        ),
      )
      if (record.status === "cancelled" || record.status === "interrupted") {
        yield* ops.cancel(record.childSessionID)
      }
      const output = ModelCallV2.result(record)
      yield* ctx.metadata({
        title: prepared.title,
        metadata: toolMetadata(output),
      })
      return {
        title: prepared.title,
        metadata: toolMetadata(output),
        output: JSON.stringify(output),
      }
    })

    return {
      description: [
        "Call another available model in a fresh child session using exactly the supplied prompt.",
        "Use models to discover available provider, model, and variant references.",
        "Foreground waits for the child result. Set background=true to continue immediately and receive a synthetic completion message later.",
        "The result is JSON and includes both requested and actual model provenance.",
      ].join("\n"),
      parameters: Parameters,
      execute: (input: ModelCall.CallInput, ctx: Tool.Context) => run(input, ctx).pipe(Effect.orDie),
    }
  }),
)

function callTitle(input: ModelCall.CallInput) {
  const first = input.prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const variant = input.model.variant === undefined ? "" : ` (${input.model.variant})`
  return `${input.model.providerID}/${input.model.id}${variant}: ${(first ?? "Model call").slice(0, 80)}`
}

function normalizeActualModel(model: ModelCall.CallInput["model"]) {
  const variant = ModelCallOrchestration.normalizeVariant(model.variant)
  return {
    providerID: model.providerID,
    id: model.id,
    ...(variant === undefined ? {} : { variant: ModelV2.VariantID.make(variant) }),
  }
}

function modelCallPromptInput(prepared: Prepared, correction: boolean): SessionPrompt.PromptInput {
  const messageID = MessageID.ascending(correction ? prepared.record.correctionPromptID : prepared.record.childPromptID)
  return {
    messageID,
    sessionID: prepared.childSessionID,
    model: {
      providerID: prepared.requestedModel.providerID,
      modelID: prepared.requestedModel.id,
    },
    variant: prepared.requestedModel.variant ?? "default",
    agent: prepared.agent,
    ...(prepared.record.system === undefined ? {} : { system: prepared.record.system }),
    ...(prepared.input.output_schema === undefined || !prepared.nativeStructured
      ? {}
      : {
          format: {
            type: "json_schema" as const,
            schema: prepared.input.output_schema,
            retryCount: 0,
          },
        }),
    parts: [
      {
        id: modelCallPartID(messageID),
        type: "text",
        text: correction
          ? ModelCallOrchestration.correctionPrompt(prepared.input.output_schema!)
          : ModelCallOrchestration.initialPrompt({
              prompt: prepared.input.prompt,
              outputSchema: prepared.input.output_schema,
              nativeStructured: prepared.nativeStructured,
            }),
      },
    ],
  }
}

export function modelCallPartID(messageID: MessageID) {
  return PartID.ascending(`prt_${messageID.slice("msg_".length)}`)
}

function callError(error: NonNullable<SessionV1.Assistant["error"]>): ModelCall.Error {
  return {
    code: error.name,
    message:
      "message" in error.data && typeof error.data.message === "string" ? error.data.message : "Model call failed",
  }
}

function failedResult(prepared: Prepared, cause: Cause.Cause<unknown>): ModelCall.CallResult {
  const interrupted = Cause.hasInterrupts(cause)
  return {
    callID: prepared.callID,
    parentSessionID: prepared.parentSessionID,
    childSessionID: prepared.childSessionID,
    requestedModel: prepared.requestedModel,
    actualModel: prepared.record.actualModel,
    mode: prepared.mode,
    status: interrupted ? "interrupted" : "failed",
    ...(!interrupted
      ? {
          error: executionError(cause),
        }
      : {}),
  }
}

function executionError(cause: Cause.Cause<unknown>): ModelCall.Error {
  const failure = Cause.squash(cause)
  return {
    code: "MODEL_CALL_EXECUTION_FAILED",
    message: failure instanceof Error ? failure.message : String(failure),
    outcomeUnknown: true,
  }
}

function sessionUsage(session: Session.Info): ModelCall.Usage {
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

function toolMetadata(result: ModelCall.CallResult) {
  return {
    truncated: false,
    callID: result.callID,
    parentSessionId: result.parentSessionID,
    sessionId: result.childSessionID,
    requestedModel: result.requestedModel,
    actualModel: result.actualModel,
    background: result.mode === "background",
    status: result.status,
    text: result.text ?? "",
    ...(result.structured === undefined ? {} : { structured: result.structured }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  }
}
