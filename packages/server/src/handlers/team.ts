import { TeamV2 } from "@opencode-ai/core/team"
import { TeamWorkspace } from "@opencode-ai/core/team/workspace"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { InvalidRequestError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const TeamHandler = HttpApiBuilder.group(Api, "server.team", (handlers) =>
  Effect.gen(function* () {
    const teams = yield* TeamV2.Service
    const workspaces = yield* TeamWorkspace.Service
    const sessions = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    const actor = (sessionID: SessionV2.ID) =>
      teams.caller(sessionID).pipe(
        Effect.mapError(
          (error) =>
            new SessionNotFoundError({
              sessionID,
              message: error.message || `Session is not a Team member: ${sessionID}`,
            }),
        ),
      )
    const invalid = (error: unknown) =>
      new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) })

    return handlers
      .handle(
        "team.status",
        Effect.fn(function* (ctx) {
          const member = yield* actor(ctx.params.sessionID)
          const active = yield* execution.active
          const current = yield* teams.get(member.team.id).pipe(Effect.mapError(invalid))
          yield* Effect.forEach(
            current.members.filter((item) => item.status === "running" || item.status === "idle"),
            (item) =>
              teams
                .memberStatus(item.id, active.has(item.sessionID) ? "running" : "idle")
                .pipe(Effect.mapError(invalid)),
            { discard: true },
          )
          return {
            data: {
              team: yield* teams.get(member.team.id).pipe(Effect.mapError(invalid)),
              tasks: yield* teams.tasks(member.team.id),
              submissions: yield* teams.submissions(member.team.id),
            },
          }
        }),
      )
      .handle(
        "team.stop",
        Effect.fn(function* (ctx) {
          const member = yield* actor(ctx.params.sessionID)
          const name = ctx.payload.member ?? (member.lead ? undefined : member.name)
          if (name) {
            const target = member.team.members.find((teammate) => teammate.name === name)
            if (target) yield* sessions.interrupt(target.sessionID)
            const stopped = yield* workspaces
              .withLock(member.team.id, workspaces.withCoordinationLock(member.team.id, teams.stopMember(member, name)))
              .pipe(Effect.mapError(invalid))
            yield* workspaces
              .cleanup(member.team, stopped, ctx.payload.force ?? false)
              .pipe(Effect.mapError(invalid), Effect.ensuring(sessions.interrupt(stopped.sessionID)))
            return { data: { team: yield* teams.get(member.team.id).pipe(Effect.mapError(invalid)) } }
          }
          const current = yield* teams.get(member.team.id).pipe(Effect.mapError(invalid))
          yield* Effect.forEach(current.members, (teammate) => sessions.interrupt(teammate.sessionID), {
            discard: true,
          })
          const team = yield* workspaces.close(member, ctx.payload.force ?? false).pipe(
            Effect.mapError(invalid),
            Effect.ensuring(
              Effect.forEach(current.members, (teammate) => sessions.interrupt(teammate.sessionID), {
                discard: true,
              }),
            ),
          )
          return { data: { team } }
        }),
      )
  }),
)
