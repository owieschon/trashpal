import { digest, LifecycleEngine, ProcessSessionAuthority } from '../../packages/lifecycle/src/index.js'
import type { Clock, CurrentDecisionInputs, IdSource, OutcomeEvidence, OutcomeEvidenceKind } from '../../packages/lifecycle/src/index.js'

export class FixedClock implements Clock {
  constructor(private value = '2026-07-21T18:20:00.000Z') {}

  now(): Date {
    return new Date(this.value)
  }

  set(value: string): void {
    this.value = value
  }
}

export const fixedIds: IdSource = {
  operationId: () => 'op_recovery-001',
  idempotencyKey: () => '6d822bda-a88e-4f7f-9773-4cb88e7823f2',
  reservationId: () => 'reservation_recovery-001',
}

export function decisionInputs(overrides: Partial<CurrentDecisionInputs> = {}): CurrentDecisionInputs {
  const values = {
    tenantId: overrides.tenantId ?? 'ten_harborworks',
    caseId: overrides.caseId ?? 'case_greenleaf-0881',
    proposalId: overrides.proposalId ?? 'proposal_greenleaf-001',
    evidenceSnapshotId: overrides.evidenceSnapshotId ?? 'ev_packet-001',
    routeQuoteId: overrides.routeQuoteId ?? 'quote_greenleaf-001',
    evidenceRevision: overrides.evidenceRevision ?? 7,
    routeRevision: overrides.routeRevision ?? 3,
    vehicleId: overrides.vehicleId ?? 'veh_v42',
    serviceStart: overrides.serviceStart ?? '2026-07-21T19:24:00.000Z',
    serviceEnd: overrides.serviceEnd ?? '2026-07-21T19:39:00.000Z',
    validUntil: overrides.validUntil ?? '2026-07-21T20:00:00.000Z',
    revoked: overrides.revoked ?? false,
  }
  const proposalPayload = overrides.proposalPayload ?? {
    id: values.proposalId,
    tenantId: values.tenantId,
    caseId: values.caseId,
    routeQuoteId: values.routeQuoteId,
    outcome: 'prepare_recovery',
    workOrder: {
      vehicleId: values.vehicleId,
      serviceStart: values.serviceStart,
      serviceEnd: values.serviceEnd,
    },
    validUntil: values.validUntil,
  }
  const contextBundlePayload = overrides.contextBundlePayload ?? {
    id: 'context_bundle-recovery-v1',
    tenantId: values.tenantId,
    version: '1.0.0',
  }
  const evidencePacketPayload = overrides.evidencePacketPayload ?? {
    id: values.evidenceSnapshotId,
    tenantId: values.tenantId,
    caseId: values.caseId,
    revision: values.evidenceRevision,
    validUntil: values.validUntil,
    evidenceIds: ['ev_agreement-001', 'ev_access-001'],
  }
  const routeQuotePayload = overrides.routeQuotePayload ?? {
    id: values.routeQuoteId,
    tenantId: values.tenantId,
    caseId: values.caseId,
    revision: values.routeRevision,
    vehicleId: values.vehicleId,
    serviceStart: values.serviceStart,
    serviceEnd: values.serviceEnd,
    validUntil: values.validUntil,
  }
  return {
    ...values,
    proposalPayload,
    contextBundlePayload,
    evidencePacketPayload,
    routeQuotePayload,
    proposalDigest: overrides.proposalDigest ?? digest(proposalPayload),
    contextBundleHash: overrides.contextBundleHash ?? digest(contextBundlePayload),
    evidencePacketHash: overrides.evidencePacketHash ?? digest(evidencePacketPayload),
    routeQuoteHash: overrides.routeQuoteHash ?? digest(routeQuotePayload),
  }
}

export function outcomeEvidence(
  operationId: string,
  kind: OutcomeEvidenceKind,
  id: string,
  overrides: Partial<OutcomeEvidence> = {},
): OutcomeEvidence {
  return {
    id,
    tenantId: 'ten_harborworks',
    operationId,
    kind,
    sourceId: `source-${kind}`,
    contentHash: digest({ id, kind }),
    observedAt: '2026-07-21T18:20:00.000Z',
    ...overrides,
  }
}

export function lifecycleFixture(): {
  authority: ProcessSessionAuthority
  clock: FixedClock
  engine: LifecycleEngine
  dispatcherSession: string
  viewerSession: string
  customerSession: string
  foreignDispatcherSession: string
  preparationWorkerSession: string
  dispatchWorkerSession: string
  foreignWorkerSession: string
} {
  const clock = new FixedClock()
  const authority = new ProcessSessionAuthority(Buffer.alloc(32, 7), { clock })
  const dispatcherSession = authority.issue({
    subjectId: 'usr_maya',
    tenantId: 'ten_harborworks',
    capabilities: ['approve_recovery', 'read_lifecycle'],
  })
  const viewerSession = authority.issue({
    subjectId: 'usr_harborworks_viewer',
    tenantId: 'ten_harborworks',
    capabilities: ['read_lifecycle'],
  })
  const customerSession = authority.issue({
    subjectId: 'usr_greenleaf_customer',
    tenantId: 'ten_harborworks',
    capabilities: ['read_lifecycle', 'confirm_customer_outcome', 'dispute_customer_outcome', 'reopen_recovery'],
  })
  const foreignDispatcherSession = authority.issue({
    subjectId: 'usr_riverview_dispatcher',
    tenantId: 'ten_riverview',
    capabilities: ['approve_recovery', 'read_lifecycle'],
  })
  const preparationWorkerSession = authority.issueWorker({
    workerId: 'worker_context',
    tenantId: 'ten_harborworks',
    capabilities: ['prepare_decision_inputs'],
  })
  const dispatchWorkerSession = authority.issueWorker({
    workerId: 'worker_dispatch',
    tenantId: 'ten_harborworks',
    capabilities: ['dispatch_recovery', 'reconcile_dispatch', 'record_provider_evidence'],
  })
  const foreignWorkerSession = authority.issueWorker({
    workerId: 'worker_riverview',
    tenantId: 'ten_riverview',
    capabilities: ['prepare_decision_inputs', 'dispatch_recovery', 'reconcile_dispatch', 'record_provider_evidence'],
  })
  return {
    authority,
    clock,
    engine: new LifecycleEngine({ authority, clock, ids: fixedIds }),
    dispatcherSession,
    viewerSession,
    customerSession,
    foreignDispatcherSession,
    preparationWorkerSession,
    dispatchWorkerSession,
    foreignWorkerSession,
  }
}
