import { expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "../src/errors"
import { makeModelCallGroup } from "../src/groups/model-call"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "@opencode-ai/protocol/test/SessionLocationMiddleware",
  { error: [InvalidRequestError, SessionNotFoundError] },
) {}

test("model-call protocol exposes lifecycle operations", () => {
  const spec = OpenApi.fromApi(HttpApi.make("model-call-test").add(makeModelCallGroup(SessionLocationMiddleware))) as {
    readonly paths: Record<string, { readonly get?: unknown; readonly post?: unknown }>
  }

  expect(spec.paths["/api/session/{sessionID}/model-call"]?.get).toBeDefined()
  expect(spec.paths["/api/session/{sessionID}/model-call/{callID}"]?.get).toBeDefined()
  expect(spec.paths["/api/session/{sessionID}/model-call/{callID}/cancel"]?.post).toBeDefined()
  expect(spec.paths["/api/session/{sessionID}/model-call/{callID}/detach"]?.post).toBeDefined()
  expect(Object.keys(spec.paths).some((path) => path.startsWith("/api/model-call/"))).toBeFalse()
})
