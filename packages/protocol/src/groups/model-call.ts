import { ModelCall } from "@opencode-ai/schema/model-call"
import { Session } from "@opencode-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { ModelCallNotFoundError, SessionNotFoundError } from "../errors"

export const makeModelCallGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.modelCall")
    .add(
      HttpApiEndpoint.get("modelCall.list", "/api/session/:sessionID/model-call", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(ModelCall.CallResult) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.modelCall.list",
            summary: "List model calls",
            description: "List durable model calls created directly by a Session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("modelCall.get", "/api/session/:sessionID/model-call/:callID", {
        params: { sessionID: Session.ID, callID: ModelCall.CallID },
        success: Schema.Struct({ data: ModelCall.CallResult }),
        error: [SessionNotFoundError, ModelCallNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.modelCall.get",
            summary: "Get model call",
            description: "Inspect one durable model call owned directly by a Session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("modelCall.cancel", "/api/session/:sessionID/model-call/:callID/cancel", {
        params: { sessionID: Session.ID, callID: ModelCall.CallID },
        success: Schema.Struct({ data: ModelCall.CallResult }),
        error: [SessionNotFoundError, ModelCallNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.modelCall.cancel",
            summary: "Cancel model call",
            description: "Atomically cancel a non-terminal model call owned by a Session and interrupt its child.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("modelCall.detach", "/api/session/:sessionID/model-call/:callID/detach", {
        params: { sessionID: Session.ID, callID: ModelCall.CallID },
        success: Schema.Struct({ data: ModelCall.CallResult }),
        error: [SessionNotFoundError, ModelCallNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.modelCall.detach",
            summary: "Detach model call",
            description: "Move a foreground model call owned by a Session to background execution.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "model calls",
        description: "Durable cross-model delegation lifecycle routes.",
      }),
    )
