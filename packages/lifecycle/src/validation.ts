import {
  CaseIdSchema,
  EvidenceIdSchema,
  OperationIdSchema,
  ProposalIdSchema,
  RouteQuoteIdSchema,
  TenantIdSchema,
} from '@trashpal/contracts'
import { digest, equalText } from './canonical.js'
import { LifecycleError } from './errors.js'
import type {
  CurrentDecisionInputs,
  DispatchAssignment,
  ExecutionSnapshot,
  OutcomeEvidence,
  OutcomeEvidenceKind,
} from './types.js'

const identifierSchemas = {
  tenant: TenantIdSchema,
  case: CaseIdSchema,
  proposal: ProposalIdSchema,
  operation: OperationIdSchema,
  evidence: EvidenceIdSchema,
  quote: RouteQuoteIdSchema,
} as const

const isoWithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const OUTCOME_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1_000

export type IdentifierKind = keyof typeof identifierSchemas

export function assertIdentifier(value: string, kind: IdentifierKind): void {
  const result = identifierSchemas[kind].safeParse(value)
  if (!result.success) {
    throw new LifecycleError('invalid_identifier', `${kind} identifier is invalid.`)
  }
}

export function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new LifecycleError('invalid_digest', `${label} must be a lowercase SHA-256 digest.`)
  }
}

export function assertIsoTimestamp(value: string, label: string): void {
  if (!isoWithOffset.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new LifecycleError('invalid_time', `${label} must be an ISO-8601 timestamp with an offset.`)
  }
}

export function assertUuid(value: string, label: string): void {
  if (!uuid.test(value)) throw new LifecycleError('invalid_idempotency_key', `${label} must be a UUID.`)
}

function assertPayloadDigest(value: unknown, expected: string, label: string): void {
  let actual: string
  try {
    actual = digest(value)
  } catch {
    throw new LifecycleError('invalid_payload', `${label} must be canonical JSON data.`)
  }
  if (!equalText(actual, expected)) {
    throw new LifecycleError('payload_digest_mismatch', `${label} does not match its canonical payload.`)
  }
}

export function assertCurrentInputs(input: CurrentDecisionInputs): void {
  assertIdentifier(input.tenantId, 'tenant')
  assertIdentifier(input.caseId, 'case')
  assertIdentifier(input.proposalId, 'proposal')
  assertIdentifier(input.evidenceSnapshotId, 'evidence')
  assertIdentifier(input.routeQuoteId, 'quote')
  assertDigest(input.proposalDigest, 'proposalDigest')
  assertDigest(input.contextBundleHash, 'contextBundleHash')
  assertDigest(input.evidencePacketHash, 'evidencePacketHash')
  assertDigest(input.routeQuoteHash, 'routeQuoteHash')
  if (!Number.isSafeInteger(input.evidenceRevision) || input.evidenceRevision < 0
      || !Number.isSafeInteger(input.routeRevision) || input.routeRevision < 0) {
    throw new LifecycleError('invalid_revision', 'Revisions must be non-negative safe integers.')
  }
  assertIsoTimestamp(input.serviceStart, 'serviceStart')
  assertIsoTimestamp(input.serviceEnd, 'serviceEnd')
  assertIsoTimestamp(input.validUntil, 'validUntil')
  if (Date.parse(input.serviceEnd) <= Date.parse(input.serviceStart)) {
    throw new LifecycleError('invalid_service_interval', 'serviceEnd must be later than serviceStart.')
  }
  assertPayloadDigest(input.proposalPayload, input.proposalDigest, 'proposalDigest')
  assertPayloadDigest(input.contextBundlePayload, input.contextBundleHash, 'contextBundleHash')
  assertPayloadDigest(input.evidencePacketPayload, input.evidencePacketHash, 'evidencePacketHash')
  assertPayloadDigest(input.routeQuotePayload, input.routeQuoteHash, 'routeQuoteHash')

  const proposal = input.proposalPayload
  const evidence = input.evidencePacketPayload
  const quote = input.routeQuotePayload
  if (
    proposal.id !== input.proposalId
    || proposal.tenantId !== input.tenantId
    || proposal.caseId !== input.caseId
    || proposal.routeQuoteId !== input.routeQuoteId
    || proposal.workOrder.vehicleId !== input.vehicleId
    || proposal.workOrder.serviceStart !== input.serviceStart
    || proposal.workOrder.serviceEnd !== input.serviceEnd
    || proposal.validUntil !== input.validUntil
    || evidence.id !== input.evidenceSnapshotId
    || evidence.tenantId !== input.tenantId
    || evidence.caseId !== input.caseId
    || evidence.revision !== input.evidenceRevision
    || quote.id !== input.routeQuoteId
    || quote.tenantId !== input.tenantId
    || quote.caseId !== input.caseId
    || quote.revision !== input.routeRevision
    || quote.vehicleId !== input.vehicleId
    || quote.serviceStart !== input.serviceStart
    || quote.serviceEnd !== input.serviceEnd
  ) {
    throw new LifecycleError('payload_binding_mismatch', 'Decision fields do not match their canonical payloads.')
  }
  assertIsoTimestamp(evidence.validUntil, 'evidence.validUntil')
  assertIsoTimestamp(quote.validUntil, 'quote.validUntil')
  const earliestValidity = Math.min(Date.parse(evidence.validUntil), Date.parse(quote.validUntil))
  if (Date.parse(input.validUntil) !== earliestValidity) {
    throw new LifecycleError('invalid_validity_boundary', 'validUntil must equal the earliest evidence or quote boundary.')
  }
}

export function assertOutcomeEvidence(
  evidence: OutcomeEvidence,
  expectedKind: OutcomeEvidenceKind,
  tenantId: string,
  operationId: string,
  time: { notBefore: string; now: string; maxFutureSkewMs?: number },
): void {
  assertIdentifier(evidence.id, 'evidence')
  assertIdentifier(evidence.tenantId, 'tenant')
  assertIdentifier(evidence.operationId, 'operation')
  assertDigest(evidence.contentHash, 'contentHash')
  assertIsoTimestamp(evidence.observedAt, 'observedAt')
  if (!evidence.sourceId || evidence.sourceId.length > 300) {
    throw new LifecycleError('invalid_evidence_source', 'Evidence requires a bounded source identifier.')
  }
  if (evidence.kind !== expectedKind || evidence.tenantId !== tenantId || evidence.operationId !== operationId) {
    throw new LifecycleError('evidence_binding_mismatch', 'Evidence kind, tenant, or operation does not match the transition.')
  }
  assertIsoTimestamp(time.notBefore, 'evidence.notBefore')
  assertIsoTimestamp(time.now, 'evidence.now')
  const maxFutureSkewMs = time.maxFutureSkewMs ?? OUTCOME_EVIDENCE_FUTURE_SKEW_MS
  if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    throw new LifecycleError('invalid_time', 'Evidence future skew must be a non-negative safe integer.')
  }
  const observedAtMs = Date.parse(evidence.observedAt)
  if (observedAtMs < Date.parse(time.notBefore) || observedAtMs > Date.parse(time.now) + maxFutureSkewMs) {
    throw new LifecycleError('evidence_time_invalid', 'Evidence must follow the operation event history and cannot exceed clock skew.')
  }
}

export function assignmentMatchesSnapshot(assignment: DispatchAssignment, snapshot: ExecutionSnapshot): boolean {
  return assignment.tenantId === snapshot.tenantId
    && assignment.operationId === snapshot.operationId
    && equalText(assignment.idempotencyKey, snapshot.idempotencyKey)
    && equalText(assignment.snapshotDigest, snapshot.digest)
    && equalText(assignment.proposalDigest, snapshot.proposalDigest)
    && equalText(assignment.approvalDigest, snapshot.approvalDigest)
    && equalText(assignment.routeQuoteHash, snapshot.routeQuoteHash)
    && assignment.vehicleId === snapshot.vehicleId
    && assignment.serviceStart === snapshot.serviceStart
    && assignment.serviceEnd === snapshot.serviceEnd
}
