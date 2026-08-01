import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelCallV2 } from "@opencode-ai/core/model-call"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ID } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { ModelCall } from "@opencode-ai/schema/model-call"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelCallRecovery } from "@/model-call/recovery"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { ModelCallTool, modelCallPartID, type ModelCallPromptOps } from "@/tool/model-call"
import { ModelsTool } from "@/tool/models"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  recoveryPromptInputs.length = 0
  recoveryCancelledSessions.length = 0
  recoveryLoopOverride = undefined
  sessionLocations.clear()
  await disposeAllInstances()
})

const model = ProviderTest.model({
  providerID: ProviderV2.ID.make("review"),
  id: ModelV2.ID.make("critic"),
  name: "Code Critic",
  family: "critic",
  variants: {
    xhigh: {
      reasoningEffort: "xhigh",
    },
  },
  cost: {
    input: 1,
    output: 2,
    cache: { read: 0.1, write: 0.2 },
  },
})
const textModel = ProviderTest.model({
  providerID: model.providerID,
  id: ModelV2.ID.make("text-only"),
  name: "Text Only",
  release_date: "2024-01-01",
  capabilities: {
    ...model.capabilities,
    toolcall: false,
  },
})
const nonTextModel = ProviderTest.model({
  providerID: model.providerID,
  id: ModelV2.ID.make("image-only"),
  name: "Image Only",
  capabilities: {
    ...model.capabilities,
    input: {
      ...model.capabilities.input,
      text: false,
      image: true,
    },
  },
})
const unavailableModel = ProviderTest.model({
  providerID: model.providerID,
  id: ModelV2.ID.make("unavailable"),
  name: "Unavailable",
})
const unloadableModel = ProviderTest.model({
  providerID: model.providerID,
  id: ModelV2.ID.make("broken-sdk"),
  name: "Broken SDK",
})
const provider = ProviderTest.fake({
  model,
  info: ProviderTest.info(
    {
      id: model.providerID,
      models: {
        [model.id]: model,
        [textModel.id]: textModel,
        [nonTextModel.id]: nonTextModel,
        [unavailableModel.id]: unavailableModel,
        [unloadableModel.id]: unloadableModel,
      },
    },
    model,
  ),
  getModel: (providerID, modelID) => {
    const resolved = [model, textModel, nonTextModel, unloadableModel].find(
      (item) => item.providerID === providerID && item.id === modelID,
    )
    if (resolved) return Effect.succeed(resolved)
    return Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
  },
  getLanguage: (resolved) =>
    resolved.id === unloadableModel.id
      ? Effect.die(new Error("Provider SDK cannot be loaded"))
      : Effect.succeed({} as never),
})

const recoveryPromptInputs: SessionPrompt.PromptInput[] = []
const recoveryCancelledSessions: SessionID[] = []
const sessionLocations = new Map<SessionID, Location.Ref>()
let recoveryLoopOverride:
  | ((input: { sessionID: SessionID }) => Effect.Effect<SessionV1.WithParts, never, never>)
  | undefined
const recoveryPromptService = SessionPrompt.Service.of({
  cancel: (sessionID) =>
    Effect.sync(() => {
      recoveryCancelledSessions.push(sessionID)
    }),
  prompt: (input) =>
    Effect.sync(() => {
      recoveryPromptInputs.push(input)
      return reply(input)
    }),
  loop: (input) => {
    if (recoveryLoopOverride) return recoveryLoopOverride(input)
    return Effect.sync(() => {
      const prompt = recoveryPromptInputs.findLast((item) => item.sessionID === input.sessionID)
      if (!prompt) throw new Error(`No admitted prompt for ${input.sessionID}`)
      return reply(prompt, { text: ["recovered result"] })
    })
  },
  shell: () => Effect.die(new Error("Not implemented")),
  command: () => Effect.die(new Error("Not implemented")),
  resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
})
const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    ModelCallV2.node,
    ModelCallRecovery.node,
    Provider.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
  [[Provider.node, provider.layer]],
)
const it = testEffect(layer)

const seed = Effect.fn("ModelCallToolTest.seed")(function* () {
  const sessions = yield* Session.Service
  const permission = [{ permission: "bash", pattern: "*", action: "deny" as const }]
  const parent = yield* sessions.create({
    title: "Parent",
    agent: "build",
    model: {
      providerID: model.providerID,
      id: model.id,
    },
    permission,
  })
  sessionLocations.set(
    parent.id,
    Location.Ref.make({
      directory: AbsolutePath.make(parent.directory),
      ...(parent.workspaceID === undefined ? {} : { workspaceID: parent.workspaceID }),
    }),
  )
  return {
    parent,
    permission,
    messageID: MessageID.ascending(),
  }
})

const reserve = Effect.fn("ModelCallToolTest.reserve")(function* (input: {
  parent: Session.Info
  messageID: MessageID
  toolCallID: string
  background?: boolean
  outputSchema?: Record<string, unknown>
  system?: string
}) {
  const calls = yield* ModelCallV2.Service
  return yield* calls.reserve({
    parentSessionID: input.parent.id,
    parentAssistantMessageID: SessionMessage.ID.make(input.messageID),
    parentToolCallID: input.toolCallID,
    agent: ID.make("build"),
    requestedModel: {
      providerID: model.providerID,
      id: model.id,
    },
    actualModel: {
      providerID: model.providerID,
      id: model.id,
    },
    location: Location.Ref.make({
      directory: AbsolutePath.make(input.parent.directory),
      ...(input.parent.workspaceID === undefined ? {} : { workspaceID: input.parent.workspaceID }),
    }),
    permission: {
      version: "legacy",
      rules: structuredClone(input.parent.permission ?? []),
    },
    prompt: "Recover this model call.",
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    runtime: "legacy",
    background: input.background ?? false,
  })
})

const recoveryService = Effect.fn("ModelCallToolTest.recovery")(function* () {
  const calls = yield* ModelCallV2.Service
  const provider = yield* Provider.Service
  const recovery = yield* ModelCallRecovery.Service
  const sessions = yield* Session.Service
  const prompts = withExact({
    cancel: recoveryPromptService.cancel,
    prompt: (input) => recoveryPromptService.prompt(input).pipe(Effect.catch(Effect.die)),
    admit: (input) => recoveryPromptService.prompt({ ...input, noReply: true }).pipe(Effect.catch(Effect.die)),
    wake: (sessionID) => recoveryPromptService.loop({ sessionID }),
  })
  yield* recovery.register({
    calls,
    provider,
    prompts: {
      ...prompts,
      admitExact: (input) =>
        Effect.gen(function* () {
          const existing = yield* sessions
            .findMessage(input.sessionID, (message) => message.info.id === input.messageID)
            .pipe(Effect.catch(Effect.die))
          if (Option.isSome(existing) && !SessionPrompt.isExactPrompt(existing.value, input)) {
            return yield* Effect.die(
              new Error(`Exact prompt conflicts with existing message: ${input.sessionID}/${input.messageID}`),
            )
          }
          return yield* prompts.admitExact(input)
        }),
    },
    sessions,
  })
  return recovery
})

function context(input: {
  parentID: SessionID
  messageID: MessageID
  ops: ModelCallPromptOps
  abort?: AbortSignal
  bypassAgentCheck?: boolean
  callID?: string
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  ask?: (input: unknown) => void
  messages?: SessionV1.WithParts[]
}): Tool.Context {
  const location = sessionLocations.get(input.parentID)
  if (!location) throw new Error(`Missing test Location for ${input.parentID}`)
  return {
    sessionID: input.parentID,
    messageID: input.messageID,
    agent: "build",
    abort: input.abort ?? new AbortController().signal,
    location,
    callID: input.callID ?? `tool_${input.messageID}`,
    extra: { promptOps: input.ops, bypassAgentCheck: input.bypassAgentCheck },
    messages: input.messages ?? [],
    metadata: (value) =>
      Effect.sync(() => {
        input.metadata?.(value)
      }),
    ask: (value) =>
      Effect.sync(() => {
        input.ask?.(value)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  options: {
    error?: SessionV1.Assistant["error"]
    structured?: unknown
    text?: string[]
  } = {},
): SessionV1.WithParts & { info: SessionV1.Assistant } {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "build",
      agent: input.agent ?? "build",
      cost: 1.25,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: {
        input: 10,
        output: 20,
        reasoning: 3,
        cache: { read: 4, write: 5 },
      },
      modelID: input.model?.modelID ?? model.id,
      providerID: input.model?.providerID ?? model.providerID,
      variant: input.variant,
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
      error: options.error,
      structured: options.structured,
    },
    parts: (options.text ?? ["first finding", "second finding"]).map((text) => ({
      id: PartID.ascending(),
      messageID: id,
      sessionID: input.sessionID,
      type: "text" as const,
      text,
    })),
  }
}

function callerMessage(sessionID: SessionID, system: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: "build",
      model: {
        providerID: model.providerID,
        modelID: model.id,
      },
      system,
    },
    parts: [],
  }
}

function withExact(
  ops: Omit<ModelCallPromptOps, "admitExact" | "consumed" | "releaseExact"> &
    Partial<Pick<ModelCallPromptOps, "consumed">>,
): ModelCallPromptOps {
  const claimed = new Set<string>()
  const consumed = new Set<string>()
  const messages = new Map<string, SessionV1.WithParts>()
  return {
    ...ops,
    admitExact: (input) => {
      const key = `${input.sessionID}/${input.messageID}`
      const existing = messages.get(key)
      if (existing) {
        const acquired = !claimed.has(key)
        claimed.add(key)
        return Effect.succeed({ message: existing, claimed: acquired })
      }
      claimed.add(key)
      return ops.admit(input).pipe(
        Effect.tap((message) =>
          Effect.sync(() => {
            messages.set(key, message)
          }),
        ),
        Effect.map((message) => ({ message, claimed: true })),
      )
    },
    releaseExact: (input) =>
      Effect.sync(() => {
        claimed.delete(`${input.sessionID}/${input.messageID}`)
      }),
    consumed: (input) => {
      if (consumed.has(`${input.sessionID}/${input.messageID}`)) return Effect.succeed(true)
      return ops.consumed?.(input) ?? Effect.succeed(false)
    },
    wake: (sessionID) =>
      ops.wake(sessionID).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            if (response.info.role !== "assistant") return
            for (const key of messages.keys()) {
              if (key.startsWith(`${sessionID}/`)) consumed.add(key)
            }
          }),
        ),
      ),
  }
}

function stubOps(onPrompt?: (input: SessionPrompt.PromptInput) => SessionV1.WithParts): ModelCallPromptOps {
  const admitted = new Map<SessionID, SessionPrompt.PromptInput>()
  return withExact({
    cancel: () => Effect.void,
    prompt: (input) => Effect.sync(() => onPrompt?.(input) ?? reply(input)),
    admit: (input) =>
      Effect.sync(() => {
        admitted.set(input.sessionID, input)
        return reply(input)
      }),
    wake: (sessionID) =>
      Effect.sync(() => {
        const input = admitted.get(sessionID)
        if (!input) throw new Error(`No admitted prompt for ${sessionID}`)
        return onPrompt?.(input) ?? reply(input)
      }),
  })
}

describe("tool.models", () => {
  it.instance("projects safe model data, filters, and paginates", () =>
    Effect.gen(function* () {
      const tool = yield* ModelsTool
      const def = yield* tool.init()
      const seeded = yield* seed()
      const first = yield* def.execute(
        {
          providerID: model.providerID,
          limit: 1,
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops: stubOps(),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.ListResult)(JSON.parse(first.output))

      expect(output.items).toHaveLength(1)
      expect(output.items[0]).toMatchObject({
        ref: {
          providerID: model.providerID,
          id: model.id,
        },
        name: "Code Critic",
        family: "critic",
        capabilities: {
          tools: true,
          input: ["text"],
          output: ["text"],
        },
        variants: ["xhigh"],
        limits: model.limit,
      })
      expect(output.nextCursor).toBe("model:1")
      expect(first.output).not.toContain("reasoningEffort")
      expect(first.output).not.toContain("headers")
      expect(first.output).not.toContain("options")

      const nextSeeded = yield* seed()
      const next = yield* def.execute(
        {
          providerID: model.providerID,
          limit: 1,
          cursor: output.nextCursor,
        },
        context({
          parentID: nextSeeded.parent.id,
          messageID: nextSeeded.messageID,
          ops: stubOps(),
        }),
      )
      const nextOutput = Schema.decodeUnknownSync(ModelCall.ListResult)(JSON.parse(next.output))
      expect(nextOutput.items[0]?.ref.id).toBe(textModel.id)
      expect(nextOutput.nextCursor).toBeUndefined()
    }),
  )

  it.instance("registers models and model_call without replacing task", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).toContain("models")
      expect(ids).toContain("model_call")
      expect(ids).toContain("task")
    }),
  )

  it.instance("does not treat model_call rules as per-target allowlists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      yield* sessions.setPermission({
        sessionID: seeded.parent.id,
        permission: [
          {
            permission: "model_call",
            pattern: `${model.providerID}/${model.id}`,
            action: "deny",
          },
        ],
      })
      const tool = yield* ModelsTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { providerID: model.providerID },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops: stubOps(),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.ListResult)(JSON.parse(result.output))

      expect(output.items.map((item) => item.ref.id)).toEqual([model.id, textModel.id])
    }),
  )

  it.instance("filters models using configured descriptions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          `${test.directory}/opencode.json`,
          JSON.stringify({
            model_call: {
              models: {
                [`${model.providerID}/${model.id}`]: { description: "Use for repository-wide code review" },
              },
            },
          }),
        ),
      )
      const seeded = yield* seed()
      const tool = yield* ModelsTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { query: "repository-wide" },
        context({ parentID: seeded.parent.id, messageID: seeded.messageID, ops: stubOps() }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.ListResult)(JSON.parse(result.output))

      expect(output.items).toHaveLength(1)
      expect(output.items[0]).toMatchObject({
        ref: { providerID: model.providerID, id: model.id },
        description: "Use for repository-wide code review",
      })
    }),
  )
})

describe("tool.model_call", () => {
  it.instance("rejects models outside the allowlist before asking permission", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(`${test.directory}/opencode.json`, JSON.stringify({ model_call: { models: {} } })),
      )
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const asks: unknown[] = []

      const exit = yield* def
        .execute(
          { model: { providerID: model.providerID, id: model.id }, prompt: "Do not run" },
          context({
            parentID: seeded.parent.id,
            messageID: seeded.messageID,
            ops: stubOps(),
            ask: (input) => asks.push(input),
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain(`Model unavailable: ${model.providerID}/${model.id}`)
      expect(asks).toEqual([])
    }),
  )

  it.instance("creates a fresh exact-model child and returns complete provenance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          `${test.directory}/opencode.json`,
          JSON.stringify({
            model_call: {
              models: { [`${model.providerID}/${model.id}`]: { description: "Use for code review" } },
            },
          }),
        ),
      )
      const calls = yield* ModelCallV2.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const prompts: SessionPrompt.PromptInput[] = []
      const metadata: Array<{ title?: string; metadata?: Record<string, unknown> }> = []
      const asks: unknown[] = []
      const outputSchema = {
        type: "object",
        properties: {
          verdict: { type: "string" },
        },
      }
      const result = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
            variant: ModelV2.VariantID.make("xhigh"),
          },
          prompt: "Review this implementation.\nDo not rewrite it.",
          output_schema: outputSchema,
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          callID: "tool_call_1",
          bypassAgentCheck: true,
          ops: stubOps((input) => {
            prompts.push(input)
            return reply(input, { structured: { verdict: "pass" } })
          }),
          metadata: (input) => metadata.push(input),
          ask: (input) => asks.push(input),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))
      const call = yield* calls.get(output.callID)
      const children = yield* sessions.children(seeded.parent.id)

      expect(call).toMatchObject({
        childSessionID: output.childSessionID,
        childPromptID: prompts[0]?.messageID,
        runtime: "legacy",
        status: "completed",
        text: "first findingsecond finding",
      })
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({
        id: output.childSessionID,
        parentID: seeded.parent.id,
        agent: "build",
        model: {
          providerID: model.providerID,
          id: model.id,
          variant: "xhigh",
        },
        permission: seeded.permission,
        directory: seeded.parent.directory,
        origin: {
          type: "model_call",
          callID: output.callID,
          parentSessionID: seeded.parent.id,
          parentToolCallID: "tool_call_1",
        },
      })
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({
        sessionID: output.childSessionID,
        agent: "build",
        model: {
          providerID: model.providerID,
          modelID: model.id,
        },
        variant: "xhigh",
        format: {
          type: "json_schema",
          schema: outputSchema,
        },
        parts: [
          {
            type: "text",
            text: "Review this implementation.\nDo not rewrite it.",
          },
        ],
      })
      expect(output).toMatchObject({
        parentSessionID: seeded.parent.id,
        requestedModel: {
          providerID: model.providerID,
          id: model.id,
          variant: "xhigh",
        },
        actualModel: {
          providerID: model.providerID,
          id: model.id,
          variant: "xhigh",
        },
        mode: "foreground",
        status: "completed",
        text: "first findingsecond finding",
        structured: { verdict: "pass" },
        usage: {
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      })
      expect(result.metadata).toMatchObject({
        truncated: false,
        callID: output.callID,
        parentSessionId: seeded.parent.id,
        sessionId: output.childSessionID,
        requestedModel: output.requestedModel,
        actualModel: output.actualModel,
        background: false,
        status: "completed",
        text: "first findingsecond finding",
      })
      expect(metadata.at(-1)?.metadata).toMatchObject({
        truncated: false,
        callID: output.callID,
        sessionId: output.childSessionID,
        status: "completed",
        text: "first findingsecond finding",
      })
      expect(asks).toEqual([
        {
          permission: "model_call",
          patterns: ["review/critic"],
          always: ["review/critic"],
          metadata: {
            model: output.requestedModel,
            background: false,
            title: "review/critic (xhigh): Review this implementation.",
          },
        },
      ])
      expect((children[0]?.metadata?.modelCall as Record<string, unknown>).status).toBe("completed")
    }),
  )

  it.instance("uses the target default variant sentinel and rejects non-text targets", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const prompts: SessionPrompt.PromptInput[] = []
      const result = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
            variant: Schema.decodeUnknownSync(ModelV2.VariantID)("default"),
          },
          prompt: "Use the target default.",
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops: stubOps((input) => {
            prompts.push(input)
            return reply(input)
          }),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))

      expect(prompts[0]?.variant).toBe("default")
      expect(String(output.requestedModel.variant)).toBe("default")
      expect(output.actualModel.variant).toBeUndefined()

      const omittedSeed = yield* seed()
      const omittedPrompts: SessionPrompt.PromptInput[] = []
      const omitted = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
          },
          prompt: "Do not inherit the agent variant.",
        },
        context({
          parentID: omittedSeed.parent.id,
          messageID: omittedSeed.messageID,
          ops: stubOps((input) => {
            omittedPrompts.push(input)
            return reply(input)
          }),
        }),
      )
      const omittedOutput = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(omitted.output))
      expect(omittedPrompts[0]?.variant).toBe("default")
      expect(omittedOutput.requestedModel.variant).toBeUndefined()
      expect(omittedOutput.actualModel.variant).toBeUndefined()

      const rejectedSeed = yield* seed()
      const rejected = yield* def
        .execute(
          {
            model: {
              providerID: nonTextModel.providerID,
              id: nonTextModel.id,
            },
            prompt: "This cannot be called with text.",
          },
          context({
            parentID: rejectedSeed.parent.id,
            messageID: rejectedSeed.messageID,
            ops: stubOps(),
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(rejected)).toBe(true)
      expect(yield* calls.list(rejectedSeed.parent.id)).toHaveLength(0)

      const unloadableSeed = yield* seed()
      const unloadable = yield* def
        .execute(
          {
            model: {
              providerID: unloadableModel.providerID,
              id: unloadableModel.id,
            },
            prompt: "This provider cannot execute.",
          },
          context({
            parentID: unloadableSeed.parent.id,
            messageID: unloadableSeed.messageID,
            ops: stubOps(),
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(unloadable)).toBe(true)
      expect(yield* calls.list(unloadableSeed.parent.id)).toHaveLength(0)
    }),
  )

  it.instance("fails clearly when a provider returns a different model", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
          },
          prompt: "Do not fall back.",
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops: stubOps((input) => {
            const response = reply(input)
            response.info.modelID = textModel.id
            return response
          }),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))

      expect(output.status).toBe("failed")
      expect(output.error).toMatchObject({
        code: "model_mismatch",
      })
      expect(output.error?.message).toContain(`${textModel.providerID}/${textModel.id}`)
    }),
  )

  it.instance("validates structured output and makes exactly one corrective child turn", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const prompts: SessionPrompt.PromptInput[] = []
      const system = "Review only the caller's uncommitted changes."
      const result = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
          },
          prompt: "Return a verdict.",
          output_schema: {
            type: "object",
            properties: {
              verdict: { type: "string" },
            },
            required: ["verdict"],
          },
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          messages: [callerMessage(seeded.parent.id, system)],
          ops: stubOps((input) => {
            prompts.push(input)
            return prompts.length === 1
              ? reply(input, { structured: { verdict: 1 } })
              : reply(input, { structured: { verdict: "pass" } })
          }),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))
      const record = yield* calls.get(output.callID)

      expect(output.status).toBe("completed")
      expect(output.structured).toEqual({ verdict: "pass" })
      expect(prompts).toHaveLength(2)
      expect(prompts[0]?.format).toMatchObject({ type: "json_schema", retryCount: 0 })
      expect(prompts[1]?.messageID).toBe(MessageID.ascending(record.correctionPromptID))
      expect(prompts.map((prompt) => prompt.system)).toEqual([system, system])
      expect(record.system).toBe(system)
      expect(record.validationAttempts).toBe(1)
    }),
  )

  it.instance("fails after one persistent structured correction and rejects oversized JSON", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      let attempts = 0
      const invalid = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
          },
          prompt: "Return a verdict.",
          output_schema: {
            type: "object",
            properties: {
              verdict: { type: "string" },
            },
            required: ["verdict"],
          },
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops: stubOps((input) => {
            attempts += 1
            return reply(input, { structured: { verdict: 1 } })
          }),
        }),
      )
      const invalidOutput = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(invalid.output))

      expect(attempts).toBe(2)
      expect(invalidOutput.status).toBe("failed")
      expect(invalidOutput.error?.code).toBe("structured_output_invalid")

      const oversizedSeed = yield* seed()
      const oversized = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
          },
          prompt: "Return a payload.",
          output_schema: {
            type: "object",
            properties: {
              payload: { type: "string" },
            },
            required: ["payload"],
          },
        },
        context({
          parentID: oversizedSeed.parent.id,
          messageID: oversizedSeed.messageID,
          ops: stubOps((input) => reply(input, { structured: { payload: "x".repeat(1024 * 1024) } })),
        }),
      )
      const oversizedOutput = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(oversized.output))

      expect(oversizedOutput.status).toBe("failed")
      expect(oversizedOutput.error?.code).toBe("structured_output_too_large")
      expect(oversizedOutput.text).toBeUndefined()
      expect(oversizedOutput.structured).toBeUndefined()
    }),
  )

  it.instance("requires an object-root structured schema before reserving", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          {
            model: {
              providerID: model.providerID,
              id: model.id,
            },
            prompt: "Return a list.",
            output_schema: {
              type: "array",
              items: { type: "string" },
            },
          },
          context({
            parentID: seeded.parent.id,
            messageID: seeded.messageID,
            ops: stubOps(),
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* calls.list(seeded.parent.id)).toHaveLength(0)
    }),
  )

  it.instance("requests and validates JSON locally for a text-only target", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const prompts: SessionPrompt.PromptInput[] = []
      const result = yield* def.execute(
        {
          model: {
            providerID: textModel.providerID,
            id: textModel.id,
          },
          prompt: "Review without tools.",
          output_schema: {
            type: "object",
            properties: {
              verdict: { type: "string" },
            },
            required: ["verdict"],
          },
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops: stubOps((input) => {
            prompts.push(input)
            return reply(input, { text: ['{"verdict":"pass"}'] })
          }),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))

      expect(output.status).toBe("completed")
      expect(output.structured).toEqual({ verdict: "pass" })
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.format).toBeUndefined()
      expect(prompts[0]?.parts[0]?.type === "text" ? prompts[0].parts[0].text : "").toContain(
        "Return only one JSON object",
      )
    }),
  )

  it.instance("fails an idempotent preparation when the reserved child conflicts", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "preparation_conflict",
      })
      yield* sessions.create({
        id: record.childSessionID,
        parentID: seeded.parent.id,
        title: "Conflicting child",
        agent: "general",
        model: record.actualModel,
      })
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          model: record.requestedModel,
          prompt: record.prompt,
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          callID: record.parentToolCallID,
          ops: stubOps(() => {
            throw new Error("Conflicting preparation must not execute the child")
          }),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))

      expect(output.status).toBe("failed")
      expect(output.error).toMatchObject({ code: "preparation_conflict" })
      expect((yield* calls.get(record.id)).status).toBe("failed")
    }),
  )

  it.instance("delivers a synchronous background reservation failure exactly once", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "background_terminal",
        background: true,
      })
      yield* calls.failed(record.id, {
        code: "child_limit",
        message: "No direct-child slot is available",
      })
      const injected: SessionPrompt.PromptInput[] = []
      const base = stubOps()
      const ops = withExact({
        ...base,
        admit: (input) =>
          Effect.sync(() => {
            if (input.sessionID === seeded.parent.id) injected.push(input)
          }).pipe(Effect.andThen(base.admit(input))),
      })
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const invoke = () =>
        def.execute(
          {
            model: record.requestedModel,
            prompt: record.prompt,
            background: true,
          },
          context({
            parentID: seeded.parent.id,
            messageID: seeded.messageID,
            callID: record.parentToolCallID,
            ops,
          }),
        )

      const first = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse((yield* invoke()).output))
      const second = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse((yield* invoke()).output))
      const stored = yield* calls.get(record.id)

      expect(first.status).toBe("failed")
      expect(second.status).toBe("failed")
      expect(injected).toHaveLength(1)
      expect(injected[0]?.parts[0]).toMatchObject({
        type: "text",
        internal: {
          type: "model-call-result",
          result: {
            callID: record.id,
            status: "failed",
          },
        },
      })
      expect(stored.deliveredAt).toBeNumber()
    }),
  )

  it.instance("returns child terminal failures as typed completed tool results", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
          },
          prompt: "Verify the change.",
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops: stubOps((input) =>
            reply(input, {
              error: {
                name: "APIError",
                data: {
                  message: "provider rejected the request",
                  isRetryable: false,
                },
              },
            }),
          ),
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))

      expect(output.status).toBe("failed")
      expect(output.error).toEqual({
        code: "APIError",
        message: "provider rejected the request",
      })
      expect(output.text).toBe("first findingsecond finding")
      expect((yield* calls.get(output.callID)).status).toBe("failed")
    }),
  )

  it.instance("cancels the child before interrupting on parent abort", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<SessionPrompt.PromptInput>()
      const cancelled = yield* Deferred.make<SessionID>()
      const abort = new AbortController()
      let admitted: SessionPrompt.PromptInput | undefined
      const ops = withExact({
        cancel: (sessionID) => Deferred.succeed(cancelled, sessionID).pipe(Effect.asVoid),
        prompt: (input) => Effect.succeed(reply(input)),
        admit: (input) =>
          Effect.sync(() => {
            admitted = input
            return reply(input)
          }),
        wake: () => {
          if (!admitted) return Effect.die(new Error("No admitted child prompt"))
          return Deferred.succeed(started, admitted).pipe(Effect.andThen(Effect.never), Effect.as(reply(admitted)))
        },
      })
      const fiber = yield* def
        .execute(
          {
            model: {
              providerID: model.providerID,
              id: model.id,
            },
            prompt: "Review forever.",
          },
          context({
            parentID: seeded.parent.id,
            messageID: seeded.messageID,
            ops,
            abort: abort.signal,
          }),
        )
        .pipe(Effect.forkChild)
      const child = yield* awaitWithTimeout(Deferred.await(started), "model call did not start")

      abort.abort()
      expect(yield* awaitWithTimeout(Deferred.await(cancelled), "child was not cancelled")).toBe(child.sessionID)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect((yield* calls.list(seeded.parent.id))[0]?.status).toBe("cancelled")
    }),
  )

  it.instance("detaches a foreground call while its child keeps running and delivers once", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<SessionPrompt.PromptInput>()
      const release = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const admitted = new Map<SessionID, SessionPrompt.PromptInput>()
      const ops = withExact({
        cancel: () => Effect.void,
        prompt: (input) => Effect.succeed(reply(input)),
        admit: (input) => {
          if (input.sessionID === seeded.parent.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input)))
          }
          admitted.set(input.sessionID, input)
          return Effect.succeed(reply(input))
        },
        wake: (sessionID) => {
          const input = admitted.get(sessionID)
          if (!input) return Effect.succeed(reply({ sessionID, agent: "build", parts: [{ type: "text", text: "" }] }))
          return Deferred.succeed(started, input).pipe(Effect.andThen(Deferred.await(release)), Effect.as(reply(input)))
        },
      })
      const fiber = yield* def
        .execute(
          {
            model: {
              providerID: model.providerID,
              id: model.id,
            },
            prompt: "Review, then detach.",
          },
          context({
            parentID: seeded.parent.id,
            messageID: seeded.messageID,
            ops,
          }),
        )
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(started), "foreground model call did not start")
      const call = (yield* calls.list(seeded.parent.id))[0]
      if (!call) return yield* Effect.die(new Error("Missing model call"))

      yield* calls.detach(call.id)
      const detached = yield* awaitWithTimeout(Fiber.join(fiber), "foreground model call did not detach")
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(detached.output))

      expect(output.mode).toBe("background")
      expect(output.status).toBe("running")
      yield* Deferred.succeed(release, undefined)
      const completion = yield* awaitWithTimeout(Deferred.await(injected), "detached completion was not injected")
      expect(completion.parts[0]).toMatchObject({
        type: "text",
        internal: {
          type: "model-call-result",
          result: {
            callID: call.id,
            mode: "background",
            status: "completed",
          },
        },
      })
    }),
  )

  it.instance("observes an external durable cancellation and stops the legacy child", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<SessionPrompt.PromptInput>()
      const cancelled = yield* Deferred.make<SessionID>()
      let admitted: SessionPrompt.PromptInput | undefined
      const ops = withExact({
        cancel: (sessionID) => Deferred.succeed(cancelled, sessionID).pipe(Effect.asVoid),
        prompt: (input) => Effect.succeed(reply(input)),
        admit: (input) =>
          Effect.sync(() => {
            admitted = input
            return reply(input)
          }),
        wake: () => {
          if (!admitted) return Effect.die(new Error("No admitted child prompt"))
          return Deferred.succeed(started, admitted).pipe(Effect.andThen(Effect.never), Effect.as(reply(admitted)))
        },
      })
      const fiber = yield* def
        .execute(
          {
            model: {
              providerID: model.providerID,
              id: model.id,
            },
            prompt: "Review until cancelled externally.",
          },
          context({
            parentID: seeded.parent.id,
            messageID: seeded.messageID,
            ops,
          }),
        )
        .pipe(Effect.forkChild)
      const child = yield* awaitWithTimeout(Deferred.await(started), "model call did not start")
      const call = (yield* calls.list(seeded.parent.id))[0]
      if (!call) return yield* Effect.die(new Error("Missing model call"))

      yield* calls.cancelled(call.id)
      expect(yield* awaitWithTimeout(Deferred.await(cancelled), "legacy child was not cancelled")).toBe(child.sessionID)
      const result = yield* awaitWithTimeout(Fiber.join(fiber), "foreground call did not settle after cancellation")
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))
      expect(output.status).toBe("cancelled")
      expect((yield* calls.get(call.id)).status).toBe("cancelled")
    }),
  )

  it.instance("does not launch the child when cancellation wins the admission/start race", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const admitted = new Map<SessionID, SessionPrompt.PromptInput>()
      const cancelled: SessionID[] = []
      const released: SessionID[] = []
      const woken: SessionID[] = []
      const ops: ModelCallPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.push(sessionID)
          }),
        prompt: (input) => Effect.succeed(reply(input)),
        admit: (input) => Effect.succeed(reply(input)),
        admitExact: (input) =>
          Effect.gen(function* () {
            admitted.set(input.sessionID, input)
            if (input.sessionID !== seeded.parent.id) {
              const record = (yield* calls.list(seeded.parent.id))[0]
              if (!record) return yield* Effect.die(new Error("Missing model call"))
              yield* calls.cancelled(record.id).pipe(Effect.catch(Effect.die))
            }
            return { message: reply(input), claimed: true }
          }),
        releaseExact: (input) =>
          Effect.sync(() => {
            released.push(input.sessionID)
          }),
        consumed: (input) => Effect.succeed(woken.includes(input.sessionID)),
        wake: (sessionID) =>
          Effect.sync(() => {
            woken.push(sessionID)
            const input = admitted.get(sessionID)
            if (!input) throw new Error(`No exact admission for ${sessionID}`)
            return reply(input)
          }),
      }
      const result = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
          },
          prompt: "Cancel before the child starts.",
          background: true,
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops,
        }),
      )
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))
      const record = yield* calls.get(output.callID)

      expect(output.status).toBe("cancelled")
      expect(record.deliveredAt).toBeNumber()
      expect(cancelled).toEqual([output.childSessionID])
      expect(woken).toEqual([seeded.parent.id])
      expect(released).toEqual([output.childSessionID, seeded.parent.id])
    }),
  )

  it.instance("returns immediately in background and injects the persisted completion", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const tool = yield* ModelCallTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<SessionPrompt.PromptInput>()
      const release = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const admitted = new Map<SessionID, SessionPrompt.PromptInput>()
      const ops = withExact({
        cancel: () => Effect.void,
        prompt: (input) => Effect.succeed(reply(input)),
        admit: (input) => {
          if (input.sessionID === seeded.parent.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input)))
          }
          admitted.set(input.sessionID, input)
          return Effect.succeed(reply(input))
        },
        wake: (sessionID) => {
          const input = admitted.get(sessionID)
          if (!input) return Effect.succeed(reply({ sessionID, agent: "build", parts: [{ type: "text", text: "" }] }))
          return Deferred.succeed(started, input).pipe(Effect.andThen(Deferred.await(release)), Effect.as(reply(input)))
        },
      })
      const result = yield* def.execute(
        {
          model: {
            providerID: model.providerID,
            id: model.id,
          },
          prompt: "Review in parallel.",
          background: true,
        },
        context({
          parentID: seeded.parent.id,
          messageID: seeded.messageID,
          ops,
        }),
      )
      const queued = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(result.output))

      expect(queued.status).toBe("running")
      expect(queued.mode).toBe("background")
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* awaitWithTimeout(Deferred.await(started), "background model call did not start")
      yield* Deferred.succeed(release, undefined)
      const completion = yield* awaitWithTimeout(Deferred.await(injected), "background result was not injected")
      const text = completion.parts[0]?.type === "text" ? completion.parts[0].text : ""
      const output = Schema.decodeUnknownSync(ModelCall.CallResult)(JSON.parse(text.split("\n")[1] ?? ""))
      const child = yield* sessions.get(queued.childSessionID)
      const call = yield* calls.get(queued.callID)

      expect(completion.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
      })
      expect(output).toMatchObject({
        callID: queued.callID,
        parentSessionID: seeded.parent.id,
        childSessionID: queued.childSessionID,
        mode: "background",
        status: "completed",
        text: "first findingsecond finding",
      })
      expect((child.metadata?.modelCall as Record<string, unknown>).status).toBe("completed")
      expect(call.status).toBe("completed")
      expect(call.deliveredAt).toBeNumber()
    }),
  )
})

describe("legacy model-call recovery", () => {
  it.instance("discovers durable legacy work during instance initialization", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const recovery = yield* recoveryService()
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "recover_init",
      })

      yield* recovery.init()
      const recovered = yield* pollWithTimeout(
        calls
          .get(record.id)
          .pipe(Effect.map((current) => (ModelCallV2.isTerminal(current.status) ? current : undefined))),
        "legacy model-call recovery did not start",
      )

      expect(recovered.status).toBe("completed")
    }),
  )

  it.instance("finishes incomplete preparation with the reserved child and prompt IDs", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const recovery = yield* recoveryService()
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "recover_preparing",
        system: "Keep the recovered reviewer read-only.",
      })

      const recovered = yield* recovery.recover(record)
      const child = yield* sessions.get(record.childSessionID)

      expect(recovered.status).toBe("completed")
      expect((yield* calls.get(record.id)).status).toBe("completed")
      expect(child).toMatchObject({
        id: record.childSessionID,
        parentID: seeded.parent.id,
        agent: "build",
        model: {
          providerID: model.providerID,
          id: model.id,
        },
        origin: {
          type: "model_call",
          callID: record.id,
          parentSessionID: seeded.parent.id,
          parentToolCallID: "recover_preparing",
        },
      })
      const prompts = recoveryPromptInputs.filter(
        (input) =>
          input.sessionID === record.childSessionID && input.messageID === MessageID.ascending(record.childPromptID),
      )
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.system).toBe("Keep the recovered reviewer read-only.")
    }),
  )

  it.instance("rejects a conflicting stable child prompt without overwriting it", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const recovery = yield* recoveryService()
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "recover_prompt_conflict",
      })
      yield* sessions.create({
        id: record.childSessionID,
        parentID: record.parentSessionID,
        title: "Recover prompt conflict",
        agent: record.agent,
        model: record.actualModel,
        origin: {
          type: "model_call",
          callID: record.id,
          parentSessionID: record.parentSessionID,
          parentAssistantMessageID: record.parentAssistantMessageID,
          parentToolCallID: record.parentToolCallID,
          requestedModel: record.requestedModel,
        },
        permission: record.permission.version === "legacy" ? record.permission.rules : undefined,
        workspaceID: record.location.workspaceID,
      })
      const messageID = MessageID.ascending(record.childPromptID)
      yield* sessions.updateMessage({
        id: messageID,
        role: "user",
        sessionID: record.childSessionID,
        time: { created: Date.now() },
        agent: record.agent,
        model: {
          providerID: record.actualModel.providerID,
          modelID: record.actualModel.id,
          variant: "default",
        },
      })
      yield* sessions.updatePart({
        id: modelCallPartID(messageID),
        messageID,
        sessionID: record.childSessionID,
        type: "text",
        text: "conflicting prompt",
      })

      const exit = yield* recovery.recover(record).pipe(Effect.exit)
      const part = yield* sessions.getPart({
        sessionID: record.childSessionID,
        messageID,
        partID: modelCallPartID(messageID),
      })

      expect(Exit.isFailure(exit)).toBe(true)
      expect(part).toMatchObject({ type: "text", text: "conflicting prompt" })
      expect((yield* calls.get(record.id)).status).toBe("preparing")
    }),
  )

  it.instance("marks an admitted in-flight prompt unknown and admits its background result exactly once", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const recovery = yield* recoveryService()
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "recover_running",
        background: true,
      })
      const origin: ModelCall.Origin = {
        type: "model_call",
        callID: record.id,
        parentSessionID: record.parentSessionID,
        parentAssistantMessageID: record.parentAssistantMessageID,
        parentToolCallID: record.parentToolCallID,
        requestedModel: record.requestedModel,
      }
      yield* sessions.create({
        id: record.childSessionID,
        parentID: record.parentSessionID,
        title: "Recover running",
        agent: record.agent,
        model: record.actualModel,
        origin,
        permission: record.permission.version === "legacy" ? record.permission.rules : undefined,
        workspaceID: record.location.workspaceID,
      })
      const messageID = MessageID.ascending(record.childPromptID)
      const user: SessionV1.User = {
        id: messageID,
        role: "user",
        sessionID: record.childSessionID,
        time: { created: Date.now() },
        agent: record.agent,
        model: {
          providerID: record.actualModel.providerID,
          modelID: record.actualModel.id,
          variant: "default",
        },
      }
      yield* sessions.updateMessage(user)
      yield* sessions.updatePart({
        id: modelCallPartID(messageID),
        messageID,
        sessionID: record.childSessionID,
        type: "text",
        text: record.prompt,
      })
      const running = yield* calls.queued(record.id).pipe(Effect.andThen(calls.started(record.id)))

      const recovered = yield* recovery.recover(running)
      yield* recovery.recover(recovered)
      const stored = yield* calls.get(record.id)
      const completion = recoveryPromptInputs.filter(
        (input) => input.messageID === MessageID.ascending(record.completionMessageID),
      )

      expect(stored.status).toBe("interrupted")
      expect(stored.error).toMatchObject({
        outcomeUnknown: true,
      })
      expect(stored.deliveredAt).toBeNumber()
      expect(completion).toHaveLength(1)
      expect(completion[0]?.parts[0]).toMatchObject({
        type: "text",
        internal: {
          type: "model-call-result",
          result: {
            callID: record.id,
            status: "interrupted",
          },
        },
      })
    }),
  )

  it.instance("reconciles a completed child transcript without retrying the provider", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const recovery = yield* recoveryService()
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "recover_completed",
      })
      const origin: ModelCall.Origin = {
        type: "model_call",
        callID: record.id,
        parentSessionID: record.parentSessionID,
        parentAssistantMessageID: record.parentAssistantMessageID,
        parentToolCallID: record.parentToolCallID,
        requestedModel: record.requestedModel,
      }
      yield* sessions.create({
        id: record.childSessionID,
        parentID: record.parentSessionID,
        title: "Recover completed",
        agent: record.agent,
        model: record.actualModel,
        origin,
        permission: record.permission.version === "legacy" ? record.permission.rules : undefined,
        workspaceID: record.location.workspaceID,
      })
      const messageID = MessageID.ascending(record.childPromptID)
      yield* sessions.updateMessage({
        id: messageID,
        role: "user",
        sessionID: record.childSessionID,
        time: { created: Date.now() },
        agent: record.agent,
        model: {
          providerID: record.actualModel.providerID,
          modelID: record.actualModel.id,
          variant: "default",
        },
      })
      yield* sessions.updatePart({
        id: modelCallPartID(messageID),
        messageID,
        sessionID: record.childSessionID,
        type: "text",
        text: record.prompt,
      })
      const assistantID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: messageID,
        sessionID: record.childSessionID,
        mode: record.agent,
        agent: record.agent,
        cost: 0,
        path: { cwd: record.location.directory, root: record.location.directory },
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: record.actualModel.id,
        providerID: record.actualModel.providerID,
        variant: "default",
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID: record.childSessionID,
        type: "text",
        text: "persisted review",
      })
      const running = yield* calls.queued(record.id).pipe(Effect.andThen(calls.started(record.id)))
      const promptCount = recoveryPromptInputs.length

      const recovered = yield* recovery.recover(running)

      expect(recovered.status).toBe("completed")
      expect(recovered.text).toBe("persisted review")
      expect(recoveryPromptInputs).toHaveLength(promptCount)
    }),
  )

  it.instance("treats cascaded parent deletion as an already-settled background result", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const recovery = yield* recoveryService()
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "recover_missing_parent",
        background: true,
      })
      const failed = yield* calls.failed(record.id, {
        code: "child_failed",
        message: "The child failed before delivery",
      })
      yield* sessions.remove(seeded.parent.id)

      const recovered = yield* recovery.recover(failed)

      expect(recovered.status).toBe("failed")
      expect(yield* calls.find(record.id)).toBeUndefined()
    }),
  )

  it.instance("cancels recovered provider work when the durable call is cancelled", () =>
    Effect.gen(function* () {
      const calls = yield* ModelCallV2.Service
      const recovery = yield* recoveryService()
      const seeded = yield* seed()
      const record = yield* reserve({
        parent: seeded.parent,
        messageID: seeded.messageID,
        toolCallID: "recover_cancelled",
      })
      const started = yield* Deferred.make<SessionID>()
      recoveryLoopOverride = (input) => Deferred.succeed(started, input.sessionID).pipe(Effect.andThen(Effect.never))
      const fiber = yield* recovery.recover(record).pipe(Effect.forkChild)
      const childSessionID = yield* awaitWithTimeout(
        Deferred.await(started),
        "recovered legacy provider work did not start",
      )

      yield* calls.cancelled(record.id)
      yield* pollWithTimeout(
        Effect.sync(() => (recoveryCancelledSessions.includes(childSessionID) ? true : undefined)),
        "recovered legacy child was not cancelled",
      )
      const recovered = yield* awaitWithTimeout(Fiber.join(fiber), "recovered cancellation did not settle")

      expect(recovered.status).toBe("cancelled")
      expect((yield* calls.get(record.id)).status).toBe("cancelled")
      expect(recoveryCancelledSessions.filter((sessionID) => sessionID === childSessionID)).toHaveLength(1)
    }),
  )
})
