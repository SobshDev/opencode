export * as ConfigModelCall from "./model-call"

import { Schema } from "effect"

export class Model extends Schema.Class<Model>("Config.ModelCall.Model")({
  description: Schema.String.check(Schema.isPattern(/\S/)).annotate({
    description: "When this model should be selected for delegated work",
  }),
}) {}

export class Info extends Schema.Class<Info>("Config.ModelCall")({
  models: Schema.Record(Schema.String.check(Schema.isPattern(/^[^/]+\/.+$/)), Model).annotate({
    description: "Models callable through model_call, keyed by exact provider/model reference",
  }),
}) {}
