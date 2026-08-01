export * as TeamV2 from "./team"

import path from "path"
import { Team } from "@opencode-ai/schema/team"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { Permission } from "@opencode-ai/schema/permission"
import { Project } from "@opencode-ai/schema/project"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { TeamMemberTable, TeamMessageTable, TeamSubmissionTable, TeamTable, TeamTaskTable } from "./team.sql"

export type ReserveInput = {
  readonly leadSessionID: Session.ID
  readonly parentAssistantMessageID: SessionMessage.ID
  readonly parentToolCallID: string
  readonly projectID: Project.ID
  readonly location: Location.Ref
  readonly targetBranch: string
  readonly baseCommit: string
  readonly directoryRoot: string
  readonly agent: Agent.ID
  readonly permission: Permission.Ruleset
  readonly members: ReadonlyArray<{ readonly name: Team.Name; readonly model: Model.Ref; readonly prompt: string }>
  readonly tasks: ReadonlyArray<Team.TaskSeed>
  readonly validation: ReadonlyArray<string>
}

export type Caller = {
  readonly team: Team.Info
  readonly memberID: Team.MemberID
  readonly sessionID: Session.ID
  readonly name: Team.Name
  readonly lead: boolean
  readonly member?: Team.Member
}

export type ReservedMember = Team.Member & {
  readonly promptID: SessionMessage.ID
  readonly prompt: string
  readonly agent: Agent.ID
  readonly permission: Permission.Ruleset
}

export type MessageInfo = {
  readonly id: Team.MessageID
  readonly teamID: Team.ID
  readonly senderMemberID: Team.MemberID
  readonly senderSessionID: Session.ID
  readonly recipientMemberID: Team.MemberID
  readonly recipientSessionID: Session.ID
  readonly targetPromptID: SessionMessage.ID
  readonly body: string
}

export type SubmissionValues = {
  readonly sourceCommit?: string
  readonly expectedIntegrationCommit?: string
  readonly resultCommit?: string
  readonly conflicts?: ReadonlyArray<string>
  readonly validationOutput?: string
  readonly error?: string | null
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Team.NotFoundError", {
  teamID: Team.ID.pipe(Schema.optional),
  sessionID: Session.ID.pipe(Schema.optional),
}) {}

export class MembershipError extends Schema.TaggedErrorClass<MembershipError>()("Team.MembershipError", {
  sessionID: Session.ID,
  message: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Team.ConflictError", {
  message: Schema.String,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("Team.InvalidStateError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly reserve: (input: ReserveInput) => Effect.Effect<Team.Info, ConflictError>
  readonly get: (teamID: Team.ID) => Effect.Effect<Team.Info, NotFoundError>
  readonly findByLead: (sessionID: Session.ID) => Effect.Effect<Team.Info | undefined>
  readonly recoverable: Effect.Effect<ReadonlyArray<Team.Info>>
  readonly caller: (sessionID: Session.ID) => Effect.Effect<Caller, MembershipError>
  readonly reservedMembers: (teamID: Team.ID) => Effect.Effect<ReadonlyArray<ReservedMember>, NotFoundError>
  readonly memberStatus: (
    memberID: Team.MemberID,
    status: Team.MemberStatus,
    error?: string,
  ) => Effect.Effect<Team.Member, NotFoundError>
  readonly activate: (teamID: Team.ID) => Effect.Effect<Team.Info, NotFoundError>
  readonly tasks: (teamID: Team.ID) => Effect.Effect<ReadonlyArray<Team.Task>>
  readonly task: (caller: Caller, input: Team.TaskInput) => Effect.Effect<Team.Task, NotFoundError | InvalidStateError>
  readonly reserveMessage: (input: {
    caller: Caller
    to: Team.Name
    body: string
    parentAssistantMessageID: SessionMessage.ID
    parentToolCallID: string
  }) => Effect.Effect<
    {
      id: Team.MessageID
      recipientMemberID: Team.MemberID
      recipientSessionID: Session.ID
      targetPromptID: SessionMessage.ID
    },
    ConflictError | InvalidStateError
  >
  readonly messageAdmitted: (messageID: Team.MessageID) => Effect.Effect<void>
  readonly messageRejected: (messageID: Team.MessageID, error: string) => Effect.Effect<void>
  readonly pendingMessages: Effect.Effect<ReadonlyArray<MessageInfo>>
  readonly reserveSubmission: (input: {
    caller: Caller
    taskID: Team.TaskID
    parentAssistantMessageID: SessionMessage.ID
    parentToolCallID: string
  }) => Effect.Effect<Team.Submission, ConflictError | InvalidStateError>
  readonly submissionStatus: (
    submissionID: Team.SubmissionID,
    status: Team.SubmissionStatus,
    values?: SubmissionValues,
  ) => Effect.Effect<Team.Submission, NotFoundError>
  readonly submission: (submissionID: Team.SubmissionID) => Effect.Effect<Team.Submission, NotFoundError>
  readonly transitionSubmission: (input: {
    readonly submissionID: Team.SubmissionID
    readonly from: ReadonlyArray<Team.SubmissionStatus>
    readonly to: Team.SubmissionStatus
    readonly values?: SubmissionValues
  }) => Effect.Effect<Team.Submission | undefined>
  readonly submissions: (teamID: Team.ID) => Effect.Effect<ReadonlyArray<Team.Submission>>
  readonly advanceIntegration: (teamID: Team.ID, expected: string, result: string) => Effect.Effect<boolean>
  readonly memberIntegrated: (memberID: Team.MemberID, commit: string) => Effect.Effect<void>
  readonly stopMember: (
    caller: Caller,
    name: Team.Name,
  ) => Effect.Effect<Team.Member, InvalidStateError | NotFoundError>
  readonly close: (caller: Caller) => Effect.Effect<Team.Info, InvalidStateError | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Team") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const memberFromRow = (row: typeof TeamMemberTable.$inferSelect): Team.Member =>
      Team.Member.make({
        id: row.id,
        teamID: row.team_id,
        sessionID: row.session_id,
        name: row.name,
        role: row.role,
        model: row.model,
        status: row.status,
        workspaceID: row.workspace_id,
        directory: row.directory,
        branch: row.branch,
        baseCommit: row.base_commit,
        ...(row.last_integrated_commit === null ? {} : { lastIntegratedCommit: row.last_integrated_commit }),
        ...(row.error === null ? {} : { error: row.error }),
        time: {
          created: DateTime.makeUnsafe(row.time_created),
          updated: DateTime.makeUnsafe(row.time_updated),
        },
      })

    const taskFromRow = (row: typeof TeamTaskTable.$inferSelect): Team.Task =>
      Team.Task.make({
        id: row.id,
        teamID: row.team_id,
        key: row.key,
        title: row.title,
        description: row.description,
        status: row.status,
        ...(row.assignee_member_id === null ? {} : { assignee: row.assignee_member_id }),
        dependsOn: row.depends_on,
        version: row.version,
        ...(row.summary === null ? {} : { summary: row.summary }),
        time: {
          created: DateTime.makeUnsafe(row.time_created),
          updated: DateTime.makeUnsafe(row.time_updated),
        },
      })

    const submissionFromRow = (row: typeof TeamSubmissionTable.$inferSelect): Team.Submission =>
      Team.Submission.make({
        id: row.id,
        teamID: row.team_id,
        memberID: row.member_id,
        taskID: row.task_id,
        status: row.status,
        baseCommit: row.base_commit,
        ...(row.source_commit === null ? {} : { sourceCommit: row.source_commit }),
        expectedIntegrationCommit: row.expected_integration_commit,
        ...(row.result_commit === null ? {} : { resultCommit: row.result_commit }),
        conflicts: row.conflicts,
        ...(row.validation_output === null ? {} : { validationOutput: row.validation_output }),
        ...(row.error === null ? {} : { error: row.error }),
        time: {
          created: DateTime.makeUnsafe(row.time_created),
          updated: DateTime.makeUnsafe(row.time_updated),
        },
      })

    const findRow = Effect.fn("Team.findRow")(function* (teamID: Team.ID) {
      return yield* db.select().from(TeamTable).where(eq(TeamTable.id, teamID)).get().pipe(Effect.orDie)
    })

    const infoFromRow = Effect.fn("Team.infoFromRow")(function* (row: typeof TeamTable.$inferSelect) {
      const members = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, row.id))
        .orderBy(asc(TeamMemberTable.time_created), asc(TeamMemberTable.id))
        .all()
        .pipe(Effect.orDie)
      return Team.Info.make({
        id: row.id,
        leadSessionID: row.lead_session_id,
        leadMemberID: row.lead_member_id,
        parentAssistantMessageID: row.parent_assistant_message_id,
        parentToolCallID: row.parent_tool_call_id,
        projectID: row.project_id,
        location: row.location,
        targetBranch: row.target_branch,
        baseCommit: row.base_commit,
        integrationCommit: row.integration_commit,
        status: row.status,
        validation: row.validation,
        members: members.map(memberFromRow),
        time: {
          created: DateTime.makeUnsafe(row.time_created),
          updated: DateTime.makeUnsafe(row.time_updated),
        },
      })
    })

    const get = Effect.fn("Team.get")(function* (teamID: Team.ID) {
      const row = yield* findRow(teamID)
      if (!row) return yield* new NotFoundError({ teamID })
      return yield* infoFromRow(row)
    })

    const findByLead = Effect.fn("Team.findByLead")(function* (sessionID: Session.ID) {
      const row = yield* db
        .select()
        .from(TeamTable)
        .where(eq(TeamTable.lead_session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? yield* infoFromRow(row) : undefined
    })

    const caller = Effect.fn("Team.caller")(function* (sessionID: Session.ID) {
      const lead = yield* findByLead(sessionID)
      if (lead)
        return {
          team: lead,
          memberID: lead.leadMemberID,
          sessionID,
          name: Team.Name.make("lead"),
          lead: true,
        } satisfies Caller
      const memberRow = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!memberRow) return yield* new MembershipError({ sessionID, message: "Session is not an active Team member" })
      const team = yield* get(memberRow.team_id).pipe(Effect.orDie)
      return {
        team,
        memberID: memberRow.id,
        sessionID,
        name: memberRow.name,
        lead: false,
        member: memberFromRow(memberRow),
      } satisfies Caller
    })

    const activeCaller = Effect.fn("Team.activeCaller")(function* (actor: Caller) {
      const row = yield* findRow(actor.team.id)
      if (!row) return yield* new InvalidStateError({ message: "Team no longer exists" })
      const team = yield* infoFromRow(row)
      if (!isActive(team.status)) return yield* new InvalidStateError({ message: `Team is ${team.status}` })
      if (actor.lead) {
        if (team.leadSessionID !== actor.sessionID)
          return yield* new InvalidStateError({ message: "Session is not this Team's lead" })
        return { ...actor, team } satisfies Caller
      }
      const member = team.members.find((item) => item.id === actor.memberID && item.sessionID === actor.sessionID)
      if (!member) return yield* new InvalidStateError({ message: "Session is not an active Team member" })
      if (member.status !== "running" && member.status !== "idle")
        return yield* new InvalidStateError({ message: `Teammate is ${member.status}` })
      return { ...actor, team, member } satisfies Caller
    })

    const findInvocation = Effect.fn("Team.findInvocation")(function* (input: {
      leadSessionID: Session.ID
      parentAssistantMessageID: SessionMessage.ID
      parentToolCallID: string
    }) {
      return yield* db
        .select()
        .from(TeamTable)
        .where(
          and(
            eq(TeamTable.lead_session_id, input.leadSessionID),
            eq(TeamTable.parent_assistant_message_id, input.parentAssistantMessageID),
            eq(TeamTable.parent_tool_call_id, input.parentToolCallID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
    })

    const reserve = Effect.fn("Team.reserve")(function* (input: ReserveInput) {
      const invalid = validateReserve(input)
      if (invalid) return yield* new ConflictError({ message: invalid })
      const existing = yield* findInvocation(input)
      if (existing) {
        const info = yield* infoFromRow(existing)
        if (matches(existing, input)) return info
        return yield* new ConflictError({ message: "Team spawn invocation was reused with different input" })
      }
      if (yield* findByLead(input.leadSessionID))
        return yield* new ConflictError({ message: "The lead Session already owns a Team" })
      const teamID = Team.ID.create()
      const leadMemberID = Team.MemberID.create()
      const suffix = teamID.slice(-12)
      const now = Date.now()
      const reserved = input.members.map((member) => ({
        id: Team.MemberID.create(),
        sessionID: Session.ID.create(),
        promptID: SessionMessage.ID.create(),
        workspaceID: Team.WorkspaceID.create(),
        directory: path.join(input.directoryRoot, suffix, member.name),
        branch: `opencode/team-${suffix}/${member.name}`,
        ...member,
      }))
      const memberByName = new Map(reserved.map((member) => [member.name, member]))
      const tasks = input.tasks.map((task) => ({ ...task, id: Team.TaskID.create() }))
      const taskByKey = new Map(tasks.map((task) => [task.key, task.id]))
      const inserted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const created = yield* tx
              .insert(TeamTable)
              .values({
                id: teamID,
                lead_session_id: input.leadSessionID,
                lead_member_id: leadMemberID,
                parent_assistant_message_id: input.parentAssistantMessageID,
                parent_tool_call_id: input.parentToolCallID,
                project_id: input.projectID,
                location: input.location,
                target_branch: input.targetBranch,
                base_commit: input.baseCommit,
                integration_commit: input.baseCommit,
                status: "preparing",
                validation: input.validation,
                spawn_input: { members: input.members, tasks: input.tasks, validation: input.validation },
                time_created: now,
                time_updated: now,
              })
              .onConflictDoNothing()
              .returning({ id: TeamTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!created) return false
            yield* tx
              .insert(TeamMemberTable)
              .values(
                reserved.map((member) => ({
                  id: member.id,
                  team_id: teamID,
                  session_id: member.sessionID,
                  prompt_id: member.promptID,
                  prompt: member.prompt,
                  name: member.name,
                  role: "teammate" as const,
                  agent_id: input.agent,
                  model: member.model,
                  permission: input.permission,
                  status: "preparing" as const,
                  workspace_id: member.workspaceID,
                  directory: member.directory,
                  branch: member.branch,
                  base_commit: input.baseCommit,
                  time_created: now,
                  time_updated: now,
                })),
              )
              .run()
              .pipe(Effect.orDie)
            if (tasks.length)
              yield* tx
                .insert(TeamTaskTable)
                .values(
                  tasks.map((task) => ({
                    id: task.id,
                    team_id: teamID,
                    key: task.key,
                    title: task.title,
                    description: task.description,
                    status: "pending" as const,
                    assignee_member_id: task.assignee ? memberByName.get(task.assignee)?.id : undefined,
                    depends_on: (task.dependsOn ?? []).flatMap((key) => {
                      const dependency = taskByKey.get(key)
                      return dependency ? [dependency] : []
                    }),
                    version: 0,
                    time_created: now,
                    time_updated: now,
                  })),
                )
                .run()
                .pipe(Effect.orDie)
            return true
          }),
        )
        .pipe(Effect.orDie)
      if (!inserted) {
        const winner = yield* findInvocation(input)
        if (winner) {
          const info = yield* infoFromRow(winner)
          if (matches(winner, input)) return info
        }
        return yield* new ConflictError({ message: "Team spawn reservation conflicted with another invocation" })
      }
      return yield* get(teamID).pipe(Effect.orDie)
    })

    const reservedMembers = Effect.fn("Team.reservedMembers")(function* (teamID: Team.ID) {
      yield* get(teamID)
      const rows = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, teamID))
        .orderBy(asc(TeamMemberTable.time_created), asc(TeamMemberTable.id))
        .all()
        .pipe(Effect.orDie)
      const source = yield* findRow(teamID)
      if (!source) return yield* new NotFoundError({ teamID })
      const input = yield* findInvocation({
        leadSessionID: source.lead_session_id,
        parentAssistantMessageID: source.parent_assistant_message_id,
        parentToolCallID: source.parent_tool_call_id,
      })
      if (!input) return yield* new NotFoundError({ teamID })
      return rows.map((row) => ({
        ...memberFromRow(row),
        promptID: row.prompt_id,
        prompt: row.prompt,
        agent: row.agent_id,
        permission: row.permission,
      }))
    })

    const memberStatus = Effect.fn("Team.memberStatus")(function* (
      memberID: Team.MemberID,
      status: Team.MemberStatus,
      error?: string,
    ) {
      const current = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.id, memberID))
        .get()
        .pipe(Effect.orDie)
      if (!current) return yield* new NotFoundError({})
      const team = yield* findRow(current.team_id)
      if (!team) return yield* new NotFoundError({ teamID: current.team_id })
      if (
        current.status === "stopped" ||
        team.status === "closed" ||
        (team.status === "failed" && status !== "stopped")
      )
        return memberFromRow(current)
      const now = Date.now()
      const row = yield* db
        .update(TeamMemberTable)
        .set({ status, error: error ?? null, time_updated: now })
        .where(and(eq(TeamMemberTable.id, memberID), eq(TeamMemberTable.status, current.status)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        const winner = yield* db
          .select()
          .from(TeamMemberTable)
          .where(eq(TeamMemberTable.id, memberID))
          .get()
          .pipe(Effect.orDie)
        if (!winner) return yield* new NotFoundError({})
        return memberFromRow(winner)
      }
      return memberFromRow(row)
    })

    const activate = Effect.fn("Team.activate")(function* (teamID: Team.ID) {
      const statuses = yield* db
        .select({ status: TeamMemberTable.status })
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)
      const status: Team.Status = statuses.every((item) => item.status === "failed")
        ? "failed"
        : statuses.some((item) => item.status === "failed")
          ? "degraded"
          : "active"
      const updated = yield* db
        .update(TeamTable)
        .set({ status, time_updated: Date.now() })
        .where(and(eq(TeamTable.id, teamID), eq(TeamTable.status, "preparing")))
        .returning({ id: TeamTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* get(teamID)
      return yield* get(teamID)
    })

    const tasks = (teamID: Team.ID) =>
      db
        .select()
        .from(TeamTaskTable)
        .where(eq(TeamTaskTable.team_id, teamID))
        .orderBy(asc(TeamTaskTable.time_created), asc(TeamTaskTable.id))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(taskFromRow)),
        )

    const task = Effect.fn("Team.task")(function* (inputActor: Caller, input: Team.TaskInput) {
      const actor = yield* activeCaller(inputActor)
      if (input.action === "create") {
        const existing = (yield* tasks(actor.team.id)).find((task) => task.key === input.key)
        if (existing) {
          if (
            existing.title === input.title &&
            existing.description === input.description &&
            existing.assignee ===
              (input.assignee ? actor.team.members.find((member) => member.name === input.assignee)?.id : undefined) &&
            isDeepStrictEqual(existing.dependsOn, input.dependsOn ?? [])
          )
            return existing
          return yield* new InvalidStateError({ message: `Task key already exists: ${input.key}` })
        }
        const assignee = input.assignee
          ? actor.team.members.find((member) => member.name === input.assignee)?.id
          : undefined
        if (input.assignee && !assignee)
          return yield* new InvalidStateError({ message: `Unknown teammate: ${input.assignee}` })
        const dependencies = input.dependsOn ?? []
        const known = dependencies.length
          ? yield* db
              .select({ id: TeamTaskTable.id })
              .from(TeamTaskTable)
              .where(and(eq(TeamTaskTable.team_id, actor.team.id), inArray(TeamTaskTable.id, dependencies)))
              .all()
              .pipe(Effect.orDie)
          : []
        if (known.length !== dependencies.length)
          return yield* new InvalidStateError({ message: "Task dependency does not belong to this Team" })
        const now = Date.now()
        const row = yield* db
          .insert(TeamTaskTable)
          .values({
            id: Team.TaskID.create(),
            team_id: actor.team.id,
            key: input.key,
            title: input.title,
            description: input.description,
            status: "pending",
            assignee_member_id: assignee,
            depends_on: dependencies,
            version: 0,
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row) return taskFromRow(row)
        const winner = yield* db
          .select()
          .from(TeamTaskTable)
          .where(and(eq(TeamTaskTable.team_id, actor.team.id), eq(TeamTaskTable.key, input.key)))
          .get()
          .pipe(Effect.orDie)
        if (
          winner &&
          winner.title === input.title &&
          winner.description === input.description &&
          winner.assignee_member_id === (assignee ?? null) &&
          isDeepStrictEqual(winner.depends_on, dependencies)
        )
          return taskFromRow(winner)
        return yield* new InvalidStateError({ message: `Task key already exists: ${input.key}` })
      }
      const current = yield* db
        .select()
        .from(TeamTaskTable)
        .where(and(eq(TeamTaskTable.id, input.taskID), eq(TeamTaskTable.team_id, actor.team.id)))
        .get()
        .pipe(Effect.orDie)
      if (!current) return yield* new NotFoundError({ teamID: actor.team.id })
      const now = Date.now()
      if (input.action === "claim") {
        if (actor.lead) return yield* new InvalidStateError({ message: "The lead coordinates and cannot claim tasks" })
        if (current.status === "in_progress" && current.assignee_member_id === actor.memberID)
          return taskFromRow(current)
        if (current.status !== "pending") return yield* new InvalidStateError({ message: `Task is ${current.status}` })
        if (current.assignee_member_id && current.assignee_member_id !== actor.memberID)
          return yield* new InvalidStateError({ message: "Task is assigned to another teammate" })
        if (current.depends_on.length) {
          const completed = yield* db
            .select({ id: TeamTaskTable.id })
            .from(TeamTaskTable)
            .where(
              and(
                eq(TeamTaskTable.team_id, actor.team.id),
                inArray(TeamTaskTable.id, current.depends_on),
                eq(TeamTaskTable.status, "completed"),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          if (completed.length !== current.depends_on.length)
            return yield* new InvalidStateError({ message: "Task dependencies have not completed" })
          const integrated = yield* db
            .select({ taskID: TeamSubmissionTable.task_id })
            .from(TeamSubmissionTable)
            .where(
              and(
                eq(TeamSubmissionTable.team_id, actor.team.id),
                inArray(TeamSubmissionTable.task_id, current.depends_on),
                eq(TeamSubmissionTable.status, "applied"),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          if (new Set(integrated.map((item) => item.taskID)).size !== current.depends_on.length)
            return yield* new InvalidStateError({ message: "Task dependencies have not been integrated" })
        }
        const row = yield* db
          .update(TeamTaskTable)
          .set({
            status: "in_progress",
            assignee_member_id: actor.memberID,
            version: current.version + 1,
            time_updated: now,
          })
          .where(
            and(
              eq(TeamTaskTable.id, current.id),
              eq(TeamTaskTable.version, current.version),
              eq(TeamTaskTable.status, "pending"),
              or(isNull(TeamTaskTable.assignee_member_id), eq(TeamTaskTable.assignee_member_id, actor.memberID)),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) {
          const latest = yield* findTask(current.id, actor.team.id)
          if (latest?.status === "in_progress" && latest.assignee_member_id === actor.memberID)
            return taskFromRow(latest)
          return yield* new InvalidStateError({ message: "Task was claimed concurrently" })
        }
        return taskFromRow(row)
      }
      if (input.action === "complete") {
        if (
          current.status === "completed" &&
          current.assignee_member_id === actor.memberID &&
          current.summary === input.summary
        )
          return taskFromRow(current)
        if (current.status !== "in_progress" || current.assignee_member_id !== actor.memberID)
          return yield* new InvalidStateError({ message: "Only the assigned teammate can complete an active task" })
        const row = yield* updateTask(current, {
          status: "completed",
          summary: input.summary,
          version: current.version + 1,
          time_updated: now,
        })
        if (!row) {
          const latest = yield* findTask(current.id, actor.team.id)
          if (
            latest?.status === "completed" &&
            latest.assignee_member_id === actor.memberID &&
            latest.summary === input.summary
          )
            return taskFromRow(latest)
          return yield* new InvalidStateError({ message: "Task changed concurrently" })
        }
        return taskFromRow(row)
      }
      if (input.action === "release") {
        if (current.status === "pending" && current.assignee_member_id === null) return taskFromRow(current)
        if (current.status !== "pending" && current.status !== "in_progress")
          return yield* new InvalidStateError({ message: `Task is ${current.status}` })
        if (!actor.lead && current.assignee_member_id !== actor.memberID)
          return yield* new InvalidStateError({ message: "Only the assignee or lead can release a task" })
        const row = yield* updateTask(current, {
          status: "pending",
          assignee_member_id: null,
          version: current.version + 1,
          time_updated: now,
        })
        if (!row) {
          const latest = yield* findTask(current.id, actor.team.id)
          if (latest?.status === "pending" && latest.assignee_member_id === null) return taskFromRow(latest)
          return yield* new InvalidStateError({ message: "Task changed concurrently" })
        }
        return taskFromRow(row)
      }
      if (!actor.lead) return yield* new InvalidStateError({ message: "Only the lead can cancel tasks" })
      if (current.status === "cancelled") return taskFromRow(current)
      if (current.status !== "pending" && current.status !== "in_progress")
        return yield* new InvalidStateError({ message: `Task is ${current.status}` })
      const row = yield* updateTask(current, {
        status: "cancelled",
        version: current.version + 1,
        time_updated: now,
      })
      if (!row) {
        const latest = yield* findTask(current.id, actor.team.id)
        if (latest?.status === "cancelled") return taskFromRow(latest)
        return yield* new InvalidStateError({ message: "Task changed concurrently" })
      }
      return taskFromRow(row)
    })

    const updateTask = (
      current: typeof TeamTaskTable.$inferSelect,
      values: Partial<typeof TeamTaskTable.$inferInsert>,
    ) =>
      db
        .update(TeamTaskTable)
        .set(values)
        .where(and(eq(TeamTaskTable.id, current.id), eq(TeamTaskTable.version, current.version)))
        .returning()
        .get()
        .pipe(Effect.orDie)

    const findTask = (taskID: Team.TaskID, teamID: Team.ID) =>
      db
        .select()
        .from(TeamTaskTable)
        .where(and(eq(TeamTaskTable.id, taskID), eq(TeamTaskTable.team_id, teamID)))
        .get()
        .pipe(Effect.orDie)

    const reserveMessage = Effect.fn("Team.reserveMessage")(function* (input: {
      caller: Caller
      to: Team.Name
      body: string
      parentAssistantMessageID: SessionMessage.ID
      parentToolCallID: string
    }) {
      const actor = yield* activeCaller(input.caller)
      const prior = yield* db
        .select()
        .from(TeamMessageTable)
        .where(
          and(
            eq(TeamMessageTable.sender_session_id, actor.sessionID),
            eq(TeamMessageTable.parent_assistant_message_id, input.parentAssistantMessageID),
            eq(TeamMessageTable.parent_tool_call_id, input.parentToolCallID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (prior) {
        const recipientName =
          prior.recipient_member_id === actor.team.leadMemberID
            ? "lead"
            : actor.team.members.find((member) => member.id === prior.recipient_member_id)?.name
        if (prior.body !== input.body || recipientName !== input.to)
          return yield* new ConflictError({ message: "Team message invocation was reused with different input" })
        return {
          id: prior.id,
          recipientMemberID: prior.recipient_member_id,
          recipientSessionID: prior.recipient_session_id,
          targetPromptID: prior.target_prompt_id,
        }
      }
      const recipient =
        input.to === "lead"
          ? {
              id: actor.team.leadMemberID,
              sessionID: actor.team.leadSessionID,
              status: "idle" as const,
            }
          : actor.team.members.find((member) => member.name === input.to)
      if (!recipient) return yield* new InvalidStateError({ message: `Unknown teammate: ${input.to}` })
      if (recipient.id === actor.memberID)
        return yield* new InvalidStateError({ message: "A teammate cannot message itself" })
      if (recipient.status === "stopped" || recipient.status === "failed")
        return yield* new InvalidStateError({ message: `Recipient is ${recipient.status}` })
      const now = Date.now()
      const record = {
        id: Team.MessageID.create(),
        recipientMemberID: recipient.id,
        recipientSessionID: recipient.sessionID,
        targetPromptID: SessionMessage.ID.create(),
      }
      const inserted = yield* db
        .insert(TeamMessageTable)
        .values({
          id: record.id,
          team_id: actor.team.id,
          sender_member_id: actor.memberID,
          sender_session_id: actor.sessionID,
          recipient_member_id: record.recipientMemberID,
          recipient_session_id: record.recipientSessionID,
          target_prompt_id: record.targetPromptID,
          parent_assistant_message_id: input.parentAssistantMessageID,
          parent_tool_call_id: input.parentToolCallID,
          body: input.body,
          status: "pending",
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .returning({ id: TeamMessageTable.id })
        .get()
        .pipe(Effect.orDie)
      if (inserted) return record
      const winner = yield* db
        .select()
        .from(TeamMessageTable)
        .where(
          and(
            eq(TeamMessageTable.sender_session_id, actor.sessionID),
            eq(TeamMessageTable.parent_assistant_message_id, input.parentAssistantMessageID),
            eq(TeamMessageTable.parent_tool_call_id, input.parentToolCallID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const recipientName =
        winner?.recipient_member_id === actor.team.leadMemberID
          ? "lead"
          : actor.team.members.find((member) => member.id === winner?.recipient_member_id)?.name
      if (!winner || winner.body !== input.body || recipientName !== input.to)
        return yield* new ConflictError({ message: "Team message reservation conflicted with another invocation" })
      return {
        id: winner.id,
        recipientMemberID: winner.recipient_member_id,
        recipientSessionID: winner.recipient_session_id,
        targetPromptID: winner.target_prompt_id,
      }
    })

    const messageAdmitted = Effect.fn("Team.messageAdmitted")(function* (messageID: Team.MessageID) {
      yield* db
        .update(TeamMessageTable)
        .set({ status: "admitted", time_updated: Date.now() })
        .where(eq(TeamMessageTable.id, messageID))
        .run()
        .pipe(Effect.orDie)
    })

    const messageRejected = Effect.fn("Team.messageRejected")(function* (messageID: Team.MessageID, error: string) {
      yield* db
        .update(TeamMessageTable)
        .set({ status: "rejected", error, time_updated: Date.now() })
        .where(eq(TeamMessageTable.id, messageID))
        .run()
        .pipe(Effect.orDie)
    })

    const pendingMessages = db
      .select()
      .from(TeamMessageTable)
      .where(eq(TeamMessageTable.status, "pending"))
      .orderBy(asc(TeamMessageTable.time_created), asc(TeamMessageTable.id))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            teamID: row.team_id,
            senderMemberID: row.sender_member_id,
            senderSessionID: row.sender_session_id,
            recipientMemberID: row.recipient_member_id,
            recipientSessionID: row.recipient_session_id,
            targetPromptID: row.target_prompt_id,
            body: row.body,
          })),
        ),
      )

    const reserveSubmission = Effect.fn("Team.reserveSubmission")(function* (input: {
      caller: Caller
      taskID: Team.TaskID
      parentAssistantMessageID: SessionMessage.ID
      parentToolCallID: string
    }) {
      if (input.caller.lead || !input.caller.member)
        return yield* new InvalidStateError({ message: "Only teammates can submit workspace changes" })
      const actor = yield* activeCaller(input.caller)
      if (!actor.member) return yield* new InvalidStateError({ message: "Only teammates can submit workspace changes" })
      const prior = yield* db
        .select()
        .from(TeamSubmissionTable)
        .where(
          and(
            eq(TeamSubmissionTable.member_id, actor.memberID),
            eq(TeamSubmissionTable.parent_assistant_message_id, input.parentAssistantMessageID),
            eq(TeamSubmissionTable.parent_tool_call_id, input.parentToolCallID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (prior) {
        if (prior.task_id !== input.taskID)
          return yield* new ConflictError({ message: "Team submission invocation was reused for another task" })
        return submissionFromRow(prior)
      }
      const active = yield* db
        .select()
        .from(TeamSubmissionTable)
        .where(
          and(
            eq(TeamSubmissionTable.member_id, actor.memberID),
            eq(TeamSubmissionTable.task_id, input.taskID),
            inArray(TeamSubmissionTable.status, ["preparing", "queued", "merging", "validating", "ready", "applying"]),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (
        active &&
        active.parent_assistant_message_id === input.parentAssistantMessageID &&
        active.parent_tool_call_id === input.parentToolCallID
      )
        return submissionFromRow(active)
      if (active) return yield* new InvalidStateError({ message: `Submission ${active.id} is still ${active.status}` })
      const task = yield* db
        .select()
        .from(TeamTaskTable)
        .where(and(eq(TeamTaskTable.id, input.taskID), eq(TeamTaskTable.team_id, actor.team.id)))
        .get()
        .pipe(Effect.orDie)
      if (!task || task.assignee_member_id !== actor.memberID)
        return yield* new InvalidStateError({ message: "Submission task is not assigned to this teammate" })
      if (task.status !== "completed")
        return yield* new InvalidStateError({ message: "Complete the task with a summary before submitting changes" })
      const now = Date.now()
      const row = {
        id: Team.SubmissionID.create(),
        team_id: actor.team.id,
        member_id: actor.memberID,
        task_id: input.taskID,
        parent_assistant_message_id: input.parentAssistantMessageID,
        parent_tool_call_id: input.parentToolCallID,
        status: "preparing" as const,
        base_commit: actor.member.baseCommit,
        expected_integration_commit: actor.team.integrationCommit,
        conflicts: [] as ReadonlyArray<string>,
        time_created: now,
        time_updated: now,
      }
      const inserted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const created = yield* tx
              .insert(TeamSubmissionTable)
              .values(row)
              .onConflictDoNothing()
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!created) return undefined
            yield* tx
              .update(TeamSubmissionTable)
              .set({ status: "cancelled", error: "Superseded by a newer submission", time_updated: now })
              .where(
                and(
                  eq(TeamSubmissionTable.member_id, actor.memberID),
                  eq(TeamSubmissionTable.task_id, input.taskID),
                  inArray(TeamSubmissionTable.status, ["conflicted", "validation_failed", "stale"]),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            return created
          }),
        )
        .pipe(Effect.orDie)
      if (inserted) return submissionFromRow(inserted)
      const winner = yield* db
        .select()
        .from(TeamSubmissionTable)
        .where(
          and(
            eq(TeamSubmissionTable.member_id, actor.memberID),
            eq(TeamSubmissionTable.parent_assistant_message_id, input.parentAssistantMessageID),
            eq(TeamSubmissionTable.parent_tool_call_id, input.parentToolCallID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!winner || winner.task_id !== input.taskID)
        return yield* new ConflictError({ message: "Team submission reservation conflicted with another invocation" })
      return submissionFromRow(winner)
    })

    const submissionStatus = Effect.fn("Team.submissionStatus")(function* (
      submissionID: Team.SubmissionID,
      status: Team.SubmissionStatus,
      values: SubmissionValues = {},
    ) {
      const row = yield* db
        .update(TeamSubmissionTable)
        .set({
          status,
          ...(values.sourceCommit === undefined ? {} : { source_commit: values.sourceCommit }),
          ...(values.expectedIntegrationCommit === undefined
            ? {}
            : { expected_integration_commit: values.expectedIntegrationCommit }),
          ...(values.resultCommit === undefined ? {} : { result_commit: values.resultCommit }),
          ...(values.conflicts === undefined ? {} : { conflicts: values.conflicts }),
          ...(values.validationOutput === undefined ? {} : { validation_output: values.validationOutput }),
          ...(values.error === undefined ? {} : { error: values.error }),
          time_updated: Date.now(),
        })
        .where(eq(TeamSubmissionTable.id, submissionID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({})
      return submissionFromRow(row)
    })

    const submission = Effect.fn("Team.submission")(function* (submissionID: Team.SubmissionID) {
      const row = yield* db
        .select()
        .from(TeamSubmissionTable)
        .where(eq(TeamSubmissionTable.id, submissionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({})
      return submissionFromRow(row)
    })

    const transitionSubmission = Effect.fn("Team.transitionSubmission")(function* (input: {
      submissionID: Team.SubmissionID
      from: ReadonlyArray<Team.SubmissionStatus>
      to: Team.SubmissionStatus
      values?: SubmissionValues
    }) {
      const values = input.values ?? {}
      const row = yield* db
        .update(TeamSubmissionTable)
        .set({
          status: input.to,
          ...(values.sourceCommit === undefined ? {} : { source_commit: values.sourceCommit }),
          ...(values.expectedIntegrationCommit === undefined
            ? {}
            : { expected_integration_commit: values.expectedIntegrationCommit }),
          ...(values.resultCommit === undefined ? {} : { result_commit: values.resultCommit }),
          ...(values.conflicts === undefined ? {} : { conflicts: values.conflicts }),
          ...(values.validationOutput === undefined ? {} : { validation_output: values.validationOutput }),
          ...(values.error === undefined ? {} : { error: values.error }),
          time_updated: Date.now(),
        })
        .where(and(eq(TeamSubmissionTable.id, input.submissionID), inArray(TeamSubmissionTable.status, input.from)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      return row ? submissionFromRow(row) : undefined
    })

    const submissions = (teamID: Team.ID) =>
      db
        .select()
        .from(TeamSubmissionTable)
        .where(eq(TeamSubmissionTable.team_id, teamID))
        .orderBy(asc(TeamSubmissionTable.time_created), asc(TeamSubmissionTable.id))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(submissionFromRow)),
        )

    const advanceIntegration = Effect.fn("Team.advanceIntegration")(function* (
      teamID: Team.ID,
      expected: string,
      result: string,
    ) {
      const updated = yield* db
        .update(TeamTable)
        .set({ integration_commit: result, time_updated: Date.now() })
        .where(and(eq(TeamTable.id, teamID), eq(TeamTable.integration_commit, expected)))
        .returning({ id: TeamTable.id })
        .get()
        .pipe(Effect.orDie)
      return updated !== undefined
    })

    const memberIntegrated = Effect.fn("Team.memberIntegrated")(function* (memberID: Team.MemberID, commit: string) {
      yield* db
        .update(TeamMemberTable)
        .set({ last_integrated_commit: commit, time_updated: Date.now() })
        .where(eq(TeamMemberTable.id, memberID))
        .run()
        .pipe(Effect.orDie)
    })

    const stopMember = Effect.fn("Team.stopMember")(function* (actor: Caller, name: Team.Name) {
      if (!actor.lead && actor.name !== name)
        return yield* new InvalidStateError({ message: "Only the lead can stop another teammate" })
      const team = yield* get(actor.team.id)
      const member = team.members.find((item) => item.name === name)
      if (!member) return yield* new InvalidStateError({ message: `Unknown teammate: ${name}` })
      if (member.status === "stopped") return member
      if (!isActive(team.status)) return yield* new InvalidStateError({ message: `Team is ${team.status}` })
      if (actor.lead ? team.leadSessionID !== actor.sessionID : member.sessionID !== actor.sessionID)
        return yield* new InvalidStateError({ message: "Session cannot stop this teammate" })
      const now = Date.now()
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const stopped = yield* tx
              .update(TeamMemberTable)
              .set({ status: "stopped", error: null, time_updated: now })
              .where(
                and(
                  eq(TeamMemberTable.id, member.id),
                  inArray(TeamMemberTable.status, ["preparing", "running", "idle", "interrupted", "failed"]),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.orDie)
            yield* tx
              .update(TeamTaskTable)
              .set({
                status: "pending",
                assignee_member_id: null,
                version: sql`${TeamTaskTable.version} + 1`,
                time_updated: now,
              })
              .where(
                and(
                  eq(TeamTaskTable.team_id, actor.team.id),
                  eq(TeamTaskTable.assignee_member_id, member.id),
                  inArray(TeamTaskTable.status, ["pending", "in_progress"]),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(TeamMessageTable)
              .set({ status: "rejected", error: "Teammate stopped before message admission", time_updated: now })
              .where(
                and(
                  eq(TeamMessageTable.team_id, actor.team.id),
                  eq(TeamMessageTable.status, "pending"),
                  or(
                    eq(TeamMessageTable.sender_member_id, member.id),
                    eq(TeamMessageTable.recipient_member_id, member.id),
                  ),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(TeamSubmissionTable)
              .set({ status: "cancelled", error: "Teammate stopped before submission applied", time_updated: now })
              .where(
                and(
                  eq(TeamSubmissionTable.team_id, team.id),
                  eq(TeamSubmissionTable.member_id, member.id),
                  inArray(TeamSubmissionTable.status, [
                    "preparing",
                    "queued",
                    "merging",
                    "conflicted",
                    "validating",
                    "validation_failed",
                    "ready",
                    "applying",
                    "stale",
                  ]),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            return stopped
          }),
        )
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ teamID: actor.team.id })
      return memberFromRow(row)
    })

    const close = Effect.fn("Team.close")(function* (actor: Caller) {
      if (!actor.lead) return yield* new InvalidStateError({ message: "Only the lead can close the Team" })
      const current = yield* get(actor.team.id)
      if (current.leadSessionID !== actor.sessionID)
        return yield* new InvalidStateError({ message: "Session is not this Team's lead" })
      if (current.status === "closed") return current
      const now = Date.now()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(TeamTable)
              .set({ status: "closed", time_updated: now })
              .where(eq(TeamTable.id, actor.team.id))
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(TeamMessageTable)
              .set({ status: "rejected", error: "Team closed before message admission", time_updated: now })
              .where(and(eq(TeamMessageTable.team_id, actor.team.id), eq(TeamMessageTable.status, "pending")))
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(TeamMemberTable)
              .set({ status: "stopped", time_updated: now })
              .where(eq(TeamMemberTable.team_id, actor.team.id))
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(TeamSubmissionTable)
              .set({ status: "cancelled", error: "Team closed before submission applied", time_updated: now })
              .where(
                and(
                  eq(TeamSubmissionTable.team_id, actor.team.id),
                  inArray(TeamSubmissionTable.status, [
                    "preparing",
                    "queued",
                    "merging",
                    "conflicted",
                    "validating",
                    "validation_failed",
                    "ready",
                    "applying",
                    "stale",
                  ]),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(TeamTaskTable)
              .set({ status: "cancelled", version: sql`${TeamTaskTable.version} + 1`, time_updated: now })
              .where(
                and(
                  eq(TeamTaskTable.team_id, actor.team.id),
                  inArray(TeamTaskTable.status, ["pending", "in_progress"]),
                ),
              )
              .run()
              .pipe(Effect.orDie)
          }),
        )
        .pipe(Effect.orDie)
      return yield* get(actor.team.id)
    })

    return Service.of({
      reserve,
      get,
      findByLead,
      recoverable: db
        .select()
        .from(TeamTable)
        .where(inArray(TeamTable.status, ["preparing", "active", "degraded"]))
        .orderBy(asc(TeamTable.time_created), asc(TeamTable.id))
        .all()
        .pipe(
          Effect.orDie,
          Effect.flatMap((rows) => Effect.forEach(rows, infoFromRow)),
        ),
      caller,
      reservedMembers,
      memberStatus,
      activate,
      tasks,
      task,
      reserveMessage,
      messageAdmitted,
      messageRejected,
      pendingMessages,
      reserveSubmission,
      submissionStatus,
      submission,
      transitionSubmission,
      submissions,
      advanceIntegration,
      memberIntegrated,
      stopMember,
      close,
    })
  }),
)

function isActive(status: Team.Status) {
  return status === "active" || status === "degraded"
}

function validateReserve(input: ReserveInput): string | undefined {
  if (!input.members.length || input.members.length > Team.MAX_MEMBERS)
    return `Team must have 1-${Team.MAX_MEMBERS} teammates`
  const memberNames = input.members.map((member) => member.name)
  if (memberNames.includes("lead")) return 'Teammate name "lead" is reserved'
  const duplicateMember = memberNames.find((name, index) => memberNames.indexOf(name) !== index)
  if (duplicateMember) return `Duplicate teammate name: ${duplicateMember}`
  const taskKeys = input.tasks.map((task) => task.key)
  const duplicateTask = taskKeys.find((key, index) => taskKeys.indexOf(key) !== index)
  if (duplicateTask) return `Duplicate task key: ${duplicateTask}`
  const unknownAssignee = input.tasks.find((task) => task.assignee && !memberNames.includes(task.assignee))?.assignee
  if (unknownAssignee) return `Unknown task assignee: ${unknownAssignee}`
  const unknownDependency = input.tasks
    .flatMap((task) => task.dependsOn ?? [])
    .find((dependency) => !taskKeys.includes(dependency))
  if (unknownDependency) return `Unknown task dependency: ${unknownDependency}`
  const selfDependent = input.tasks.find((task) => task.dependsOn?.includes(task.key))
  if (selfDependent) return `Task cannot depend on itself: ${selfDependent.key}`
  const dependencies = new Map(input.tasks.map((task) => [task.key, task.dependsOn ?? []]))
  const visited = new Set<Team.Name>()
  const visiting = new Set<Team.Name>()
  const cyclic = (key: Team.Name): boolean => {
    if (visiting.has(key)) return true
    if (visited.has(key)) return false
    visiting.add(key)
    const found = (dependencies.get(key) ?? []).some(cyclic)
    visiting.delete(key)
    visited.add(key)
    return found
  }
  if (taskKeys.some(cyclic)) return "Task dependencies contain a cycle"
  return undefined
}

function matches(team: typeof TeamTable.$inferSelect, input: ReserveInput) {
  return (
    team.lead_session_id === input.leadSessionID &&
    team.project_id === input.projectID &&
    team.target_branch === input.targetBranch &&
    team.base_commit === input.baseCommit &&
    isDeepStrictEqual(team.location, input.location) &&
    isDeepStrictEqual(team.spawn_input, {
      members: input.members,
      tasks: input.tasks,
      validation: input.validation,
    })
  )
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
