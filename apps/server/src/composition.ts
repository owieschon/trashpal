import { randomUUID } from 'node:crypto'
import {
  HttpVroomTransport,
  VroomRecoveryRoutePlanner,
  type RecoveryRouteResult,
} from '@trashpal/adapters'
import { RouteQuoteSchema, contentDigest } from '@trashpal/contracts'
import type { PalProviderAdapter, RecoveryRoutePlannerPort } from '@trashpal/agent'
import {
  PostgresLifecycleRepository,
  PostgresOutboxWorker,
  LifecycleError,
  type Clock,
  type DispatchConnector,
  type LifecyclePostgresPool,
  type OutcomeEvidence,
  type OutcomeEvidenceKind,
  type ApprovalRecord,
  type DispatchOperation,
  type PrincipalResolver,
  assertIdentifier,
  digest as lifecycleDigest,
} from '@trashpal/lifecycle'
import { createLocalCompositionRuntime, type LocalCompositionRuntime } from './runtime.js'
import type { SyntheticRecoverySourceFactory } from './synthetic-source.js'

const minuteMs = 60 * 1_000
const localClock: Clock = { now: () => new Date() }

export interface ComposedRuntime {
  readonly authority: PrincipalResolver
  readonly connector: DispatchConnector
  readonly repository: PostgresLifecycleRepository
  readonly pal: LocalCompositionRuntime
  readonly workers: {
    readonly preparation: string
    readonly dispatch: string
  }
  dispatch(workerToken: string): Promise<Awaited<ReturnType<PostgresOutboxWorker['dispatchNext']>>>
  /**
   * Local operator dispatch atomically claims the named reserved operation.
   * It does not reuse the queue-wide worker path for an operation-specific
   * command.
   */
  dispatchOperation(workerToken: string, operationId: string): Promise<DispatchOperation>
  reconcile(workerToken: string, operationId: string): Promise<Awaited<ReturnType<PostgresOutboxWorker['reconcile']>>>
  recordEvidence(token: string, operationId: string, kind: OutcomeEvidenceKind): Promise<Awaited<ReturnType<PostgresLifecycleRepository['recordEvidence']>>>
  getProposalBinding(sessionToken: string, proposalId: string): Promise<ProposalBinding>
  getCaseLifecycleState(sessionToken: string, caseId: string): Promise<CaseLifecycleState>
}

/**
 * The approval review representation is read from the durable proposal record,
 * not from a process-local Pal run cache.
 */
export interface ProposalBinding {
  readonly payload: unknown
  readonly digest: string
}

/** Minimal durable lifecycle state used by the local operator projection. */
export interface CaseLifecycleState {
  readonly proposal?: ProposalBinding & Readonly<{ id: string }>
  /** Source deadline retained in the immutable evidence packet at prepare time. */
  readonly serviceDeadline?: string
  readonly approval?: Pick<ApprovalRecord, 'digest' | 'proposalDigest' | 'validUntil'>
  readonly operation?: DispatchOperation
  readonly receiptAvailable: boolean
}

interface ProposalBindingRow {
  readonly payload: unknown
  readonly digest: string
}

interface ActiveCaseProposalRow extends ProposalBindingRow {
  readonly id: string
  readonly evidence_payload: unknown
}

interface CaseOperationProjectionRow {
  readonly operation_id: string
  readonly evidence_payload: unknown
}

export interface CreateComposedRuntimeOptions {
  readonly pool: LifecyclePostgresPool
  readonly authority: PrincipalResolver
  readonly connector: DispatchConnector
  readonly workers: {
    readonly preparation: string
    readonly dispatch: string
  }
  readonly now?: () => Date
  readonly routePlanner?: RecoveryRoutePlannerPort
  readonly sourceFactory?: SyntheticRecoverySourceFactory
  readonly providerFactory?: (input: Readonly<{ scope: { tenantId: string; caseId: string }; runToken: string }>) => PalProviderAdapter
}

/**
 * Builds the local operating slice from explicit durable and provider ports.
 * The default planner is a narrow VROOM bridge; tests can substitute a
 * deterministic port while P3B separately proves the real solver adapter.
 */
export function createComposedRuntime(options: CreateComposedRuntimeOptions): ComposedRuntime {
  const clock: Clock = { now: options.now ?? localClock.now }
  const repository = new PostgresLifecycleRepository(options.pool, options.authority)
  const pal = createLocalCompositionRuntime({
    repository,
    preparationWorkerToken: options.workers.preparation,
    routePlanner: options.routePlanner ?? createVroomBackedRoutePlanner(clock),
    clock,
    ...(options.sourceFactory ? { sourceFactory: options.sourceFactory } : {}),
    ...(options.providerFactory ? { providerFactory: options.providerFactory } : {}),
  })

  return {
    authority: options.authority,
    connector: options.connector,
    repository,
    pal,
    workers: { ...options.workers },
    async dispatch(workerToken) {
      return await new PostgresOutboxWorker({
        repository,
        connector: options.connector,
        workerToken,
        leaseOwner: `api-dispatch-${randomUUID()}`,
      }).dispatchNext()
    },
    async dispatchOperation(workerToken, operationId) {
      assertIdentifier(operationId, 'operation')
      return await new PostgresOutboxWorker({
        repository,
        connector: options.connector,
        workerToken,
        leaseOwner: `operator-dispatch-${randomUUID()}`,
      }).dispatchOperation(operationId)
    },
    async reconcile(workerToken, operationId) {
      try {
        return await new PostgresOutboxWorker({
          repository,
          connector: options.connector,
          workerToken,
          leaseOwner: `api-reconcile-${randomUUID()}`,
        }).reconcile(operationId)
      } catch (error) {
        if (error instanceof LifecycleError && error.code === 'reconciliation_not_required') {
          const current = await repository.getOperation(workerToken, operationId)
          if (current.state === 'assignment_reconciled') return current
        }
        throw error
      }
    },
    async recordEvidence(token, operationId, kind) {
      const principal = options.authority.resolve(token)
      const time = await options.pool.query<{ now: Date | string }>('SELECT clock_timestamp() AS now')
      const observedAt = new Date(time.rows[0]!.now).toISOString()
      const id = `ev_outcome-${randomUUID()}`
      const evidence: OutcomeEvidence = {
        id,
        tenantId: principal.tenantId,
        operationId,
        kind,
        sourceId: `local_${kind}`,
        contentHash: contentDigest({ id, operationId, kind, observedAt }),
        observedAt,
      }
      return await repository.recordEvidence(token, operationId, evidence, targetState(kind))
    },
    async getProposalBinding(sessionToken, proposalId) {
      assertIdentifier(proposalId, 'proposal')
      const principal = options.authority.resolve(sessionToken)
      if (principal.kind !== 'user' || !principal.capabilities.has('read_lifecycle')) {
        throw new LifecycleError('missing_capability', 'A readable user session is required.')
      }
      const result = await options.pool.query<ProposalBindingRow>(
        `SELECT payload,digest FROM lifecycle_proposals
         WHERE tenant_id=$1 AND id=$2`,
        [principal.tenantId, proposalId],
      )
      const proposal = result.rows[0]
      if (!proposal) {
        throw new LifecycleError('proposal_not_found', 'The proposal does not exist in the resolved tenant.')
      }
      if (lifecycleDigest(proposal.payload) !== proposal.digest) {
        throw new LifecycleError('database_binding_invalid', 'Stored proposal payload does not match its digest.')
      }
      return structuredClone({ payload: proposal.payload, digest: proposal.digest })
    },
    async getCaseLifecycleState(sessionToken, caseId) {
      assertIdentifier(caseId, 'case')
      const principal = options.authority.resolve(sessionToken)
      if (principal.kind !== 'user' || !principal.capabilities.has('read_lifecycle')) {
        throw new LifecycleError('missing_capability', 'A readable user session is required.')
      }
      const operationResult = await options.pool.query<CaseOperationProjectionRow>(
        `SELECT snapshot.operation_id,evidence.payload AS evidence_payload
         FROM lifecycle_execution_snapshots snapshot
         JOIN lifecycle_operations operation
           ON operation.tenant_id=snapshot.tenant_id AND operation.id=snapshot.operation_id
         LEFT JOIN lifecycle_evidence_snapshots evidence
           ON evidence.tenant_id=snapshot.tenant_id AND evidence.case_id=snapshot.case_id
          AND evidence.revision=snapshot.evidence_revision AND evidence.packet_hash=snapshot.evidence_packet_hash
         WHERE snapshot.tenant_id=$1 AND snapshot.case_id=$2
         ORDER BY snapshot.captured_at DESC
         LIMIT 1`,
        [principal.tenantId, caseId],
      )
      const operationProjection = operationResult.rows[0]
      const operationId = operationProjection?.operation_id
      const receiptResult = operationId
        ? await options.pool.query<{ present: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM lifecycle_outcome_receipts
             WHERE tenant_id=$1 AND operation_id=$2
           ) AS present`,
          [principal.tenantId, operationId],
        )
        : undefined
      const proposalResult = await options.pool.query<ActiveCaseProposalRow>(
        `SELECT proposal.id,proposal.payload,proposal.digest,evidence.payload AS evidence_payload
         FROM lifecycle_proposals proposal
         JOIN lifecycle_evidence_snapshots evidence
           ON evidence.tenant_id=proposal.tenant_id AND evidence.id=proposal.evidence_snapshot_id
          AND evidence.case_id=proposal.case_id AND evidence.revision=proposal.evidence_revision
          AND evidence.packet_hash=proposal.evidence_packet_hash
         WHERE proposal.tenant_id=$1 AND proposal.case_id=$2
           AND proposal.revoked_at IS NULL AND proposal.valid_until > clock_timestamp()
         ORDER BY proposal.created_at DESC
         LIMIT 1`,
        [principal.tenantId, caseId],
      )
      const activeProposal = proposalResult.rows[0]
      if (!activeProposal) {
        return {
          ...(operationProjection ? { serviceDeadline: recoveryDeadlineFromEvidencePacket(operationProjection.evidence_payload) } : {}),
          ...(operationId ? { operation: await repository.getOperation(sessionToken, operationId) } : {}),
          receiptAvailable: receiptResult?.rows[0]?.present === true,
        }
      }
      if (lifecycleDigest(activeProposal.payload) !== activeProposal.digest) {
        throw new LifecycleError('database_binding_invalid', 'Stored proposal payload does not match its digest.')
      }
      const proposalId = activeProposal.id
      const proposal: ProposalBinding = { payload: activeProposal.payload, digest: activeProposal.digest }
      const approvalResult = await options.pool.query<{
        digest: string
        proposal_digest: string
        valid_until: Date | string
      }>(
        `SELECT digest,proposal_digest,valid_until FROM lifecycle_approvals
         WHERE tenant_id=$1 AND proposal_id=$2 AND revoked_at IS NULL
         LIMIT 1`,
        [principal.tenantId, proposalId],
      )
      const approval = approvalResult.rows[0]
      return {
        proposal: { id: proposalId, ...proposal },
        serviceDeadline: recoveryDeadlineFromEvidencePacket(activeProposal.evidence_payload),
        ...(approval ? {
          approval: {
            digest: approval.digest,
            proposalDigest: approval.proposal_digest,
            validUntil: new Date(approval.valid_until).toISOString(),
          },
        } : {}),
        ...(operationId ? { operation: await repository.getOperation(sessionToken, operationId) } : {}),
        receiptAvailable: receiptResult?.rows[0]?.present === true,
      }
    },
  }
}

function recoveryDeadlineFromEvidencePacket(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LifecycleError('database_binding_invalid', 'Stored evidence packet is not an object.')
  }
  const value = (payload as Record<string, unknown>).recoveryDeadline
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new LifecycleError('database_binding_invalid', 'Stored evidence packet lacks its recovery deadline.')
  }
  return new Date(value).toISOString()
}

export function createVroomBackedRoutePlanner(clock: Clock, endpoint?: string): RecoveryRoutePlannerPort {
  const planner = new VroomRecoveryRoutePlanner(new HttpVroomTransport(endpoint))
  return {
    async quoteRecovery(input) {
      const access = input.accessEvidence.find((item) => item.freshness === 'fresh'
        && item.content.status === 'confirmed_clear'
        && typeof item.content.validFrom === 'string'
        && typeof item.content.validUntil === 'string')
      const agreementDeadline = input.agreement.content.recoveryDeadline
      if (!access || typeof agreementDeadline !== 'string') {
        return { status: 'infeasible', reasons: ['A current agreement and confirmed access window are required.'] }
      }
      const result = await planner.quoteRecovery(vroomRequest({
        tenantId: input.tenantId,
        caseId: input.caseId,
        requestedAt: clock.now().toISOString(),
        quoteValidUntil: earliest([agreementDeadline, String(access.content.validUntil)]),
        accessStart: String(access.content.validFrom),
        accessEnd: String(access.content.validUntil),
      }))
      return mapVroomResult(result, input.caseId)
    },
  }
}

function vroomRequest(input: {
  readonly tenantId: string
  readonly caseId: string
  readonly requestedAt: string
  readonly quoteValidUntil: string
  readonly accessStart: string
  readonly accessEnd: string
}) {
  const requestedAt = vroomTime(input.requestedAt)
  const quoteValidUntil = vroomTime(input.quoteValidUntil)
  const accessStart = vroomTime(input.accessStart)
  const accessEnd = vroomTime(input.accessEnd)
  const requestedAtMs = Date.parse(requestedAt)
  const accessStartMs = Date.parse(accessStart)
  const committedStart = vroomTime(new Date(Math.max(requestedAtMs + 5 * minuteMs, accessStartMs - 20 * minuteMs)).toISOString())
  const committedEnd = vroomTime(new Date(Math.max(requestedAtMs + 10 * minuteMs, accessStartMs - 10 * minuteMs)).toISOString())
  const shiftStart = vroomTime(new Date(requestedAtMs - 5 * minuteMs).toISOString())
  const shiftEnd = accessEnd
  return {
    tenantId: input.tenantId,
    caseId: input.caseId,
    requestedAt,
    quoteValidUntil,
    streamCapability: 101,
    pickupKg: 240,
    serviceSeconds: 900,
    recoveryLocationIndex: 2,
    confirmedAccessWindow: { startAt: accessStart, endAt: accessEnd },
    vehicles: [{
      tenantId: input.tenantId,
      id: 'veh_v42',
      available: true,
      startIndex: 0,
      endIndex: 0,
      capacityKg: 670,
      capabilities: [101],
      shift: { startAt: shiftStart, endAt: shiftEnd },
      breaks: [],
      committedWork: [{
        id: `committed_${contentDigest({ tenantId: input.tenantId, caseId: input.caseId }).slice(0, 16)}`,
        locationIndex: 1,
        serviceSeconds: 300,
        pickupKg: 240,
        requiredCapabilities: [101],
        timeWindows: [{ startAt: committedStart, endAt: committedEnd }],
      }],
    }],
    matrix: {
      locationCount: 3,
      durationsSeconds: [
        [0, 300, 480],
        [300, 0, 360],
        [480, 360, 0],
      ],
    },
  }
}

function vroomTime(value: string): string {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return value
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function mapVroomResult(result: RecoveryRouteResult, caseId: string):
  | { status: 'feasible'; quote: ReturnType<typeof RouteQuoteSchema.parse> }
  | { status: 'infeasible'; reasons: string[] }
  | { status: 'unavailable'; retryable: boolean } {
  if (result.status === 'feasible') {
    // The solver's digest identifies its feasibility result. The agent contract
    // binds the complete typed quote, including a case-scoped host quote ID.
    const { hash: _solverDigest, ...quoteBinding } = result.quote
    const id = `quote_${contentDigest({ caseId, solverDigest: _solverDigest }).slice(0, 24)}`
    const hostQuote = { ...quoteBinding, id }
    return {
      status: 'feasible',
      quote: RouteQuoteSchema.parse({ ...hostQuote, hash: contentDigest(hostQuote) }),
    }
  }
  if (result.status === 'infeasible') return { status: 'infeasible', reasons: result.failures.map((failure) => failure.message) }
  return { status: 'unavailable', retryable: result.retryable }
}

function targetState(kind: OutcomeEvidenceKind) {
  const states = {
    driver_report: 'driver_reported',
    supporting_attachment: 'supporting_evidence_received',
    reconciliation: 'evidence_reconciled',
    customer_confirmation: 'customer_confirmed',
    customer_dispute: 'disputed',
    reopen: 'reopened',
  } as const
  return states[kind]
}

function earliest(values: readonly string[]): string {
  const first = values[0]
  if (!first) throw new Error('VROOM_VALIDITY_MISSING')
  return values.reduce((candidate, value) => Date.parse(value) < Date.parse(candidate) ? value : candidate, first)
}
