import { describe, expect } from "bun:test"
import path from "path"
import { Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ModelCall } from "@opencode-ai/schema/model-call"
import { Team } from "@opencode-ai/schema/team"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"
import { ModelCallV2 } from "@opencode-ai/core/model-call"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TeamV2 } from "@opencode-ai/core/team"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ModelCallTool } from "@opencode-ai/core/tool/model-call"
import { Tool } from "@opencode-ai/core/tool/tool"
import { DateTime, Deferred, Effect, Fiber, Layer, LayerMap, Option, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Config } from "@opencode-ai/core/config"
import { ConfigModelCall } from "@opencode-ai/core/config/model-call"
import { it as effectIt, testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const providerID = ProviderV2.ID.make("review")
const modelID = ModelV2.ID.make("review/model")
const outputOnlyID = ModelV2.ID.make("output-only")
const defaultVariant = ModelV2.VariantID.make("balanced")
const location = Location.Ref.make({ directory: AbsolutePath.make("/model-call") })
const agentID = AgentV2.ID.make("build")
const parentID = SessionV2.ID.make("ses_model_call_tool_parent")
const permission = [{ action: "edit", resource: "*", effect: "deny" as const }]

const target = ModelV2.Info.make({
  ...ModelV2.Info.empty(providerID, modelID),
  name: "Review Model",
  api: { id: modelID, type: "aisdk", package: "@ai-sdk/openai", settings: {} },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {}, variant: defaultVariant },
  variants: [
    { id: defaultVariant, headers: {}, body: { effort: "balanced" } },
    { id: ModelV2.VariantID.make("fast"), headers: {}, body: { effort: "fast" } },
  ],
})
const outputOnly = ModelV2.Info.make({
  ...target,
  id: outputOnlyID,
  name: "Output Only",
  api: { ...target.api, id: outputOnlyID },
  capabilities: { tools: true, input: ["image"], output: ["text"] },
})
const agent = AgentV2.Info.make({
  ...AgentV2.Info.empty(agentID),
  request: { headers: { "x-agent": "build" }, body: { temperature: 0.1 } },
  steps: 4,
  permissions: permission,
})
const llmModel = Model.make({ id: modelID, provider: providerID, route: OpenAIChat.route })

const availableModels = [target, outputOnly]
const resolutions: Array<{ session: SessionV2.Info; agent: AgentV2.Info | undefined }> = []
const permissionAssertions: PermissionV2.AssertInput[] = []
let permissionMode: "allow" | "ask" | "deny" = "allow"
let permissionGate: Deferred.Deferred<void> | undefined
let modelCallConfig: Config.Info["model_call"]
const catalog = Catalog.Service.of({
  transform: () => Effect.die("unused"),
  reload: () => Effect.die("unused"),
  provider: {
    get: () => Effect.die("unused"),
    all: () => Effect.die("unused"),
    available: () => Effect.die("unused"),
  },
  model: {
    get: () => Effect.die("unused"),
    all: () => Effect.die("unused"),
    available: () => Effect.succeed(availableModels),
    default: () => Effect.die("unused"),
    small: () => Effect.die("unused"),
  },
})
const agents = AgentV2.Service.of({
  transform: () => Effect.die("unused"),
  reload: () => Effect.die("unused"),
  get: (id) => Effect.succeed(id === agentID ? agent : undefined),
  default: () => Effect.succeed(agent),
  resolve: (id) => Effect.succeed(id === undefined || id === agentID ? agent : undefined),
  select: (id) => Effect.succeed({ id: AgentV2.ID.make(id ?? agentID), info: agent }),
  all: () => Effect.succeed([agent]),
})
const resolver = SessionRunnerModel.Service.of({
  resolve: (session, selectedAgent) =>
    Effect.sync(() => {
      resolutions.push({ session, agent: selectedAgent })
      return llmModel
    }),
})
const permissionService = PermissionV2.Service.of({
  ask: () => Effect.die("unused"),
  assert: (input) =>
    Effect.gen(function* () {
      permissionAssertions.push(input)
      if (permissionMode === "deny")
        return yield* new PermissionV2.BlockedError({
          rules: [{ action: "model_call", resource: "*", effect: "deny" }],
        })
      if (permissionMode !== "ask") return
      permissionGate = yield* Deferred.make<void>()
      yield* Deferred.await(permissionGate)
    }),
  reply: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  forSession: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
})
const locationRuntime = Layer.mergeAll(
  Layer.succeed(Catalog.Service, catalog),
  Layer.succeed(AgentV2.Service, agents),
  Layer.succeed(SessionRunnerModel.Service, resolver),
  Layer.succeed(PermissionV2.Service, permissionService),
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed(
          modelCallConfig === undefined
            ? []
            : [new Config.Document({ type: "document", info: new Config.Info({ model_call: modelCallConfig }) })],
        ),
    }),
  ),
)
const locationMapLayer = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(() => locationRuntime, {
    idleTimeToLive: "1 minute",
  }) as unknown as Effect.Effect<LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>>,
)
const locationMapNode = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: locationMapLayer,
  deps: [],
})

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

type Response =
  | { readonly type: "text"; readonly text: string; readonly model?: ModelV2.Ref }
  | {
      readonly type: "tool-then-text"
      readonly intermediate: string
      readonly text: string
      readonly model?: ModelV2.Ref
    }
  | { readonly type: "block" }
const responses: Response[] = []
const resumeCalls: SessionV2.ID[] = []
const wakeCalls: SessionV2.ID[] = []
const interruptCalls: SessionV2.ID[] = []
const gates = new Map<SessionV2.ID, Deferred.Deferred<void>>()

const complete = Effect.fn("ModelCallTest.complete")(function* (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  sessionID: SessionV2.ID,
  text: string,
  override?: ModelV2.Ref,
  finish: "stop" | "tool-calls" = "stop",
) {
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  if (!row?.model) return yield* Effect.die(`Missing model for ${sessionID}`)
  const model = override ?? Schema.decodeUnknownSync(ModelV2.Ref)(row.model)
  const assistantMessageID = SessionMessage.ID.create()
  const textID = `text-${resumeCalls.length}`
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    timestamp: yield* DateTime.now,
    agent: row.agent ?? agentID,
    model,
  })
  yield* events.publish(SessionEvent.Text.Started, {
    sessionID,
    assistantMessageID,
    textID,
    timestamp: yield* DateTime.now,
  })
  yield* events.publish(SessionEvent.Text.Ended, {
    sessionID,
    assistantMessageID,
    textID,
    text,
    timestamp: yield* DateTime.now,
  })
  yield* events.publish(SessionEvent.Step.Ended, {
    sessionID,
    assistantMessageID,
    timestamp: yield* DateTime.now,
    finish,
    cost: 0.25,
    tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
  })
})

const executionLayer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service

    const resume = Effect.fn("ModelCallTest.resume")(function* (sessionID: SessionV2.ID) {
      resumeCalls.push(sessionID)
      const response = responses.shift() ?? { type: "text" as const, text: "review complete" }
      if (response.type === "block") {
        const gate = yield* Deferred.make<void>()
        gates.set(sessionID, gate)
        return yield* Deferred.await(gate).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              gates.delete(sessionID)
            }),
          ),
        )
      }
      const promoted = yield* SessionInput.promoteNextQueued(db, events, sessionID)
      if (!promoted) return
      if (response.type === "tool-then-text") {
        yield* complete(db, events, sessionID, response.intermediate, response.model, "tool-calls")
        yield* complete(db, events, sessionID, response.text, response.model)
        return
      }
      yield* complete(db, events, sessionID, response.text, response.model)
    })

    return SessionExecution.Service.of({
      active: Effect.sync(() => new Set(gates.keys())),
      resume,
      wake: (sessionID) =>
        Effect.gen(function* () {
          wakeCalls.push(sessionID)
          yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
        }),
      wait: () => Effect.void,
      whenIdle: (_sessionID, effect) => effect,
      interrupt: (sessionID) =>
        Effect.gen(function* () {
          interruptCalls.push(sessionID)
          const gate = gates.get(sessionID)
          if (gate) yield* Deferred.interrupt(gate)
        }),
    })
  }),
)
const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: executionLayer,
  deps: [Database.node, EventV2.node],
})

const nodes = LayerNode.group([
  ApplicationTools.node,
  Database.node,
  EventV2.node,
  ModelCallV2.node,
  SessionProjector.node,
  SessionStore.node,
  SessionV2.node,
  TeamV2.node,
  ModelCallTool.node,
])
const replacements = [
  [LocationServiceMap.node, locationMapNode],
  [ProjectV2.node, projects],
  [SessionExecution.node, executionNode],
] as const
const testLayer = AppNodeBuilder.build(nodes, replacements)
const it = testEffect(testLayer)

const seedNodes = LayerNode.group([
  Database.node,
  EventV2.node,
  ModelCallV2.node,
  SessionProjector.node,
  SessionStore.node,
  SessionV2.node,
])

const layerAt = (database: Layer.Layer<Database.Service>) => ({
  seed: AppNodeBuilder.build(seedNodes, [
    [Database.node, database],
    [LocationServiceMap.node, locationMapNode],
    [ProjectV2.node, projects],
    [SessionExecution.node, SessionExecution.noopLayer],
  ]),
  recover: AppNodeBuilder.build(nodes, [[Database.node, database], ...replacements]),
})

const setup = Effect.gen(function* () {
  responses.length = 0
  resolutions.length = 0
  resumeCalls.length = 0
  wakeCalls.length = 0
  interruptCalls.length = 0
  permissionAssertions.length = 0
  permissionMode = "allow"
  permissionGate = undefined
  modelCallConfig = undefined
  gates.clear()
  const sessions = yield* SessionV2.Service
  yield* sessions.create({
    id: parentID,
    location,
    agent: agentID,
    permission,
  })
  return {
    calls: yield* ModelCallV2.Service,
    sessions,
  }
})

const invoke = (input: ModelCall.CallInput, callID: string) =>
  Effect.gen(function* () {
    const registration = (yield* ApplicationTools.Service).entries().get(ModelCallTool.name)
    if (!registration) return yield* Effect.die("model_call was not registered")
    const settled = yield* Tool.settle(
      registration.tool,
      { type: "tool-call", id: callID, name: ModelCallTool.name, input },
      {
        sessionID: parentID,
        agent: agentID,
        location,
        abort: new AbortController().signal,
        assistantMessageID: SessionMessage.ID.make(`msg_${callID}`),
        toolCallID: callID,
      },
    )
    return yield* Schema.decodeUnknownEffect(ModelCall.CallResult)(settled.structured)
  })

const awaitDelivered = (
  calls: ModelCallV2.Interface,
  callID: ModelCall.CallID,
): Effect.Effect<ModelCallV2.Info, ModelCallV2.NotFoundError> =>
  calls
    .get(callID)
    .pipe(
      Effect.flatMap((record) =>
        record.deliveredAt === undefined
          ? Effect.sleep("20 millis").pipe(Effect.andThen(awaitDelivered(calls, callID)))
          : Effect.succeed(record),
      ),
    )

const awaitTerminal = (
  calls: ModelCallV2.Interface,
  callID: ModelCall.CallID,
): Effect.Effect<ModelCallV2.Info, ModelCallV2.NotFoundError> =>
  calls
    .get(callID)
    .pipe(
      Effect.flatMap((record) =>
        ModelCallV2.isTerminal(record.status)
          ? Effect.succeed(record)
          : Effect.sleep("20 millis").pipe(Effect.andThen(awaitTerminal(calls, callID))),
      ),
    )

describe("ModelCallTool V2 orchestration", () => {
  it.live("creates a fresh exact-model child with inherited runtime context", () =>
    Effect.gen(function* () {
      const { calls, sessions } = yield* setup
      modelCallConfig = new ConfigModelCall.Info({
        models: {
          [`${providerID}/${modelID}`]: new ConfigModelCall.Model({ description: "Use for code review" }),
        },
      })
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      yield* sessions.prompt({
        sessionID: parentID,
        prompt: { text: "Private parent transcript" },
        resume: false,
      })
      yield* SessionInput.promoteSteers(db, events, parentID, Number.MAX_SAFE_INTEGER)
      responses.push({ type: "text", text: "No blocking findings." })

      const result = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Review the implementation" },
        "call-foreground",
      )

      expect(result).toMatchObject({
        parentSessionID: parentID,
        requestedModel: { providerID, id: modelID },
        actualModel: { providerID, id: modelID, variant: defaultVariant },
        mode: "foreground",
        status: "completed",
        text: "No blocking findings.",
        usage: {
          cost: 0.25,
          tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        },
      })
      const record = yield* calls.get(result.callID)
      const child = yield* sessions.get(record.childSessionID)
      expect(child).toMatchObject({
        id: result.childSessionID,
        parentID,
        agent: agentID,
        model: { providerID, id: modelID, variant: defaultVariant },
        location,
        permission,
        origin: {
          type: "model_call",
          callID: result.callID,
          parentSessionID: parentID,
          parentToolCallID: "call-foreground",
          requestedModel: { providerID, id: modelID },
        },
      })
      expect(yield* sessions.messages({ sessionID: child.id, order: "asc" })).toMatchObject([
        { type: "user", text: "Review the implementation" },
        { type: "assistant", content: [{ type: "text", text: "No blocking findings." }] },
      ])
      expect(yield* sessions.messages({ sessionID: parentID })).toMatchObject([
        { type: "user", text: "Private parent transcript" },
      ])
      expect(resolutions).toHaveLength(1)
      expect(resolutions[0]).toMatchObject({
        session: { id: parentID, model: { providerID, id: modelID } },
        agent: {
          id: agentID,
          request: { headers: { "x-agent": "build" }, body: { temperature: 0.1 } },
          steps: 4,
        },
      })
    }),
  )

  it.live("waits past an intermediate tool-call assistant turn for final text", () =>
    Effect.gen(function* () {
      const { sessions } = yield* setup
      responses.push({
        type: "tool-then-text",
        intermediate: "I need to inspect the implementation.",
        text: "Review complete after tool use.",
      })

      const result = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Review with tools" },
        "call-tool-then-text",
      )

      expect(result).toMatchObject({
        status: "completed",
        text: "Review complete after tool use.",
        usage: {
          cost: 0.5,
          tokens: { input: 20, output: 40, reasoning: 6, cache: { read: 8, write: 10 } },
        },
      })
      expect(yield* sessions.messages({ sessionID: result.childSessionID, order: "asc" })).toMatchObject([
        { type: "user", text: "Review with tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [{ type: "text", text: "I need to inspect the implementation." }],
        },
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "Review complete after tool use." }],
        },
      ])
    }),
  )

  it.live("reports resolved default variants and preserves explicit non-default variants", () =>
    Effect.gen(function* () {
      yield* setup
      responses.push(
        { type: "text", text: "omitted" },
        { type: "text", text: "default" },
        { type: "text", text: "fast" },
      )

      const omitted = yield* invoke({ model: { providerID, id: modelID }, prompt: "one" }, "call-omitted")
      const sentinel = yield* invoke(
        { model: { providerID, id: modelID, variant: ModelV2.VariantID.make("default") }, prompt: "two" },
        "call-default",
      )
      const explicit = yield* invoke(
        { model: { providerID, id: modelID, variant: ModelV2.VariantID.make("fast") }, prompt: "three" },
        "call-fast",
      )

      expect(omitted.actualModel.variant).toBe(defaultVariant)
      expect(sentinel.actualModel.variant).toBe(defaultVariant)
      expect(explicit.actualModel.variant).toBe(ModelV2.VariantID.make("fast"))
      expect(resolutions.map((item) => item.session.model?.variant)).toEqual([
        undefined,
        ModelV2.VariantID.make("default"),
        ModelV2.VariantID.make("fast"),
      ])
    }),
  )

  it.live("preserves a model_call result larger than generic tool-output bounds", () =>
    Effect.gen(function* () {
      yield* setup
      const text = "finding ".repeat(8_000)
      responses.push({ type: "text", text })
      const registration = (yield* ApplicationTools.Service).entries().get(ModelCallTool.name)
      if (!registration) return yield* Effect.die("model_call was not registered")

      const result = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Return the complete review" },
        "call-large-output",
      )

      expect(Tool.outputPolicy(registration.tool)).toBe("preserve")
      expect(result.text).toBe(text)
      expect(JSON.parse(JSON.stringify(result))).toMatchObject({
        callID: result.callID,
        status: "completed",
        text,
      })
    }),
  )

  it.live("finishes a Requested-only exact retry before creating the child", () =>
    Effect.gen(function* () {
      const { calls, sessions } = yield* setup
      const events = yield* EventV2.Service
      const callID = ModelCall.CallID.create()
      const childSessionID = SessionV2.ID.create()
      const childPromptID = SessionMessage.ID.create()
      const correctionPromptID = SessionMessage.ID.create()
      const completionMessageID = SessionMessage.ID.create()
      const prompt = "Resume the crashed invocation"
      yield* events.publish(
        ModelCall.Event.Requested,
        {
          timestamp: yield* DateTime.now,
          callID,
          origin: {
            type: "model_call",
            callID,
            parentSessionID: parentID,
            parentAssistantMessageID: SessionMessage.ID.make("msg_call-requested-retry"),
            parentToolCallID: "call-requested-retry",
            requestedModel: { providerID, id: modelID },
          },
          requestedModel: { providerID, id: modelID },
          prompt,
          background: false,
          childSessionID,
          childPromptID,
          correctionPromptID,
          completionMessageID,
          agent: agentID,
          actualModel: { providerID, id: modelID, variant: defaultVariant },
          location,
          permission: { version: "v2", rules: permission },
          runtime: "v2",
          depth: 1,
        },
        { location },
      )
      const requested = yield* calls.get(callID)
      expect(requested.slot).toBeUndefined()
      expect(yield* sessions.get(childSessionID).pipe(Effect.option)).toEqual(Option.none())
      responses.push({ type: "text", text: "Recovered exact retry." })

      const result = yield* invoke({ model: { providerID, id: modelID }, prompt }, "call-requested-retry")

      expect(result).toMatchObject({
        callID,
        childSessionID,
        status: "completed",
        text: "Recovered exact retry.",
      })
      expect(yield* sessions.get(childSessionID)).toMatchObject({ parentID, permission })
    }),
  )

  it.effect("rejects output-only targets before reserving a child", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup

      const failure = yield* invoke(
        { model: { providerID, id: outputOnlyID }, prompt: "Review this image-only target" },
        "call-output-only",
      ).pipe(Effect.flip)

      expect(failure.message).toContain(`Model unavailable: ${providerID}/${outputOnlyID}`)
      expect(yield* calls.list(parentID)).toEqual([])
      expect(resolutions).toEqual([])
    }),
  )

  it.effect("rejects delegation from a coordinator-only Team lead", () =>
    Effect.gen(function* () {
      const { calls, sessions } = yield* setup
      const parent = yield* sessions.get(parentID)
      const teams = yield* TeamV2.Service
      yield* teams.reserve({
        leadSessionID: parentID,
        parentAssistantMessageID: SessionMessage.ID.make("msg_team_spawn"),
        parentToolCallID: "team-spawn",
        projectID: parent.projectID,
        location,
        targetBranch: "dev",
        baseCommit: "base",
        directoryRoot: "/tmp/team-model-call",
        agent: agentID,
        permission,
        members: [
          {
            name: Team.Name.make("writer"),
            model: ModelV2.Ref.make({ providerID, id: modelID }),
            prompt: "Write the change",
          },
        ],
        tasks: [],
        validation: [],
      })

      const failure = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Bypass the coordinator guard" },
        "call-team-lead",
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(Tool.Failure)
      expect(failure.message).toContain("coordinator-only")
      expect(yield* calls.list(parentID)).toEqual([])
    }),
  )

  it.effect("rejects models outside the model_call allowlist before permission or reservation", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      modelCallConfig = new ConfigModelCall.Info({ models: {} })

      const failure = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Do not run this model" },
        "call-not-allowlisted",
      ).pipe(Effect.flip)

      expect(failure.message).toContain(`Model unavailable: ${providerID}/${modelID}`)
      expect(yield* calls.list(parentID)).toEqual([])
      expect(permissionAssertions).toEqual([])
      expect(resolutions).toEqual([])
    }),
  )

  it.live("waits for model_call permission before reserving the child", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      permissionMode = "ask"
      responses.push({ type: "text", text: "Allowed review." })
      const fiber = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Review after approval" },
        "call-permission-ask",
      ).pipe(Effect.forkChild)
      while (!permissionGate) yield* Effect.yieldNow

      expect(yield* calls.list(parentID)).toEqual([])
      expect(permissionAssertions).toEqual([
        {
          action: "model_call",
          resources: [`${providerID}/${modelID}`],
          save: [`${providerID}/${modelID}`],
          sessionID: parentID,
          agent: agentID,
          source: {
            type: "tool",
            messageID: SessionMessage.ID.make("msg_call-permission-ask"),
            callID: "call-permission-ask",
          },
          metadata: {
            model: { providerID, id: modelID },
            background: false,
          },
        },
      ])

      yield* Deferred.succeed(permissionGate, undefined)
      expect(yield* Fiber.join(fiber)).toMatchObject({ status: "completed", text: "Allowed review." })
    }),
  )

  it.effect("does not reserve a child when model_call permission is denied", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      permissionMode = "deny"

      const failure = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Do not run" },
        "call-permission-deny",
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(Tool.Failure)
      expect(yield* calls.list(parentID)).toEqual([])
      expect(permissionAssertions).toHaveLength(1)
    }),
  )

  it.live("fails when the terminal child response uses a different model variant", () =>
    Effect.gen(function* () {
      yield* setup
      responses.push({
        type: "text",
        text: "Response from the wrong model.",
        model: {
          providerID,
          id: modelID,
          variant: ModelV2.VariantID.make("fast"),
        },
      })

      const result = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Review the implementation" },
        "call-model-mismatch",
      )

      expect(result).toMatchObject({
        actualModel: { providerID, id: modelID, variant: defaultVariant },
        status: "failed",
        text: "Response from the wrong model.",
        error: {
          code: "model_mismatch",
          message: `Expected ${providerID}/${modelID}/${defaultVariant}, but the child returned ${providerID}/${modelID}/fast`,
        },
        usage: {
          cost: 0.25,
          tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        },
      })
    }),
  )

  it.live("makes one corrective child turn for invalid structured output", () =>
    Effect.gen(function* () {
      const { calls, sessions } = yield* setup
      responses.push({ type: "text", text: "not json" }, { type: "text", text: '{"findings":[]}' })

      const result = yield* invoke(
        {
          model: { providerID, id: modelID },
          prompt: "Return findings",
          output_schema: {
            type: "object",
            properties: { findings: { type: "array" } },
            required: ["findings"],
          },
        },
        "call-structured",
      )

      expect(result).toMatchObject({
        status: "completed",
        text: '{"findings":[]}',
        structured: { findings: [] },
        usage: {
          cost: 0.5,
          tokens: { input: 20, output: 40, reasoning: 6, cache: { read: 8, write: 10 } },
        },
      })
      const record = yield* calls.get(result.callID)
      expect(record.validationAttempts).toBe(1)
      const messages = yield* sessions.messages({ sessionID: result.childSessionID, order: "asc" })
      const initial = messages[0]
      if (initial?.type !== "user") return yield* Effect.die("Missing structured-output child prompt")
      expect(initial.text).toContain("Return only one JSON object that validates against this JSON Schema")
      expect(initial.text).toContain('"required":["findings"]')
      expect(messages).toMatchObject([
        {
          type: "user",
          text: initial.text,
        },
        { type: "assistant", content: [{ type: "text", text: "not json" }] },
        { type: "user", text: expect.stringContaining("required JSON Schema") },
        { type: "assistant", content: [{ type: "text", text: '{"findings":[]}' }] },
      ])
    }),
  )

  it.live("persists final text and child usage when structured correction still fails", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      responses.push({ type: "text", text: '{"wrong":1}' }, { type: "text", text: '{"still":"wrong"}' })

      const result = yield* invoke(
        {
          model: { providerID, id: modelID },
          prompt: "Return findings",
          output_schema: {
            type: "object",
            properties: { findings: { type: "array" } },
            required: ["findings"],
          },
        },
        "call-structured-failure",
      )

      expect(result).toMatchObject({
        status: "failed",
        text: '{"still":"wrong"}',
        error: { code: "structured_output_invalid" },
        usage: {
          cost: 0.5,
          tokens: { input: 20, output: 40, reasoning: 6, cache: { read: 8, write: 10 } },
        },
      })
      expect(yield* calls.get(result.callID)).toMatchObject({
        status: "failed",
        text: '{"still":"wrong"}',
        usage: result.usage,
      })
    }),
  )

  it.effect("delivers synchronous background reservation failures to the parent", () =>
    Effect.gen(function* () {
      const { calls, sessions } = yield* setup
      yield* Effect.forEach(
        Array.from({ length: ModelCall.MAX_ACTIVE_CHILDREN }, (_, index) => index),
        (index) =>
          calls.reserve({
            parentSessionID: parentID,
            parentAssistantMessageID: SessionMessage.ID.make(`msg_slot_${index}`),
            parentToolCallID: `call-slot-${index}`,
            agent: agentID,
            requestedModel: { providerID, id: modelID },
            actualModel: { providerID, id: modelID, variant: defaultVariant },
            location,
            permission: { version: "v2", rules: permission },
            prompt: "occupy slot",
            runtime: "v2",
            background: false,
          }),
        { discard: true },
      )

      const result = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "overflow", background: true },
        "call-overflow",
      )
      const record = yield* calls.get(result.callID)

      expect(result).toMatchObject({
        mode: "background",
        status: "failed",
        error: { code: "child_limit" },
      })
      expect(record.deliveredAt).toEqual(expect.any(Number))
      expect(yield* calls.recoverable("v2")).not.toContainEqual(expect.objectContaining({ id: result.callID }))
      expect(yield* sessions.messages({ sessionID: parentID })).toMatchObject([
        {
          type: "user",
          internal: {
            type: "model-call-result",
            result: { callID: result.callID, status: "failed", mode: "background" },
          },
        },
      ])
    }),
  )

  it.live("delivers a typed background cancellation after interrupting the child", () =>
    Effect.gen(function* () {
      const { calls, sessions } = yield* setup
      responses.push({ type: "block" })

      const started = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Wait", background: true },
        "call-background",
      )
      expect(started).toMatchObject({ mode: "background", status: "running" })
      while (!gates.has(started.childSessionID)) yield* Effect.yieldNow

      yield* calls.cancelled(started.callID)
      yield* sessions.interrupt(started.childSessionID)
      const delivered = yield* awaitDelivered(calls, started.callID)

      expect(delivered).toMatchObject({ status: "cancelled", background: true, deliveredAt: expect.any(Number) })
      expect(interruptCalls).toContain(started.childSessionID)
      expect(wakeCalls).toContain(parentID)
      expect(yield* sessions.messages({ sessionID: parentID, order: "asc" })).toMatchObject([
        {
          type: "user",
          internal: {
            type: "model-call-result",
            result: { callID: started.callID, status: "cancelled", mode: "background" },
          },
        },
      ])
    }),
  )

  it.live("keeps a detached child running when the former foreground wait is interrupted", () =>
    Effect.gen(function* () {
      const { calls, sessions } = yield* setup
      responses.push({ type: "block" })
      const fiber = yield* invoke({ model: { providerID, id: modelID }, prompt: "Detach me" }, "call-detached").pipe(
        Effect.forkChild,
      )
      while (gates.size === 0) yield* Effect.yieldNow
      const record = (yield* calls.list(parentID))[0]!
      yield* calls.detach(record.id)

      yield* Fiber.interrupt(fiber)

      expect(yield* calls.get(record.id)).toMatchObject({ status: "running", background: true })
      expect(interruptCalls).not.toContain(record.childSessionID)

      yield* calls.cancelled(record.id)
      yield* sessions.interrupt(record.childSessionID)
      expect(yield* awaitDelivered(calls, record.id)).toMatchObject({
        status: "cancelled",
        background: true,
        deliveredAt: expect.any(Number),
      })
    }),
  )

  it.effect("cancels a foreground child when the parent tool wait is interrupted", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const db = (yield* Database.Service).db
      responses.push({ type: "block" })
      const fiber = yield* invoke(
        { model: { providerID, id: modelID }, prompt: "Wait in foreground" },
        "call-cancelled",
      ).pipe(Effect.forkChild)
      while (gates.size === 0) yield* Effect.yieldNow
      const record = (yield* calls.list(parentID))[0]!
      yield* db
        .update(SessionTable)
        .set({
          cost: 0.75,
          tokens_input: 11,
          tokens_output: 22,
          tokens_reasoning: 3,
          tokens_cache_read: 4,
          tokens_cache_write: 5,
        })
        .where(eq(SessionTable.id, record.childSessionID))
        .run()
        .pipe(Effect.orDie)

      yield* Fiber.interrupt(fiber)

      expect(yield* calls.get(record.id)).toMatchObject({
        status: "cancelled",
        background: false,
        usage: {
          cost: 0.75,
          tokens: { input: 11, output: 22, reasoning: 3, cache: { read: 4, write: 5 } },
        },
      })
      expect(interruptCalls).toContain(record.childSessionID)
    }),
  )
})

describe("ModelCallTool V2 recovery", () => {
  effectIt.live("interrupts recovery after an intermediate tool-call turn without resuming provider work", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) => {
        const layers = layerAt(Database.layerFromPath(path.join(directory.path, "model-call-tool-turn.sqlite")))
        const recoveryParentID = SessionV2.ID.make("ses_model_call_tool_turn_recovery")
        const seed = Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const calls = yield* ModelCallV2.Service
          const db = (yield* Database.Service).db
          const events = yield* EventV2.Service
          yield* sessions.create({
            id: recoveryParentID,
            location,
            agent: agentID,
            permission,
          })
          const reserved = yield* calls.reserve({
            parentSessionID: recoveryParentID,
            parentAssistantMessageID: SessionMessage.ID.make("msg_tool_turn_recovery_parent"),
            parentToolCallID: "call-tool-turn-recovery",
            agent: agentID,
            requestedModel: { providerID, id: modelID },
            actualModel: { providerID, id: modelID, variant: defaultVariant },
            location,
            permission: { version: "v2", rules: permission },
            prompt: "Inspect the implementation before reviewing it",
            runtime: "v2",
            background: false,
          })
          yield* sessions.create({
            id: reserved.childSessionID,
            parentID: recoveryParentID,
            title: "Model call recovery child",
            origin: {
              type: "model_call",
              callID: reserved.id,
              parentSessionID: recoveryParentID,
              parentAssistantMessageID: reserved.parentAssistantMessageID,
              parentToolCallID: reserved.parentToolCallID,
              requestedModel: reserved.requestedModel,
            },
            agent: agentID,
            model: reserved.actualModel,
            location,
            permission,
          })
          yield* sessions.prompt({
            id: reserved.childPromptID,
            sessionID: reserved.childSessionID,
            prompt: { text: reserved.prompt },
            delivery: "queue",
            resume: false,
          })
          yield* calls.queued(reserved.id)
          const started = yield* calls.started(reserved.id)
          yield* SessionInput.promoteNextQueued(db, events, reserved.childSessionID)
          yield* complete(
            db,
            events,
            reserved.childSessionID,
            "I need to inspect files before giving the final review.",
            undefined,
            "tool-calls",
          )
          return started
        }).pipe(Effect.scoped, Effect.provide(layers.seed))

        return seed.pipe(
          Effect.flatMap((seeded) =>
            Effect.sync(() => {
              responses.length = 0
              resumeCalls.length = 0
            }).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const calls = yield* ModelCallV2.Service
                  const recovered = yield* awaitTerminal(calls, seeded.id)

                  expect(recovered).toMatchObject({
                    status: "interrupted",
                    error: { code: "unknown_outcome", outcomeUnknown: true },
                    usage: {
                      cost: 0.25,
                      tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
                    },
                  })
                  expect(resumeCalls).toEqual([])
                }).pipe(Effect.scoped, Effect.provide(layers.recover)),
              ),
            ),
          ),
        )
      }),
    ),
  )

  effectIt.live("rejects a conflicting child returned by concurrent Session creation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) => {
        const layers = layerAt(Database.layerFromPath(path.join(directory.path, "model-call-conflict.sqlite")))
        const recoveryParentID = SessionV2.ID.make("ses_model_call_conflict_recovery")
        const seed = Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const calls = yield* ModelCallV2.Service
          yield* sessions.create({
            id: recoveryParentID,
            location,
            agent: agentID,
            permission,
          })
          const reserved = yield* calls.reserve({
            parentSessionID: recoveryParentID,
            parentAssistantMessageID: SessionMessage.ID.make("msg_conflict_recovery_parent"),
            parentToolCallID: "call-conflict-recovery",
            agent: agentID,
            requestedModel: { providerID, id: modelID },
            actualModel: { providerID, id: modelID, variant: defaultVariant },
            location,
            permission: { version: "v2", rules: permission },
            prompt: "Never admit this prompt",
            runtime: "v2",
            background: false,
          })
          yield* sessions.create({
            id: reserved.childSessionID,
            parentID: recoveryParentID,
            title: "Conflicting child",
            metadata: {},
            agent: agentID,
            model: {
              providerID,
              id: modelID,
              variant: ModelV2.VariantID.make("fast"),
            },
            location,
            permission: [{ action: "*", resource: "*", effect: "allow" }],
          })
          return reserved
        }).pipe(Effect.scoped, Effect.provide(layers.seed))

        return seed.pipe(
          Effect.flatMap((seeded) =>
            Effect.gen(function* () {
              const calls = yield* ModelCallV2.Service
              const sessions = yield* SessionV2.Service
              expect(yield* awaitTerminal(calls, seeded.id)).toMatchObject({
                status: "failed",
                error: { code: "preparation_conflict" },
              })
              expect(yield* sessions.messages({ sessionID: seeded.childSessionID })).toEqual([])
            }).pipe(Effect.scoped, Effect.provide(layers.recover)),
          ),
        )
      }),
    ),
  )

  effectIt.live("reuses the invocation-time permission overlay after restart", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) => {
        const layers = layerAt(Database.layerFromPath(path.join(directory.path, "model-call-permission.sqlite")))
        const recoveryParentID = SessionV2.ID.make("ses_model_call_permission_recovery")
        const seed = Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const calls = yield* ModelCallV2.Service
          const db = (yield* Database.Service).db
          yield* sessions.create({
            id: recoveryParentID,
            location,
            agent: agentID,
            permission,
          })
          const reserved = yield* calls.reserve({
            parentSessionID: recoveryParentID,
            parentAssistantMessageID: SessionMessage.ID.make("msg_permission_recovery_parent"),
            parentToolCallID: "call-permission-recovery",
            agent: agentID,
            requestedModel: { providerID, id: modelID },
            actualModel: { providerID, id: modelID, variant: defaultVariant },
            location,
            permission: { version: "v2", rules: permission },
            prompt: "Review with original authority",
            runtime: "v2",
            background: false,
          })
          yield* db
            .update(SessionTable)
            .set({
              permission_v2: [{ action: "*", resource: "*", effect: "allow" }],
            })
            .where(eq(SessionTable.id, recoveryParentID))
            .run()
            .pipe(Effect.orDie)
          return reserved
        }).pipe(Effect.scoped, Effect.provide(layers.seed))

        return seed.pipe(
          Effect.flatMap((seeded) =>
            Effect.sync(() => {
              responses.length = 0
              resumeCalls.length = 0
              responses.push({ type: "text", text: "Recovered review." })
            }).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const calls = yield* ModelCallV2.Service
                  const sessions = yield* SessionV2.Service
                  expect(yield* awaitTerminal(calls, seeded.id)).toMatchObject({ status: "completed" })
                  expect(yield* sessions.get(seeded.childSessionID)).toMatchObject({
                    permission,
                  })
                  expect(yield* sessions.get(recoveryParentID)).toMatchObject({
                    permission: [{ action: "*", resource: "*", effect: "allow" }],
                  })
                }).pipe(Effect.scoped, Effect.provide(layers.recover)),
              ),
            ),
          ),
        )
      }),
    ),
  )

  effectIt.live("admits a recorded-but-missing correction prompt before resuming", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) => {
        const layers = layerAt(Database.layerFromPath(path.join(directory.path, "model-call.sqlite")))
        const recoveryParentID = SessionV2.ID.make("ses_model_call_correction_recovery")
        const seed = Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const calls = yield* ModelCallV2.Service
          const db = (yield* Database.Service).db
          const events = yield* EventV2.Service
          yield* sessions.create({
            id: recoveryParentID,
            location,
            agent: agentID,
            permission,
          })
          const reserved = yield* calls.reserve({
            parentSessionID: recoveryParentID,
            parentAssistantMessageID: SessionMessage.ID.make("msg_recovery_parent"),
            parentToolCallID: "call-recovery",
            agent: agentID,
            requestedModel: { providerID, id: modelID },
            actualModel: { providerID, id: modelID, variant: defaultVariant },
            location,
            permission: { version: "v2", rules: permission },
            prompt: "Return findings",
            outputSchema: {
              type: "object",
              properties: { findings: { type: "array" } },
              required: ["findings"],
            },
            runtime: "v2",
            background: false,
          })
          yield* sessions.create({
            id: reserved.childSessionID,
            parentID: recoveryParentID,
            title: "Model call recovery child",
            origin: {
              type: "model_call",
              callID: reserved.id,
              parentSessionID: recoveryParentID,
              parentAssistantMessageID: reserved.parentAssistantMessageID,
              parentToolCallID: reserved.parentToolCallID,
              requestedModel: reserved.requestedModel,
              outputSchema: reserved.outputSchema,
            },
            agent: agentID,
            model: reserved.actualModel,
            location,
            permission,
          })
          yield* sessions.prompt({
            id: reserved.childPromptID,
            sessionID: reserved.childSessionID,
            prompt: {
              text: [
                reserved.prompt,
                "",
                "Return only one JSON object that validates against this JSON Schema:",
                JSON.stringify(reserved.outputSchema),
              ].join("\n"),
            },
            delivery: "queue",
            resume: false,
          })
          yield* calls.queued(reserved.id)
          yield* calls.started(reserved.id)
          yield* SessionInput.promoteNextQueued(db, events, reserved.childSessionID)
          yield* complete(db, events, reserved.childSessionID, "not json")
          const correcting = yield* calls.requestCorrection(reserved.id, "Response is not valid JSON")
          expect(yield* SessionInput.find(db, correcting.correctionPromptID)).toBeUndefined()
          return correcting
        }).pipe(Effect.scoped, Effect.provide(layers.seed))

        return seed.pipe(
          Effect.flatMap((seeded) =>
            Effect.sync(() => {
              responses.length = 0
              resumeCalls.length = 0
              responses.push({ type: "text", text: '{"findings":[]}' })
            }).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const calls = yield* ModelCallV2.Service
                  const sessions = yield* SessionV2.Service
                  const completed = yield* awaitTerminal(calls, seeded.id)

                  expect(completed).toMatchObject({
                    status: "completed",
                    structured: { findings: [] },
                    validationAttempts: 1,
                  })
                  expect(
                    yield* SessionInput.find((yield* Database.Service).db, seeded.correctionPromptID),
                  ).toMatchObject({
                    id: seeded.correctionPromptID,
                    promotedSeq: expect.any(Number),
                  })
                  expect(yield* sessions.messages({ sessionID: seeded.childSessionID, order: "asc" })).toMatchObject([
                    {
                      type: "user",
                      text: expect.stringContaining(
                        "Return only one JSON object that validates against this JSON Schema",
                      ),
                    },
                    { type: "assistant", content: [{ type: "text", text: "not json" }] },
                    { type: "user", text: expect.stringContaining("required JSON Schema") },
                    { type: "assistant", content: [{ type: "text", text: '{"findings":[]}' }] },
                  ])
                }).pipe(Effect.scoped, Effect.provide(layers.recover)),
              ),
            ),
          ),
        )
      }),
    ),
  )
})
