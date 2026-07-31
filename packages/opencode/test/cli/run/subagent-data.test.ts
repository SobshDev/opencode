import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { entryBody } from "@/cli/cmd/run/entry.body"
import {
  bootstrapSubagentCalls,
  bootstrapSubagentData,
  createSubagentData,
  modelCallAction,
  reduceSubagentData,
  snapshotSubagentData,
} from "@/cli/cmd/run/subagent-data"

type SessionMessage = Parameters<typeof bootstrapSubagentData>[0]["messages"][number]
type ChildMessage = Parameters<typeof bootstrapSubagentCalls>[0]["messages"][number]

function visible(commits: Array<Parameters<typeof entryBody>[0]>) {
  return commits.flatMap((item) => {
    const body = entryBody(item)
    if (body.type === "none") {
      return []
    }

    if (body.type === "structured") {
      if (body.snapshot.kind === "code" || body.snapshot.kind === "task") {
        return [body.snapshot.title]
      }

      if (body.snapshot.kind === "diff") {
        return body.snapshot.items.map((item) => item.title)
      }

      if (body.snapshot.kind === "todo") {
        return ["# Todos"]
      }

      return ["# Questions"]
    }

    return [body.content]
  })
}

function reduce(data: ReturnType<typeof createSubagentData>, event: unknown) {
  return reduceSubagentData({
    data,
    event: event as Event,
    sessionID: "parent-1",
    thinking: true,
    limits: {},
  })
}

function taskMessage(sessionID: string, status: "running" | "completed" | "interrupted" = "completed"): SessionMessage {
  if (status === "running") {
    return {
      parts: [
        {
          id: `part-${sessionID}`,
          sessionID: "parent-1",
          messageID: `msg-${sessionID}`,
          type: "tool",
          callID: `call-${sessionID}`,
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "Scan reducer paths",
              subagent_type: "explore",
            },
            title: "Reducer touchpoints",
            metadata: {
              sessionId: sessionID,
              toolcalls: 4,
            },
            time: { start: 1 },
          },
        },
      ],
    }
  }

  if (status === "interrupted") {
    return {
      parts: [
        {
          id: `part-${sessionID}`,
          sessionID: "parent-1",
          messageID: `msg-${sessionID}`,
          type: "tool",
          callID: `call-${sessionID}`,
          tool: "task",
          state: {
            status: "error",
            input: {
              description: "Scan reducer paths",
              subagent_type: "explore",
            },
            error: "Tool execution aborted",
            metadata: {
              sessionId: sessionID,
              toolcalls: 4,
              interrupted: true,
            },
            time: { start: 1, end: 2 },
          },
        },
      ],
    }
  }

  return {
    parts: [
      {
        id: `part-${sessionID}`,
        sessionID: "parent-1",
        messageID: `msg-${sessionID}`,
        type: "tool",
        callID: `call-${sessionID}`,
        tool: "task",
        state: {
          status: "completed",
          input: {
            description: "Scan reducer paths",
            subagent_type: "explore",
          },
          output: "",
          title: "Reducer touchpoints",
          metadata: {
            sessionId: sessionID,
            toolcalls: 4,
          },
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}

function modelCallMessage(sessionID: string): SessionMessage {
  return {
    parts: [
      {
        id: `part-${sessionID}`,
        sessionID: "parent-1",
        messageID: `msg-${sessionID}`,
        type: "tool",
        callID: `tool-${sessionID}`,
        tool: "model_call",
        state: {
          status: "completed",
          input: {
            model: {
              providerID: "anthropic",
              id: "claude-sonnet",
              variant: "thinking",
            },
            prompt: "Review the implementation",
            background: true,
          },
          output: "",
          title: "Review the implementation",
          metadata: {
            callID: "mcl_1",
            sessionId: sessionID,
            actualModel: {
              providerID: "anthropic",
              id: "claude-sonnet",
              variant: "thinking",
            },
            background: true,
            status: "running",
          },
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}

function modelCallChild(
  sessionID: string,
  callID = "mcl_1",
  requestedModel: { providerID: string; id: string; variant?: string } = {
    providerID: "anthropic",
    id: "claude-sonnet",
    variant: "thinking",
  },
) {
  return {
    id: sessionID,
    parentID: "parent-1",
    origin: {
      type: "model_call",
      callID,
      parentSessionID: "parent-1",
      parentAssistantMessageID: `msg-${sessionID}`,
      parentToolCallID: `tool-${sessionID}`,
      requestedModel,
    },
  }
}

function question(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    questions: [
      {
        question: "Mode?",
        header: "Mode",
        options: [{ label: "Fast", description: "Quick pass" }],
        multiple: false,
      },
    ],
  }
}

function childMessage(input: {
  messageID: string
  sessionID: string
  role: "user" | "assistant"
  parts: ChildMessage["parts"]
}) {
  if (input.role === "user") {
    return {
      info: {
        id: input.messageID,
        sessionID: input.sessionID,
        role: "user",
        time: {
          created: 1,
        },
        agent: "test",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
      },
      parts: input.parts,
    } satisfies ChildMessage
  }

  return {
    info: {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "assistant",
      time: {
        created: 2,
        completed: 3,
      },
      parentID: "msg-user-1",
      providerID: "openai",
      modelID: "gpt-5",
      mode: "default",
      agent: "explore",
      path: {
        cwd: "/tmp",
        root: "/tmp",
      },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      finish: "stop",
    },
    parts: input.parts,
  } satisfies ChildMessage
}

describe("run subagent data", () => {
  test("bootstraps tabs and child blockers from parent task parts", () => {
    const data = createSubagentData()

    expect(
      bootstrapSubagentData({
        data,
        messages: [taskMessage("child-1")],
        children: [{ id: "child-1" }, { id: "child-2" }],
        permissions: [
          {
            id: "perm-1",
            sessionID: "child-1",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
          {
            id: "perm-2",
            sessionID: "other",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
        ],
        questions: [question("question-1", "child-1"), question("question-2", "other")],
      }),
    ).toBe(true)

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        label: "Explore",
        description: "Scan reducer paths",
        title: "Reducer touchpoints",
        status: "completed",
        toolCalls: 4,
      }),
    ])
    expect(snapshot.details).toEqual({
      "child-1": {
        sessionID: "child-1",
        commits: [],
      },
    })
    expect(snapshot.permissions.map((item) => item.id)).toEqual(["perm-1"])
    expect(snapshot.questions.map((item) => item.id)).toEqual(["question-1"])
  })

  test("marks interrupted task tabs as cancelled during bootstrap", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "interrupted")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        status: "cancelled",
      }),
    ])
  })

  test("tracks model calls as navigable child tabs with exact model provenance", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [modelCallMessage("child-model-1")],
      children: [modelCallChild("child-model-1")],
      modelCalls: [
        {
          callID: "mcl_1",
          parentSessionID: "parent-1",
          childSessionID: "child-model-1",
          requestedModel: {
            providerID: "anthropic",
            id: "claude-sonnet",
            variant: "thinking",
          },
          actualModel: {
            providerID: "anthropic",
            id: "claude-sonnet",
            variant: "thinking",
          },
          prompt: "Review the implementation",
          background: true,
          status: "completed",
          usage: {
            cost: 0.004,
            tokens: {
              input: 100,
              output: 40,
              reasoning: 10,
              cache: { read: 0, write: 0 },
            },
          },
          timeUpdated: 5,
        },
      ],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-model-1",
        kind: "model_call",
        modelCallID: "mcl_1",
        modelCallParentSessionID: "parent-1",
        model: "anthropic/claude-sonnet (thinking)",
        mode: "background",
        status: "completed",
        usage: "150 tokens · $0.0040",
      }),
    ])
    expect(modelCallAction(snapshotSubagentData(data).tabs[0]!)).toEqual({
      sessionID: "parent-1",
      callID: "mcl_1",
    })

    reduce(data, {
      type: "model.call.requested",
      properties: {
        callID: "mcl_1",
        childSessionID: "child-model-1",
        origin: {
          parentSessionID: "parent-1",
        },
      },
    })
    expect(snapshotSubagentData(data).tabs[0]?.status).toBe("completed")
  })

  test("hydrates model-call tabs from typed child origin without a parent tool snapshot", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [],
      children: [
        {
          ...modelCallChild("child-model-1", "mcl_2", { providerID: "openai", id: "gpt-5.1" }),
          title: "Independent review",
          model: { providerID: "openai", id: "gpt-5.1" },
          metadata: {
            modelCall: {
              type: "model_call",
              callID: "mcl_2",
              parentSessionID: "parent-1",
              requestedModel: { providerID: "openai", id: "gpt-5.1" },
              actualModel: { providerID: "openai", id: "gpt-5.1" },
              mode: "foreground",
              status: "queued",
            },
          },
        },
      ],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-model-1",
        modelCallID: "mcl_2",
        modelCallParentSessionID: "parent-1",
        label: "openai/gpt-5.1",
        description: "Independent review",
        status: "queued",
      }),
    ])
  })

  test("does not recognize or authorize metadata-only model-call children", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [modelCallMessage("child-model-1")],
      children: [
        {
          id: "child-model-1",
          metadata: {
            modelCall: {
              type: "model_call",
              callID: "mcl_spoofed",
              parentSessionID: "parent-1",
              parentAssistantMessageID: "msg-child-model-1",
              parentToolCallID: "tool-child-model-1",
              status: "running",
            },
          },
        },
      ],
      modelCalls: [
        {
          callID: "mcl_spoofed",
          parentSessionID: "parent-1",
          childSessionID: "child-model-1",
          status: "running",
        },
      ],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([])
  })

  test("recognizes a live model-call child only after its typed session origin arrives", () => {
    const data = createSubagentData()
    const child = modelCallChild("child-model-1")

    expect(
      reduce(data, {
        type: "session.created",
        properties: {
          sessionID: child.id,
          info: {
            ...child,
            title: "Live review",
            model: { providerID: "anthropic", id: "claude-sonnet", variant: "thinking" },
            metadata: {
              modelCall: {
                ...child.origin,
                status: "queued",
              },
            },
          },
        },
      }),
    ).toBe(true)
    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: child.id,
        modelCallID: "mcl_1",
        modelCallParentSessionID: "parent-1",
        status: "queued",
      }),
    ])
  })

  test("applies model-call lifecycle events to an existing child tab", () => {
    const data = createSubagentData()
    bootstrapSubagentData({
      data,
      messages: [modelCallMessage("child-model-1")],
      children: [modelCallChild("child-model-1")],
      permissions: [],
      questions: [],
    })

    reduce(data, {
      type: "model.call.failed",
      properties: {
        callID: "mcl_1",
        error: {
          code: "MODEL_ERROR",
          message: "Provider rejected the request",
        },
      },
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        modelCallID: "mcl_1",
        status: "failed",
        error: "Provider rejected the request",
      }),
    ])
  })

  test("captures child activity and blocker metadata in the footer detail state", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-user-1",
          messageID: "msg-user-1",
          sessionID: "child-1",
          type: "text",
          text: "Inspect footer tabs",
        },
      },
    })
    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: {
          id: "msg-user-1",
          role: "user",
        },
      },
    })
    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: {
          id: "msg-assistant-1",
          role: "assistant",
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "reason-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "reasoning",
          text: "planning next steps",
          time: { start: 1 },
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "git status --short",
            },
            time: { start: 1 },
          },
        },
      },
    })
    reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "child-1",
        permission: "bash",
        patterns: ["git status --short"],
        metadata: {},
        always: [],
        tool: {
          messageID: "msg-assistant-1",
          callID: "call-1",
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "text",
          text: "hello",
        },
      },
    })
    reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "child-1",
        messageID: "msg-assistant-1",
        partID: "txt-1",
        field: "text",
        delta: " world",
      },
    })

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "running" })])
    expect(visible(snapshot.details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "$ git status --short",
      "hello world",
    ])
    expect(snapshot.permissions).toEqual([
      expect.objectContaining({
        id: "perm-1",
        metadata: {
          input: {
            command: "git status --short",
          },
        },
      }),
    ])
    expect(snapshot.questions).toEqual([])
  })

  test("replays bootstrapped child session messages into inspector commits", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "completed")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    expect(
      bootstrapSubagentCalls({
        data,
        sessionID: "child-1",
        messages: [
          childMessage({
            messageID: "msg-user-1",
            sessionID: "child-1",
            role: "user",
            parts: [
              {
                id: "txt-user-1",
                messageID: "msg-user-1",
                sessionID: "child-1",
                type: "text",
                text: "Inspect footer tabs",
                time: { start: 1, end: 1 },
              },
            ],
          }),
          childMessage({
            messageID: "msg-assistant-1",
            sessionID: "child-1",
            role: "assistant",
            parts: [
              {
                id: "reason-1",
                messageID: "msg-assistant-1",
                sessionID: "child-1",
                type: "reasoning",
                text: "planning next steps",
                time: { start: 2, end: 2 },
              },
              {
                id: "txt-1",
                messageID: "msg-assistant-1",
                sessionID: "child-1",
                type: "text",
                text: "hello world",
                time: { start: 2, end: 3 },
              },
            ],
          }),
        ],
        thinking: true,
        limits: {},
      }),
    ).toBe(true)

    expect(visible(snapshotSubagentData(data).details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "hello world",
    ])
  })

  test("marks a running tab cancelled when the child session aborts", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: {
          id: "msg-assistant-1",
          sessionID: "child-1",
          role: "assistant",
          time: {
            created: 1,
            completed: 2,
          },
          error: {
            name: "MessageAbortedError",
            data: {
              message: "Aborted",
            },
          },
          parentID: "msg-user-1",
          providerID: "openai",
          modelID: "gpt-5",
          mode: "default",
          agent: "explore",
          path: {
            cwd: "/tmp",
            root: "/tmp",
          },
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          finish: "error",
        },
      },
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        status: "cancelled",
      }),
    ])
  })
})
