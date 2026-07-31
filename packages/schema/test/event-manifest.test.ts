import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, ModelCall, Permission, Project, Reference, Session, Workspace } from "../src"
import { DurableEventManifest } from "../src/durable-event-manifest"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions.length).toBe(69)
    expect(EventManifest.Definitions.length).toBe(99)
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(99)
    expect(EventManifest.Durable.size).toBe(46)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("model.call.requested")).toBe(ModelCall.Event.Requested)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    const sessionV1Live = [SessionV1.Event.PartDelta, SessionV1.Event.Diff, SessionV1.Event.Error]
    expect(
      EventManifest.Definitions.filter((definition) =>
        sessionV1Live.some((candidate) => candidate.type === definition.type),
      ),
    ).toEqual(sessionV1Live)
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Durable.get("model.call.requested.1")).toBe(ModelCall.Event.Requested)
    expect(DurableEventManifest.ModelCallDurable.schema).toBe(ModelCall.Event.Durable)
    expect(DurableEventManifest.ModelCallDurable.definitions.get("model.call.result-delivered.1")).toBe(
      ModelCall.Event.ResultDelivered,
    )
  })
})
