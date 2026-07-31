import { ModelCallV2 } from "@opencode-ai/core/model-call"
import { SessionV2 } from "@opencode-ai/core/session"
import { ModelCallNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export function modelCallOwnedBy(record: Pick<ModelCallV2.Info, "parentSessionID">, sessionID: SessionV2.ID) {
  return record.parentSessionID === sessionID
}

export const ModelCallHandler = HttpApiBuilder.group(Api, "server.modelCall", (handlers) =>
  Effect.gen(function* () {
    const calls = yield* ModelCallV2.Service
    const sessions = yield* SessionV2.Service
    const notFound = (callID: ModelCallV2.Info["id"]) =>
      new ModelCallNotFoundError({
        callID,
        message: `Model call not found: ${callID}`,
      })
    const owned = Effect.fn(function* (sessionID: SessionV2.ID, callID: ModelCallV2.Info["id"]) {
      const record = yield* calls.get(callID).pipe(Effect.mapError((error) => notFound(error.callID)))
      if (!modelCallOwnedBy(record, sessionID)) return yield* notFound(callID)
      return record
    })

    return handlers
      .handle(
        "modelCall.list",
        Effect.fn(function* (ctx) {
          return {
            data: (yield* calls.list(ctx.params.sessionID)).map(ModelCallV2.result),
          }
        }),
      )
      .handle(
        "modelCall.get",
        Effect.fn(function* (ctx) {
          return {
            data: ModelCallV2.result(yield* owned(ctx.params.sessionID, ctx.params.callID)),
          }
        }),
      )
      .handle(
        "modelCall.cancel",
        Effect.fn(function* (ctx) {
          const current = yield* owned(ctx.params.sessionID, ctx.params.callID)
          const child = yield* sessions.get(current.childSessionID).pipe(
            Effect.map((session) => session as SessionV2.Info | undefined),
            Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
          )
          const record = yield* calls
            .cancelled(ctx.params.callID, {
              ...(child === undefined
                ? {}
                : {
                    usage: {
                      cost: child.cost,
                      tokens: child.tokens,
                    },
                  }),
            })
            .pipe(Effect.mapError((error) => notFound(error.callID)))
          if (record.runtime === "v2" && record.status === "cancelled") yield* sessions.interrupt(record.childSessionID)
          return { data: ModelCallV2.result(record) }
        }),
      )
      .handle(
        "modelCall.detach",
        Effect.fn(function* (ctx) {
          yield* owned(ctx.params.sessionID, ctx.params.callID)
          const record = yield* calls.detach(ctx.params.callID).pipe(Effect.mapError((error) => notFound(error.callID)))
          return { data: ModelCallV2.result(record) }
        }),
      )
  }),
)
