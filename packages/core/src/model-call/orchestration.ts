export * as ModelCallOrchestration from "./orchestration"

import { ModelCall } from "@opencode-ai/schema/model-call"
import Ajv from "ajv"
import { Option, Schema } from "effect"

export const MAX_STRUCTURED_BYTES = 1024 * 1024

export type ModelIdentity = {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export type Provenance =
  | {
      readonly matches: true
      readonly expected: ModelIdentity
      readonly actual: ModelIdentity
    }
  | {
      readonly matches: false
      readonly expected: ModelIdentity
      readonly actual: ModelIdentity
      readonly error: ModelCall.Error
    }

export function compareProvenance(expected: ModelIdentity, actual: ModelIdentity): Provenance {
  const normalizedExpected = normalizeModel(expected)
  const normalizedActual = normalizeModel(actual)
  if (
    normalizedExpected.providerID === normalizedActual.providerID &&
    normalizedExpected.id === normalizedActual.id &&
    normalizedExpected.variant === normalizedActual.variant
  )
    return {
      matches: true,
      expected: normalizedExpected,
      actual: normalizedActual,
    }
  return {
    matches: false,
    expected: normalizedExpected,
    actual: normalizedActual,
    error: {
      code: "model_mismatch",
      message: `Expected ${formatModel(normalizedExpected)}, but the child returned ${formatModel(normalizedActual)}`,
    },
  }
}

export function normalizeVariant(variant: string | undefined) {
  return variant === undefined || variant === "default" ? undefined : variant
}

export type OutputSchemaValidation =
  | { readonly valid: true }
  | {
      readonly valid: false
      readonly error: string
    }

export function validateOutputSchema(schema: Record<string, unknown>): OutputSchemaValidation {
  if (schema.type !== "object")
    return {
      valid: false,
      error: 'output_schema must have an object root (`type: "object"`)',
    }
  try {
    new Ajv({ strict: false }).compile(schema)
    return { valid: true }
  } catch (error) {
    return {
      valid: false,
      error: `Invalid output_schema: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export type StructuredValidation =
  | {
      readonly structured: unknown
      readonly error?: never
      readonly code?: never
    }
  | {
      readonly structured?: never
      readonly error: string
      readonly code: "structured_output_invalid" | "structured_output_too_large"
    }

export function validateStructured(schema: Record<string, unknown> | undefined, input: unknown): StructuredValidation {
  if (!schema) return { structured: undefined }
  try {
    const decoded =
      typeof input === "string"
        ? Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(stripFence(input))
        : Option.some(input)
    if (Option.isNone(decoded))
      return {
        code: "structured_output_invalid",
        error: "Response is not valid JSON",
      }
    const structured = decoded.value
    const encoded = JSON.stringify(structured)
    if (new TextEncoder().encode(encoded).byteLength > MAX_STRUCTURED_BYTES)
      return {
        code: "structured_output_too_large",
        error: "Structured output exceeds the 1 MiB storage limit",
      }
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    if (validate(structured)) return { structured }
    return {
      code: "structured_output_invalid",
      error: ajv.errorsText(validate.errors),
    }
  } catch (error) {
    return {
      code: "structured_output_invalid",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function initialPrompt(input: {
  readonly prompt: string
  readonly outputSchema?: Record<string, unknown>
  readonly nativeStructured?: boolean
}) {
  if (!input.outputSchema || input.nativeStructured) return input.prompt
  return [
    input.prompt,
    "",
    "Return only one JSON object that validates against this JSON Schema:",
    JSON.stringify(input.outputSchema),
  ].join("\n")
}

export function correctionPrompt(outputSchema: Record<string, unknown>) {
  return [
    "Your previous response did not validate against the required JSON Schema.",
    "Return only one JSON object that validates against this schema:",
    JSON.stringify(outputSchema),
  ].join("\n")
}

export type PromptAdmissionState = "missing" | "admitted" | "promoted"

export type AssistantTurnState = "none" | "incomplete" | "continuation" | "terminal"

export type PromptAdmissionObservation = {
  readonly exists: boolean
  readonly promoted: boolean
}

export type AssistantTurnObservation = {
  readonly exists: boolean
  readonly completed: boolean
  readonly error: boolean
  readonly finish?: string
  readonly continuation?: boolean
  readonly continuationFinishes?: ReadonlyArray<string>
}

export type ChildLifecycleObservation = {
  readonly status: ModelCall.Status
  readonly prompt: PromptAdmissionObservation
  readonly assistant: AssistantTurnObservation
}

export type RecoveryObservation =
  | {
      readonly stage: "record"
      readonly status: ModelCall.Status
      readonly slotReserved: boolean
    }
  | {
      readonly stage: "child"
      readonly status: ModelCall.Status
      readonly prompt: PromptAdmissionState
      readonly assistant: AssistantTurnState
    }

export type RecoveryAction =
  | { readonly action: "deliver" }
  | { readonly action: "prepare"; readonly reserveSlot: boolean }
  | { readonly action: "settle" }
  | { readonly action: "resume" }
  | { readonly action: "interrupt" }

export function classifyPromptAdmission(input: PromptAdmissionObservation) {
  if (!input.exists) return "missing" as const
  return input.promoted ? ("promoted" as const) : ("admitted" as const)
}

export function classifyAssistantTurn(input: AssistantTurnObservation): AssistantTurnState {
  if (!input.exists) return "none"
  if (input.error) return "terminal"
  if (input.continuation || (input.finish !== undefined && input.continuationFinishes?.includes(input.finish)))
    return "continuation"
  if (input.completed || input.finish !== undefined) return "terminal"
  return "incomplete"
}

export function observeChildLifecycle(input: ChildLifecycleObservation): RecoveryObservation {
  return {
    stage: "child",
    status: input.status,
    prompt: classifyPromptAdmission(input.prompt),
    assistant: classifyAssistantTurn(input.assistant),
  }
}

export function decideRecovery(observation: RecoveryObservation): RecoveryAction {
  if (isTerminal(observation.status)) return { action: "deliver" }
  if (observation.stage === "record") return { action: "prepare", reserveSlot: !observation.slotReserved }
  if (observation.assistant === "terminal") return { action: "settle" }
  if (observation.assistant === "incomplete" || observation.assistant === "continuation") return { action: "interrupt" }
  if (observation.prompt === "promoted") return { action: "interrupt" }
  return { action: "resume" }
}

function normalizeModel(model: ModelIdentity): ModelIdentity {
  const variant = normalizeVariant(model.variant)
  return {
    providerID: model.providerID,
    id: model.id,
    ...(variant === undefined ? {} : { variant }),
  }
}

function formatModel(model: ModelIdentity) {
  return `${model.providerID}/${model.id}${model.variant ? `/${model.variant}` : ""}`
}

function stripFence(text: string) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1] ?? trimmed
}

function isTerminal(status: ModelCall.Status) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"
}
