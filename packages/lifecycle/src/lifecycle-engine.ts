import { randomUUID } from 'node:crypto'
import { deepFreeze, digest, equalText } from './canonical.js'
import { ConnectorRejectedError, isAcknowledgementLostError, LifecycleError } from './errors.js'
import { ProcessSessionAuthority, rejectCallerIdentity } from './session-authority.js'
import { assertLifecycleTransition } from './state-machine.js'
import type {
  ApprovalRecord,
  Capability,
  Clock,
  CurrentDecisionInputs,
  DispatchConnector,
  DispatchOperation,
  ExecutionSnapshot,
  IdSource,
  OperationEvent,
  OperationState,
  OutcomeEvidence,
  OutcomeEvidenceKind,
  OutcomeReceipt,
  Principal,
  ReconciliationResult,
  ReservationResult,
} from './types.js'
import {
  assignmentMatchesSnapshot,
  assertCurrentInputs,
  assertIdentifier,
  assertOutcomeEvidence,
  assertUuid,
} from './validation.js'

interface MutableOperation {
  id: string
  tenantId: string
  snapshot: Readonly<ExecutionSnapshot>
  state: OperationState
  revision: number
  events: OperationEvent[]
  evidenceIds: Set<string>
  providerAssignmentId?: string
  createdAt: string
  updatedAt: string
}

const systemClock: Clock = { now: () => new Date() }
const randomIds: IdSource = {
  operationId: () => `op_${randomUUID()}`,
  idempotencyKey: () => randomUUID(),
}

function immutableCopy<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value))
}

function sameBinding(approval: ApprovalRecord, current: CurrentDecisionInputs): boolean {
  return approval.tenantId === current.tenantId
    && approval.proposalId === current.proposalId
    && equalText(approval.proposalDigest, current.proposalDigest)
    && equalText(approval.contextBundleHash, current.contextBundleHash)
    && equalText(approval.evidencePacketHash, current.evidencePacketHash)
    && equalText(approval.routeQuoteHash, current.routeQuoteHash)
    && approval.evidenceRevision === current.evidenceRevision
    && approval.routeRevision === current.routeRevision
    && approval.validUntil === current.validUntil
}

function sameExecutableBinding(current: CurrentDecisionInputs, snapshot: ExecutionSnapshot): boolean {
  return current.tenantId === snapshot.tenantId
    && current.caseId === snapshot.caseId
    && current.proposalId === snapshot.proposalId
    && current.vehicleId === snapshot.vehicleId
    && current.serviceStart === snapshot.serviceStart
    && current.serviceEnd === snapshot.serviceEnd
    && current.validUntil === snapshot.approvalValidUntil
    && equalText(current.proposalDigest, snapshot.proposalDigest)
    && equalText(current.contextBundleHash, snapshot.contextBundleHash)
    && equalText(current.evidencePacketHash, snapshot.evidencePacketHash)
    && equalText(current.routeQuoteHash, snapshot.routeQuoteHash)
    && current.evidenceRevision === snapshot.evidenceRevision
    && current.routeRevision === snapshot.routeRevision
}

export class LifecycleEngine {
  readonly #authority: ProcessSessionAuthority
  readonly #clock: Clock
  readonly #ids: IdSource
  readonly #decisionInputs = new Map<string, Map<string, Readonly<CurrentDecisionInputs>>>()
  readonly #approvals = new Map<string, Readonly<ApprovalRecord>>()
  readonly #approvalByProposal = new Map<string, Map<string, string>>()
  readonly #operations = new Map<string, Map<string, MutableOperation>>()
  readonly #operationByProposal = new Map<string, Map<string, string>>()
  readonly #outcomeEvidence = new Map<string, Map<string, Readonly<OutcomeEvidence>>>()
  readonly #receipts = new Map<string, Readonly<OutcomeReceipt>>()

  constructor(options: {
    authority: ProcessSessionAuthority
    clock?: Clock
    ids?: IdSource
  }) {
    this.#authority = options.authority
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? randomIds
  }

  registerDecisionInputs(workerToken: string, input: CurrentDecisionInputs): void {
    const worker = this.#requirePrincipal(workerToken, 'worker', 'prepare_decision_inputs')
    assertCurrentInputs(input)
    this.#assertTenant(worker, input.tenantId)
    const tenantInputs = this.#tenantMap(this.#decisionInputs, input.tenantId)
    if (tenantInputs.has(input.proposalId)) {
      throw new LifecycleError('proposal_exists', 'Decision inputs are immutable; register a new proposal version.')
    }
    tenantInputs.set(input.proposalId, immutableCopy(input))
  }

  replaceCurrentDecisionInputs(workerToken: string, input: CurrentDecisionInputs): void {
    const worker = this.#requirePrincipal(workerToken, 'worker', 'prepare_decision_inputs')
    assertCurrentInputs(input)
    this.#assertTenant(worker, input.tenantId)
    const tenantInputs = this.#decisionInputs.get(input.tenantId)
    if (!tenantInputs?.has(input.proposalId)) {
      throw new LifecycleError('proposal_not_found', 'The proposal does not exist in this tenant.')
    }
    tenantInputs.set(input.proposalId, immutableCopy(input))
  }

  approve(sessionToken: string, request: Readonly<Record<string, unknown>> & { proposalId: string }): ApprovalRecord {
    rejectCallerIdentity(request)
    assertIdentifier(request.proposalId, 'proposal')
    const principal = this.#requirePrincipal(sessionToken, 'user', 'approve_recovery')
    const current = this.#decisionInputs.get(principal.tenantId)?.get(request.proposalId)
    if (!current) throw new LifecycleError('proposal_not_found', 'The proposal does not exist in the resolved tenant.')
    const now = this.#nowIso()
    if (current.revoked || Date.parse(current.validUntil) <= Date.parse(now)) {
      throw new LifecycleError('approval_invalid', 'The current proposal inputs are revoked or expired.')
    }
    const existingDigest = this.#approvalByProposal.get(current.tenantId)?.get(current.proposalId)
    if (existingDigest) {
      const existing = this.#approvals.get(existingDigest)
      if (existing && sameBinding(existing, current) && existing.approverId === principal.subjectId && !existing.revokedAt) {
        return structuredClone(existing)
      }
      throw new LifecycleError(
        'proposal_version_required',
        'A proposal may have one approval lineage; register a new proposal version before approving again.',
      )
    }
    const unsigned = {
      tenantId: current.tenantId,
      proposalId: current.proposalId,
      proposalDigest: current.proposalDigest,
      contextBundleHash: current.contextBundleHash,
      evidencePacketHash: current.evidencePacketHash,
      routeQuoteHash: current.routeQuoteHash,
      evidenceRevision: current.evidenceRevision,
      routeRevision: current.routeRevision,
      approverId: principal.subjectId,
      capability: 'approve_recovery' as const,
      approvedAt: now,
      validUntil: current.validUntil,
    }
    const approval: ApprovalRecord = { ...unsigned, digest: digest(unsigned) }
    this.#approvals.set(approval.digest, immutableCopy(approval))
    this.#tenantMap(this.#approvalByProposal, current.tenantId).set(current.proposalId, approval.digest)
    return structuredClone(approval)
  }

  revokeApproval(sessionToken: string, approvalDigest: string): ApprovalRecord {
    const principal = this.#requirePrincipal(sessionToken, 'user', 'approve_recovery')
    const approval = this.#approvals.get(approvalDigest)
    if (!approval || approval.tenantId !== principal.tenantId) {
      throw new LifecycleError('approval_not_found', 'The approval does not exist in the resolved tenant.')
    }
    const revoked = { ...approval, revokedAt: this.#nowIso() }
    this.#approvals.set(approvalDigest, immutableCopy(revoked))
    return structuredClone(revoked)
  }

  reserve(sessionToken: string, request: Readonly<Record<string, unknown>> & { approvalDigest: string }): ReservationResult {
    rejectCallerIdentity(request)
    const principal = this.#requirePrincipal(sessionToken, 'user', 'approve_recovery')
    const approval = this.#approvals.get(request.approvalDigest)
    if (!approval || approval.tenantId !== principal.tenantId) {
      throw new LifecycleError('approval_not_found', 'The approval does not exist in the resolved tenant.')
    }
    const existingOperationId = this.#operationByProposal.get(approval.tenantId)?.get(approval.proposalId)
    if (existingOperationId) {
      const existing = this.#operations.get(approval.tenantId)?.get(existingOperationId)
      if (!existing) throw new LifecycleError('invariant_violation', 'The reservation index is corrupt.')
      if (!equalText(existing.snapshot.approvalDigest, approval.digest)) {
        throw new LifecycleError('proposal_already_reserved', 'The proposal already has a different execution lineage.')
      }
      return { operation: this.#publicOperation(existing), replayed: true }
    }
    const current = this.#assertApprovalIsCurrent(approval)
    const operationId = this.#ids.operationId()
    const idempotencyKey = this.#ids.idempotencyKey()
    assertIdentifier(operationId, 'operation')
    assertUuid(idempotencyKey, 'idempotencyKey')
    if (this.#operations.get(current.tenantId)?.has(operationId)) {
      throw new LifecycleError('operation_id_conflict', 'The generated operation identifier already exists.')
    }
    const capturedAt = this.#nowIso()
    if (Date.parse(capturedAt) >= Date.parse(current.validUntil)) {
      throw new LifecycleError('approval_stale_or_revoked', 'The approval expired before its snapshot was captured.')
    }
    const snapshotWithoutDigest = {
      operationId,
      tenantId: current.tenantId,
      caseId: current.caseId,
      proposalId: current.proposalId,
      proposalDigest: current.proposalDigest,
      contextBundleHash: current.contextBundleHash,
      evidencePacketHash: current.evidencePacketHash,
      approvalDigest: approval.digest,
      approverId: approval.approverId,
      approverCapability: approval.capability,
      approvalValidUntil: approval.validUntil,
      evidenceRevision: current.evidenceRevision,
      routeRevision: current.routeRevision,
      routeQuoteHash: current.routeQuoteHash,
      vehicleId: current.vehicleId,
      serviceStart: current.serviceStart,
      serviceEnd: current.serviceEnd,
      idempotencyKey,
      capturedAt,
    }
    const snapshot: ExecutionSnapshot = { ...snapshotWithoutDigest, digest: digest(snapshotWithoutDigest) }
    const operation: MutableOperation = {
      id: operationId,
      tenantId: current.tenantId,
      snapshot: immutableCopy(snapshot),
      state: 'reserved',
      revision: 0,
      events: [{ sequence: 0, state: 'reserved', occurredAt: capturedAt }],
      evidenceIds: new Set(),
      createdAt: capturedAt,
      updatedAt: capturedAt,
    }
    this.#tenantMap(this.#operations, operation.tenantId).set(operation.id, operation)
    this.#tenantMap(this.#operationByProposal, approval.tenantId).set(approval.proposalId, operation.id)
    return { operation: this.#publicOperation(operation), replayed: false }
  }

  async dispatch(workerToken: string, operationId: string, connector: DispatchConnector): Promise<DispatchOperation> {
    const worker = this.#requirePrincipal(workerToken, 'worker', 'dispatch_recovery')
    const operation = this.#requireOperation(worker.tenantId, operationId)
    if (operation.state === 'unknown') {
      throw new LifecycleError('reconciliation_required', 'An unknown dispatch must be reconciled before any retry.')
    }
    if (operation.state === 'accepted' || operation.state === 'assignment_reconciled') return this.#publicOperation(operation)
    if (operation.state !== 'reserved') throw new LifecycleError('invalid_transition', `Cannot dispatch from ${operation.state}.`)
    try {
      this.#assertSnapshotIsCurrent(operation.snapshot)
    } catch (error) {
      this.#transition(operation, 'cancelled', error instanceof LifecycleError ? error.code : 'revalidation_failed')
      throw error
    }
    this.#transition(operation, 'sending')
    let assignment
    try {
      assignment = await connector.send(operation.snapshot)
    } catch (error) {
      if (error instanceof ConnectorRejectedError) {
        this.#transition(operation, 'failed', error.code)
        throw error
      }
      const acknowledgementLost = isAcknowledgementLostError(error)
      this.#transition(operation, 'unknown', acknowledgementLost ? 'acknowledgement_lost' : 'connector_result_unknown')
      if (!acknowledgementLost) throw error
    }
    if (assignment) {
      if (!assignmentMatchesSnapshot(assignment, operation.snapshot)) {
        this.#transition(operation, 'failed', 'connector_binding_mismatch')
        throw new LifecycleError('connector_binding_mismatch', 'The provider assignment does not match the immutable execution snapshot.')
      }
      operation.providerAssignmentId = assignment.id
      this.#transition(operation, 'accepted')
    }
    return this.#publicOperation(operation)
  }

  async reconcile(workerToken: string, operationId: string, connector: DispatchConnector): Promise<ReconciliationResult> {
    const worker = this.#requirePrincipal(workerToken, 'worker', 'reconcile_dispatch')
    const operation = this.#requireOperation(worker.tenantId, operationId)
    if (operation.state !== 'unknown') throw new LifecycleError('reconciliation_not_required', `Cannot reconcile from ${operation.state}.`)
    const assignment = await connector.lookup(operation.snapshot.idempotencyKey)
    if (!assignment) return { operation: this.#publicOperation(operation), assignmentFound: false }
    if (!assignmentMatchesSnapshot(assignment, operation.snapshot)) {
      this.#transition(operation, 'failed', 'reconciled_binding_mismatch')
      throw new LifecycleError('connector_binding_mismatch', 'The reconciled assignment does not match the immutable snapshot.')
    }
    operation.providerAssignmentId = assignment.id
    this.#transition(operation, 'assignment_reconciled')
    return { operation: this.#publicOperation(operation), assignmentFound: true }
  }

  recordDriverReport(workerToken: string, operationId: string, evidence: OutcomeEvidence): DispatchOperation {
    return this.#workerEvidenceTransition(workerToken, operationId, 'driver_reported', 'driver_report', evidence)
  }

  recordSupportingEvidence(workerToken: string, operationId: string, evidence: OutcomeEvidence): DispatchOperation {
    return this.#workerEvidenceTransition(workerToken, operationId, 'supporting_evidence_received', 'supporting_attachment', evidence)
  }

  reconcileEvidence(workerToken: string, operationId: string, evidence: OutcomeEvidence): DispatchOperation {
    return this.#workerEvidenceTransition(workerToken, operationId, 'evidence_reconciled', 'reconciliation', evidence)
  }

  confirmCustomerOutcome(sessionToken: string, operationId: string, evidence: OutcomeEvidence): DispatchOperation {
    return this.#userEvidenceTransition(
      sessionToken,
      'confirm_customer_outcome',
      operationId,
      'customer_confirmed',
      'customer_confirmation',
      evidence,
    )
  }

  dispute(sessionToken: string, operationId: string, evidence: OutcomeEvidence): DispatchOperation {
    return this.#userEvidenceTransition(
      sessionToken,
      'dispute_customer_outcome',
      operationId,
      'disputed',
      'customer_dispute',
      evidence,
    )
  }

  reopen(sessionToken: string, operationId: string, evidence: OutcomeEvidence): DispatchOperation {
    return this.#userEvidenceTransition(sessionToken, 'reopen_recovery', operationId, 'reopened', 'reopen', evidence)
  }

  receipt(sessionToken: string, operationId: string): OutcomeReceipt {
    const principal = this.#requireReadPrincipal(sessionToken)
    const operation = this.#requireOperation(principal.tenantId, operationId)
    const receiptKey = `${operation.tenantId}/${operation.id}/${operation.revision}`
    const existing = this.#receipts.get(receiptKey)
    if (existing) return structuredClone(existing)
    const lastEvent = operation.events.at(-1)
    const current = this.#decisionInputs.get(operation.tenantId)?.get(operation.snapshot.proposalId)
    const unsigned = {
      operationId: operation.id,
      operationRevision: operation.revision,
      tenantId: operation.tenantId,
      state: operation.state,
      evidenceIds: [...operation.evidenceIds].sort(),
      contextBundleHash: operation.snapshot.contextBundleHash,
      evidencePacketHash: operation.snapshot.evidencePacketHash,
      routeQuoteHash: operation.snapshot.routeQuoteHash,
      proposalDigest: operation.snapshot.proposalDigest,
      approvalDigest: operation.snapshot.approvalDigest,
      approverId: operation.snapshot.approverId,
      approverCapability: operation.snapshot.approverCapability,
      approvalValidUntil: operation.snapshot.approvalValidUntil,
      idempotencyKey: operation.snapshot.idempotencyKey,
      executionSnapshotDigest: operation.snapshot.digest,
      ...(lastEvent?.reason ? {
        invalidation: {
          reason: lastEvent.reason,
          approvedEvidenceRevision: operation.snapshot.evidenceRevision,
          approvedRouteRevision: operation.snapshot.routeRevision,
          ...(current ? {
            currentEvidenceRevision: current.evidenceRevision,
            currentRouteRevision: current.routeRevision,
          } : {}),
        },
      } : {}),
      recordedAt: this.#nowIso(),
    }
    const receipt: OutcomeReceipt = { ...unsigned, digest: digest(unsigned) }
    this.#receipts.set(receiptKey, immutableCopy(receipt))
    return structuredClone(receipt)
  }

  getOperation(sessionToken: string, operationId: string): DispatchOperation {
    const principal = this.#requireReadPrincipal(sessionToken)
    return this.#publicOperation(this.#requireOperation(principal.tenantId, operationId))
  }

  #workerEvidenceTransition(
    workerToken: string,
    operationId: string,
    state: OperationState,
    kind: OutcomeEvidenceKind,
    evidence: OutcomeEvidence,
  ): DispatchOperation {
    const worker = this.#requirePrincipal(workerToken, 'worker', 'record_provider_evidence')
    return this.#evidenceTransition(worker.tenantId, operationId, state, kind, evidence)
  }

  #userEvidenceTransition(
    sessionToken: string,
    capability: Capability,
    operationId: string,
    state: OperationState,
    kind: OutcomeEvidenceKind,
    evidence: OutcomeEvidence,
  ): DispatchOperation {
    const principal = this.#requirePrincipal(sessionToken, 'user', capability)
    return this.#evidenceTransition(principal.tenantId, operationId, state, kind, evidence)
  }

  #evidenceTransition(
    tenantId: string,
    operationId: string,
    state: OperationState,
    kind: OutcomeEvidenceKind,
    evidence: OutcomeEvidence,
  ): DispatchOperation {
    const operation = this.#requireOperation(tenantId, operationId)
    assertOutcomeEvidence(evidence, kind, tenantId, operationId, {
      notBefore: operation.events.at(-1)?.occurredAt ?? operation.createdAt,
      now: this.#nowIso(),
    })
    const evidenceByTenant = this.#tenantMap(this.#outcomeEvidence, tenantId)
    if (evidenceByTenant.has(evidence.id)) {
      throw new LifecycleError('evidence_exists', 'An evidence identifier cannot authorize more than one outcome transition.')
    }
    this.#transition(operation, state, undefined, evidence.id)
    evidenceByTenant.set(evidence.id, immutableCopy(evidence))
    operation.evidenceIds.add(evidence.id)
    return this.#publicOperation(operation)
  }

  #assertApprovalIsCurrent(approval: Readonly<ApprovalRecord>): Readonly<CurrentDecisionInputs> {
    const current = this.#decisionInputs.get(approval.tenantId)?.get(approval.proposalId)
    const now = this.#nowIso()
    if (
      !current
      || current.revoked
      || approval.revokedAt
      || Date.parse(approval.validUntil) <= Date.parse(now)
      || !sameBinding(approval, current)
      || !this.#authority.hasCapability(approval.approverId, approval.tenantId, approval.capability, 'user')
    ) {
      throw new LifecycleError('approval_stale_or_revoked', 'The approval no longer binds the current authorized decision inputs.')
    }
    return current
  }

  #assertSnapshotIsCurrent(snapshot: Readonly<ExecutionSnapshot>): void {
    const approval = this.#approvals.get(snapshot.approvalDigest)
    if (!approval || approval.tenantId !== snapshot.tenantId || approval.approverId !== snapshot.approverId) {
      throw new LifecycleError('approval_not_found', 'The snapshot approval no longer exists or is misbound.')
    }
    const current = this.#assertApprovalIsCurrent(approval)
    if (!sameExecutableBinding(current, snapshot)) {
      throw new LifecycleError('snapshot_stale', 'The reserved snapshot no longer matches current decision inputs.')
    }
  }

  #transition(operation: MutableOperation, state: OperationState, reason?: string, evidenceId?: string): void {
    assertLifecycleTransition(operation.state, state)
    const occurredAt = this.#nowIso()
    operation.state = state
    operation.revision += 1
    operation.updatedAt = occurredAt
    const event: OperationEvent = { sequence: operation.revision, state, occurredAt }
    if (reason !== undefined) event.reason = reason
    if (evidenceId !== undefined) event.evidenceId = evidenceId
    operation.events.push(event)
  }

  #requireOperation(tenantId: string, operationId: string): MutableOperation {
    assertIdentifier(operationId, 'operation')
    const operation = this.#operations.get(tenantId)?.get(operationId)
    if (!operation) throw new LifecycleError('operation_not_found', 'The operation does not exist in the resolved tenant.')
    return operation
  }

  #requirePrincipal(token: string, kind: Principal['kind'], capability: Capability): Principal {
    const principal = this.#authority.resolve(token)
    if (principal.kind !== kind || !principal.capabilities.has(capability)) {
      throw new LifecycleError('capability_required', `The resolved ${kind} principal lacks ${capability}.`)
    }
    return principal
  }

  #requireReadPrincipal(token: string): Principal {
    const principal = this.#authority.resolve(token)
    const readable = principal.kind === 'user'
      ? principal.capabilities.has('read_lifecycle') || principal.capabilities.has('approve_recovery')
      : principal.capabilities.has('reconcile_dispatch') || principal.capabilities.has('dispatch_recovery')
    if (!readable) throw new LifecycleError('capability_required', 'The resolved principal cannot read lifecycle state.')
    return principal
  }

  #assertTenant(principal: Principal, tenantId: string): void {
    if (principal.tenantId !== tenantId) throw new LifecycleError('tenant_scope_mismatch', 'The principal cannot cross tenant scope.')
  }

  #publicOperation(operation: MutableOperation): DispatchOperation {
    const value: DispatchOperation = {
      id: operation.id,
      tenantId: operation.tenantId,
      snapshot: structuredClone(operation.snapshot),
      state: operation.state,
      revision: operation.revision,
      events: structuredClone(operation.events),
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    }
    if (operation.providerAssignmentId !== undefined) value.providerAssignmentId = operation.providerAssignmentId
    return immutableCopy(value)
  }

  #tenantMap<T>(source: Map<string, Map<string, T>>, tenantId: string): Map<string, T> {
    let tenantMap = source.get(tenantId)
    if (!tenantMap) {
      tenantMap = new Map()
      source.set(tenantId, tenantMap)
    }
    return tenantMap
  }

  #nowIso(): string {
    const now = this.#clock.now()
    if (!Number.isFinite(now.valueOf())) throw new LifecycleError('invalid_time', 'Clock returned an invalid time.')
    return now.toISOString()
  }
}
