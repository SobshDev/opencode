import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Location } from "@opencode-ai/schema/location"
import type { Model } from "@opencode-ai/schema/model"
import type { Permission } from "@opencode-ai/schema/permission"
import type { Project } from "@opencode-ai/schema/project"
import type { Session } from "@opencode-ai/schema/session"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Team } from "@opencode-ai/schema/team"
import { Timestamps } from "./database/schema.sql"
import { SessionTable } from "./session/sql"

export const TeamTable = sqliteTable(
  "team",
  {
    id: text().$type<Team.ID>().primaryKey(),
    lead_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    lead_member_id: text().$type<Team.MemberID>().notNull(),
    parent_assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    parent_tool_call_id: text().notNull(),
    project_id: text().$type<Project.ID>().notNull(),
    location: text({ mode: "json" }).$type<Location.Ref>().notNull(),
    target_branch: text().notNull(),
    base_commit: text().notNull(),
    integration_commit: text().notNull(),
    status: text({ enum: ["preparing", "active", "degraded", "shutting_down", "closed", "failed"] })
      .$type<Team.Status>()
      .notNull(),
    validation: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    spawn_input: text({ mode: "json" })
      .$type<{
        members: readonly ReserveMemberInput[]
        tasks: readonly Team.TaskSeed[]
        validation: readonly string[]
      }>()
      .notNull(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("team_lead_session_idx").on(table.lead_session_id),
    uniqueIndex("team_parent_invocation_idx").on(
      table.lead_session_id,
      table.parent_assistant_message_id,
      table.parent_tool_call_id,
    ),
    index("team_status_created_idx").on(table.status, table.time_created, table.id),
  ],
)

type ReserveMemberInput = {
  readonly name: Team.Name
  readonly model: Model.Ref
  readonly prompt: string
}

export const TeamMemberTable = sqliteTable(
  "team_member",
  {
    id: text().$type<Team.MemberID>().primaryKey(),
    team_id: text()
      .$type<Team.ID>()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    session_id: text().$type<Session.ID>().notNull(),
    prompt_id: text().$type<SessionMessage.ID>().notNull(),
    prompt: text().notNull(),
    name: text().$type<Team.Name>().notNull(),
    role: text({ enum: ["teammate"] }).notNull(),
    agent_id: text().$type<Agent.ID>().notNull(),
    model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    permission: text({ mode: "json" }).$type<Permission.Ruleset>().notNull(),
    status: text({ enum: ["preparing", "running", "idle", "interrupted", "stopped", "failed"] })
      .$type<Team.MemberStatus>()
      .notNull(),
    workspace_id: text().$type<Team.WorkspaceID>().notNull(),
    directory: text().notNull(),
    branch: text().notNull(),
    base_commit: text().notNull(),
    last_integrated_commit: text(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("team_member_team_name_idx").on(table.team_id, table.name),
    uniqueIndex("team_member_session_idx").on(table.session_id),
    uniqueIndex("team_member_workspace_idx").on(table.workspace_id),
    uniqueIndex("team_member_directory_idx").on(table.directory),
    index("team_member_team_status_idx").on(table.team_id, table.status),
  ],
)

export const TeamMessageTable = sqliteTable(
  "team_message",
  {
    id: text().$type<Team.MessageID>().primaryKey(),
    team_id: text()
      .$type<Team.ID>()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    sender_member_id: text().$type<Team.MemberID>().notNull(),
    sender_session_id: text().$type<Session.ID>().notNull(),
    recipient_member_id: text().$type<Team.MemberID>().notNull(),
    recipient_session_id: text().$type<Session.ID>().notNull(),
    target_prompt_id: text().$type<SessionMessage.ID>().notNull(),
    parent_assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    parent_tool_call_id: text().notNull(),
    body: text().notNull(),
    status: text({ enum: ["pending", "admitted", "rejected"] }).notNull(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("team_message_sender_invocation_idx").on(
      table.sender_session_id,
      table.parent_assistant_message_id,
      table.parent_tool_call_id,
    ),
    uniqueIndex("team_message_target_prompt_idx").on(table.target_prompt_id),
    index("team_message_recipient_status_idx").on(table.recipient_session_id, table.status, table.time_created),
  ],
)

export const TeamTaskTable = sqliteTable(
  "team_task",
  {
    id: text().$type<Team.TaskID>().primaryKey(),
    team_id: text()
      .$type<Team.ID>()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    key: text().$type<Team.Name>().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    status: text({ enum: ["pending", "in_progress", "stale", "completed", "cancelled"] })
      .$type<Team.TaskStatus>()
      .notNull(),
    assignee_member_id: text().$type<Team.MemberID>(),
    depends_on: text({ mode: "json" }).$type<readonly Team.TaskID[]>().notNull(),
    version: integer().notNull().default(0),
    summary: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("team_task_team_key_idx").on(table.team_id, table.key),
    index("team_task_team_status_idx").on(table.team_id, table.status, table.time_created),
  ],
)

export const TeamSubmissionTable = sqliteTable(
  "team_submission",
  {
    id: text().$type<Team.SubmissionID>().primaryKey(),
    team_id: text()
      .$type<Team.ID>()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    member_id: text().$type<Team.MemberID>().notNull(),
    task_id: text().$type<Team.TaskID>().notNull(),
    parent_assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    parent_tool_call_id: text().notNull(),
    status: text({
      enum: [
        "preparing",
        "queued",
        "merging",
        "conflicted",
        "validating",
        "validation_failed",
        "ready",
        "applying",
        "applied",
        "stale",
        "failed",
        "cancelled",
      ],
    })
      .$type<Team.SubmissionStatus>()
      .notNull(),
    base_commit: text().notNull(),
    source_commit: text(),
    expected_integration_commit: text().notNull(),
    result_commit: text(),
    conflicts: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    validation_output: text(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("team_submission_member_invocation_idx").on(
      table.member_id,
      table.parent_assistant_message_id,
      table.parent_tool_call_id,
    ),
    uniqueIndex("team_submission_active_task_member_idx")
      .on(table.member_id, table.task_id)
      .where(sql`${table.status} in ('preparing', 'queued', 'merging', 'validating', 'ready', 'applying')`),
    index("team_submission_team_status_idx").on(table.team_id, table.status, table.time_created),
    index("team_submission_task_idx").on(table.task_id, table.time_created),
  ],
)
