import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801032847_team-collaboration",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`team_member\` (
          \`id\` text PRIMARY KEY,
          \`team_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`prompt_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`name\` text NOT NULL,
          \`role\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`model\` text NOT NULL,
          \`permission\` text NOT NULL,
          \`status\` text NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`branch\` text NOT NULL,
          \`base_commit\` text NOT NULL,
          \`last_integrated_commit\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_member_team_id_team_id_fk\` FOREIGN KEY (\`team_id\`) REFERENCES \`team\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_message\` (
          \`id\` text PRIMARY KEY,
          \`team_id\` text NOT NULL,
          \`sender_member_id\` text NOT NULL,
          \`sender_session_id\` text NOT NULL,
          \`recipient_member_id\` text NOT NULL,
          \`recipient_session_id\` text NOT NULL,
          \`target_prompt_id\` text NOT NULL,
          \`parent_assistant_message_id\` text NOT NULL,
          \`parent_tool_call_id\` text NOT NULL,
          \`body\` text NOT NULL,
          \`status\` text NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_message_team_id_team_id_fk\` FOREIGN KEY (\`team_id\`) REFERENCES \`team\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_submission\` (
          \`id\` text PRIMARY KEY,
          \`team_id\` text NOT NULL,
          \`member_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`parent_assistant_message_id\` text NOT NULL,
          \`parent_tool_call_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`base_commit\` text NOT NULL,
          \`source_commit\` text,
          \`expected_integration_commit\` text NOT NULL,
          \`result_commit\` text,
          \`conflicts\` text NOT NULL,
          \`validation_output\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_submission_team_id_team_id_fk\` FOREIGN KEY (\`team_id\`) REFERENCES \`team\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team\` (
          \`id\` text PRIMARY KEY,
          \`lead_session_id\` text NOT NULL,
          \`lead_member_id\` text NOT NULL,
          \`parent_assistant_message_id\` text NOT NULL,
          \`parent_tool_call_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`location\` text NOT NULL,
          \`target_branch\` text NOT NULL,
          \`base_commit\` text NOT NULL,
          \`integration_commit\` text NOT NULL,
          \`status\` text NOT NULL,
          \`validation\` text NOT NULL,
          \`spawn_input\` text NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_lead_session_id_session_id_fk\` FOREIGN KEY (\`lead_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_task\` (
          \`id\` text PRIMARY KEY,
          \`team_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text NOT NULL,
          \`status\` text NOT NULL,
          \`assignee_member_id\` text,
          \`depends_on\` text NOT NULL,
          \`version\` integer DEFAULT 0 NOT NULL,
          \`summary\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_task_team_id_team_id_fk\` FOREIGN KEY (\`team_id\`) REFERENCES \`team\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_member_team_name_idx\` ON \`team_member\` (\`team_id\`,\`name\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_member_session_idx\` ON \`team_member\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_member_workspace_idx\` ON \`team_member\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_member_directory_idx\` ON \`team_member\` (\`directory\`);`)
      yield* tx.run(`CREATE INDEX \`team_member_team_status_idx\` ON \`team_member\` (\`team_id\`,\`status\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`team_message_sender_invocation_idx\` ON \`team_message\` (\`sender_session_id\`,\`parent_assistant_message_id\`,\`parent_tool_call_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`team_message_target_prompt_idx\` ON \`team_message\` (\`target_prompt_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`team_message_recipient_status_idx\` ON \`team_message\` (\`recipient_session_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`team_submission_member_invocation_idx\` ON \`team_submission\` (\`member_id\`,\`parent_assistant_message_id\`,\`parent_tool_call_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`team_submission_active_task_member_idx\` ON \`team_submission\` (\`member_id\`,\`task_id\`) WHERE "team_submission"."status" in ('preparing', 'queued', 'merging', 'validating', 'ready', 'applying');`,
      )
      yield* tx.run(
        `CREATE INDEX \`team_submission_team_status_idx\` ON \`team_submission\` (\`team_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`team_submission_task_idx\` ON \`team_submission\` (\`task_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_lead_session_idx\` ON \`team\` (\`lead_session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`team_parent_invocation_idx\` ON \`team\` (\`lead_session_id\`,\`parent_assistant_message_id\`,\`parent_tool_call_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`team_status_created_idx\` ON \`team\` (\`status\`,\`time_created\`,\`id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_task_team_key_idx\` ON \`team_task\` (\`team_id\`,\`key\`);`)
      yield* tx.run(
        `CREATE INDEX \`team_task_team_status_idx\` ON \`team_task\` (\`team_id\`,\`status\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
