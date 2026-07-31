import type { Event, Message, Part, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import * as Locale from "@/util/locale"
import {
  bootstrapSessionData,
  createSessionData,
  formatError,
  reduceSessionData,
  type SessionData,
} from "./session-data"
import type { FooterSubagentState, FooterSubagentTab, StreamCommit } from "./types"

export const SUBAGENT_BOOTSTRAP_LIMIT = 200
export const SUBAGENT_CALL_BOOTSTRAP_LIMIT = 80

const SUBAGENT_COMMIT_LIMIT = 80
const SUBAGENT_CALL_LIMIT = 32
const SUBAGENT_ROLE_LIMIT = 32
const SUBAGENT_ERROR_LIMIT = 16
const SUBAGENT_ECHO_LIMIT = 8

type SessionMessage = {
  parts: Part[]
}

type BootstrapChildMessage = SessionMessage & {
  info: Message
}

type Frame = {
  key: string
  commit: StreamCommit
}

type DetailState = {
  sessionID: string
  data: SessionData
  frames: Frame[]
}

export type SubagentData = {
  tabs: Map<string, FooterSubagentTab>
  details: Map<string, DetailState>
}

export type BootstrapSubagentInput = {
  data: SubagentData
  messages: SessionMessage[]
  children: Array<{
    id: string
    title?: string
    model?: unknown
    metadata?: unknown
    origin?: unknown
    cost?: unknown
    tokens?: unknown
  }>
  modelCalls?: unknown[]
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}

function createDetail(sessionID: string): DetailState {
  return {
    sessionID,
    data: createSessionData({
      includeUserText: true,
    }),
    frames: [],
  }
}

function ensureDetail(data: SubagentData, sessionID: string) {
  const current = data.details.get(sessionID)
  if (current) {
    return current
  }

  const next = createDetail(sessionID)
  data.details.set(sessionID, next)
  return next
}

export function sameSubagentTab(a: FooterSubagentTab | undefined, b: FooterSubagentTab | undefined) {
  if (!a || !b) {
    return false
  }

  return (
    a.sessionID === b.sessionID &&
    a.partID === b.partID &&
    a.callID === b.callID &&
    a.kind === b.kind &&
    a.modelCallID === b.modelCallID &&
    a.modelCallParentSessionID === b.modelCallParentSessionID &&
    a.label === b.label &&
    a.description === b.description &&
    a.status === b.status &&
    a.model === b.model &&
    a.mode === b.mode &&
    a.usage === b.usage &&
    a.error === b.error &&
    a.background === b.background &&
    a.title === b.title &&
    a.toolCalls === b.toolCalls &&
    a.lastUpdatedAt === b.lastUpdatedAt
  )
}

function sameQueue<T extends { id: string }>(left: T[], right: T[]) {
  return (
    left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item === right[index])
  )
}

function queueSnapshot(data: SessionData) {
  return {
    permissions: data.permissions.slice(),
    questions: data.questions.slice(),
  }
}

function queueChanged(data: SessionData, before: ReturnType<typeof queueSnapshot>) {
  return !sameQueue(before.permissions, data.permissions) || !sameQueue(before.questions, data.questions)
}

function sameCommit(left: StreamCommit, right: StreamCommit) {
  return (
    left.kind === right.kind &&
    left.text === right.text &&
    left.phase === right.phase &&
    left.source === right.source &&
    left.messageID === right.messageID &&
    left.partID === right.partID &&
    left.tool === right.tool &&
    left.interrupted === right.interrupted &&
    left.toolState === right.toolState &&
    left.toolError === right.toolError
  )
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const next = value.trim()
  return next || undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function modelLabel(value: unknown): string | undefined {
  const model = record(value)
  const providerID = text(model?.providerID)
  const id = text(model?.id) ?? text(model?.modelID)
  if (!providerID || !id) {
    return undefined
  }

  const variant = text(model?.variant)
  return `${providerID}/${id}${variant && variant !== "default" ? ` (${variant})` : ""}`
}

function usageLabel(value: unknown): string | undefined {
  const usage = record(value)
  if (!usage) {
    return undefined
  }

  const tokens = record(usage.tokens)
  const cache = record(tokens?.cache)
  const total =
    (num(tokens?.input) ?? 0) +
    (num(tokens?.output) ?? 0) +
    (num(tokens?.reasoning) ?? 0) +
    (num(cache?.read) ?? 0) +
    (num(cache?.write) ?? 0)
  const cost = num(usage.cost)
  const values = [
    total > 0 ? `${Locale.number(total)} tokens` : undefined,
    cost && cost > 0 ? costLabel(cost) : undefined,
  ]
  const label = values.filter((item): item is string => Boolean(item)).join(" · ")
  return label || undefined
}

function costLabel(cost: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cost < 0.01 ? 4 : 2,
    maximumFractionDigits: cost < 0.01 ? 4 : 2,
  }).format(cost)
}

function errorLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return text(value)
  }

  return text(record(value)?.message)
}

const modelCallStatuses = new Set<FooterSubagentTab["status"]>([
  "preparing",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
])

function modelCallStatus(value: unknown): FooterSubagentTab["status"] | undefined {
  const status = text(value) as FooterSubagentTab["status"] | undefined
  return status && modelCallStatuses.has(status) ? status : undefined
}

function activeStatus(status: FooterSubagentTab["status"]) {
  return status === "preparing" || status === "queued" || status === "running"
}

function statusRank(status: FooterSubagentTab["status"]) {
  if (status === "preparing") return 0
  if (status === "queued") return 1
  if (status === "running") return 2
  return 3
}

function inputLabel(input: Record<string, unknown>): string | undefined {
  const description = text(input.description)
  if (description) {
    return description
  }

  const command = text(input.command)
  if (command) {
    return command
  }

  const filePath = text(input.filePath) ?? text(input.filepath)
  if (filePath) {
    return filePath
  }

  const pattern = text(input.pattern)
  if (pattern) {
    return pattern
  }

  const query = text(input.query)
  if (query) {
    return query
  }

  const url = text(input.url)
  if (url) {
    return url
  }

  const path = text(input.path)
  if (path) {
    return path
  }

  const prompt = text(input.prompt)
  if (prompt) {
    return prompt
  }

  return undefined
}

function stateTitle(part: ToolPart) {
  return text("title" in part.state ? part.state.title : undefined)
}

function callKey(messageID: string | undefined, callID: string | undefined): string | undefined {
  if (!messageID || !callID) {
    return undefined
  }

  return `${messageID}:${callID}`
}

function compactToolState(part: ToolPart): ToolPart["state"] {
  if (part.state.status === "pending") {
    return {
      status: "pending",
      input: part.state.input,
      raw: part.state.raw,
    }
  }

  if (part.state.status === "running") {
    return {
      status: "running",
      input: part.state.input,
      time: part.state.time,
      ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
      ...(part.state.title ? { title: part.state.title } : {}),
    }
  }

  if (part.state.status === "completed") {
    return {
      status: "completed",
      input: part.state.input,
      output: part.state.output,
      title: part.state.title,
      metadata: part.state.metadata,
      time: part.state.time,
    }
  }

  return {
    status: "error",
    input: part.state.input,
    error: part.state.error,
    time: part.state.time,
    ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
  }
}

function recent<T>(input: Iterable<T>, limit: number) {
  const list = [...input]
  return list.slice(Math.max(0, list.length - limit))
}

function copyMap<K, V>(source: Map<K, V>, keep: Set<K>) {
  const out = new Map<K, V>()
  for (const [key, value] of source) {
    if (!keep.has(key)) {
      continue
    }

    out.set(key, value)
  }
  return out
}

function compactToolPart(part: ToolPart): ToolPart {
  return {
    id: part.id,
    type: "tool",
    sessionID: part.sessionID,
    messageID: part.messageID,
    callID: part.callID,
    tool: part.tool,
    state: compactToolState(part),
    ...(part.metadata ? { metadata: part.metadata } : {}),
  }
}

function compactCommit(commit: StreamCommit): StreamCommit {
  if (!commit.part) {
    return commit
  }

  return {
    ...commit,
    part: compactToolPart(commit.part),
  }
}

function stateUpdatedAt(part: ToolPart) {
  if (!("time" in part.state)) {
    return Date.now()
  }

  const time = part.state.time
  if (!("end" in time)) {
    return time.start ?? Date.now()
  }

  return time.end ?? time.start ?? Date.now()
}

function metadata(part: ToolPart, key: string) {
  return ("metadata" in part.state ? part.state.metadata?.[key] : undefined) ?? part.metadata?.[key]
}

function taskStatus(part: ToolPart): FooterSubagentTab["status"] {
  if (part.state.status === "completed") {
    return "completed"
  }

  if (part.state.status === "error") {
    if (metadata(part, "interrupted") === true || text(part.state.error) === "Tool execution aborted") {
      return "cancelled"
    }

    return "error"
  }

  return "running"
}

function taskTab(part: ToolPart, sessionID: string): FooterSubagentTab {
  const label = Locale.titlecase(text(part.state.input.subagent_type) ?? "general")
  const description = text(part.state.input.description) ?? stateTitle(part) ?? inputLabel(part.state.input) ?? ""

  return {
    sessionID,
    partID: part.id,
    callID: part.callID,
    kind: "task",
    label,
    description,
    status: taskStatus(part),
    background: metadata(part, "background") === true,
    title: stateTitle(part),
    toolCalls: num(metadata(part, "toolcalls")) ?? num(metadata(part, "toolCalls")) ?? num(metadata(part, "calls")),
    lastUpdatedAt: stateUpdatedAt(part),
  }
}

function childSessionID(part: ToolPart) {
  return text(metadata(part, "sessionId")) ?? text(metadata(part, "sessionID"))
}

function typedModelCallOrigin(child: BootstrapSubagentInput["children"][number]) {
  const origin = record(child.origin)
  if (
    origin?.type !== "model_call" ||
    !text(origin.callID) ||
    !text(origin.parentSessionID) ||
    !text(origin.parentAssistantMessageID) ||
    !text(origin.parentToolCallID)
  ) {
    return undefined
  }
  return origin
}

function matchingModelCallMetadata(
  child: BootstrapSubagentInput["children"][number],
  origin: Record<string, unknown>,
) {
  const value = record(record(child.metadata)?.modelCall)
  if (!value || text(value.callID) !== text(origin.callID)) return undefined
  if (text(value.parentSessionID) && text(value.parentSessionID) !== text(origin.parentSessionID)) return undefined
  if (
    text(value.parentAssistantMessageID) &&
    text(value.parentAssistantMessageID) !== text(origin.parentAssistantMessageID)
  )
    return undefined
  if (text(value.parentToolCallID) && text(value.parentToolCallID) !== text(origin.parentToolCallID)) return undefined
  if (value.requestedModel && !sameModelRef(value.requestedModel, origin.requestedModel)) return undefined
  return value
}

function sameModelRef(left: unknown, right: unknown) {
  const a = record(left)
  const b = record(right)
  return (
    text(a?.providerID) === text(b?.providerID) &&
    text(a?.id) === text(b?.id) &&
    (text(a?.variant) ?? "default") === (text(b?.variant) ?? "default")
  )
}

function matchingToolMetadata(part: ToolPart, callID: string) {
  const value = "metadata" in part.state ? record(part.state.metadata) : undefined
  return text(value?.callID) === callID ? value : undefined
}

function modelCallTab(
  part: ToolPart,
  child: BootstrapSubagentInput["children"][number],
  origin: Record<string, unknown>,
): FooterSubagentTab {
  const callID = text(origin.callID)!
  const trusted = matchingToolMetadata(part, callID)
  const model = modelLabel(trusted?.actualModel) ?? modelLabel(child.model) ?? modelLabel(part.state.input.model) ?? "Model"
  const status =
    modelCallStatus(trusted?.status) ??
    (part.state.status === "error"
      ? trusted?.interrupted === true || text(part.state.error) === "Tool execution aborted"
        ? "interrupted"
        : "failed"
      : part.state.status === "completed"
        ? "completed"
        : "running")
  const background = trusted?.background === true || part.state.input.background === true
  const prompt = text(part.state.input.prompt)?.split(/\r?\n/, 1)[0]

  return {
    sessionID: child.id,
    partID: part.id,
    callID: part.callID,
    kind: "model_call",
    modelCallID: callID,
    modelCallParentSessionID: text(origin.parentSessionID),
    label: model,
    model,
    description: stateTitle(part) ?? prompt ?? model,
    status,
    mode: background ? "background" : "foreground",
    background,
    usage: usageLabel(trusted?.usage),
    error: errorLabel(trusted?.error) ?? (part.state.status === "error" ? text(part.state.error) : undefined),
    title: stateTitle(part),
    lastUpdatedAt: stateUpdatedAt(part),
  }
}

function syncChildTab(data: SubagentData, part: ToolPart, children?: Set<string>) {
  if (part.tool !== "task") {
    return false
  }

  const sessionID = childSessionID(part)
  if (!sessionID) {
    return false
  }

  if (children && children.size > 0 && !children.has(sessionID)) {
    return false
  }

  const next = taskTab(part, sessionID)
  if (sameSubagentTab(data.tabs.get(sessionID), next)) {
    ensureDetail(data, sessionID)
    return false
  }

  data.tabs.set(sessionID, next)
  ensureDetail(data, sessionID)
  return true
}

function syncModelCallToolTab(
  data: SubagentData,
  part: ToolPart,
  child: BootstrapSubagentInput["children"][number] | undefined,
) {
  if (part.tool !== "model_call" || !child) return false
  const origin = typedModelCallOrigin(child)
  if (
    !origin ||
    text(origin.parentToolCallID) !== part.callID ||
    text(origin.parentAssistantMessageID) !== part.messageID
  )
    return false
  const next = modelCallTab(part, child, origin)
  const current = data.tabs.get(child.id)
  const merged = current
    ? {
        ...current,
        ...next,
        status: statusRank(current.status) > statusRank(next.status) ? current.status : next.status,
        usage: next.usage ?? current.usage,
        error: next.error ?? current.error,
      }
    : next
  if (sameSubagentTab(current, merged)) {
    ensureDetail(data, child.id)
    return false
  }
  data.tabs.set(child.id, merged)
  ensureDetail(data, child.id)
  return true
}

function modelCallInfoTab(
  value: unknown,
  child: BootstrapSubagentInput["children"][number],
): FooterSubagentTab | undefined {
  const info = record(value)
  const origin = typedModelCallOrigin(child)
  if (!info || !origin) return undefined
  const callID = text(origin.callID)!
  const parentSessionID = text(origin.parentSessionID)!
  if ((text(info.id) ?? text(info.callID)) !== callID) return undefined
  if (text(info.parentSessionID) !== parentSessionID) return undefined
  if (text(info.childSessionID) !== child.id) return undefined
  if (!sameModelRef(info.requestedModel, origin.requestedModel)) return undefined

  const requested = info.requestedModel ?? origin.requestedModel
  const model = modelLabel(info.actualModel) ?? modelLabel(child.model) ?? modelLabel(requested) ?? "Model"
  const background = info.background === true || info.mode === "background"
  const prompt = text(info.prompt)?.split(/\r?\n/, 1)[0]
  const status = modelCallStatus(info.status) ?? "running"
  const usage = usageLabel(info.usage) ?? usageLabel({ cost: child.cost, tokens: child.tokens })

  return {
    sessionID: child.id,
    partID: `model-call:${callID}`,
    callID: text(origin.parentToolCallID)!,
    kind: "model_call",
    modelCallID: callID,
    modelCallParentSessionID: parentSessionID,
    label: model,
    model,
    description: prompt ?? text(child.title) ?? model,
    status,
    mode: background ? "background" : "foreground",
    background,
    usage,
    error: errorLabel(info.error),
    title: text(child.title),
    lastUpdatedAt: num(info.timeUpdated) ?? Date.now(),
  }
}

function childModelCallTab(child: BootstrapSubagentInput["children"][number]) {
  const origin = typedModelCallOrigin(child)
  if (!origin) return undefined
  const modelCall = matchingModelCallMetadata(child, origin)

  return modelCallInfoTab(
    {
      ...modelCall,
      callID: origin.callID,
      parentSessionID: origin.parentSessionID,
      childSessionID: child.id,
      requestedModel: origin.requestedModel,
      actualModel: modelCall?.actualModel ?? child.model ?? origin.requestedModel,
      status: modelCall?.status,
      usage:
        modelCall?.usage ??
        ({
          cost: child.cost,
          tokens: child.tokens,
        } satisfies Record<string, unknown>),
    },
    child,
  )
}

function syncModelCallInfo(data: SubagentData, value: unknown, child?: BootstrapSubagentInput["children"][number]) {
  if (!child) return false
  const hydrated = modelCallInfoTab(value, child)
  if (!hydrated) {
    return false
  }

  const current = data.tabs.get(hydrated.sessionID)
  const next = current
    ? {
        ...hydrated,
        partID: current.partID,
        callID: current.callID,
        description: current.description || hydrated.description,
        title: current.title ?? hydrated.title,
      }
    : hydrated
  if (sameSubagentTab(current, next)) {
    ensureDetail(data, hydrated.sessionID)
    return false
  }

  data.tabs.set(hydrated.sessionID, next)
  ensureDetail(data, hydrated.sessionID)
  return true
}

function frameKey(commit: StreamCommit) {
  if (commit.partID) {
    return `${commit.kind}:${commit.partID}:${commit.phase}`
  }

  if (commit.messageID) {
    return `${commit.kind}:${commit.messageID}:${commit.phase}`
  }

  return `${commit.kind}:${commit.phase}:${commit.text}`
}

function limitFrames(detail: DetailState) {
  if (detail.frames.length <= SUBAGENT_COMMIT_LIMIT) {
    return
  }

  detail.frames.splice(0, detail.frames.length - SUBAGENT_COMMIT_LIMIT)
}

function mergeLiveCommit(current: StreamCommit, next: StreamCommit) {
  if (current.phase !== "progress" || next.phase !== "progress") {
    if (sameCommit(current, next)) {
      return current
    }

    return next
  }

  const merged = {
    ...current,
    ...next,
    text: current.text + next.text,
  }

  if (sameCommit(current, merged)) {
    return current
  }

  return merged
}

function appendCommits(detail: DetailState, commits: StreamCommit[]) {
  let changed = false

  for (const commit of commits.map(compactCommit)) {
    const key = frameKey(commit)
    const index = detail.frames.findIndex((item) => item.key === key)
    if (index === -1) {
      detail.frames.push({
        key,
        commit,
      })
      changed = true
      continue
    }

    const next = mergeLiveCommit(detail.frames[index].commit, commit)
    if (sameCommit(detail.frames[index].commit, next)) {
      continue
    }

    detail.frames[index] = {
      key,
      commit: next,
    }
    changed = true
  }

  if (changed) {
    limitFrames(detail)
  }

  return changed
}

function ensureBlockerTab(
  data: SubagentData,
  sessionID: string,
  title: string | undefined,
  kind: "permission" | "question",
) {
  const current = data.tabs.get(sessionID)
  if (current) {
    ensureDetail(data, sessionID)
    if (!activeStatus(current.status)) {
      return false
    }

    const next = {
      ...current,
      description: kind === "permission" ? "Pending permission" : "Pending question",
      status: "running" as const,
      title: current.title ?? title,
      lastUpdatedAt: Date.now(),
    }
    if (sameSubagentTab(current, next)) {
      return false
    }

    data.tabs.set(sessionID, next)
    return true
  }

  data.tabs.set(sessionID, {
    sessionID,
    partID: `bootstrap:${sessionID}`,
    callID: `bootstrap:${sessionID}`,
    label: text(title) ?? Locale.titlecase(kind),
    description: kind === "permission" ? "Pending permission" : "Pending question",
    status: "running",
    lastUpdatedAt: Date.now(),
  })
  ensureDetail(data, sessionID)
  return true
}

function isAbortedAssistantMessage(info: Message) {
  return info.role === "assistant" && info.error?.name === "MessageAbortedError"
}

function cancelSubagentTab(data: SubagentData, sessionID: string) {
  const current = data.tabs.get(sessionID)
  if (!current || !activeStatus(current.status)) {
    return false
  }

  const next = {
    ...current,
    status: "cancelled" as const,
    lastUpdatedAt: Date.now(),
  }
  if (sameSubagentTab(current, next)) {
    return false
  }

  data.tabs.set(sessionID, next)
  return true
}

function compactCallMap(detail: DetailState) {
  const keep = new Set(recent(detail.data.call.keys(), SUBAGENT_CALL_LIMIT))

  for (const request of detail.data.permissions) {
    const key = callKey(request.tool?.messageID, request.tool?.callID)
    if (key) {
      keep.add(key)
    }
  }

  for (const item of detail.frames) {
    const key = callKey(item.commit.part?.messageID, item.commit.part?.callID)
    if (key) {
      keep.add(key)
    }
  }

  return copyMap(detail.data.call, keep)
}

function compactEchoMap(data: SessionData, messageIDs: Set<string>) {
  const keys = new Set([...messageIDs, ...recent(data.echo.keys(), SUBAGENT_ECHO_LIMIT)])
  return copyMap(data.echo, keys)
}

function compactIDs(detail: DetailState) {
  return new Set(recent(detail.data.ids, SUBAGENT_COMMIT_LIMIT + SUBAGENT_ERROR_LIMIT))
}

function compactDetail(detail: DetailState) {
  const next = createSessionData({
    includeUserText: true,
  })
  const activePartIDs = new Set(detail.data.part.keys())
  const framePartIDs = new Set(detail.frames.flatMap((item) => (item.commit.partID ? [item.commit.partID] : [])))
  const partIDs = new Set([...activePartIDs, ...framePartIDs, ...detail.data.tools])
  const messageIDs = new Set([
    ...[...activePartIDs]
      .map((partID) => detail.data.msg.get(partID))
      .filter((item): item is string => typeof item === "string"),
    ...recent(detail.data.role.keys(), SUBAGENT_ROLE_LIMIT),
  ])

  next.announced = detail.data.announced
  next.permissions = detail.data.permissions
  next.questions = detail.data.questions
  next.ids = compactIDs(detail)
  next.tools = new Set([...detail.data.tools].filter((item) => partIDs.has(item)))
  next.call = compactCallMap(detail)
  next.role = copyMap(detail.data.role, messageIDs)
  next.msg = copyMap(detail.data.msg, activePartIDs)
  next.part = copyMap(detail.data.part, activePartIDs)
  next.text = copyMap(detail.data.text, activePartIDs)
  next.sent = copyMap(detail.data.sent, activePartIDs)
  next.end = new Set([...detail.data.end].filter((item) => activePartIDs.has(item)))
  next.echo = compactEchoMap(detail.data, messageIDs)
  detail.data = next
}

function applyChildEvent(input: {
  detail: DetailState
  event: Event
  thinking: boolean
  limits: Record<string, number>
}) {
  const before = queueSnapshot(input.detail.data)
  const out = reduceSessionData({
    data: input.detail.data,
    event: input.event,
    sessionID: input.detail.sessionID,
    thinking: input.thinking,
    limits: input.limits,
  })
  const changed = appendCommits(input.detail, out.commits)
  compactDetail(input.detail)

  return changed || queueChanged(input.detail.data, before)
}

function bootstrapChildEvent(input: {
  detail: DetailState
  event: Event
  thinking: boolean
  limits: Record<string, number>
}) {
  const out = reduceSessionData({
    data: input.detail.data,
    event: input.event,
    sessionID: input.detail.sessionID,
    thinking: input.thinking,
    limits: input.limits,
  })

  return appendCommits(input.detail, out.commits)
}

function bootstrapChildMessages(input: {
  detail: DetailState
  messages: BootstrapChildMessage[]
  thinking: boolean
  limits: Record<string, number>
}) {
  let changed = false

  for (const message of input.messages) {
    changed =
      bootstrapChildEvent({
        detail: input.detail,
        event: {
          id: `bootstrap:message:${message.info.id}`,
          type: "message.updated",
          properties: {
            sessionID: input.detail.sessionID,
            info: message.info,
          },
        },
        thinking: input.thinking,
        limits: input.limits,
      }) || changed

    for (const part of message.parts) {
      changed =
        bootstrapChildEvent({
          detail: input.detail,
          event: {
            id: `bootstrap:part:${part.id}`,
            type: "message.part.updated",
            properties: {
              sessionID: input.detail.sessionID,
              part,
              time: 0,
            },
          },
          thinking: input.thinking,
          limits: input.limits,
        }) || changed
    }
  }

  compactDetail(input.detail)
  return changed
}

function knownSession(data: SubagentData, sessionID: string) {
  return data.tabs.has(sessionID)
}

export function listSubagentPermissions(data: SubagentData) {
  return [...data.details.values()].flatMap((detail) => detail.data.permissions)
}

export function listSubagentQuestions(data: SubagentData) {
  return [...data.details.values()].flatMap((detail) => detail.data.questions)
}

export function createSubagentData(): SubagentData {
  return {
    tabs: new Map(),
    details: new Map(),
  }
}

function snapshotDetail(detail: DetailState) {
  return {
    sessionID: detail.sessionID,
    commits: detail.frames.map((item) => item.commit),
  }
}

export function listSubagentTabs(data: SubagentData) {
  return [...data.tabs.values()].sort((a, b) => {
    const active = Number(activeStatus(b.status)) - Number(activeStatus(a.status))
    if (active !== 0) {
      return active
    }

    return b.lastUpdatedAt - a.lastUpdatedAt
  })
}

export function modelCallAction(tab: FooterSubagentTab) {
  if (tab.kind !== "model_call" || !tab.modelCallID || !tab.modelCallParentSessionID) return undefined
  return {
    sessionID: tab.modelCallParentSessionID,
    callID: tab.modelCallID,
  }
}

function snapshotQueues(data: SubagentData) {
  return {
    permissions: listSubagentPermissions(data).sort((a, b) => a.id.localeCompare(b.id)),
    questions: listSubagentQuestions(data).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function snapshotState(data: SubagentData, details: FooterSubagentState["details"]): FooterSubagentState {
  return {
    tabs: listSubagentTabs(data),
    details,
    ...snapshotQueues(data),
  }
}

export function snapshotSubagentData(data: SubagentData): FooterSubagentState {
  return snapshotState(
    data,
    Object.fromEntries([...data.details.entries()].map(([sessionID, detail]) => [sessionID, snapshotDetail(detail)])),
  )
}

export function snapshotSelectedSubagentData(
  data: SubagentData,
  selectedSessionID: string | undefined,
): FooterSubagentState {
  const detail = selectedSessionID ? data.details.get(selectedSessionID) : undefined

  return snapshotState(data, detail ? { [detail.sessionID]: snapshotDetail(detail) } : {})
}

export function bootstrapSubagentData(input: BootstrapSubagentInput) {
  const child = new Map(input.children.map((item) => [item.id, item]))
  const children = new Set(child.keys())
  const modelCallChildren = input.children.filter((item) => typedModelCallOrigin(item))
  let changed = false

  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue
      }

      if (part.tool === "model_call") {
        const target = modelCallChildren.find((item) => {
          const origin = typedModelCallOrigin(item)!
          return (
            text(origin.parentAssistantMessageID) === part.messageID && text(origin.parentToolCallID) === part.callID
          )
        })
        changed = syncModelCallToolTab(input.data, part, target) || changed
        continue
      }
      changed = syncChildTab(input.data, part, children) || changed
    }
  }

  for (const item of input.children) {
    const tab = childModelCallTab(item)
    if (!tab) {
      continue
    }

    const current = input.data.tabs.get(tab.sessionID)
    if (current) {
      const next = {
        ...tab,
        partID: current.partID,
        callID: current.callID,
        description: current.description || tab.description,
        title: current.title ?? tab.title,
      }
      if (!sameSubagentTab(current, next)) {
        input.data.tabs.set(tab.sessionID, next)
        changed = true
      }
    } else {
      input.data.tabs.set(tab.sessionID, tab)
      changed = true
    }
    ensureDetail(input.data, tab.sessionID)
  }

  for (const item of input.modelCalls ?? []) {
    const info = record(item)
    changed = syncModelCallInfo(input.data, item, child.get(text(info?.childSessionID) ?? "")) || changed
  }

  for (const item of input.permissions) {
    if (!children.has(item.sessionID)) {
      continue
    }

    changed = ensureBlockerTab(input.data, item.sessionID, child.get(item.sessionID)?.title, "permission") || changed
  }

  for (const item of input.questions) {
    if (!children.has(item.sessionID)) {
      continue
    }

    changed = ensureBlockerTab(input.data, item.sessionID, child.get(item.sessionID)?.title, "question") || changed
  }

  for (const sessionID of input.data.tabs.keys()) {
    const detail = ensureDetail(input.data, sessionID)
    const before = queueSnapshot(detail.data)

    bootstrapSessionData({
      data: detail.data,
      messages: [],
      permissions: input.permissions
        .filter((item) => item.sessionID === sessionID)
        .sort((a, b) => a.id.localeCompare(b.id)),
      questions: input.questions
        .filter((item) => item.sessionID === sessionID)
        .sort((a, b) => a.id.localeCompare(b.id)),
    })
    compactDetail(detail)

    changed = queueChanged(detail.data, before) || changed
  }

  return changed
}

export function bootstrapSubagentCalls(input: {
  data: SubagentData
  sessionID: string
  messages: BootstrapChildMessage[]
  thinking: boolean
  limits: Record<string, number>
}) {
  if (!knownSession(input.data, input.sessionID) || input.messages.length === 0) {
    return false
  }

  const detail = ensureDetail(input.data, input.sessionID)
  const before = queueSnapshot(detail.data)
  const beforeCallCount = detail.data.call.size
  bootstrapSessionData({
    data: detail.data,
    messages: input.messages,
    permissions: detail.data.permissions,
    questions: detail.data.questions,
  })
  const changed = bootstrapChildMessages({
    detail,
    messages: input.messages,
    thinking: input.thinking,
    limits: input.limits,
  })

  return changed || beforeCallCount !== detail.data.call.size || queueChanged(detail.data, before)
}

function reduceModelCallEvent(data: SubagentData, event: Event, parentSessionID: string) {
  const value = event as unknown as {
    type?: unknown
    properties?: unknown
  }
  const type = text(value.type)
  if (!type?.startsWith("model.call.")) {
    return false
  }

  const properties = record(value.properties)
  const origin = record(properties?.origin)
  const callID = text(properties?.callID) ?? text(origin?.callID)
  if (!callID) {
    return false
  }

  const current = [...data.tabs.values()].find((item) => item.modelCallID === callID)
  if (!current?.modelCallParentSessionID || current.modelCallParentSessionID !== parentSessionID) return false

  const status = (
    {
      "model.call.requested": "preparing",
      "model.call.prepared": "preparing",
      "model.call.queued": "queued",
      "model.call.started": "running",
      "model.call.completed": "completed",
      "model.call.failed": "failed",
      "model.call.cancelled": "cancelled",
      "model.call.interrupted": "interrupted",
    } as const
  )[type]
  if (!status && type !== "model.call.detached" && type !== "model.call.result-delivered") {
    return false
  }

  const sessionID = current.sessionID

  const requested = properties?.requestedModel ?? origin?.requestedModel
  const model = modelLabel(properties?.actualModel) ?? modelLabel(requested) ?? current.model ?? "Model"
  const background = type === "model.call.detached" || properties?.background === true || current.mode === "background"
  const nextStatus =
    status && statusRank(status) >= statusRank(current.status) ? status : current.status
  const next: FooterSubagentTab = {
    sessionID,
    partID: current.partID,
    callID: current.callID,
    kind: "model_call",
    modelCallID: callID,
    modelCallParentSessionID: current.modelCallParentSessionID,
    label: model,
    model,
    description: current.description,
    status: nextStatus,
    mode: background ? "background" : "foreground",
    background,
    usage: usageLabel(properties?.usage) ?? current.usage,
    error: errorLabel(properties?.error) ?? current.error,
    title: current.title,
    lastUpdatedAt: Date.now(),
  }
  if (sameSubagentTab(current, next)) {
    return false
  }

  data.tabs.set(sessionID, next)
  ensureDetail(data, sessionID)
  return true
}

function reduceModelCallSession(data: SubagentData, event: Event, parentSessionID: string) {
  if (event.type !== "session.created" && event.type !== "session.updated") return false
  const child = event.properties.info
  const origin = typedModelCallOrigin(child)
  if (!origin || child.parentID !== parentSessionID || text(origin.parentSessionID) !== parentSessionID) return false
  const tab = childModelCallTab(child)
  if (!tab) return false
  const current = data.tabs.get(child.id)
  const next = current
    ? {
        ...tab,
        partID: current.partID,
        callID: current.callID,
        description: current.description || tab.description,
        title: current.title ?? tab.title,
      }
    : tab
  if (sameSubagentTab(current, next)) return false
  data.tabs.set(child.id, next)
  ensureDetail(data, child.id)
  return true
}

export function reduceSubagentData(input: {
  data: SubagentData
  event: Event
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
}) {
  const event = input.event
  const modelCall = reduceModelCallEvent(input.data, event, input.sessionID)
  const modelCallSession = reduceModelCallSession(input.data, event, input.sessionID)

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.sessionID === input.sessionID) {
      if (part.type !== "tool") {
        return false
      }

      if (part.tool === "model_call") {
        const current = [...input.data.tabs.values()].find(
          (item) =>
            item.kind === "model_call" &&
            item.modelCallParentSessionID === input.sessionID &&
            item.callID === part.callID,
        )
        const child = current
          ? ({
              id: current.sessionID,
              origin: {
                type: "model_call",
                callID: current.modelCallID,
                parentSessionID: current.modelCallParentSessionID,
                parentAssistantMessageID: part.messageID,
                parentToolCallID: part.callID,
              },
            } satisfies BootstrapSubagentInput["children"][number])
          : undefined
        return syncModelCallToolTab(input.data, part, child) || modelCall || modelCallSession
      }
      return syncChildTab(input.data, part) || modelCall || modelCallSession
    }
  }

  const sessionID =
    event.type === "message.updated" ||
    event.type === "message.part.delta" ||
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "session.error" ||
    event.type === "session.status"
      ? event.properties.sessionID
      : event.type === "message.part.updated"
        ? event.properties.part.sessionID
        : undefined

  if (!sessionID || !knownSession(input.data, sessionID)) {
    return modelCall || modelCallSession
  }

  const detail = ensureDetail(input.data, sessionID)
  const cancelled =
    event.type === "message.updated" && isAbortedAssistantMessage(event.properties.info)
      ? cancelSubagentTab(input.data, sessionID)
      : false
  if (event.type === "session.status") {
    if (event.properties.status.type !== "retry") {
      return cancelled || modelCall || modelCallSession
    }

    return (
      appendCommits(detail, [
        {
          kind: "error",
          text: event.properties.status.message,
          phase: "start",
          source: "system",
          messageID: `retry:${event.properties.status.attempt}`,
        },
      ]) ||
      cancelled ||
      modelCall ||
      modelCallSession
    )
  }

  if (event.type === "session.error" && event.properties.error) {
    return (
      appendCommits(detail, [
        {
          kind: "error",
          text: formatError(event.properties.error),
          phase: "start",
          source: "system",
          messageID: `session.error:${event.properties.sessionID}:${formatError(event.properties.error)}`,
        },
      ]) || cancelled
    )
  }

  return (
    applyChildEvent({
      detail,
      event,
      thinking: input.thinking,
      limits: input.limits,
    }) ||
    cancelled ||
    modelCall ||
    modelCallSession
  )
}
