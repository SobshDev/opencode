export * as Team from "./team"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { Location } from "./location"
import { Model } from "./model"
import { Project } from "./project"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessageID } from "./session-message-id"

const id = <Brand extends string>(prefix: string, brand: Brand) =>
  Schema.String.check(Schema.isStartsWith(prefix)).pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )

export const ID = id("tem_", "Team.ID")
export type ID = typeof ID.Type

export const MemberID = id("mem_", "Team.MemberID")
export type MemberID = typeof MemberID.Type

export const MessageID = id("tmg_", "Team.MessageID")
export type MessageID = typeof MessageID.Type

export const TaskID = id("ttk_", "Team.TaskID")
export type TaskID = typeof TaskID.Type

export const WorkspaceID = id("tws_", "Team.WorkspaceID")
export type WorkspaceID = typeof WorkspaceID.Type

export const SubmissionID = id("sub_", "Team.SubmissionID")
export type SubmissionID = typeof SubmissionID.Type

export const MAX_MEMBERS = 5
export const MAX_PENDING_MESSAGES = 32
export const MAX_MESSAGE_LENGTH = 32_000

export const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,30}$/)).annotate({
  identifier: "Team.Name",
})
export type Name = typeof Name.Type

export const MemberName = Schema.String.check(Schema.isPattern(/^(?!lead$)[a-z][a-z0-9-]{0,30}$/)).annotate({
  identifier: "Team.MemberName",
})
export type MemberName = typeof MemberName.Type

export const Status = Schema.Literals([
  "preparing",
  "active",
  "degraded",
  "shutting_down",
  "closed",
  "failed",
]).annotate({ identifier: "Team.Status" })
export type Status = typeof Status.Type

export const MemberStatus = Schema.Literals([
  "preparing",
  "running",
  "idle",
  "interrupted",
  "stopped",
  "failed",
]).annotate({ identifier: "Team.MemberStatus" })
export type MemberStatus = typeof MemberStatus.Type

export const MemberRole = Schema.Literals(["lead", "teammate"]).annotate({ identifier: "Team.MemberRole" })
export type MemberRole = typeof MemberRole.Type

export const TaskStatus = Schema.Literals(["pending", "in_progress", "stale", "completed", "cancelled"]).annotate({
  identifier: "Team.TaskStatus",
})
export type TaskStatus = typeof TaskStatus.Type

export const SubmissionStatus = Schema.Literals([
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
]).annotate({ identifier: "Team.SubmissionStatus" })
export type SubmissionStatus = typeof SubmissionStatus.Type

export interface Origin extends Schema.Schema.Type<typeof Origin> {}
export const Origin = Schema.Struct({
  type: Schema.Literal("team_member"),
  teamID: ID,
  memberID: MemberID,
  leadSessionID: SessionID,
  parentAssistantMessageID: SessionMessageID,
  parentToolCallID: Schema.String,
}).annotate({ identifier: "Team.Origin" })

export interface MemberSpec extends Schema.Schema.Type<typeof MemberSpec> {}
export const MemberSpec = Schema.Struct({
  name: MemberName,
  model: Model.Ref,
  prompt: Schema.String.check(Schema.isMinLength(1)),
}).annotate({ identifier: "Team.MemberSpec" })

export interface TaskSeed extends Schema.Schema.Type<typeof TaskSeed> {}
export const TaskSeed = Schema.Struct({
  key: Name,
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.String.check(Schema.isMinLength(1)),
  assignee: MemberName.pipe(optional),
  dependsOn: Schema.Array(Name).pipe(optional),
}).annotate({ identifier: "Team.TaskSeed" })

export interface SpawnInput extends Schema.Schema.Type<typeof SpawnInput> {}
export const SpawnInput = Schema.Struct({
  members: Schema.Array(MemberSpec).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_MEMBERS)),
  tasks: Schema.Array(TaskSeed).pipe(optional),
  validation: Schema.Array(Schema.String.check(Schema.isMinLength(1))).pipe(optional),
}).annotate({ identifier: "Team.SpawnInput" })

export interface Member extends Schema.Schema.Type<typeof Member> {}
export const Member = Schema.Struct({
  id: MemberID,
  teamID: ID,
  sessionID: SessionID,
  name: MemberName,
  role: MemberRole,
  model: Model.Ref,
  status: MemberStatus,
  workspaceID: WorkspaceID,
  directory: Schema.String,
  branch: Schema.String,
  baseCommit: Schema.String,
  lastIntegratedCommit: Schema.String.pipe(optional),
  error: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Team.Member" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  leadSessionID: SessionID,
  leadMemberID: MemberID,
  parentAssistantMessageID: SessionMessageID,
  parentToolCallID: Schema.String,
  projectID: Project.ID,
  location: Location.Ref,
  targetBranch: Schema.String,
  baseCommit: Schema.String,
  integrationCommit: Schema.String,
  status: Status,
  validation: Schema.Array(Schema.String),
  members: Schema.Array(Member),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Team.Info" })

export interface Task extends Schema.Schema.Type<typeof Task> {}
export const Task = Schema.Struct({
  id: TaskID,
  teamID: ID,
  key: Name,
  title: Schema.String,
  description: Schema.String,
  status: TaskStatus,
  assignee: MemberID.pipe(optional),
  dependsOn: Schema.Array(TaskID),
  version: NonNegativeInt,
  summary: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Team.Task" })

export interface Submission extends Schema.Schema.Type<typeof Submission> {}
export const Submission = Schema.Struct({
  id: SubmissionID,
  teamID: ID,
  memberID: MemberID,
  taskID: TaskID,
  status: SubmissionStatus,
  baseCommit: Schema.String,
  sourceCommit: Schema.String.pipe(optional),
  expectedIntegrationCommit: Schema.String,
  resultCommit: Schema.String.pipe(optional),
  conflicts: Schema.Array(Schema.String),
  validationOutput: Schema.String.pipe(optional),
  error: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Team.Submission" })

export interface SpawnResult extends Schema.Schema.Type<typeof SpawnResult> {}
export const SpawnResult = Schema.Struct({
  team: Info,
}).annotate({ identifier: "Team.SpawnResult" })

export interface SendInput extends Schema.Schema.Type<typeof SendInput> {}
export const SendInput = Schema.Struct({
  to: Name,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_MESSAGE_LENGTH)),
}).annotate({ identifier: "Team.SendInput" })

export interface SendResult extends Schema.Schema.Type<typeof SendResult> {}
export const SendResult = Schema.Struct({
  messageID: MessageID,
  recipient: MemberID,
  admitted: Schema.Boolean,
}).annotate({ identifier: "Team.SendResult" })

const TaskCreate = Schema.Struct({
  action: Schema.Literal("create"),
  key: Name,
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.String.check(Schema.isMinLength(1)),
  assignee: MemberName.pipe(optional),
  dependsOn: Schema.Array(TaskID).pipe(optional),
})
const TaskClaim = Schema.Struct({ action: Schema.Literal("claim"), taskID: TaskID })
const TaskComplete = Schema.Struct({
  action: Schema.Literal("complete"),
  taskID: TaskID,
  summary: Schema.String.check(Schema.isMinLength(1)),
})
const TaskRelease = Schema.Struct({ action: Schema.Literal("release"), taskID: TaskID })
const TaskCancel = Schema.Struct({ action: Schema.Literal("cancel"), taskID: TaskID })

export const TaskInput = Schema.Union([TaskCreate, TaskClaim, TaskComplete, TaskRelease, TaskCancel])
  .pipe(Schema.toTaggedUnion("action"))
  .annotate({ identifier: "Team.TaskInput" })
export type TaskInput = typeof TaskInput.Type

export interface TaskResult extends Schema.Schema.Type<typeof TaskResult> {}
export const TaskResult = Schema.Struct({ task: Task }).annotate({ identifier: "Team.TaskResult" })

export interface SubmitInput extends Schema.Schema.Type<typeof SubmitInput> {}
export const SubmitInput = Schema.Struct({ taskID: TaskID }).annotate({ identifier: "Team.SubmitInput" })

export interface SubmitResult extends Schema.Schema.Type<typeof SubmitResult> {}
export const SubmitResult = Schema.Struct({ submission: Submission }).annotate({ identifier: "Team.SubmitResult" })

export interface SyncResult extends Schema.Schema.Type<typeof SyncResult> {}
export const SyncResult = Schema.Struct({
  member: Member,
  conflicts: Schema.Array(Schema.String),
}).annotate({ identifier: "Team.SyncResult" })

export interface StatusResult extends Schema.Schema.Type<typeof StatusResult> {}
export const StatusResult = Schema.Struct({
  team: Info,
  tasks: Schema.Array(Task),
  submissions: Schema.Array(Submission),
}).annotate({ identifier: "Team.StatusResult" })

export interface StopInput extends Schema.Schema.Type<typeof StopInput> {}
export const StopInput = Schema.Struct({
  member: MemberName.pipe(optional),
  force: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Team.StopInput" })

export interface StopResult extends Schema.Schema.Type<typeof StopResult> {}
export const StopResult = Schema.Struct({ team: Info }).annotate({ identifier: "Team.StopResult" })
