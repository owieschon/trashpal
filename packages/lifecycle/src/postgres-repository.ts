import { randomUUID } from 'node:crypto'
import { canonicalJson, deepFreeze, digest, equalText } from './canonical.js'
import { ConnectorRejectedError, isAcknowledgementLostError, LifecycleError } from './errors.js'
import { assertLifecycleTransition } from './state-machine.js'
import type {
  ApprovalRecord,
  Capability,
  CurrentDecisionInputs,
  DispatchAssignment,
  DispatchConnector,
  DispatchOperation,
  ExecutionSnapshot,
  OperationEvent,
  OperationState,
  OutcomeEvidence,
  OutcomeReceipt,
  PgClientLike,
  PgPoolLike,
  Principal,
  PrincipalResolver,
  ReservationResult,
} from './types.js'
import {
  assignmentMatchesSnapshot,
  assertCurrentInputs,
  assertIdentifier,
  assertOutcomeEvidence,
  assertUuid,
} from './validation.js'

interface ProposalRow {
  tenant_id: string
  id: string
  case_id: string
  digest: string
  context_bundle_hash: string
  context_bundle_payload: unknown
  evidence_snapshot_id: string
  evidence_packet_hash: string
  evidence_revision: number
  route_quote_hash: string
  route_quote_id: string
  route_revision: number
  vehicle_id: string
  service_start: Date | string
  service_end: Date | string
  valid_until: Date | string
  payload: unknown
  evidence_payload?: unknown
  route_payload?: unknown
}

interface ApprovalRow {
  tenant_id: string
  digest: string
  proposal_id: string
  proposal_digest: string
  context_bundle_hash: string
  evidence_packet_hash: string
  evidence_revision: number
  route_quote_hash: string
  route_revision: number
  approver_subject_id: string
  capability: Capability
  approved_at: Date | string
  valid_until: Date | string
  revoked_at: Date | string | null
}

interface SnapshotRow {
  tenant_id: string
  operation_id: string
  reservation_id: string
  case_id: string
  proposal_id: string
  digest: string
  proposal_digest: string
  approval_digest: string
  context_bundle_hash: string
  evidence_packet_hash: string
  evidence_revision: number
  route_quote_hash: string
  route_revision: number
  vehicle_id: string
  service_start: Date | string
  service_end: Date | string
  approval_valid_until: Date | string
  approver_subject_id: string
  idempotency_key: string
  captured_at: Date | string
  payload: unknown
}

interface OperationRow {
  tenant_id: string
  id: string
  snapshot_digest: string
  state: OperationState
  revision: number
  created_at: Date | string
  updated_at: Date | string
}

interface EventRow {
  sequence: number
  state: OperationState
  occurred_at: Date | string
  evidence_id: string | null
  reason: string | null
}

interface ReceiptRow {
  tenant_id: string
  digest: string
  operation_id: string
  operation_revision: number
  state: OperationState
  snapshot_digest: string
  payload: unknown
  recorded_at: Date | string
}

interface DecisionPayloadRow {
  stored_proposal_payload: unknown
  stored_context_payload: unknown
  stored_evidence_payload: unknown
  stored_route_payload: unknown
  stored_proposal_digest: string
  stored_context_hash: string
  stored_evidence_hash: string
  stored_route_hash: string
}

/**
 * The locked database facts required to turn a proposal into an approval or
 * an approval into a reservation. Aliases keep proposal fields distinct from
 * their supporting evidence, quote, and authority records.
 */
interface CurrentBindingRow extends ProposalRow, DecisionPayloadRow {
  proposal_revoked_at: Date | string | null
  case_evidence_revision: number
  case_route_revision: number
  evidence_valid_until: Date | string
  quote_valid_until: Date | string
  quote_revoked_at: Date | string | null
  quote_vehicle_id: string
  quote_service_start: Date | string
  quote_service_end: Date | string
  approver_enabled: boolean
  approver_revoked_at: Date | string | null
  approver_expires_at: Date | string
  capability_revoked_at: Date | string | null
  checked_at: Date | string
}

export interface ClaimedDispatch {
  readonly operation: DispatchOperation
  readonly snapshot: ExecutionSnapshot
  readonly leaseOwner: string
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.valueOf())) throw new LifecycleError('database_time_invalid', 'Database returned an invalid timestamp.')
  return parsed.toISOString()
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function immutable<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value))
}

function assertStoredPayloadDigest(payload: unknown, expected: string, label: string): void {
  if (!equalText(digest(payload), expected)) {
    throw new LifecycleError('database_binding_invalid', `Stored ${label} payload does not match its digest.`)
  }
}

function assertStoredDecisionPayloads(row: DecisionPayloadRow): void {
  assertStoredPayloadDigest(row.stored_proposal_payload, row.stored_proposal_digest, 'proposal')
  assertStoredPayloadDigest(row.stored_context_payload, row.stored_context_hash, 'context bundle')
  assertStoredPayloadDigest(row.stored_evidence_payload, row.stored_evidence_hash, 'evidence packet')
  assertStoredPayloadDigest(row.stored_route_payload, row.stored_route_hash, 'route quote')
}

function receiptUnsigned(
  operation: Pick<OperationRow, 'id' | 'tenant_id' | 'revision' | 'state'>,
  snapshot: ExecutionSnapshot,
  evidenceIds: readonly string[],
  reason: string | null,
  recordedAt: string,
): Omit<OutcomeReceipt, 'digest'> {
  return {
    operationId: operation.id,
    operationRevision: operation.revision,
    tenantId: operation.tenant_id,
    state: operation.state,
    evidenceIds: [...evidenceIds],
    contextBundleHash: snapshot.contextBundleHash,
    evidencePacketHash: snapshot.evidencePacketHash,
    routeQuoteHash: snapshot.routeQuoteHash,
    proposalDigest: snapshot.proposalDigest,
    approvalDigest: snapshot.approvalDigest,
    approverId: snapshot.approverId,
    approverCapability: snapshot.approverCapability,
    approvalValidUntil: snapshot.approvalValidUntil,
    idempotencyKey: snapshot.idempotencyKey,
    executionSnapshotDigest: snapshot.digest,
    ...(reason ? {
      invalidation: {
        reason,
        approvedEvidenceRevision: snapshot.evidenceRevision,
        approvedRouteRevision: snapshot.routeRevision,
      },
    } : {}),
    recordedAt,
  }
}

function assertStoredReceipt(
  row: ReceiptRow,
  operation: OperationRow,
  snapshot: ExecutionSnapshot,
  expectedUnsigned: Omit<OutcomeReceipt, 'digest'>,
): OutcomeReceipt {
  if (
    row.tenant_id !== operation.tenant_id
    || row.operation_id !== operation.id
    || row.operation_revision !== operation.revision
    || row.state !== operation.state
    || row.snapshot_digest !== snapshot.digest
    || typeof row.payload !== 'object'
    || row.payload === null
    || Array.isArray(row.payload)
  ) {
    throw new LifecycleError('database_binding_invalid', 'Stored outcome receipt row does not match the requested operation.')
  }
  const payload = row.payload as Record<string, unknown>
  const payloadDigest = payload.digest
  const payloadUnsigned = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'digest'))
  if (
    typeof payloadDigest !== 'string'
    || !equalText(payloadDigest, row.digest)
    || !equalText(digest(payloadUnsigned), row.digest)
    || !equalText(canonicalJson(payloadUnsigned), canonicalJson(expectedUnsigned))
  ) {
    throw new LifecycleError('database_binding_invalid', 'Stored outcome receipt payload does not match its row, snapshot, or evidence set.')
  }
  return payload as unknown as OutcomeReceipt
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return (error as { code?: unknown }).code === '40001' || (error as { code?: unknown }).code === '40P01'
}

export class PostgresLifecycleRepository {
  readonly #pool: PgPoolLike
  readonly #authority: PrincipalResolver

  constructor(pool: PgPoolLike, authority: PrincipalResolver) {
    this.#pool = pool
    this.#authority = authority
  }

  async prepareDecisionInputs(workerToken: string, input: CurrentDecisionInputs): Promise<void> {
    const worker = this.#require(workerToken, 'worker', 'prepare_decision_inputs')
    assertCurrentInputs(input)
    this.#assertTenant(worker, input.tenantId)
    await this.#transaction(async (client) => {
      await this.#persistPrincipal(client, worker)
      const currentCase = await client.query<{ evidence_revision: number; route_revision: number }>(
        `INSERT INTO lifecycle_cases
           (tenant_id, id, source_id, revision, evidence_revision, route_revision, state)
         VALUES ($1, $2, $3, 0, $4, $5, 'open')
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           evidence_revision = EXCLUDED.evidence_revision,
           route_revision = EXCLUDED.route_revision,
           revision = lifecycle_cases.revision + 1,
           updated_at = clock_timestamp()
         WHERE lifecycle_cases.evidence_revision <= EXCLUDED.evidence_revision
           AND lifecycle_cases.route_revision <= EXCLUDED.route_revision
         RETURNING evidence_revision, route_revision`,
        [input.tenantId, input.caseId, input.caseId, input.evidenceRevision, input.routeRevision],
      )
      if (currentCase.rows[0]?.evidence_revision !== input.evidenceRevision
          || currentCase.rows[0]?.route_revision !== input.routeRevision) {
        throw new LifecycleError('stale_decision_inputs', 'Decision revisions cannot move current case truth backwards.')
      }
      await client.query(
        `INSERT INTO lifecycle_evidence_snapshots
           (tenant_id, id, case_id, revision, packet_hash, payload, observed_at, valid_until)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp(), $7)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [
          input.tenantId,
          input.evidenceSnapshotId,
          input.caseId,
          input.evidenceRevision,
          input.evidencePacketHash,
          json(input.evidencePacketPayload),
          input.evidencePacketPayload.validUntil,
        ],
      )
      await client.query(
        `INSERT INTO lifecycle_route_quotes
           (tenant_id, id, case_id, revision, quote_hash, vehicle_id, service_start, service_end, valid_until, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [
          input.tenantId,
          input.routeQuoteId,
          input.caseId,
          input.routeRevision,
          input.routeQuoteHash,
          input.vehicleId,
          input.serviceStart,
          input.serviceEnd,
          input.routeQuotePayload.validUntil,
          json(input.routeQuotePayload),
        ],
      )
      await client.query(
        `INSERT INTO lifecycle_proposals
           (tenant_id, id, case_id, digest, context_bundle_hash, context_bundle_payload, evidence_snapshot_id,
            evidence_packet_hash, evidence_revision, route_quote_id, route_quote_hash, route_revision,
            vehicle_id, service_start, service_end, payload, valid_until, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17,
           CASE WHEN $18::boolean THEN clock_timestamp() ELSE NULL END)
         ON CONFLICT (tenant_id, id) DO NOTHING RETURNING digest`,
        [
          input.tenantId,
          input.proposalId,
          input.caseId,
          input.proposalDigest,
          input.contextBundleHash,
          json(input.contextBundlePayload),
          input.evidenceSnapshotId,
          input.evidencePacketHash,
          input.evidenceRevision,
          input.routeQuoteId,
          input.routeQuoteHash,
          input.routeRevision,
          input.vehicleId,
          input.serviceStart,
          input.serviceEnd,
          json(input.proposalPayload),
          input.validUntil,
          input.revoked,
        ],
      )
      const stored = await client.query<ProposalRow>(
        `SELECT proposal.*, evidence.payload AS evidence_payload, quote.payload AS route_payload
         FROM lifecycle_proposals proposal
         JOIN lifecycle_evidence_snapshots evidence
           ON evidence.tenant_id=proposal.tenant_id AND evidence.id=proposal.evidence_snapshot_id
          AND evidence.case_id=proposal.case_id AND evidence.revision=proposal.evidence_revision
          AND evidence.packet_hash=proposal.evidence_packet_hash
         JOIN lifecycle_route_quotes quote
           ON quote.tenant_id=proposal.tenant_id AND quote.id=proposal.route_quote_id
          AND quote.case_id=proposal.case_id AND quote.revision=proposal.route_revision
          AND quote.quote_hash=proposal.route_quote_hash
         WHERE proposal.tenant_id = $1 AND proposal.id = $2`,
        [input.tenantId, input.proposalId],
      )
      const row = stored.rows[0]
      if (!row
          || row.case_id !== input.caseId
          || row.digest !== input.proposalDigest
          || !equalText(digest(row.payload), input.proposalDigest)
          || !equalText(canonicalJson(row.payload), canonicalJson(input.proposalPayload))
          || row.context_bundle_hash !== input.contextBundleHash
          || !equalText(digest(row.context_bundle_payload), input.contextBundleHash)
          || !equalText(canonicalJson(row.context_bundle_payload), canonicalJson(input.contextBundlePayload))
          || row.evidence_snapshot_id !== input.evidenceSnapshotId
          || row.evidence_packet_hash !== input.evidencePacketHash
          || !equalText(digest(row.evidence_payload), input.evidencePacketHash)
          || !equalText(canonicalJson(row.evidence_payload), canonicalJson(input.evidencePacketPayload))
          || row.evidence_revision !== input.evidenceRevision
          || row.route_quote_id !== input.routeQuoteId
          || row.route_quote_hash !== input.routeQuoteHash
          || !equalText(digest(row.route_payload), input.routeQuoteHash)
          || !equalText(canonicalJson(row.route_payload), canonicalJson(input.routeQuotePayload))
          || row.route_revision !== input.routeRevision
          || row.vehicle_id !== input.vehicleId
          || iso(row.service_start) !== iso(input.serviceStart)
          || iso(row.service_end) !== iso(input.serviceEnd)
          || iso(row.valid_until) !== iso(input.validUntil)) {
        throw new LifecycleError('proposal_exists', 'The proposal identifier already binds a different canonical payload.')
      }
    })
  }

  async approve(sessionToken: string, proposalId: string): Promise<ApprovalRecord> {
    assertIdentifier(proposalId, 'proposal')
    const principal = this.#require(sessionToken, 'user', 'approve_recovery')
    return await this.#transaction(async (client) => {
      await this.#persistPrincipal(client, principal)
      const existing = await client.query<ApprovalRow>(
        'SELECT * FROM lifecycle_approvals WHERE tenant_id = $1 AND proposal_id = $2 FOR UPDATE',
        [principal.tenantId, proposalId],
      )
      if (existing.rows[0]) {
        if (existing.rows[0].approver_subject_id !== principal.subjectId || existing.rows[0].revoked_at !== null) {
          throw new LifecycleError('proposal_version_required', 'The proposal already has an approval lineage.')
        }
        await this.#assertCurrentBinding(client, {
          tenantId: principal.tenantId,
          proposalId,
          approverId: principal.subjectId,
          approval: existing.rows[0],
        })
        return this.#approval(existing.rows[0])
      }
      const proposal = await this.#assertCurrentBinding(client, {
        tenantId: principal.tenantId,
        proposalId,
        approverId: principal.subjectId,
      })
      const approvedAt = iso(proposal.checked_at)
      const unsigned = {
        tenantId: principal.tenantId,
        proposalId,
        proposalDigest: proposal.digest,
        contextBundleHash: proposal.context_bundle_hash,
        evidencePacketHash: proposal.evidence_packet_hash,
        routeQuoteHash: proposal.route_quote_hash,
        evidenceRevision: proposal.evidence_revision,
        routeRevision: proposal.route_revision,
        approverId: principal.subjectId,
        capability: 'approve_recovery' as const,
        approvedAt,
        validUntil: iso(proposal.valid_until),
      }
      const approval: ApprovalRecord = { ...unsigned, digest: digest(unsigned) }
      await client.query(
        `INSERT INTO lifecycle_approvals
           (tenant_id, digest, proposal_id, proposal_digest, context_bundle_hash, evidence_packet_hash,
            evidence_revision, route_quote_hash, route_revision, approver_subject_id, capability,
            approved_at, valid_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approve_recovery',$11,$12)`,
        [
          approval.tenantId,
          approval.digest,
          approval.proposalId,
          approval.proposalDigest,
          approval.contextBundleHash,
          approval.evidencePacketHash,
          approval.evidenceRevision,
          approval.routeQuoteHash,
          approval.routeRevision,
          approval.approverId,
          approval.approvedAt,
          approval.validUntil,
        ],
      )
      return immutable(approval)
    })
  }

  async revokeApproval(sessionToken: string, approvalDigest: string): Promise<ApprovalRecord> {
    const principal = this.#require(sessionToken, 'user', 'approve_recovery')
    return await this.#transaction(async (client) => {
      await this.#persistPrincipal(client, principal)
      const selected = await client.query<ApprovalRow>(
        `SELECT * FROM lifecycle_approvals
         WHERE tenant_id=$1 AND digest=$2 FOR UPDATE`,
        [principal.tenantId, approvalDigest],
      )
      const approval = selected.rows[0]
      if (!approval) throw new LifecycleError('approval_not_found', 'The approval does not exist in the resolved tenant.')
      if (approval.approver_subject_id !== principal.subjectId) {
        throw new LifecycleError('capability_required', 'Only the recorded approver can revoke this approval.')
      }
      if (approval.revoked_at) return this.#approval(approval)
      const updated = await client.query<ApprovalRow>(
        `UPDATE lifecycle_approvals SET revoked_at=clock_timestamp()
         WHERE tenant_id=$1 AND digest=$2 RETURNING *`,
        [principal.tenantId, approvalDigest],
      )
      return this.#approval(updated.rows[0]!)
    })
  }

  async revokeCapability(adminToken: string, subjectId: string, capability: Capability): Promise<void> {
    const admin = this.#require(adminToken, 'user', 'manage_lifecycle_authority')
    await this.#transaction(async (client) => {
      await this.#persistPrincipal(client, admin)
      const selected = await client.query<{ revoked_at: Date | string | null }>(
        `SELECT revoked_at FROM lifecycle_capabilities
         WHERE tenant_id=$1 AND subject_id=$2 AND capability=$3 FOR UPDATE`,
        [admin.tenantId, subjectId, capability],
      )
      if (!selected.rows[0]) {
        throw new LifecycleError('authority_not_found', 'The capability does not exist in the resolved tenant.')
      }
      if (!selected.rows[0].revoked_at) {
        await client.query(
          `UPDATE lifecycle_capabilities SET revoked_at=clock_timestamp()
           WHERE tenant_id=$1 AND subject_id=$2 AND capability=$3`,
          [admin.tenantId, subjectId, capability],
        )
      }
    })
    this.#authority.revokeCapability?.(subjectId, admin.tenantId, capability)
  }

  async revokePrincipal(adminToken: string, subjectId: string): Promise<void> {
    const admin = this.#require(adminToken, 'user', 'manage_lifecycle_authority')
    await this.#transaction(async (client) => {
      await this.#persistPrincipal(client, admin)
      const selected = await client.query<{ revoked_at: Date | string | null }>(
        `SELECT revoked_at FROM lifecycle_principals
         WHERE tenant_id=$1 AND subject_id=$2 FOR UPDATE`,
        [admin.tenantId, subjectId],
      )
      if (!selected.rows[0]) {
        throw new LifecycleError('authority_not_found', 'The principal does not exist in the resolved tenant.')
      }
      if (!selected.rows[0].revoked_at) {
        await client.query(
          `UPDATE lifecycle_principals SET enabled=false,revoked_at=clock_timestamp()
           WHERE tenant_id=$1 AND subject_id=$2`,
          [admin.tenantId, subjectId],
        )
      }
    })
    this.#authority.revokePrincipal?.(subjectId, admin.tenantId)
  }

  async reserve(sessionToken: string, approvalDigest: string): Promise<ReservationResult> {
    const principal = this.#require(sessionToken, 'user', 'approve_recovery')
    return await this.#transaction(async (client) => {
      await this.#persistPrincipal(client, principal)
      const approvalResult = await client.query<ApprovalRow>(
        `SELECT * FROM lifecycle_approvals
         WHERE tenant_id = $1 AND digest = $2 FOR UPDATE`,
        [principal.tenantId, approvalDigest],
      )
      const approval = approvalResult.rows[0]
      if (!approval) throw new LifecycleError('approval_not_found', 'The approval does not exist in the resolved tenant.')
      this.#approval(approval)
      const existing = await this.#operationByProposal(client, principal.tenantId, approval.proposal_id)
      if (existing) return { operation: existing, replayed: true }
      const binding = await this.#assertCurrentBinding(client, {
        tenantId: principal.tenantId,
        proposalId: approval.proposal_id,
        approverId: approval.approver_subject_id,
        approval,
      })
      const row = { ...binding, ...approval }

      const operationId = `op_${randomUUID()}`
      const reservationId = `reservation_${randomUUID()}`
      const idempotencyKey = randomUUID()
      assertIdentifier(operationId, 'operation')
      assertUuid(idempotencyKey, 'idempotencyKey')
      const capturedAt = iso(binding.checked_at)
      const snapshotWithoutDigest = {
        operationId,
        tenantId: principal.tenantId,
        caseId: row.case_id,
        proposalId: row.proposal_id,
        proposalDigest: row.proposal_digest,
        contextBundleHash: row.context_bundle_hash,
        evidencePacketHash: row.evidence_packet_hash,
        approvalDigest: row.digest,
        approverId: row.approver_subject_id,
        approverCapability: 'approve_recovery' as const,
        approvalValidUntil: iso(row.valid_until),
        evidenceRevision: row.evidence_revision,
        routeRevision: row.route_revision,
        routeQuoteHash: row.route_quote_hash,
        vehicleId: row.vehicle_id,
        serviceStart: iso(row.service_start),
        serviceEnd: iso(row.service_end),
        idempotencyKey,
        capturedAt,
      }
      const snapshot: ExecutionSnapshot = { ...snapshotWithoutDigest, digest: digest(snapshotWithoutDigest) }
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO lifecycle_reservations
           (tenant_id,id,proposal_id,approval_digest,proposal_digest,context_bundle_hash,
            evidence_packet_hash,evidence_revision,route_quote_hash,route_revision,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved')
         ON CONFLICT (tenant_id, proposal_id) DO NOTHING RETURNING id`,
        [
          principal.tenantId,
          reservationId,
          row.proposal_id,
          row.digest,
          row.proposal_digest,
          row.context_bundle_hash,
          row.evidence_packet_hash,
          row.evidence_revision,
          row.route_quote_hash,
          row.route_revision,
        ],
      )
      if (reservation.rowCount === 0) {
        const replay = await this.#operationByProposal(client, principal.tenantId, row.proposal_id)
        if (!replay) throw new LifecycleError('reservation_race', 'A concurrent reservation has not completed its snapshot.')
        return { operation: replay, replayed: true }
      }
      await client.query(
        `INSERT INTO lifecycle_execution_snapshots
           (tenant_id,operation_id,reservation_id,case_id,proposal_id,digest,proposal_digest,approval_digest,
            context_bundle_hash,evidence_packet_hash,evidence_revision,route_quote_hash,route_revision,
            vehicle_id,service_start,service_end,approval_valid_until,approver_subject_id,
            idempotency_key,payload,captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)`,
        [
          snapshot.tenantId,
          snapshot.operationId,
          reservationId,
          snapshot.caseId,
          snapshot.proposalId,
          snapshot.digest,
          snapshot.proposalDigest,
          snapshot.approvalDigest,
          snapshot.contextBundleHash,
          snapshot.evidencePacketHash,
          snapshot.evidenceRevision,
          snapshot.routeQuoteHash,
          snapshot.routeRevision,
          snapshot.vehicleId,
          snapshot.serviceStart,
          snapshot.serviceEnd,
          snapshot.approvalValidUntil,
          snapshot.approverId,
          snapshot.idempotencyKey,
          json(snapshot),
          snapshot.capturedAt,
        ],
      )
      await client.query(
        `INSERT INTO lifecycle_operations (tenant_id,id,snapshot_digest,state,revision,created_at,updated_at)
         VALUES ($1,$2,$3,'reserved',0,$4,$4)`,
        [snapshot.tenantId, snapshot.operationId, snapshot.digest, capturedAt],
      )
      await this.#insertEvent(client, snapshot.tenantId, snapshot.operationId, 0, 'reserved', capturedAt)
      await client.query(
        `INSERT INTO lifecycle_dispatch_outbox
           (tenant_id,operation_id,idempotency_key,snapshot_digest,state)
         VALUES ($1,$2,$3,$4,'pending')`,
        [snapshot.tenantId, snapshot.operationId, snapshot.idempotencyKey, snapshot.digest],
      )
      return {
        replayed: false,
        operation: immutable({
          id: snapshot.operationId,
          tenantId: snapshot.tenantId,
          snapshot,
          state: 'reserved' as const,
          revision: 0,
          events: [{ sequence: 0, state: 'reserved' as const, occurredAt: capturedAt }],
          createdAt: capturedAt,
          updatedAt: capturedAt,
        }),
      }
    })
  }

  async claimNext(workerToken: string, leaseOwner: string, leaseMs = 30_000): Promise<ClaimedDispatch | null> {
    return await this.#claim(workerToken, leaseOwner, undefined, leaseMs)
  }

  /**
   * Atomically claims one named pending operation. Callers that present an
   * operation-specific command must use this instead of a queue-wide claim.
   */
  async claimOperation(workerToken: string, operationId: string, leaseOwner: string, leaseMs = 30_000): Promise<ClaimedDispatch | null> {
    assertIdentifier(operationId, 'operation')
    return await this.#claim(workerToken, leaseOwner, operationId, leaseMs)
  }

  async #claim(workerToken: string, leaseOwner: string, operationId: string | undefined, leaseMs: number): Promise<ClaimedDispatch | null> {
    const worker = this.#require(workerToken, 'worker', 'dispatch_recovery')
    if (!leaseOwner || leaseOwner.length > 200 || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new LifecycleError('invalid_lease', 'Outbox lease parameters are invalid.')
    }
    return await this.#transaction(async (client) => {
      await this.#persistPrincipal(client, worker)
      await this.#recoverExpiredLease(client, worker.tenantId)
      const result = await client.query<SnapshotRow & OperationRow & DecisionPayloadRow & { is_current: boolean }>(
        `SELECT snapshot.*, operation.state, operation.revision, operation.created_at, operation.updated_at,
           proposal.payload AS stored_proposal_payload,
           proposal.context_bundle_payload AS stored_context_payload,
           evidence.payload AS stored_evidence_payload, quote.payload AS stored_route_payload,
           proposal.digest AS stored_proposal_digest,
           proposal.context_bundle_hash AS stored_context_hash,
           proposal.evidence_packet_hash AS stored_evidence_hash,
           proposal.route_quote_hash AS stored_route_hash,
           (proposal.revoked_at IS NULL AND approval.revoked_at IS NULL
            AND proposal.valid_until > clock_timestamp() AND approval.valid_until > clock_timestamp()
            AND proposal.valid_until = approval.valid_until
            AND cases.evidence_revision = snapshot.evidence_revision
            AND cases.route_revision = snapshot.route_revision
            AND evidence.valid_until > clock_timestamp()
            AND quote.valid_until >= proposal.valid_until AND quote.valid_until > clock_timestamp()
            AND quote.revoked_at IS NULL
            AND quote.vehicle_id = snapshot.vehicle_id
            AND quote.service_start = snapshot.service_start AND quote.service_end = snapshot.service_end
            AND approver.enabled = true AND approver.revoked_at IS NULL AND approver.expires_at > clock_timestamp()
            AND capability.revoked_at IS NULL) AS is_current
         FROM lifecycle_dispatch_outbox outbox
         JOIN lifecycle_operations operation
           ON operation.tenant_id = outbox.tenant_id AND operation.id = outbox.operation_id
         JOIN lifecycle_execution_snapshots snapshot
           ON snapshot.tenant_id = outbox.tenant_id AND snapshot.operation_id = outbox.operation_id
          AND snapshot.digest = outbox.snapshot_digest AND snapshot.idempotency_key = outbox.idempotency_key
         JOIN lifecycle_approvals approval
           ON approval.tenant_id = snapshot.tenant_id AND approval.digest = snapshot.approval_digest
         JOIN lifecycle_proposals proposal
           ON proposal.tenant_id = snapshot.tenant_id AND proposal.id = snapshot.proposal_id
         JOIN lifecycle_cases cases
           ON cases.tenant_id = proposal.tenant_id AND cases.id = proposal.case_id
         JOIN lifecycle_evidence_snapshots evidence
           ON evidence.tenant_id = proposal.tenant_id AND evidence.id = proposal.evidence_snapshot_id
          AND evidence.case_id = proposal.case_id AND evidence.revision = proposal.evidence_revision
          AND evidence.packet_hash = proposal.evidence_packet_hash
         JOIN lifecycle_route_quotes quote
           ON quote.tenant_id = proposal.tenant_id AND quote.id = proposal.route_quote_id
          AND quote.case_id = proposal.case_id AND quote.revision = proposal.route_revision
          AND quote.quote_hash = proposal.route_quote_hash
         JOIN lifecycle_principals approver
           ON approver.tenant_id = approval.tenant_id AND approver.subject_id = approval.approver_subject_id
         JOIN lifecycle_capabilities capability
           ON capability.tenant_id = approver.tenant_id AND capability.subject_id = approver.subject_id
          AND capability.capability = 'approve_recovery'
         WHERE outbox.tenant_id = $1 AND outbox.state = 'pending'
           AND ($2::text IS NULL OR outbox.operation_id = $2)
         ORDER BY outbox.created_at
         FOR UPDATE OF outbox, operation SKIP LOCKED LIMIT 1`,
        [worker.tenantId, operationId ?? null],
      )
      const row = result.rows[0]
      if (!row) return null
      let cancellationReason = row.is_current ? undefined : 'final_revalidation_failed'
      let snapshot: ExecutionSnapshot | undefined
      try {
        assertStoredDecisionPayloads(row)
        snapshot = this.#snapshot(row)
      } catch (error) {
        cancellationReason = error instanceof LifecycleError ? error.code : 'database_binding_invalid'
      }
      if (cancellationReason) {
        const updated = await this.#advanceOperation(client, worker.tenantId, row.operation_id, row.state, row.revision, 'cancelled')
        await this.#insertEvent(client, worker.tenantId, row.operation_id, updated.revision, 'cancelled', updated.updatedAt, cancellationReason)
        await client.query(
          `UPDATE lifecycle_dispatch_outbox SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND operation_id=$2`,
          [worker.tenantId, row.operation_id],
        )
        await this.#transitionReservation(client, worker.tenantId, row.reservation_id, 'cancelled', cancellationReason)
        return null
      }
      const updated = await this.#advanceOperation(client, worker.tenantId, row.operation_id, row.state, row.revision, 'sending')
      await this.#insertEvent(client, worker.tenantId, row.operation_id, updated.revision, 'sending', updated.updatedAt)
      await client.query(
        `UPDATE lifecycle_dispatch_outbox SET state='leased',lease_owner=$3,
           lease_expires_at=clock_timestamp()+($4::text || ' milliseconds')::interval,
           attempt_count=attempt_count+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND operation_id=$2`,
        [worker.tenantId, row.operation_id, leaseOwner, leaseMs],
      )
      return {
        leaseOwner,
        snapshot: snapshot!,
        operation: await this.#loadOperation(client, worker.tenantId, row.operation_id),
      }
    })
  }

  async markUnknown(workerToken: string, operationId: string, reason: string): Promise<DispatchOperation> {
    const worker = this.#require(workerToken, 'worker', 'dispatch_recovery')
    return await this.#transaction(async (client) => {
      const operation = await this.#lockOperation(client, worker.tenantId, operationId)
      if (operation.state === 'unknown') return await this.#loadOperation(client, worker.tenantId, operationId)
      const updated = await this.#advanceOperation(client, worker.tenantId, operationId, operation.state, operation.revision, 'unknown')
      await this.#insertEvent(client, worker.tenantId, operationId, updated.revision, 'unknown', updated.updatedAt, reason)
      await client.query(
        `UPDATE lifecycle_dispatch_outbox SET state='unknown',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND operation_id=$2`,
        [worker.tenantId, operationId],
      )
      return await this.#loadOperation(client, worker.tenantId, operationId)
    })
  }

  async markFailed(workerToken: string, operationId: string, reason: string): Promise<DispatchOperation> {
    const worker = this.#require(workerToken, 'worker', 'dispatch_recovery')
    return await this.#transaction(async (client) => {
      const operation = await this.#lockOperation(client, worker.tenantId, operationId)
      if (operation.state === 'failed') return await this.#loadOperation(client, worker.tenantId, operationId)
      const snapshotResult = await client.query<Pick<SnapshotRow, 'reservation_id'>>(
        'SELECT reservation_id FROM lifecycle_execution_snapshots WHERE tenant_id=$1 AND operation_id=$2 FOR KEY SHARE',
        [worker.tenantId, operationId],
      )
      const reservationId = snapshotResult.rows[0]?.reservation_id
      if (!reservationId) throw new LifecycleError('database_binding_invalid', 'The failed operation lacks its exact reservation.')
      const updated = await this.#advanceOperation(client, worker.tenantId, operationId, operation.state, operation.revision, 'failed')
      await this.#insertEvent(client, worker.tenantId, operationId, updated.revision, 'failed', updated.updatedAt, reason)
      await client.query(
        `UPDATE lifecycle_dispatch_outbox SET state='failed',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND operation_id=$2`,
        [worker.tenantId, operationId],
      )
      await this.#transitionReservation(client, worker.tenantId, reservationId, 'cancelled', reason)
      return await this.#loadOperation(client, worker.tenantId, operationId)
    })
  }

  async completeAssignment(
    workerToken: string,
    operationId: string,
    assignment: DispatchAssignment,
    reconciled: boolean,
  ): Promise<DispatchOperation> {
    const worker = this.#require(workerToken, 'worker', reconciled ? 'reconcile_dispatch' : 'dispatch_recovery')
    return await this.#transaction(async (client) => {
      const operation = await this.#lockOperation(client, worker.tenantId, operationId)
      const snapshotRow = await client.query<SnapshotRow>(
        'SELECT * FROM lifecycle_execution_snapshots WHERE tenant_id=$1 AND operation_id=$2 FOR KEY SHARE',
        [worker.tenantId, operationId],
      )
      const snapshot = this.#snapshot(snapshotRow.rows[0]!)
      if (!assignmentMatchesSnapshot(assignment, snapshot)) {
        throw new LifecycleError('connector_binding_mismatch', 'The assignment does not echo the immutable snapshot.')
      }
      const target: OperationState = reconciled ? 'assignment_reconciled' : 'accepted'
      const expected: OperationState = reconciled ? 'unknown' : 'sending'
      if (operation.state !== expected) throw new LifecycleError('invalid_transition', `Cannot record assignment from ${operation.state}.`)
      const inserted = await client.query<{ provider_assignment_id: string }>(
        `INSERT INTO lifecycle_assignments
           (tenant_id,id,operation_id,provider_assignment_id,idempotency_key,snapshot_digest,
            proposal_digest,approval_digest,route_quote_hash,vehicle_id,service_start,service_end,
            accepted_at,reconciled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp(),
           CASE WHEN $13::boolean THEN clock_timestamp() ELSE NULL END)
         ON CONFLICT (tenant_id,operation_id) DO NOTHING
         RETURNING provider_assignment_id`,
        [
          worker.tenantId,
          `assignment_${randomUUID()}`,
          operationId,
          assignment.id,
          assignment.idempotencyKey,
          assignment.snapshotDigest,
          assignment.proposalDigest,
          assignment.approvalDigest,
          assignment.routeQuoteHash,
          assignment.vehicleId,
          assignment.serviceStart,
          assignment.serviceEnd,
          reconciled,
        ],
      )
      if (inserted.rowCount === 0) {
        const existing = await client.query<{ provider_assignment_id: string }>(
          'SELECT provider_assignment_id FROM lifecycle_assignments WHERE tenant_id=$1 AND operation_id=$2',
          [worker.tenantId, operationId],
        )
        if (existing.rows[0]?.provider_assignment_id !== assignment.id) {
          throw new LifecycleError('connector_binding_mismatch', 'The operation already binds a different provider assignment.')
        }
      }
      const updated = await this.#advanceOperation(client, worker.tenantId, operationId, operation.state, operation.revision, target)
      await this.#insertEvent(client, worker.tenantId, operationId, updated.revision, target, updated.updatedAt)
      await client.query(
        `UPDATE lifecycle_dispatch_outbox SET state='sent',lease_owner=NULL,lease_expires_at=NULL,
           last_reconciled_at=CASE WHEN $3 THEN clock_timestamp() ELSE last_reconciled_at END,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND operation_id=$2`,
        [worker.tenantId, operationId, reconciled],
      )
      await this.#transitionReservation(client, worker.tenantId, snapshotRow.rows[0]!.reservation_id, 'consumed')
      return await this.#loadOperation(client, worker.tenantId, operationId)
    })
  }

  async snapshotForReconciliation(workerToken: string, operationId: string): Promise<ExecutionSnapshot> {
    const worker = this.#require(workerToken, 'worker', 'reconcile_dispatch')
    const result = await this.#pool.query<SnapshotRow & { state: OperationState }>(
      `SELECT snapshot.*,operation.state FROM lifecycle_execution_snapshots snapshot
       JOIN lifecycle_operations operation ON operation.tenant_id=snapshot.tenant_id AND operation.id=snapshot.operation_id
       WHERE snapshot.tenant_id=$1 AND snapshot.operation_id=$2`,
      [worker.tenantId, operationId],
    )
    const row = result.rows[0]
    if (!row || row.state !== 'unknown') throw new LifecycleError('reconciliation_not_required', 'The operation is not durably unknown.')
    return this.#snapshot(row)
  }

  async recordEvidence(
    token: string,
    operationId: string,
    evidence: OutcomeEvidence,
    targetState: OperationState,
  ): Promise<DispatchOperation> {
    const capabilityByKind: Record<OutcomeEvidence['kind'], Capability> = {
      driver_report: 'record_provider_evidence',
      supporting_attachment: 'record_provider_evidence',
      reconciliation: 'record_provider_evidence',
      customer_confirmation: 'confirm_customer_outcome',
      customer_dispute: 'dispute_customer_outcome',
      reopen: 'reopen_recovery',
    }
    const targetByKind: Record<OutcomeEvidence['kind'], OperationState> = {
      driver_report: 'driver_reported',
      supporting_attachment: 'supporting_evidence_received',
      reconciliation: 'evidence_reconciled',
      customer_confirmation: 'customer_confirmed',
      customer_dispute: 'disputed',
      reopen: 'reopened',
    }
    if (targetByKind[evidence.kind] !== targetState) {
      throw new LifecycleError('evidence_binding_mismatch', 'Evidence kind does not authorize the requested outcome state.')
    }
    const principalKind: Principal['kind'] = ['driver_report', 'supporting_attachment', 'reconciliation'].includes(evidence.kind)
      ? 'worker'
      : 'user'
    const capability = capabilityByKind[evidence.kind]
    const principal = this.#require(token, principalKind, capability)
    return await this.#transaction(async (client) => {
      await this.#persistPrincipal(client, principal)
      const operation = await this.#lockOperation(client, principal.tenantId, operationId)
      assertLifecycleTransition(operation.state, targetState)
      const time = await client.query<{ now: Date | string; not_before: Date | string }>(
        `SELECT clock_timestamp() AS now,
           COALESCE((
             SELECT occurred_at FROM lifecycle_operation_events
             WHERE tenant_id=$1 AND operation_id=$2 ORDER BY sequence DESC LIMIT 1
           ),$3::timestamptz) AS not_before`,
        [principal.tenantId, operationId, operation.created_at],
      )
      assertOutcomeEvidence(evidence, evidence.kind, principal.tenantId, operationId, {
        notBefore: iso(time.rows[0]!.not_before),
        now: iso(time.rows[0]!.now),
      })
      await client.query(
        `INSERT INTO lifecycle_outcome_evidence
           (tenant_id,id,operation_id,operation_revision,kind,source_id,content_hash,payload,observed_at,
            recorded_by_subject_id,recorded_by_capability)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          principal.tenantId,
          evidence.id,
          operationId,
          operation.revision + 1,
          evidence.kind,
          evidence.sourceId,
          evidence.contentHash,
          json(evidence),
          evidence.observedAt,
          principal.subjectId,
          capability,
        ],
      )
      const updated = await this.#advanceOperation(client, principal.tenantId, operationId, operation.state, operation.revision, targetState)
      await this.#insertEvent(client, principal.tenantId, operationId, updated.revision, targetState, updated.updatedAt, undefined, evidence.id)
      return await this.#loadOperation(client, principal.tenantId, operationId)
    })
  }

  async receipt(sessionToken: string, operationId: string): Promise<OutcomeReceipt> {
    const principal = this.#readPrincipal(sessionToken)
    return await this.#transaction(async (client) => {
      const operation = await this.#lockOperation(client, principal.tenantId, operationId)
      const snapshotResult = await client.query<SnapshotRow>(
        'SELECT * FROM lifecycle_execution_snapshots WHERE tenant_id=$1 AND operation_id=$2',
        [principal.tenantId, operationId],
      )
      const snapshot = this.#snapshot(snapshotResult.rows[0]!)
      const evidenceResult = await client.query<{ id: string }>(
        `SELECT evidence.id FROM lifecycle_outcome_evidence evidence
         JOIN lifecycle_operation_events event
           ON event.tenant_id=evidence.tenant_id AND event.operation_id=evidence.operation_id
          AND event.sequence=evidence.operation_revision AND event.evidence_id=evidence.id
         WHERE evidence.tenant_id=$1 AND evidence.operation_id=$2
           AND evidence.operation_revision <= $3 ORDER BY evidence.id`,
        [principal.tenantId, operationId, operation.revision],
      )
      const event = await client.query<{ reason: string | null }>(
        `SELECT reason FROM lifecycle_operation_events
         WHERE tenant_id=$1 AND operation_id=$2 AND sequence=$3 AND state=$4`,
        [principal.tenantId, operationId, operation.revision, operation.state],
      )
      if (!event.rows[0]) {
        throw new LifecycleError('database_binding_invalid', 'The current operation revision lacks its exact event.')
      }
      const existing = await client.query<ReceiptRow>(
        `SELECT tenant_id,digest,operation_id,operation_revision,state,snapshot_digest,payload,recorded_at
         FROM lifecycle_outcome_receipts
         WHERE tenant_id=$1 AND operation_id=$2 AND operation_revision=$3`,
        [principal.tenantId, operationId, operation.revision],
      )
      if (existing.rows[0]) {
        const row = existing.rows[0]
        const expected = receiptUnsigned(
          operation,
          snapshot,
          evidenceResult.rows.map(({ id }) => id),
          event.rows[0]?.reason ?? null,
          iso(row.recorded_at),
        )
        return immutable(assertStoredReceipt(row, operation, snapshot, expected))
      }
      const time = await client.query<{ now: Date | string }>('SELECT clock_timestamp() AS now')
      const unsigned = receiptUnsigned(
        operation,
        snapshot,
        evidenceResult.rows.map(({ id }) => id),
        event.rows[0]?.reason ?? null,
        iso(time.rows[0]!.now),
      )
      const receipt: OutcomeReceipt = { ...unsigned, digest: digest(unsigned) }
      await client.query(
        `INSERT INTO lifecycle_outcome_receipts
           (tenant_id,digest,operation_id,operation_revision,state,snapshot_digest,payload,recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [principal.tenantId, receipt.digest, operationId, operation.revision, operation.state, snapshot.digest, json(receipt), receipt.recordedAt],
      )
      return immutable(receipt)
    })
  }

  async getOperation(sessionToken: string, operationId: string): Promise<DispatchOperation> {
    const principal = this.#readPrincipal(sessionToken)
    return await this.#loadOperation(this.#pool, principal.tenantId, operationId)
  }

  async #recoverExpiredLease(client: PgClientLike, tenantId: string): Promise<void> {
    const expired = await client.query<OperationRow & { operation_id: string }>(
      `SELECT operation.*,outbox.operation_id FROM lifecycle_dispatch_outbox outbox
       JOIN lifecycle_operations operation ON operation.tenant_id=outbox.tenant_id AND operation.id=outbox.operation_id
       WHERE outbox.tenant_id=$1 AND outbox.state='leased' AND outbox.lease_expires_at<=clock_timestamp()
       FOR UPDATE OF outbox,operation SKIP LOCKED LIMIT 1`,
      [tenantId],
    )
    const row = expired.rows[0]
    if (!row) return
    const updated = await this.#advanceOperation(client, tenantId, row.operation_id, row.state, row.revision, 'unknown')
    await this.#insertEvent(client, tenantId, row.operation_id, updated.revision, 'unknown', updated.updatedAt, 'worker_lease_expired')
    await client.query(
      `UPDATE lifecycle_dispatch_outbox SET state='unknown',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND operation_id=$2`,
      [tenantId, row.operation_id],
    )
  }

  async #operationByProposal(client: PgClientLike, tenantId: string, proposalId: string): Promise<DispatchOperation | null> {
    const result = await client.query<{ operation_id: string }>(
      `SELECT snapshot.operation_id FROM lifecycle_execution_snapshots snapshot
       WHERE snapshot.tenant_id=$1 AND snapshot.proposal_id=$2`,
      [tenantId, proposalId],
    )
    return result.rows[0] ? await this.#loadOperation(client, tenantId, result.rows[0].operation_id) : null
  }

  async #lockOperation(client: PgClientLike, tenantId: string, operationId: string): Promise<OperationRow> {
    assertIdentifier(operationId, 'operation')
    const result = await client.query<OperationRow>(
      'SELECT * FROM lifecycle_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [tenantId, operationId],
    )
    if (!result.rows[0]) throw new LifecycleError('operation_not_found', 'The operation does not exist in the resolved tenant.')
    return result.rows[0]
  }

  async #advanceOperation(
    client: PgClientLike,
    tenantId: string,
    operationId: string,
    currentState: OperationState,
    revision: number,
    targetState: OperationState,
  ): Promise<{ revision: number; updatedAt: string }> {
    assertLifecycleTransition(currentState, targetState)
    const result = await client.query<{ revision: number; updated_at: Date | string }>(
      `UPDATE lifecycle_operations SET state=$5,revision=revision+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND state=$3 AND revision=$4 RETURNING revision,updated_at`,
      [tenantId, operationId, currentState, revision, targetState],
    )
    if (!result.rows[0]) throw new LifecycleError('operation_conflict', 'The operation changed concurrently.')
    return { revision: result.rows[0].revision, updatedAt: iso(result.rows[0].updated_at) }
  }

  async #insertEvent(
    client: PgClientLike,
    tenantId: string,
    operationId: string,
    sequence: number,
    state: OperationState,
    occurredAt: string,
    reason?: string,
    evidenceId?: string,
  ): Promise<void> {
    if (reason !== undefined && !reason.trim()) {
      throw new LifecycleError('invalid_reason', 'Operation event reasons must contain non-whitespace text.')
    }
    await client.query(
      `INSERT INTO lifecycle_operation_events
         (tenant_id,operation_id,sequence,state,reason,evidence_id,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, operationId, sequence, state, reason ?? null, evidenceId ?? null, occurredAt],
    )
  }

  async #transitionReservation(
    client: PgClientLike,
    tenantId: string,
    reservationId: string,
    target: 'cancelled' | 'consumed',
    reason?: string,
  ): Promise<void> {
    if (target === 'cancelled' && (!reason || !reason.trim())) {
      throw new LifecycleError('invalid_reason', 'Reservation cancellation requires a nonblank reason.')
    }
    const updated = await client.query<{ id: string }>(
      target === 'cancelled'
        ? `UPDATE lifecycle_reservations
           SET state='cancelled',cancel_reason=$3
           WHERE tenant_id=$1 AND id=$2 AND state='reserved' RETURNING id`
        : `UPDATE lifecycle_reservations
           SET state='consumed'
           WHERE tenant_id=$1 AND id=$2 AND state='reserved' RETURNING id`,
      target === 'cancelled' ? [tenantId, reservationId, reason] : [tenantId, reservationId],
    )
    if (updated.rowCount === 1) return
    const current = await client.query<{ state: string }>(
      'SELECT state FROM lifecycle_reservations WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE',
      [tenantId, reservationId],
    )
    if (current.rows[0]?.state === target) return
    throw new LifecycleError('database_binding_invalid', 'The exact reservation could not make its terminal transition.')
  }

  async #loadOperation(client: Pick<PgPoolLike, 'query'>, tenantId: string, operationId: string): Promise<DispatchOperation> {
    const result = await client.query<OperationRow & SnapshotRow & { provider_assignment_id: string | null }>(
      `SELECT operation.*,snapshot.payload,snapshot.operation_id,snapshot.proposal_id,snapshot.digest,
         snapshot.case_id,snapshot.reservation_id,
         snapshot.proposal_digest,snapshot.approval_digest,snapshot.context_bundle_hash,
         snapshot.evidence_packet_hash,snapshot.evidence_revision,snapshot.route_quote_hash,
         snapshot.route_revision,snapshot.vehicle_id,snapshot.service_start,snapshot.service_end,
         snapshot.approval_valid_until,snapshot.approver_subject_id,snapshot.idempotency_key,
         snapshot.captured_at,assignment.provider_assignment_id
       FROM lifecycle_operations operation
       JOIN lifecycle_execution_snapshots snapshot
         ON snapshot.tenant_id=operation.tenant_id AND snapshot.operation_id=operation.id
       LEFT JOIN lifecycle_assignments assignment
         ON assignment.tenant_id=operation.tenant_id AND assignment.operation_id=operation.id
       WHERE operation.tenant_id=$1 AND operation.id=$2`,
      [tenantId, operationId],
    )
    const row = result.rows[0]
    if (!row) throw new LifecycleError('operation_not_found', 'The operation does not exist in the resolved tenant.')
    const events = await client.query<EventRow>(
      `SELECT sequence,state,occurred_at,evidence_id,reason FROM lifecycle_operation_events
       WHERE tenant_id=$1 AND operation_id=$2 ORDER BY sequence`,
      [tenantId, operationId],
    )
    const value: DispatchOperation = {
      id: operationId,
      tenantId,
      snapshot: this.#snapshot(row),
      state: row.state,
      revision: row.revision,
      events: events.rows.map((event): OperationEvent => ({
        sequence: event.sequence,
        state: event.state,
        occurredAt: iso(event.occurred_at),
        ...(event.evidence_id ? { evidenceId: event.evidence_id } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      })),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(row.provider_assignment_id ? { providerAssignmentId: row.provider_assignment_id } : {}),
    }
    return immutable(value)
  }

  #snapshot(row: SnapshotRow): ExecutionSnapshot {
    const unsigned = {
      operationId: row.operation_id,
      tenantId: row.tenant_id,
      caseId: row.case_id,
      proposalId: row.proposal_id,
      proposalDigest: row.proposal_digest,
      contextBundleHash: row.context_bundle_hash,
      evidencePacketHash: row.evidence_packet_hash,
      approvalDigest: row.approval_digest,
      approverId: row.approver_subject_id,
      approverCapability: 'approve_recovery' as const,
      approvalValidUntil: iso(row.approval_valid_until),
      evidenceRevision: row.evidence_revision,
      routeRevision: row.route_revision,
      routeQuoteHash: row.route_quote_hash,
      vehicleId: row.vehicle_id,
      serviceStart: iso(row.service_start),
      serviceEnd: iso(row.service_end),
      idempotencyKey: row.idempotency_key,
      capturedAt: iso(row.captured_at),
    }
    const reconstructed: ExecutionSnapshot = { ...unsigned, digest: row.digest }
    if (
      !equalText(digest(unsigned), row.digest)
      || typeof row.payload !== 'object'
      || row.payload === null
      || Array.isArray(row.payload)
      || !equalText(canonicalJson(row.payload), canonicalJson(reconstructed))
    ) {
      throw new LifecycleError('database_binding_invalid', 'Stored execution snapshot does not match its digest.')
    }
    return immutable(reconstructed)
  }

  #approval(row: ApprovalRow): ApprovalRecord {
    const unsigned = {
      tenantId: row.tenant_id,
      proposalId: row.proposal_id,
      proposalDigest: row.proposal_digest,
      contextBundleHash: row.context_bundle_hash,
      evidencePacketHash: row.evidence_packet_hash,
      routeQuoteHash: row.route_quote_hash,
      evidenceRevision: row.evidence_revision,
      routeRevision: row.route_revision,
      approverId: row.approver_subject_id,
      capability: 'approve_recovery' as const,
      approvedAt: iso(row.approved_at),
      validUntil: iso(row.valid_until),
    }
    if (!equalText(digest(unsigned), row.digest)) {
      throw new LifecycleError('database_binding_invalid', 'Stored approval does not match its digest.')
    }
    return immutable({ ...unsigned, ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}), digest: row.digest })
  }

  /**
   * Locks the complete decision binding before an approval or reservation is
   * written. Dispatch performs a final revalidation too, but stale inputs
   * must not create a new approval or operation in the first place.
   */
  async #assertCurrentBinding(
    client: PgClientLike,
    input: Readonly<{
      tenantId: string
      proposalId: string
      approverId: string
      approval?: ApprovalRow
    }>,
  ): Promise<CurrentBindingRow> {
    const proposalExists = await client.query<{ id: string }>(
      `SELECT id FROM lifecycle_proposals
       WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [input.tenantId, input.proposalId],
    )
    if (!proposalExists.rows[0]) {
      throw new LifecycleError('proposal_not_found', 'The proposal does not exist in the resolved tenant.')
    }
    const result = await client.query<CurrentBindingRow>(
      `SELECT proposal.*,
         proposal.revoked_at AS proposal_revoked_at,
         cases.evidence_revision AS case_evidence_revision,
         cases.route_revision AS case_route_revision,
         evidence.payload AS stored_evidence_payload,
         evidence.valid_until AS evidence_valid_until,
         quote.payload AS stored_route_payload,
         quote.valid_until AS quote_valid_until,
         quote.revoked_at AS quote_revoked_at,
         quote.vehicle_id AS quote_vehicle_id,
         quote.service_start AS quote_service_start,
         quote.service_end AS quote_service_end,
         proposal.payload AS stored_proposal_payload,
         proposal.context_bundle_payload AS stored_context_payload,
         proposal.digest AS stored_proposal_digest,
         proposal.context_bundle_hash AS stored_context_hash,
         proposal.evidence_packet_hash AS stored_evidence_hash,
         proposal.route_quote_hash AS stored_route_hash,
         approver.enabled AS approver_enabled,
         approver.revoked_at AS approver_revoked_at,
         approver.expires_at AS approver_expires_at,
         capability.revoked_at AS capability_revoked_at,
         clock_timestamp() AS checked_at
       FROM lifecycle_proposals proposal
       JOIN lifecycle_cases cases
         ON cases.tenant_id=proposal.tenant_id AND cases.id=proposal.case_id
       JOIN lifecycle_evidence_snapshots evidence
         ON evidence.tenant_id=proposal.tenant_id AND evidence.id=proposal.evidence_snapshot_id
        AND evidence.case_id=proposal.case_id AND evidence.revision=proposal.evidence_revision
        AND evidence.packet_hash=proposal.evidence_packet_hash
       JOIN lifecycle_route_quotes quote
         ON quote.tenant_id=proposal.tenant_id AND quote.id=proposal.route_quote_id
        AND quote.case_id=proposal.case_id AND quote.revision=proposal.route_revision
        AND quote.quote_hash=proposal.route_quote_hash
       JOIN lifecycle_principals approver
         ON approver.tenant_id=proposal.tenant_id AND approver.subject_id=$3
       JOIN lifecycle_capabilities capability
         ON capability.tenant_id=approver.tenant_id AND capability.subject_id=approver.subject_id
        AND capability.capability='approve_recovery'
       WHERE proposal.tenant_id=$1 AND proposal.id=$2
       FOR UPDATE OF proposal,cases,evidence,quote,approver,capability`,
      [input.tenantId, input.proposalId, input.approverId],
    )
    const row = result.rows[0]
    if (!row) {
      throw new LifecycleError('approval_stale_or_revoked', 'The decision binding no longer authorizes a new approval or reservation.')
    }
    assertStoredDecisionPayloads(row)
    const checkedAt = iso(row.checked_at)
    const proposalValidUntil = iso(row.valid_until)
    const approvalMatches = !input.approval || (
      input.approval.proposal_id === row.id
      && equalText(input.approval.proposal_digest, row.digest)
      && equalText(input.approval.context_bundle_hash, row.context_bundle_hash)
      && equalText(input.approval.evidence_packet_hash, row.evidence_packet_hash)
      && input.approval.evidence_revision === row.evidence_revision
      && equalText(input.approval.route_quote_hash, row.route_quote_hash)
      && input.approval.route_revision === row.route_revision
      && input.approval.approver_subject_id === input.approverId
      && input.approval.capability === 'approve_recovery'
      && input.approval.revoked_at === null
      && iso(input.approval.valid_until) === proposalValidUntil
    )
    const current = row.proposal_revoked_at === null
      && Date.parse(proposalValidUntil) > Date.parse(checkedAt)
      && row.case_evidence_revision === row.evidence_revision
      && row.case_route_revision === row.route_revision
      && Date.parse(iso(row.evidence_valid_until)) >= Date.parse(proposalValidUntil)
      && Date.parse(iso(row.evidence_valid_until)) > Date.parse(checkedAt)
      && row.quote_revoked_at === null
      && Date.parse(iso(row.quote_valid_until)) >= Date.parse(proposalValidUntil)
      && Date.parse(iso(row.quote_valid_until)) > Date.parse(checkedAt)
      && row.quote_vehicle_id === row.vehicle_id
      && iso(row.quote_service_start) === iso(row.service_start)
      && iso(row.quote_service_end) === iso(row.service_end)
      && row.approver_enabled
      && row.approver_revoked_at === null
      && Date.parse(iso(row.approver_expires_at)) > Date.parse(checkedAt)
      && row.capability_revoked_at === null
      && approvalMatches
    if (!current) {
      throw new LifecycleError('approval_stale_or_revoked', 'The decision binding no longer authorizes a new approval or reservation.')
    }
    return row
  }

  async #persistPrincipal(client: PgClientLike, principal: Principal): Promise<void> {
    await client.query(
      `INSERT INTO lifecycle_principals
         (tenant_id,subject_id,kind,enabled,created_at,expires_at,revoked_at)
       VALUES ($1,$2,$3,true,$4,$5,NULL)
       ON CONFLICT (tenant_id,subject_id) DO UPDATE SET
         expires_at=GREATEST(lifecycle_principals.expires_at,EXCLUDED.expires_at)`,
      [principal.tenantId, principal.subjectId, principal.kind, principal.issuedAt, principal.expiresAt],
    )
    for (const capability of principal.capabilities) {
      await client.query(
        `INSERT INTO lifecycle_capabilities (tenant_id,subject_id,capability,revoked_at)
         VALUES ($1,$2,$3,NULL)
         ON CONFLICT (tenant_id,subject_id,capability) DO NOTHING`,
        [principal.tenantId, principal.subjectId, capability],
      )
    }
  }

  #require(token: string, kind: Principal['kind'], capability: Capability): Principal {
    const principal = this.#authority.resolve(token)
    if (principal.kind !== kind || !principal.capabilities.has(capability)) {
      throw new LifecycleError('capability_required', `The resolved ${kind} principal lacks ${capability}.`)
    }
    return principal
  }

  #readPrincipal(token: string): Principal {
    const principal = this.#authority.resolve(token)
    const allowed = principal.kind === 'user'
      ? principal.capabilities.has('read_lifecycle') || principal.capabilities.has('approve_recovery')
      : principal.capabilities.has('dispatch_recovery') || principal.capabilities.has('reconcile_dispatch')
    if (!allowed) throw new LifecycleError('capability_required', 'The principal cannot read lifecycle state.')
    return principal
  }

  #assertTenant(principal: Principal, tenantId: string): void {
    if (principal.tenantId !== tenantId) throw new LifecycleError('tenant_scope_mismatch', 'The principal cannot cross tenant scope.')
  }

  async #transaction<T>(work: (client: PgClientLike) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.#pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if (!isRetryableTransactionError(error) || attempt >= 4) throw error
      } finally {
        client.release()
      }
    }
  }
}

export class PostgresOutboxWorker {
  readonly #repository: PostgresLifecycleRepository
  readonly #connector: DispatchConnector
  readonly #workerToken: string
  readonly #leaseOwner: string

  constructor(options: {
    repository: PostgresLifecycleRepository
    connector: DispatchConnector
    workerToken: string
    leaseOwner: string
  }) {
    this.#repository = options.repository
    this.#connector = options.connector
    this.#workerToken = options.workerToken
    this.#leaseOwner = options.leaseOwner
  }

  async dispatchNext(): Promise<DispatchOperation | null> {
    const claim = await this.#repository.claimNext(this.#workerToken, this.#leaseOwner)
    if (!claim) return null
    return await this.#dispatchClaim(claim)
  }

  /** Dispatches only the exact durable operation named by the caller. */
  async dispatchOperation(operationId: string): Promise<DispatchOperation> {
    const claim = await this.#repository.claimOperation(this.#workerToken, operationId, this.#leaseOwner)
    if (!claim) {
      throw new LifecycleError('operation_not_pending', 'The requested operation is not pending dispatch.')
    }
    return await this.#dispatchClaim(claim)
  }

  async #dispatchClaim(claim: ClaimedDispatch): Promise<DispatchOperation> {
    try {
      const assignment = await this.#connector.send(claim.snapshot)
      return await this.#repository.completeAssignment(this.#workerToken, claim.operation.id, assignment, false)
    } catch (error) {
      if (error instanceof ConnectorRejectedError) {
        return await this.#repository.markFailed(this.#workerToken, claim.operation.id, `connector_rejected:${error.code}`)
      }
      const acknowledgementLost = isAcknowledgementLostError(error)
      const operation = await this.#repository.markUnknown(
        this.#workerToken,
        claim.operation.id,
        acknowledgementLost ? 'acknowledgement_lost' : 'connector_result_unknown',
      )
      if (!acknowledgementLost) throw error
      return operation
    }
  }

  async reconcile(operationId: string): Promise<DispatchOperation> {
    const snapshot = await this.#repository.snapshotForReconciliation(this.#workerToken, operationId)
    const assignment = await this.#connector.lookup(snapshot.idempotencyKey)
    if (!assignment) return await this.#repository.getOperation(this.#workerToken, operationId)
    return await this.#repository.completeAssignment(this.#workerToken, operationId, assignment, true)
  }
}
