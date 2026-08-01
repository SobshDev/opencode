import { Session } from "@opencode-ai/schema/session"
import { Team } from "@opencode-ai/schema/team"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "../errors"

export const makeTeamGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.team")
    .add(
      HttpApiEndpoint.get("team.status", "/api/session/:sessionID/team", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Team.StatusResult }),
        error: [SessionNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.status",
            summary: "Get Team status",
            description:
              "Inspect the Team roster, tasks, submissions, conflicts, and integration state for a member Session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("team.stop", "/api/session/:sessionID/team/stop", {
        params: { sessionID: Session.ID },
        payload: Team.StopInput,
        success: Schema.Struct({ data: Team.StopResult }),
        error: [SessionNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.stop",
            summary: "Stop Team work",
            description:
              "Stop one teammate or close a lead-owned Team, preserving dirty worktrees unless force is explicit.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "teams",
        description: "Durable multi-Session collaboration and isolated parallel writing.",
      }),
    )
