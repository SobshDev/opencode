import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730234026_model-call",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `session` ADD `origin` text;")
      yield* tx.run("ALTER TABLE `session` ADD `permission_v2` text;")
      yield* tx.run(`
        CREATE TABLE \`model_call\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`parent_assistant_message_id\` text NOT NULL,
          \`parent_tool_call_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`child_prompt_id\` text NOT NULL,
          \`correction_prompt_id\` text NOT NULL,
          \`completion_message_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`requested_model\` text NOT NULL,
          \`actual_model\` text NOT NULL,
          \`location\` text NOT NULL,
          \`permission\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`system\` text,
          \`output_schema\` text,
          \`runtime\` text NOT NULL,
          \`requested_background\` integer NOT NULL,
          \`background\` integer NOT NULL,
          \`depth\` integer NOT NULL,
          \`slot\` integer,
          \`status\` text NOT NULL,
          \`text\` text,
          \`structured\` text,
          \`error\` text,
          \`usage\` text,
          \`validation_attempts\` integer DEFAULT 0 NOT NULL,
          \`delivered_at\` integer,
          \`time_queued\` integer,
          \`time_started\` integer,
          \`time_completed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_model_call_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`model_call_parent_invocation_idx\` ON \`model_call\` (\`parent_session_id\`,\`parent_assistant_message_id\`,\`parent_tool_call_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`model_call_child_session_idx\` ON \`model_call\` (\`child_session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`model_call_parent_slot_idx\` ON \`model_call\` (\`parent_session_id\`,\`slot\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`model_call_parent_created_idx\` ON \`model_call\` (\`parent_session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`model_call_status_created_idx\` ON \`model_call\` (\`status\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
