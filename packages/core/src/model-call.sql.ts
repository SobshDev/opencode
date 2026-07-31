import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ModelCall } from "@opencode-ai/schema/model-call"
import type { Location } from "@opencode-ai/schema/location"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import { Timestamps } from "./database/schema.sql"
import { SessionTable } from "./session/sql"

export const ModelCallTable = sqliteTable(
  "model_call",
  {
    id: text().$type<ModelCall.CallID>().primaryKey(),
    parent_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    parent_tool_call_id: text().notNull(),
    // The call record reserves this identity before the child Session is created.
    child_session_id: text().$type<Session.ID>().notNull(),
    child_prompt_id: text().$type<SessionMessage.ID>().notNull(),
    correction_prompt_id: text().$type<SessionMessage.ID>().notNull(),
    completion_message_id: text().$type<SessionMessage.ID>().notNull(),
    agent_id: text().notNull(),
    requested_model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    actual_model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    location: text({ mode: "json" }).$type<Location.Ref>().notNull(),
    permission: text({ mode: "json" }).$type<ModelCall.PermissionSnapshot>().notNull(),
    prompt: text().notNull(),
    system: text(),
    output_schema: text({ mode: "json" }).$type<Record<string, unknown>>(),
    runtime: text({ enum: ["legacy", "v2"] }).notNull(),
    requested_background: integer({ mode: "boolean" }).notNull(),
    background: integer({ mode: "boolean" }).notNull(),
    depth: integer().notNull(),
    slot: integer(),
    status: text({
      enum: ["preparing", "queued", "running", "completed", "failed", "cancelled", "interrupted"],
    })
      .$type<ModelCall.Status>()
      .notNull(),
    text: text(),
    structured: text({ mode: "json" }).$type<unknown>(),
    error: text({ mode: "json" }).$type<ModelCall.Error>(),
    usage: text({ mode: "json" }).$type<ModelCall.Usage>(),
    validation_attempts: integer().notNull().default(0),
    delivered_at: integer(),
    time_queued: integer(),
    time_started: integer(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("model_call_parent_invocation_idx").on(
      table.parent_session_id,
      table.parent_assistant_message_id,
      table.parent_tool_call_id,
    ),
    uniqueIndex("model_call_child_session_idx").on(table.child_session_id),
    uniqueIndex("model_call_parent_slot_idx").on(table.parent_session_id, table.slot),
    index("model_call_parent_created_idx").on(table.parent_session_id, table.time_created, table.id),
    index("model_call_status_created_idx").on(table.status, table.time_created, table.id),
  ],
)
