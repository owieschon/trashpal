import { equalText } from './canonical.js'
import { transitionLifecycleState } from './state-machine.js'
import type { LifecycleState } from './types.js'

interface OpaqueBinding {
  proposalDigest: string
  evidenceDigest: string
  quoteDigest: string
  contextDigest?: string
  validityDigest?: string
}

type InputEvent =
  | { type: 'approve'; binding: OpaqueBinding }
  | { type: 'execute'; binding: OpaqueBinding }
  | { type: 'dispatch_ack_lost'; idempotencyKey: string }
  | { type: 'reconcile_assignment_found' }
  | { type: 'driver_reported_complete' }
  | { type: 'supporting_attachment_received'; attachmentId: string }
  | { type: 'evidence_reconciled' }
  | { type: 'customer_confirmed' }
  | { type: 'customer_disputed' }
  | { type: 'reopen' }

interface LifecycleScenarioInput {
  schemaVersion: '1.0'
  operationId: string
  binding: OpaqueBinding
  events: InputEvent[]
}

export interface LifecycleScenarioOutput {
  schemaVersion: '1.0'
  operationId: string
  states: string[]
  finalState: string
  accepted: boolean
  reason?: string
  evidenceIds: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseBinding(value: unknown): OpaqueBinding | undefined {
  if (!isObject(value)) return undefined
  const { proposalDigest, evidenceDigest, quoteDigest } = value
  const digestPattern = /^[a-f0-9]{64}$/
  if (
    typeof proposalDigest !== 'string'
    || typeof evidenceDigest !== 'string'
    || typeof quoteDigest !== 'string'
    || !digestPattern.test(proposalDigest)
    || !digestPattern.test(evidenceDigest)
    || !digestPattern.test(quoteDigest)
  ) return undefined
  const contextDigest = typeof value.contextDigest === 'string' && digestPattern.test(value.contextDigest)
    ? value.contextDigest
    : undefined
  const validityDigest = typeof value.validityDigest === 'string' && digestPattern.test(value.validityDigest)
    ? value.validityDigest
    : undefined
  if ((value.contextDigest !== undefined && contextDigest === undefined)
      || (value.validityDigest !== undefined && validityDigest === undefined)) return undefined
  return { proposalDigest, evidenceDigest, quoteDigest, ...(contextDigest ? { contextDigest } : {}), ...(validityDigest ? { validityDigest } : {}) }
}

function parseInput(value: unknown): LifecycleScenarioInput {
  if (!isObject(value) || value.schemaVersion !== '1.0' || typeof value.operationId !== 'string' || !Array.isArray(value.events)) {
    throw new Error('invalid lifecycle scenario input')
  }
  const binding = parseBinding(value.binding)
  if (!binding) throw new Error('invalid lifecycle binding')
  return {
    schemaVersion: '1.0',
    operationId: value.operationId,
    binding,
    events: value.events as InputEvent[],
  }
}

function bindingMatches(left: OpaqueBinding, right: OpaqueBinding): boolean {
  return equalText(left.proposalDigest, right.proposalDigest)
    && equalText(left.evidenceDigest, right.evidenceDigest)
    && equalText(left.quoteDigest, right.quoteDigest)
    && left.contextDigest === right.contextDigest
    && left.validityDigest === right.validityDigest
}

function rejected(input: LifecycleScenarioInput, states: string[], evidenceIds: string[], reason: string): LifecycleScenarioOutput {
  return {
    schemaVersion: '1.0',
    operationId: input.operationId,
    states,
    finalState: states.at(-1) ?? 'uninitialized',
    accepted: false,
    reason,
    evidenceIds,
  }
}

export function executeLifecycleScenario(value: unknown): LifecycleScenarioOutput {
  const input = parseInput(value)
  const states: string[] = []
  const evidenceIds: string[] = []
  let state: LifecycleState = 'uninitialized'
  let idempotencyKey: string | undefined

  for (const event of input.events) {
    if (!isObject(event) || typeof event.type !== 'string') return rejected(input, states, evidenceIds, 'invalid_event')
    if (event.type === 'approve') {
      const eventBinding = parseBinding(event.binding)
      if (!eventBinding || !bindingMatches(input.binding, eventBinding)) return rejected(input, states, evidenceIds, 'binding_mismatch')
      if (state !== 'uninitialized') return rejected(input, states, evidenceIds, 'invalid_transition')
      state = transitionLifecycleState(state, 'approved')
      states.push(state)
      continue
    }
    if (event.type === 'execute') {
      const eventBinding = parseBinding(event.binding)
      if (!eventBinding || !bindingMatches(input.binding, eventBinding)) return rejected(input, states, evidenceIds, 'binding_mismatch')
      if (state !== 'approved') return rejected(input, states, evidenceIds, 'invalid_transition')
      state = transitionLifecycleState(state, 'accepted')
      states.push(state)
      continue
    }
    if (event.type === 'dispatch_ack_lost') {
      if (typeof event.idempotencyKey !== 'string' || event.idempotencyKey.length === 0) return rejected(input, states, evidenceIds, 'invalid_idempotency_key')
      if (state === 'unknown' && event.idempotencyKey === idempotencyKey) continue
      if (state !== 'approved') return rejected(input, states, evidenceIds, 'reconciliation_required')
      idempotencyKey = event.idempotencyKey
      state = transitionLifecycleState(state, 'unknown')
      states.push(state)
      continue
    }
    if (event.type === 'reconcile_assignment_found') {
      if (state !== 'unknown' || !idempotencyKey) return rejected(input, states, evidenceIds, 'invalid_transition')
      state = transitionLifecycleState(state, 'assignment_reconciled')
      states.push(state)
      continue
    }
    if (event.type === 'driver_reported_complete') {
      if (state !== 'accepted' && state !== 'assignment_reconciled') return rejected(input, states, evidenceIds, 'invalid_transition')
      state = transitionLifecycleState(state, 'driver_reported')
      states.push(state)
      continue
    }
    if (event.type === 'supporting_attachment_received') {
      if (state !== 'driver_reported' || typeof event.attachmentId !== 'string' || event.attachmentId.length === 0) {
        return rejected(input, states, evidenceIds, 'invalid_transition')
      }
      evidenceIds.push(event.attachmentId)
      state = transitionLifecycleState(state, 'supporting_evidence_received')
      states.push(state)
      continue
    }
    if (event.type === 'evidence_reconciled') {
      if (state !== 'driver_reported' && state !== 'supporting_evidence_received') return rejected(input, states, evidenceIds, 'invalid_transition')
      state = transitionLifecycleState(state, 'evidence_reconciled')
      states.push(state)
      continue
    }
    if (event.type === 'customer_confirmed') {
      if (state !== 'evidence_reconciled') return rejected(input, states, evidenceIds, 'invalid_transition')
      state = transitionLifecycleState(state, 'customer_confirmed')
      states.push(state)
      continue
    }
    if (event.type === 'customer_disputed') {
      if (!['driver_reported', 'supporting_evidence_received', 'evidence_reconciled', 'customer_confirmed'].includes(state)) {
        return rejected(input, states, evidenceIds, 'invalid_transition')
      }
      state = transitionLifecycleState(state, 'disputed')
      states.push(state)
      continue
    }
    if (event.type === 'reopen') {
      if (state !== 'disputed') return rejected(input, states, evidenceIds, 'invalid_transition')
      state = transitionLifecycleState(state, 'reopened')
      states.push(state)
      continue
    }
    return rejected(input, states, evidenceIds, 'unknown_event')
  }

  return {
    schemaVersion: '1.0',
    operationId: input.operationId,
    states,
    finalState: state,
    accepted: true,
    evidenceIds,
  }
}

async function main(): Promise<void> {
  process.stdin.setEncoding('utf8')
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const output = executeLifecycleScenario(JSON.parse(raw))
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
