export * as TeamTool from "./team"

import { Team } from "@opencode-ai/schema/team"
import { Effect, Layer, Schedule, Schema, Scope } from "effect"
import { isDeepStrictEqual } from "node:util"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { CallableModels } from "../callable-model"
import { Config } from "../config"
import { makeGlobalNode } from "../effect/app-node"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import { SessionExecution } from "../session/execution"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionRunnerModel } from "../session/runner/model"
import { AbsolutePath } from "../schema"
import { TeamV2 } from "../team"
import { TeamWorkspace } from "../team/workspace"
import { ApplicationTools } from "./application-tools"
import { Tool } from "./tool"

const spawnName = "team_spawn"
const sendName = "team_send"
const taskName = "team_task"
const submitName = "team_submit"
const syncName = "team_sync"
const statusName = "team_status"
const stopName = "team_stop"

const Empty = Schema.Struct({})

const descriptions = {
  [spawnName]: [
    "Create one experimental writing Team in isolated branch-backed Git worktrees.",
    "The current Session becomes a coordinator-only lead. Each teammate gets an exact model, fresh Session, private branch and worktree, shared tasks, direct messaging, staged validation, and safe integration.",
    "The target repository must be clean and on a named branch. Use models first; model selection is exact and never falls back.",
    `Create 1-${Team.MAX_MEMBERS} teammates. Teams cannot nest.`,
  ].join("\n"),
  [sendName]: "Send one durable, provenance-marked message to the lead or a named teammate in the same Team.",
  [taskName]: "Create, claim, complete, release, or cancel one shared Team task using atomic task transitions.",
  [submitName]: [
    "Capture this teammate worktree as an immutable commit and stage it for validated integration.",
    "Complete the assigned task first. Clean merges advance the Team integration head; conflicts and validation failures never modify the lead workspace.",
  ].join("\n"),
  [syncName]:
    "Reset a clean teammate worktree to the latest applied Team integration head before starting dependent work.",
  [statusName]: "Read the Team roster, shared tasks, submission states, conflicts, and integration progress.",
  [stopName]:
    "Stop one teammate or, when called by the lead without a member, close the Team and clean integrated worktrees.",
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const teams = yield* TeamV2.Service
    const workspaces = yield* TeamWorkspace.Service
    const sessions = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    const locations = yield* LocationServiceMap.Service
    const scope = yield* Scope.Scope

    const resolveTarget = Effect.fn("TeamTool.resolveTarget")(function* (
      parent: SessionV2.Info,
      context: Tool.Context,
      requestedModel: ModelV2.Ref,
    ) {
      return yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const resolver = yield* SessionRunnerModel.Service
        const agents = yield* AgentV2.Service
        const config = yield* Config.Service
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
        if (!CallableModels.allowed(Config.latest(yield* config.entries(), "model_call"), selected))
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

    const assertSpawnPermission = Effect.fn("TeamTool.assertSpawnPermission")(function* (
      input: Team.SpawnInput,
      context: Tool.Context,
    ) {
      yield* Effect.gen(function* () {
        const permission = yield* PermissionV2.Service
        yield* permission.assert({
          action: spawnName,
          resources: input.members.map((member) => `${member.model.providerID}/${member.model.id}`),
          save: input.members.map((member) => `${member.model.providerID}/${member.model.id}`),
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          metadata: { members: input.members.length },
        })
        if (input.validation?.length)
          yield* permission.assert({
            action: "bash",
            resources: input.validation,
            save: [],
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            metadata: { teamValidation: true },
          })
      }).pipe(Effect.provide(locations.get(context.location)))
    })

    const fail = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((error) => {
          const message = error instanceof Error ? error.message : String(error)
          const tag = typeof error === "object" && error && "_tag" in error ? String(error._tag) : undefined
          return new Tool.Failure({ message: message || tag || "Team operation failed" })
        }),
      )

    const prepareMember = Effect.fn("TeamTool.prepareMember")(function* (
      team: Team.Info,
      member: TeamV2.ReservedMember,
    ) {
      const origin = {
        type: "team_member" as const,
        teamID: team.id,
        memberID: member.id,
        leadSessionID: team.leadSessionID,
        parentAssistantMessageID: team.parentAssistantMessageID,
        parentToolCallID: team.parentToolCallID,
      }
      const expectedOrigin = origin
      yield* workspaces.provision(team, member)
      const existing = yield* sessions.get(member.sessionID).pipe(
        Effect.map((session) => session as SessionV2.Info | undefined),
        Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
      )
      const child =
        existing ??
        (yield* sessions.create({
          id: member.sessionID,
          parentID: team.leadSessionID,
          title: `Team · ${member.name}`,
          origin: expectedOrigin,
          agent: member.agent,
          model: member.model,
          location: Location.Ref.make({ directory: AbsolutePath.make(member.directory) }),
          permission: member.permission,
        }))
      if (
        child.parentID !== team.leadSessionID ||
        child.agent !== member.agent ||
        child.location.directory !== member.directory ||
        !isDeepStrictEqual(child.origin, expectedOrigin) ||
        !isDeepStrictEqual(child.permission ?? [], member.permission) ||
        child.model?.providerID !== member.model.providerID ||
        child.model.id !== member.model.id ||
        (child.model.variant ?? "default") !== (member.model.variant ?? "default")
      )
        yield* new TeamV2.ConflictError({
          message: `Reserved teammate Session ${member.sessionID} has conflicting immutable settings`,
        })
      yield* sessions.prompt({
        id: member.promptID,
        sessionID: member.sessionID,
        prompt: {
          text: [
            `You are teammate ${member.name} in Team ${team.id}.`,
            `Your writable workspace is isolated at ${member.directory} on branch ${member.branch}.`,
            "Coordinate through team_send and team_task. Claim work before editing. Complete the task with a summary, then call team_submit. Call team_sync before dependent work. Do not edit another teammate's worktree or spawn nested agents.",
            "",
            member.prompt,
          ].join("\n"),
        },
        delivery: "queue",
        resume: false,
      })
      const started = yield* teams.memberStatus(member.id, "running")
      if (started.status !== "running") return
      yield* execution.wake(member.sessionID)
    })

    const deliver = Effect.fn("TeamTool.deliver")(function* (
      actor: TeamV2.Caller,
      input: { to: Team.Name; body: string; assistantMessageID: SessionMessage.ID; toolCallID: string },
    ) {
      const target = yield* teams.reserveMessage({
        caller: actor,
        to: input.to,
        body: input.body,
        parentAssistantMessageID: input.assistantMessageID,
        parentToolCallID: input.toolCallID,
      })
      const text = `<team_message sender="${actor.name}" source="another-agent">\n${escapeMessage(input.body)}\n</team_message>`
      yield* sessions
        .internal({
          id: target.targetPromptID,
          sessionID: target.recipientSessionID,
          prompt: Prompt.make({
            text,
            internal: {
              type: "team-message",
              messageID: target.id,
              teamID: actor.team.id,
              senderMemberID: actor.memberID,
              senderSessionID: actor.sessionID,
              body: input.body,
            },
          }),
          delivery: "steer",
          pendingLimit: Team.MAX_PENDING_MESSAGES,
          resume: false,
        })
        .pipe(
          Effect.catchTag("SessionInput.InboxFullError", () =>
            teams
              .messageRejected(target.id, "Recipient inbox is full")
              .pipe(Effect.andThen(Effect.fail(new TeamV2.InvalidStateError({ message: "Recipient inbox is full" })))),
          ),
        )
      yield* execution.wake(target.recipientSessionID)
      yield* teams.messageAdmitted(target.id)
      return target
    })

    const notifyLead = Effect.fn("TeamTool.notifyLead")(function* (actor: TeamV2.Caller, submission: Team.Submission) {
      if (actor.lead) return
      const body = `Submission ${submission.id} for task ${submission.taskID} is ${submission.status}.${
        submission.conflicts.length ? ` Conflicts: ${submission.conflicts.join(", ")}.` : ""
      }${submission.error ? ` ${submission.error}` : ""}`
      yield* workspaces.withCoordinationLock(
        actor.team.id,
        deliver(actor, {
          to: Team.Name.make("lead"),
          body,
          assistantMessageID: actor.team.parentAssistantMessageID,
          toolCallID: `${actor.team.parentToolCallID}:${submission.id}:${submission.status}:${Bun.hash(body).toString(16)}`,
        }),
      )
    })

    const reportLead = (actor: TeamV2.Caller, submission: Team.Submission) =>
      notifyLead(actor, submission).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to notify Team lead", {
            teamID: actor.team.id,
            submissionID: submission.id,
            status: submission.status,
            error,
          }),
        ),
      )

    const recoverMessage = Effect.fn("TeamTool.recoverMessage")(function* (message: TeamV2.MessageInfo) {
      const team = yield* teams.get(message.teamID)
      const sender =
        message.senderMemberID === team.leadMemberID
          ? "lead"
          : (team.members.find((member) => member.id === message.senderMemberID)?.name ?? "teammate")
      yield* sessions.internal({
        id: message.targetPromptID,
        sessionID: message.recipientSessionID,
        prompt: Prompt.make({
          text: `<team_message sender="${sender}" source="another-agent">\n${escapeMessage(message.body)}\n</team_message>`,
          internal: {
            type: "team-message",
            messageID: message.id,
            teamID: message.teamID,
            senderMemberID: message.senderMemberID,
            senderSessionID: message.senderSessionID,
            body: message.body,
          },
        }),
        delivery: "steer",
        pendingLimit: Team.MAX_PENDING_MESSAGES,
        resume: false,
      })
      yield* execution.wake(message.recipientSessionID)
      yield* teams.messageAdmitted(message.id)
    })

    const notifySubmission = Effect.fn("TeamTool.notifySubmission")(function* (
      team: Team.Info,
      submission: Team.Submission,
    ) {
      const member = team.members.find((item) => item.id === submission.memberID)
      if (!member) {
        yield* new TeamV2.NotFoundError({ teamID: team.id })
        return
      }
      yield* reportLead(yield* teams.caller(member.sessionID), submission)
    })

    const stageAndNotify = Effect.fn("TeamTool.stageAndNotify")(function* (
      actor: TeamV2.Caller,
      submission: Team.Submission,
    ) {
      const staged = yield* workspaces.submit(submission, actor).pipe(
        Effect.catch((error) =>
          teams.submission(submission.id).pipe(
            Effect.flatMap((failed) => reportLead(actor, failed)),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      )
      yield* reportLead(actor, staged)
      return staged
    })

    const applyWhenLeadIdle = (team: Team.Info, submission: Team.Submission) => {
      const apply = workspaces.withLock(
        team.id,
        execution.whenIdle(team.leadSessionID, workspaces.applyLocked(submission)),
      )
      return Effect.gen(function* () {
        const first = yield* apply
        yield* notifySubmission(team, first)
        if (first.status !== "ready") return first
        const result = yield* apply.pipe(
          Effect.repeat({ schedule: Schedule.spaced("2 seconds"), while: (current) => current.status === "ready" }),
        )
        yield* notifySubmission(team, result)
        return result
      }).pipe(
        Effect.catch((error) =>
          teams
            .transitionSubmission({
              submissionID: submission.id,
              from: ["ready", "applying"],
              to: "failed",
              values: { error: error instanceof Error ? error.message : String(error) },
            })
            .pipe(
              Effect.flatMap((failed) => (failed ? notifySubmission(team, failed) : Effect.void)),
              Effect.andThen(Effect.fail(error)),
            ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to apply ready Team submission", {
            teamID: team.id,
            submissionID: submission.id,
            cause,
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    }

    const recoverSubmission = Effect.fn("TeamTool.recoverSubmission")(function* (
      team: Team.Info,
      submission: Team.Submission,
    ) {
      if (submission.status === "ready" || submission.status === "applying") {
        yield* applyWhenLeadIdle(team, submission)
        return
      }
      if (!["preparing", "queued", "merging", "validating"].includes(submission.status)) return
      const member = team.members.find((item) => item.id === submission.memberID)
      if (!member) {
        yield* new TeamV2.NotFoundError({ teamID: team.id })
        return
      }
      const actor = yield* teams.caller(member.sessionID)
      const staged = yield* stageAndNotify(actor, submission)
      if (staged.status === "ready") yield* applyWhenLeadIdle(team, staged)
    })

    const json = (output: unknown) => [{ type: "text" as const, text: JSON.stringify(output) }]

    yield* applications
      .register({
        [spawnName]: Tool.make({
          description: descriptions[spawnName],
          input: Team.SpawnInput,
          output: Team.SpawnResult,
          outputPolicy: "preserve",
          toModelOutput: ({ output }) => json(output),
          execute: (input, context) =>
            fail(
              Effect.gen(function* () {
                const parent = yield* sessions.get(context.sessionID)
                if (parent.origin || parent.parentID)
                  return yield* new TeamV2.InvalidStateError({ message: "Only top-level Sessions can create Teams" })
                const preflight = yield* workspaces.preflight(context.location.directory)
                const models = yield* Effect.forEach(input.members, (member) =>
                  resolveTarget(parent, context, member.model).pipe(Effect.map((model) => ({ ...member, model }))),
                )
                yield* assertSpawnPermission(input, context)
                const team = yield* teams.reserve({
                  leadSessionID: context.sessionID,
                  parentAssistantMessageID: context.assistantMessageID,
                  parentToolCallID: context.toolCallID,
                  projectID: parent.projectID,
                  location: Location.Ref.make({ directory: preflight.root }),
                  targetBranch: preflight.branch,
                  baseCommit: preflight.commit,
                  directoryRoot: workspaces.root,
                  agent: context.agent,
                  permission: parent.permission ?? [],
                  members: models,
                  tasks: input.tasks ?? [],
                  validation: input.validation ?? [],
                })
                return yield* workspaces.withLock(
                  team.id,
                  Effect.gen(function* () {
                    const current = yield* teams.get(team.id)
                    if (current.status !== "preparing") return { team: current }
                    yield* workspaces.initialize(current)
                    yield* Effect.forEach(
                      (yield* teams.reservedMembers(current.id)).filter(
                        (member) => member.status === "preparing" || member.status === "running",
                      ),
                      (member) =>
                        prepareMember(current, member).pipe(
                          Effect.catch((error) =>
                            teams.memberStatus(
                              member.id,
                              "failed",
                              error instanceof Error ? error.message : String(error),
                            ),
                          ),
                        ),
                      { concurrency: "unbounded", discard: true },
                    )
                    return { team: yield* teams.activate(current.id) }
                  }),
                )
              }),
            ),
        }),
        [sendName]: Tool.make({
          description: descriptions[sendName],
          input: Team.SendInput,
          output: Team.SendResult,
          toModelOutput: ({ output }) => json(output),
          execute: (input, context) =>
            fail(
              Effect.gen(function* () {
                const found = yield* teams.caller(context.sessionID)
                const result = yield* workspaces.withCoordinationLock(
                  found.team.id,
                  Effect.gen(function* () {
                    const actor = yield* teams.caller(context.sessionID)
                    return yield* deliver(actor, {
                      to: input.to,
                      body: input.message,
                      assistantMessageID: context.assistantMessageID,
                      toolCallID: context.toolCallID,
                    })
                  }),
                )
                return { messageID: result.id, recipient: result.recipientMemberID, admitted: true }
              }),
            ),
        }),
        [taskName]: Tool.make({
          description: descriptions[taskName],
          input: Team.TaskInput,
          output: Team.TaskResult,
          toModelOutput: ({ output }) => json(output),
          execute: (input, context) =>
            fail(
              Effect.gen(function* () {
                const found = yield* teams.caller(context.sessionID)
                return yield* workspaces.withCoordinationLock(
                  found.team.id,
                  Effect.gen(function* () {
                    const actor = yield* teams.caller(context.sessionID)
                    return { task: yield* teams.task(actor, input) }
                  }),
                )
              }),
            ),
        }),
        [submitName]: Tool.make({
          description: descriptions[submitName],
          input: Team.SubmitInput,
          output: Team.SubmitResult,
          outputPolicy: "preserve",
          toModelOutput: ({ output }) => json(output),
          execute: (input, context) =>
            fail(
              Effect.gen(function* () {
                const found = yield* teams.caller(context.sessionID)
                const reserved = yield* workspaces.withCoordinationLock(
                  found.team.id,
                  Effect.gen(function* () {
                    const actor = yield* teams.caller(context.sessionID)
                    return yield* teams.reserveSubmission({
                      caller: actor,
                      taskID: input.taskID,
                      parentAssistantMessageID: context.assistantMessageID,
                      parentToolCallID: context.toolCallID,
                    })
                  }),
                )
                const actor = yield* teams.caller(context.sessionID)
                const staged = yield* stageAndNotify(actor, reserved)
                if (staged.status === "ready") yield* applyWhenLeadIdle(actor.team, staged)
                return { submission: staged }
              }),
            ),
        }),
        [syncName]: Tool.make({
          description: descriptions[syncName],
          input: Empty,
          output: Team.SyncResult,
          toModelOutput: ({ output }) => json(output),
          execute: (_, context) =>
            fail(
              Effect.gen(function* () {
                const actor = yield* teams.caller(context.sessionID)
                return yield* workspaces.sync(actor)
              }),
            ),
        }),
        [statusName]: Tool.make({
          description: descriptions[statusName],
          input: Empty,
          output: Team.StatusResult,
          outputPolicy: "preserve",
          toModelOutput: ({ output }) => json(output),
          execute: (_, context) =>
            fail(
              Effect.gen(function* () {
                const actor = yield* teams.caller(context.sessionID)
                const active = yield* execution.active
                const refreshed = yield* teams.get(actor.team.id)
                yield* Effect.forEach(
                  refreshed.members.filter((member) => member.status === "running" || member.status === "idle"),
                  (member) => teams.memberStatus(member.id, active.has(member.sessionID) ? "running" : "idle"),
                  { discard: true },
                )
                return {
                  team: yield* teams.get(actor.team.id),
                  tasks: yield* teams.tasks(actor.team.id),
                  submissions: yield* teams.submissions(actor.team.id),
                }
              }),
            ),
        }),
        [stopName]: Tool.make({
          description: descriptions[stopName],
          input: Team.StopInput,
          output: Team.StopResult,
          outputPolicy: "preserve",
          toModelOutput: ({ output }) => json(output),
          execute: (input, context) =>
            fail(
              Effect.gen(function* () {
                const actor = yield* teams.caller(context.sessionID)
                const name = input.member ?? (actor.lead ? undefined : actor.name)
                if (name) {
                  const target = actor.team.members.find((member) => member.name === name)
                  if (target && target.sessionID !== context.sessionID) yield* execution.interrupt(target.sessionID)
                  const member = yield* workspaces.withLock(
                    actor.team.id,
                    workspaces.withCoordinationLock(actor.team.id, teams.stopMember(actor, name)),
                  )
                  yield* workspaces
                    .cleanup(actor.team, member, input.force ?? false)
                    .pipe(Effect.ensuring(execution.interrupt(member.sessionID)))
                  return { team: yield* teams.get(actor.team.id) }
                }
                const current = yield* teams.get(actor.team.id)
                yield* Effect.forEach(current.members, (member) => execution.interrupt(member.sessionID), {
                  discard: true,
                })
                return yield* workspaces.close(actor, input.force ?? false).pipe(
                  Effect.map((team) => ({ team })),
                  Effect.ensuring(
                    Effect.forEach(current.members, (member) => execution.interrupt(member.sessionID), {
                      discard: true,
                    }),
                  ),
                )
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)

    yield* Effect.gen(function* () {
      yield* Effect.forEach(
        yield* teams.pendingMessages,
        (message) =>
          workspaces
            .withCoordinationLock(
              message.teamID,
              Effect.gen(function* () {
                const team = yield* teams.get(message.teamID)
                if (team.status === "closed" || team.status === "failed") return
                yield* recoverMessage(message)
              }),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to recover Team message", { messageID: message.id, cause }),
              ),
            ),
        { discard: true },
      )
      yield* Effect.forEach(
        yield* teams.recoverable,
        (team) =>
          Effect.gen(function* () {
            yield* workspaces.withLock(
              team.id,
              Effect.gen(function* () {
                const current = yield* teams.get(team.id)
                if (current.status === "preparing" || current.status === "active" || current.status === "degraded")
                  yield* workspaces.initialize(current)
              }),
            )
            yield* Effect.forEach(
              yield* teams.submissions(team.id),
              (submission) =>
                recoverSubmission(team, submission).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to recover Team submission", {
                      teamID: team.id,
                      submissionID: submission.id,
                      cause,
                    }),
                  ),
                ),
              { discard: true },
            )
            yield* workspaces.withLock(
              team.id,
              Effect.gen(function* () {
                const current = yield* teams.get(team.id)
                if (current.status !== "preparing") return
                yield* Effect.forEach(
                  (yield* teams.reservedMembers(team.id)).filter(
                    (member) => member.status === "preparing" || member.status === "running",
                  ),
                  (member) =>
                    prepareMember(current, member).pipe(
                      Effect.catch((error) =>
                        teams.memberStatus(member.id, "failed", error instanceof Error ? error.message : String(error)),
                      ),
                    ),
                  { discard: true },
                )
                yield* teams.activate(team.id)
              }),
            )
          }).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Failed to recover Team", { teamID: team.id, cause })),
          ),
        { concurrency: "unbounded", discard: true },
      )
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Team recovery failed", { cause })),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  }),
)

export const node = makeGlobalNode({
  name: "tool/team",
  layer,
  deps: [
    ApplicationTools.node,
    TeamV2.node,
    TeamWorkspace.node,
    SessionV2.node,
    SessionExecution.node,
    LocationServiceMap.node,
  ],
})

function escapeMessage(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
