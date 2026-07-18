import { LifecycleError } from './errors.js'
import type { LifecycleState } from './types.js'

export const lifecycleTransitions: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  uninitialized: ['approved'],
  approved: ['reserved', 'accepted', 'unknown'],
  reserved: ['sending', 'cancelled'],
  sending: ['accepted', 'unknown', 'failed'],
  accepted: ['driver_reported', 'unknown'],
  unknown: ['assignment_reconciled', 'failed'],
  assignment_reconciled: ['driver_reported'],
  driver_reported: ['supporting_evidence_received', 'evidence_reconciled', 'disputed'],
  supporting_evidence_received: ['evidence_reconciled', 'disputed'],
  evidence_reconciled: ['customer_confirmed', 'disputed'],
  customer_confirmed: ['disputed'],
  disputed: ['reopened'],
  reopened: ['reserved', 'cancelled'],
  cancelled: [],
  failed: [],
}

export function assertLifecycleTransition(from: LifecycleState, to: LifecycleState): void {
  if (!lifecycleTransitions[from].includes(to)) {
    throw new LifecycleError('invalid_transition', `Cannot transition from ${from} to ${to}.`)
  }
}

export function transitionLifecycleState(from: LifecycleState, to: LifecycleState): LifecycleState {
  assertLifecycleTransition(from, to)
  return to
}
