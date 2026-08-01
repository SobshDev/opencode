import { describe, expect } from "bun:test"
import { Team } from "@opencode-ai/schema/team"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TeamV2 } from "@opencode-ai/core/team"
import { assertTeamCoordinatorCommand, assertTeamCoordinatorReadOnly } from "@opencode-ai/core/tool/team-coordinator"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, TeamV2.node])))
const location = Location.Ref.make({ directory: AbsolutePath.make("/team-project") })
const leadSessionID = SessionV2.ID.make("ses_team_lead")
const assistantMessageID = SessionMessage.ID.make("msg_team_lead")
const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.anthropic, id: ModelV2.ID.make("claude") })

const reserveInput = (overrides: Partial<TeamV2.ReserveInput> = {}): TeamV2.ReserveInput => ({
  leadSessionID,
  parentAssistantMessageID: assistantMessageID,
  parentToolCallID: "tool-team",
  projectID: ProjectV2.ID.global,
  location,
  targetBranch: "dev",
  baseCommit: "base",
  directoryRoot: "/tmp/team-worktrees",
  agent: AgentV2.ID.make("build"),
  permission: [],
  members: [
    { name: Team.Name.make("alpha"), model, prompt: "Implement alpha" },
    { name: Team.Name.make("beta"), model, prompt: "Implement beta" },
  ],
  tasks: [
    {
      key: Team.Name.make("shared"),
      title: "Shared task",
      description: "Claim this task",
    },
  ],
  validation: ["bun test"],
  ...overrides,
})

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: leadSessionID,
      project_id: ProjectV2.ID.global,
      slug: "team-lead",
      directory: location.directory,
      title: "Team lead",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return yield* TeamV2.Service
})

describe("TeamV2", () => {
  it.effect("reconciles concurrent exact spawn reservations", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const input = reserveInput()
      const results = yield* Effect.all([teams.reserve(input), teams.reserve(input)], { concurrency: "unbounded" })

      expect(results[1]).toEqual(results[0])
      expect(results[0]).toMatchObject({
        leadSessionID,
        targetBranch: "dev",
        baseCommit: "base",
        integrationCommit: "base",
        status: "preparing",
      })
      expect(results[0].members.map((member) => member.name)).toEqual(["alpha", "beta"])
      expect(new Set(results[0].members.map((member) => member.directory)).size).toBe(2)
    }),
  )

  it.effect("keeps the lead read-only while allowing conservative shell inspection", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)

      expect(yield* assertTeamCoordinatorReadOnly(teams, leadSessionID).pipe(Effect.flip)).toMatchObject({
        _tag: "LLM.ToolFailure",
      })
      yield* assertTeamCoordinatorCommand(teams, leadSessionID, "git status --short")
      expect(yield* assertTeamCoordinatorCommand(teams, leadSessionID, "./tools/ls").pipe(Effect.flip)).toMatchObject({
        _tag: "LLM.ToolFailure",
      })
      expect(
        yield* assertTeamCoordinatorCommand(
          teams,
          leadSessionID,
          "git diff --no-ext-diff --no-textconv --output=feature.txt",
        ).pipe(Effect.flip),
      ).toMatchObject({ _tag: "LLM.ToolFailure" })
      expect(
        yield* assertTeamCoordinatorCommand(
          teams,
          leadSessionID,
          "git diff --no-ext-diff --no-textconv --ext-diff",
        ).pipe(Effect.flip),
      ).toMatchObject({ _tag: "LLM.ToolFailure" })
      expect(
        yield* assertTeamCoordinatorCommand(teams, leadSessionID, "printf changed > feature.txt").pipe(Effect.flip),
      ).toMatchObject({ _tag: "LLM.ToolFailure" })
      yield* assertTeamCoordinatorReadOnly(teams, team.members[0].sessionID)
    }),
  )

  it.effect("rejects changed prompts on an exact invocation retry", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const input = reserveInput()
      yield* teams.reserve(input)
      const conflict = yield* teams
        .reserve({
          ...input,
          members: [{ ...input.members[0], prompt: "Different" }, input.members[1]],
        })
        .pipe(Effect.flip)

      expect(conflict).toBeInstanceOf(TeamV2.ConflictError)
    }),
  )

  it.effect("rejects invalid roster and task references before persistence", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const duplicate = yield* teams
        .reserve({
          ...reserveInput(),
          members: [reserveInput().members[0], { ...reserveInput().members[1], name: Team.Name.make("alpha") }],
        })
        .pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(TeamV2.ConflictError)

      const unknown = yield* teams
        .reserve({
          ...reserveInput({ parentToolCallID: "tool-team-dependency" }),
          tasks: [
            {
              key: Team.Name.make("shared"),
              title: "Shared task",
              description: "Invalid dependency",
              dependsOn: [Team.Name.make("missing")],
            },
          ],
        })
        .pipe(Effect.flip)
      expect(unknown).toBeInstanceOf(TeamV2.ConflictError)
    }),
  )

  it.effect("allows exactly one concurrent claimant for an unassigned task", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)
      const [alpha, beta] = yield* Effect.forEach(team.members, (member) => teams.caller(member.sessionID))
      const task = (yield* teams.tasks(team.id))[0]
      const claims = yield* Effect.all(
        [alpha, beta].map((actor) =>
          teams.task(actor, { action: "claim", taskID: task.id }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ),
        ),
        { concurrency: "unbounded" },
      )

      expect(claims.filter(Boolean)).toHaveLength(1)
      expect((yield* teams.tasks(team.id))[0]).toMatchObject({ status: "in_progress", version: 1 })
    }),
  )

  it.effect("reserves one idempotent addressed peer message", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)
      const alpha = yield* teams.caller(team.members[0].sessionID)
      const input = {
        caller: alpha,
        to: Team.Name.make("beta"),
        body: "Please challenge this implementation",
        parentAssistantMessageID: SessionMessage.ID.make("msg_alpha"),
        parentToolCallID: "tool-send",
      }
      const first = yield* teams.reserveMessage(input)
      const retry = yield* teams.reserveMessage(input)

      expect(retry).toEqual(first)
      expect(first.recipientSessionID).toBe(team.members[1].sessionID)
      const conflict = yield* teams.reserveMessage({ ...input, body: "Changed" }).pipe(Effect.flip)
      expect(conflict).toBeInstanceOf(TeamV2.ConflictError)
    }),
  )

  it.effect("reconciles concurrent exact message reservations", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)
      const alpha = yield* teams.caller(team.members[0].sessionID)
      const input = {
        caller: alpha,
        to: Team.Name.make("beta"),
        body: "Review concurrently",
        parentAssistantMessageID: SessionMessage.ID.make("msg_concurrent"),
        parentToolCallID: "tool-send-concurrent",
      }
      const messages = yield* Effect.all([teams.reserveMessage(input), teams.reserveMessage(input)], {
        concurrency: "unbounded",
      })

      expect(messages[1]).toEqual(messages[0])
    }),
  )

  it.effect("requires task completion before workspace submission", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)
      const alpha = yield* teams.caller(team.members[0].sessionID)
      const task = (yield* teams.tasks(team.id))[0]
      yield* teams.task(alpha, { action: "claim", taskID: task.id })
      const early = yield* teams
        .reserveSubmission({
          caller: alpha,
          taskID: task.id,
          parentAssistantMessageID: SessionMessage.ID.make("msg_submit_early"),
          parentToolCallID: "submit-early",
        })
        .pipe(Effect.flip)
      expect(early).toBeInstanceOf(TeamV2.InvalidStateError)

      yield* teams.task(alpha, { action: "complete", taskID: task.id, summary: "Implemented" })
      const submission = yield* teams.reserveSubmission({
        caller: alpha,
        taskID: task.id,
        parentAssistantMessageID: SessionMessage.ID.make("msg_submit"),
        parentToolCallID: "submit",
      })
      expect(submission).toMatchObject({ memberID: alpha.memberID, status: "preparing", taskID: task.id })
    }),
  )

  it.effect("reconciles task and submission retries", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)
      const alpha = yield* teams.caller(team.members[0].sessionID)
      const task = (yield* teams.tasks(team.id))[0]
      const claimed = yield* Effect.all(
        [
          teams.task(alpha, { action: "claim", taskID: task.id }),
          teams.task(alpha, { action: "claim", taskID: task.id }),
        ],
        { concurrency: "unbounded" },
      )
      expect(claimed[1]).toEqual(claimed[0])
      const completed = yield* Effect.all(
        [
          teams.task(alpha, { action: "complete", taskID: task.id, summary: "Implemented" }),
          teams.task(alpha, { action: "complete", taskID: task.id, summary: "Implemented" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(completed[1]).toEqual(completed[0])
      const input = {
        caller: alpha,
        taskID: task.id,
        parentAssistantMessageID: SessionMessage.ID.make("msg_submit_retry"),
        parentToolCallID: "submit-retry",
      }
      const submissions = yield* Effect.all([teams.reserveSubmission(input), teams.reserveSubmission(input)], {
        concurrency: "unbounded",
      })
      expect(submissions[1]).toEqual(submissions[0])
    }),
  )

  it.effect("stopping a teammate releases its unfinished tasks", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)
      const alpha = yield* teams.caller(team.members[0].sessionID)
      const task = (yield* teams.tasks(team.id))[0]
      yield* teams.task(alpha, { action: "claim", taskID: task.id })
      const lead = yield* teams.caller(leadSessionID)
      expect((yield* teams.stopMember(lead, Team.Name.make("alpha"))).status).toBe("stopped")
      const released = (yield* teams.tasks(team.id))[0]
      expect(released).toMatchObject({ status: "pending", version: 2 })
      expect(released.assignee).toBeUndefined()
    }),
  )

  it.effect("stopping a teammate cancels its nonterminal submissions", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)
      const alpha = yield* teams.caller(team.members[0].sessionID)
      const task = (yield* teams.tasks(team.id))[0]
      yield* teams.task(alpha, { action: "claim", taskID: task.id })
      yield* teams.task(alpha, { action: "complete", taskID: task.id, summary: "Implemented" })
      const submission = yield* teams.reserveSubmission({
        caller: alpha,
        taskID: task.id,
        parentAssistantMessageID: SessionMessage.ID.make("msg_stop_submission"),
        parentToolCallID: "stop-submission",
      })
      yield* teams.submissionStatus(submission.id, "ready", { resultCommit: "result" })

      const lead = yield* teams.caller(leadSessionID)
      yield* teams.stopMember(lead, Team.Name.make("alpha"))

      expect((yield* teams.submission(submission.id)).status).toBe("cancelled")
    }),
  )

  it.effect("keeps close terminal against stale callers and activation", () =>
    Effect.gen(function* () {
      const teams = yield* setup
      const team = yield* teams.reserve(reserveInput())
      yield* Effect.forEach(team.members, (member) => teams.memberStatus(member.id, "running"), { discard: true })
      yield* teams.activate(team.id)
      const alpha = yield* teams.caller(team.members[0].sessionID)
      const lead = yield* teams.caller(leadSessionID)
      yield* teams.reserveMessage({
        caller: alpha,
        to: Team.Name.make("beta"),
        body: "Pending before close",
        parentAssistantMessageID: SessionMessage.ID.make("msg_pending_close"),
        parentToolCallID: "pending-close",
      })
      expect((yield* teams.close(lead)).status).toBe("closed")

      expect((yield* teams.activate(team.id)).status).toBe("closed")
      expect((yield* teams.memberStatus(team.members[0].id, "running")).status).toBe("stopped")
      expect(yield* teams.pendingMessages).toEqual([])
      expect(
        yield* teams
          .task(alpha, {
            action: "create",
            key: Team.Name.make("late"),
            title: "Late task",
            description: "Must not be created",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(TeamV2.InvalidStateError)
      expect(
        yield* teams
          .reserveMessage({
            caller: alpha,
            to: Team.Name.make("beta"),
            body: "Late message",
            parentAssistantMessageID: SessionMessage.ID.make("msg_late"),
            parentToolCallID: "late-message",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(TeamV2.InvalidStateError)
    }),
  )
})
