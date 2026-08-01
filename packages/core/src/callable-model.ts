export * as CallableModels from "./callable-model"

import { ModelCall } from "@opencode-ai/schema/model-call"
import { ModelV2 } from "./model"
import { ConfigModelCall } from "./config/model-call"

export const DEFAULT_LIMIT = 20

export interface SearchEntry {
  readonly item: ModelCall.CallableModel
  readonly released: number
}

export function project(model: ModelV2.Info, description?: string): ModelCall.CallableModel {
  return {
    ref: {
      id: model.id,
      providerID: model.providerID,
    },
    name: model.name,
    ...(description === undefined ? {} : { description }),
    ...(model.family === undefined ? {} : { family: model.family }),
    capabilities: {
      tools: model.capabilities.tools,
      input: [...model.capabilities.input],
      output: [...model.capabilities.output],
    },
    variants: model.variants.map((variant) => variant.id).toSorted(compare),
    status: model.status,
    limits: {
      context: model.limit.context,
      ...(model.limit.input === undefined ? {} : { input: model.limit.input }),
      output: model.limit.output,
    },
    cost: model.cost.map((cost) => ({
      ...(cost.tier === undefined ? {} : { tier: { type: cost.tier.type, size: cost.tier.size } }),
      input: cost.input,
      output: cost.output,
      cache: {
        read: cost.cache.read,
        write: cost.cache.write,
      },
    })),
  }
}

export const fromModel = (model: ModelV2.Info): SearchEntry => ({
  item: project(model),
  released: model.time.released,
})

export const fromConfiguredModel = (model: ModelV2.Info, description: string | undefined): SearchEntry => ({
  item: project(model, description),
  released: model.time.released,
})

export function search(entries: ReadonlyArray<SearchEntry>, input: ModelCall.ListInput): ModelCall.ListResult {
  const query = input.query?.trim().toLowerCase()
  const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor.substring("model:".length), 10)
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, ModelCall.MAX_LIST_LIMIT)
  const matches = entries
    .filter(({ item }) => input.providerID === undefined || item.ref.providerID === input.providerID)
    .filter(({ item }) => input.tools === undefined || item.capabilities.tools === input.tools)
    .filter(({ item }) => query === undefined || query === "" || searchable(item).includes(query))
    .toSorted((left, right) => {
      const score = relevance(right.item, query) - relevance(left.item, query)
      if (score !== 0) return score
      const released = right.released - left.released
      if (released !== 0) return released
      const provider = compare(left.item.ref.providerID, right.item.ref.providerID)
      if (provider !== 0) return provider
      return compare(left.item.ref.id, right.item.ref.id)
    })
  const items = matches.slice(offset, offset + limit).map((match) => match.item)
  const next = offset + items.length
  return {
    items,
    ...(next < matches.length ? { nextCursor: `model:${next}` } : {}),
  }
}

function searchable(model: ModelCall.CallableModel) {
  return [
    `${model.ref.providerID}/${model.ref.id}`,
    model.ref.providerID,
    model.ref.id,
    model.name,
    model.description,
    model.family,
    ...model.variants,
  ]
    .filter((value) => value !== undefined)
    .join(" ")
    .toLowerCase()
}

export function allowed(policy: ConfigModelCall.Info | undefined, model: ModelV2.Info) {
  return policy === undefined || policy.models[`${model.providerID}/${model.id}`] !== undefined
}

export function description(policy: ConfigModelCall.Info | undefined, model: ModelV2.Info) {
  return policy?.models[`${model.providerID}/${model.id}`]?.description
}

function relevance(model: ModelCall.CallableModel, query: string | undefined) {
  if (!query) return 0
  const reference = `${model.ref.providerID}/${model.ref.id}`.toLowerCase()
  if (reference === query) return 4
  if (model.ref.id.toLowerCase() === query || model.name.toLowerCase() === query) return 3
  if (
    reference.startsWith(query) ||
    model.ref.id.toLowerCase().startsWith(query) ||
    model.name.toLowerCase().startsWith(query)
  )
    return 2
  return 1
}

function compare(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
