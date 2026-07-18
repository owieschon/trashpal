export type UserCapability =
  | 'approve_recovery'
  | 'read_lifecycle'
  | 'confirm_customer_outcome'
  | 'dispute_customer_outcome'
  | 'reopen_recovery'
  | 'manage_lifecycle_authority'

export type WorkerCapability =
  | 'prepare_decision_inputs'
  | 'dispatch_recovery'
  | 'reconcile_dispatch'
  | 'record_provider_evidence'

export type Capability = UserCapability | WorkerCapability

export type PrincipalKind = 'user' | 'worker'

export interface Principal {
  subjectId: string
  tenantId: string
  kind: PrincipalKind
  capabilities: ReadonlySet<Capability>
  enabled: boolean
  issuedAt: string
  expiresAt: string
}

export interface PrincipalResolver {
  resolve(token: string): Principal
  revokeCapability?(subjectId: string, tenantId: string, capability: Capability): void
  revokePrincipal?(subjectId: string, tenantId: string): void
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[]

export interface ProposalPayload {
  readonly id: string
  readonly tenantId: string
  readonly caseId: string
  readonly routeQuoteId: string
  readonly workOrder: {
    readonly vehicleId: string
    readonly serviceStart: string
    readonly serviceEnd: string
  }
  readonly validUntil: string
  readonly [key: string]: JsonValue
}

export interface ContextBundlePayload {
  readonly tenantId: string
  readonly [key: string]: JsonValue
}

export interface EvidencePacketPayload {
  readonly id: string
  readonly tenantId: string
  readonly caseId: string
  readonly revision: number
  readonly validUntil: string
  readonly [key: string]: JsonValue
}

export interface RouteQuotePayload {
  readonly id: string
  readonly tenantId: string
  readonly caseId: string
  readonly revision: number
  readonly vehicleId: string
  readonly serviceStart: string
  readonly serviceEnd: string
  readonly validUntil: string
  readonly [key: string]: JsonValue
}

export interface CurrentDecisionInputs {
  tenantId: string
  caseId: string
  proposalId: string
  evidenceSnapshotId: string
  routeQuoteId: string
  proposalDigest: string
  contextBundleHash: string
  evidencePacketHash: string
  routeQuoteHash: string
  evidenceRevision: number
  routeRevision: number
  vehicleId: string
  serviceStart: string
  serviceEnd: string
  validUntil: string
  revoked: boolean
  proposalPayload: ProposalPayload
  contextBundlePayload: ContextBundlePayload
  evidencePacketPayload: EvidencePacketPayload
  routeQuotePayload: RouteQuotePayload
}

export interface ApprovalRecord {
  tenantId: string
  proposalId: string
  proposalDigest: string
  contextBundleHash: string
  evidencePacketHash: string
  routeQuoteHash: string
  evidenceRevision: number
  routeRevision: number
  approverId: string
  capability: 'approve_recovery'
  approvedAt: string
  validUntil: string
  revokedAt?: string
  digest: string
}

export interface ExecutionSnapshot {
  operationId: string
  tenantId: string
  caseId: string
  proposalId: string
  proposalDigest: string
  contextBundleHash: string
  evidencePacketHash: string
  approvalDigest: string
  approverId: string
  approverCapability: 'approve_recovery'
  approvalValidUntil: string
  evidenceRevision: number
  routeRevision: number
  routeQuoteHash: string
  vehicleId: string
  serviceStart: string
  serviceEnd: string
  idempotencyKey: string
  capturedAt: string
  digest: string
}

export type OperationState =
  | 'reserved'
  | 'sending'
  | 'accepted'
  | 'unknown'
  | 'assignment_reconciled'
  | 'driver_reported'
  | 'supporting_evidence_received'
  | 'evidence_reconciled'
  | 'customer_confirmed'
  | 'disputed'
  | 'reopened'
  | 'cancelled'
  | 'failed'

export type LifecycleState = 'uninitialized' | 'approved' | OperationState

export type OutcomeEvidenceKind =
  | 'driver_report'
  | 'supporting_attachment'
  | 'reconciliation'
  | 'customer_confirmation'
  | 'customer_dispute'
  | 'reopen'

export interface OutcomeEvidence {
  id: string
  tenantId: string
  operationId: string
  kind: OutcomeEvidenceKind
  sourceId: string
  contentHash: string
  observedAt: string
}

export interface OperationEvent {
  sequence: number
  state: OperationState
  occurredAt: string
  evidenceId?: string
  reason?: string
}

export interface DispatchOperation {
  id: string
  tenantId: string
  snapshot: ExecutionSnapshot
  state: OperationState
  revision: number
  events: readonly OperationEvent[]
  providerAssignmentId?: string
  createdAt: string
  updatedAt: string
}

export interface ReceiptInvalidation {
  reason: string
  approvedEvidenceRevision: number
  approvedRouteRevision: number
  currentEvidenceRevision?: number
  currentRouteRevision?: number
}

export interface OutcomeReceipt {
  operationId: string
  operationRevision: number
  tenantId: string
  state: OperationState
  evidenceIds: readonly string[]
  contextBundleHash: string
  evidencePacketHash: string
  routeQuoteHash: string
  proposalDigest: string
  approvalDigest: string
  approverId: string
  approverCapability: 'approve_recovery'
  approvalValidUntil: string
  idempotencyKey: string
  executionSnapshotDigest: string
  invalidation?: ReceiptInvalidation
  recordedAt: string
  digest: string
}

export interface Clock {
  now(): Date
}

export interface IdSource {
  operationId(): string
  idempotencyKey(): string
  reservationId?(): string
}

export interface DispatchAssignment {
  id: string
  tenantId: string
  operationId: string
  idempotencyKey: string
  snapshotDigest: string
  proposalDigest: string
  approvalDigest: string
  routeQuoteHash: string
  vehicleId: string
  serviceStart: string
  serviceEnd: string
}

export interface DispatchConnector {
  send(snapshot: ExecutionSnapshot): Promise<DispatchAssignment>
  lookup(idempotencyKey: string): Promise<DispatchAssignment | undefined>
}

export interface ReservationResult {
  operation: DispatchOperation
  replayed: boolean
}

export interface ReconciliationResult {
  operation: DispatchOperation
  assignmentFound: boolean
}

export interface PgQueryResult<Row extends object = Record<string, unknown>> {
  readonly rows: readonly Row[]
  readonly rowCount: number | null
}

export interface PgQueryable {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>
}

export interface PgClientLike extends PgQueryable {
  release(): void
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>
}

export interface LifecyclePostgresPool extends PgPoolLike {
  end(): Promise<void>
}
