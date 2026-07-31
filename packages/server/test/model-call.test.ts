import { expect, test } from "bun:test"
import { SessionV2 } from "@opencode-ai/core/session"
import { modelCallOwnedBy } from "../src/handlers/model-call"

test("model-call ownership is scoped to its direct parent Session", () => {
  const parentSessionID = SessionV2.ID.make("ses_parent")
  expect(modelCallOwnedBy({ parentSessionID }, parentSessionID)).toBeTrue()
  expect(modelCallOwnedBy({ parentSessionID }, SessionV2.ID.make("ses_other"))).toBeFalse()
})
