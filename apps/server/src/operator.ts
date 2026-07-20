import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { LifecycleError, rejectCallerIdentity, type OperationState, type Principal } from '@trashpal/lifecycle'
import type { ComposedRuntime } from './composition.js'
import { createTrashPalApi } from './api.js'
import { safeProposalFromBinding } from './runtime.js'
import { createSyntheticRecordedRecoveryCase } from './synthetic-source.js'

export const GreenleafOperatorCaseId = 'case_greenleaf-operator'
export const GreenleafOperatorTenantId = 'ten_harborworks'
const operatorCases = {
  [GreenleafOperatorCaseId]: { title: 'Greenleaf Café · organics service exception', priority: 'Service window closing' },
  'case_riverbend-operator': { title: 'Riverbend Market · organics service exception', priority: 'Access confirmation needed' },
  'case_northstar-operator': { title: 'Northstar Kitchen · organics service exception', priority: 'Recovery review queued' },
} as const
const OperatorCaseIdSchema = z.enum([GreenleafOperatorCaseId, 'case_riverbend-operator', 'case_northstar-operator'])

const demoCookieName = 'tp_demo_session'
const localSessionTtlSeconds = 60 * 60

const OperatorHelpTopicSchema = z.enum(['overview', 'prepare', 'approve', 'dispatch', 'reconcile', 'receipt', 'developer-reference'])
const operatorHelpFiles = {
  overview: 'index.md',
  prepare: 'resolve-a-missed-collection.md',
  approve: 'review-and-approve-a-recovery.md',
  dispatch: 'review-and-approve-a-recovery.md',
  reconcile: 'check-an-uncertain-dispatch.md',
  receipt: 'read-a-recovery-receipt.md',
  'developer-reference': 'developer-reference.md',
} as const satisfies Record<z.output<typeof OperatorHelpTopicSchema>, string>

const OperatorHelpReferenceSchema = z.enum([
  'core-build-contract',
  'recovery-program',
  'domain-assumptions',
  'synthetic-seed-corpus',
])
const operatorHelpReferenceFiles = {
  'core-build-contract': 'architecture/CORE_BUILD_CONTRACT.md',
  'recovery-program': 'reference/generated/recovery-program.md',
  'domain-assumptions': 'architecture/DOMAIN_ASSUMPTIONS.md',
  'synthetic-seed-corpus': 'architecture/SYNTHETIC_SEED_CORPUS.md',
} as const satisfies Record<z.output<typeof OperatorHelpReferenceSchema>, string>

const sourceRecordsWhatHappened = 'A scheduled organics collection could not be completed.'
const historicalDecisionWhatHappened = 'A recovery was prepared for this exception. Its durable operation remains the record for the next outcome check.'

const OperatorEvidenceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['confirmed', 'observed', 'pending']),
  detail: z.string().min(1),
}).strict()

const OperatorProposalSchema = z.object({
  id: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  validUntil: z.iso.datetime({ offset: true }),
  workOrder: z.object({
    vehicleId: z.string().min(1),
    serviceStart: z.iso.datetime({ offset: true }),
    serviceEnd: z.iso.datetime({ offset: true }),
  }).strict(),
  claims: z.array(z.object({
    text: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
}).strict()

const OperatorOperationSchema = z.object({
  id: z.string().min(1),
  state: z.enum([
    'reserved', 'sending', 'accepted', 'unknown', 'assignment_reconciled',
    'driver_reported', 'supporting_evidence_received', 'evidence_reconciled',
    'customer_confirmed', 'disputed', 'reopened', 'cancelled', 'failed',
  ]),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }),
  providerAssignmentId: z.string().min(1).optional(),
}).strict()

const OperatorNextActionSchema = z.object({
  kind: z.enum(['prepare', 'approve', 'reserve', 'dispatch', 'reconcile', 'view_receipt', 'monitor']),
  label: z.string().min(1),
  requiresApproval: z.boolean(),
}).strict()

const OperatorActivitySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().min(1),
  status: z.enum(['complete', 'current']),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
}).strict()

const OperatorPalRunSchema = z.object({
  outcome: z.enum(['prepare_recovery', 'hold_for_confirmation', 'escalate']),
  stopCode: z.enum(['proposal_validated', 'human_confirmation_required', 'safe_recovery_not_prepared']),
  skillCount: z.number().int().nonnegative(),
  includedEvidence: z.array(z.string().min(1)),
  omittedEvidence: z.array(z.string().min(1)),
  conflicts: z.array(z.string().min(1)),
  reasoner: z.literal('deterministic_local'),
}).strict()

/**
 * The browser-facing case shape. It is a typed presentation projection, not a
 * serialized CRM record, model context, execution snapshot, or worker trace.
 */
export const CaseOperatorViewSchema = z.object({
  case: z.object({
    id: OperatorCaseIdSchema,
    title: z.string().min(1),
    serviceType: z.literal('Organics collection'),
    priority: z.string().min(1),
    timeZone: z.literal('America/Chicago'),
    serviceWindowEndsAt: z.iso.datetime({ offset: true }),
  }).strict(),
  summary: z.object({
    phase: z.enum(['source_records_available', 'recovery_prepared', 'historical_decision']),
    whatHappened: z.enum([sourceRecordsWhatHappened, historicalDecisionWhatHappened]),
    whatPalChecked: z.array(z.string().min(1)).min(1).max(4),
    whatIsUnknown: z.array(z.string().min(1)).min(1).max(2),
  }).strict(),
  evidence: z.array(OperatorEvidenceSchema).length(4),
  activity: z.array(OperatorActivitySchema).min(1),
  palRun: OperatorPalRunSchema.optional(),
  proposal: OperatorProposalSchema.optional(),
  approval: z.object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    validUntil: z.iso.datetime({ offset: true }),
  }).strict().optional(),
  operation: OperatorOperationSchema.optional(),
  receiptAvailable: z.boolean(),
  nextAction: OperatorNextActionSchema,
}).strict()

export type CaseOperatorView = z.output<typeof CaseOperatorViewSchema>

const OperatorReceiptSchema = z.object({
  operationId: z.string().min(1),
  operationRevision: z.number().int().nonnegative(),
  state: OperatorOperationSchema.shape.state,
  evidenceCount: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.iso.datetime({ offset: true }),
  binding: z.object({
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    approvalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    routeQuoteHash: z.string().regex(/^[a-f0-9]{64}$/),
    workOrder: z.object({
      vehicleId: z.string().min(1),
      serviceStart: z.iso.datetime({ offset: true }),
      serviceEnd: z.iso.datetime({ offset: true }),
    }).strict(),
    evidenceIds: z.array(z.string().min(1)),
  }).strict(),
}).strict()

export type OperatorReceipt = z.output<typeof OperatorReceiptSchema>

interface StoredLocalDemoSession {
  readonly userSession: string
  readonly tenantId: string
  readonly expiresAtMs: number
  /** One local source snapshot time keeps the presentation projection stable. */
  readonly sourceSnapshotAt: string
}

export interface LocalDemoSession {
  readonly id: string
  readonly expiresAt: string
}

/**
 * An HttpOnly cookie contains only this random lookup key. The lifecycle user
 * session stays in this process and is never returned to, stored by, or logged
 * for the browser.
 */
export class LocalDemoSessionStore {
  readonly #authority: ComposedRuntime['authority']
  readonly #defaultDispatcherSession: string
  readonly #sessions = new Map<string, StoredLocalDemoSession>()

  constructor(input: Readonly<{ authority: ComposedRuntime['authority']; dispatcherSession: string }>) {
    this.#authority = input.authority
    this.#defaultDispatcherSession = input.dispatcherSession
    this.#assertDispatcher(input.dispatcherSession)
  }

  issue(): LocalDemoSession {
    return this.issueForServerSession(this.#defaultDispatcherSession)
  }

  /** Server-only composition/test hook. No HTTP route accepts a user session. */
  issueForServerSession(userSession: string): LocalDemoSession {
    const principal = this.#assertDispatcher(userSession)
    const id = `local_${randomBytes(24).toString('base64url')}`
    const expiresAtMs = Date.now() + localSessionTtlSeconds * 1_000
    const sourceSnapshotAt = new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString()
    this.#sessions.set(id, { userSession, tenantId: principal.tenantId, expiresAtMs, sourceSnapshotAt })
    return { id, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  resolve(cookieValue: string | undefined): Readonly<{ userSession: string; principal: Principal; sourceSnapshotAt: Date }> {
    if (!cookieValue) throw new LifecycleError('invalid_session', 'A local demo session is required.')
    const stored = this.#sessions.get(cookieValue)
    if (!stored || stored.expiresAtMs <= Date.now()) {
      this.#sessions.delete(cookieValue)
      throw new LifecycleError('invalid_session', 'The local demo session is invalid or expired.')
    }
    const principal = this.#assertDispatcher(stored.userSession)
    if (principal.tenantId !== stored.tenantId) {
      this.#sessions.delete(cookieValue)
      throw new LifecycleError('invalid_session', 'The local demo session no longer matches its tenant.')
    }
    return { userSession: stored.userSession, principal, sourceSnapshotAt: new Date(stored.sourceSnapshotAt) }
  }

  #assertDispatcher(userSession: string): Principal {
    const principal = this.#authority.resolve(userSession)
    if (principal.kind !== 'user'
      || !principal.capabilities.has('read_lifecycle')
      || !principal.capabilities.has('approve_recovery')) {
      throw new LifecycleError('missing_capability', 'The local operator requires a readable dispatcher session.')
    }
    return principal
  }
}

export interface CreateTrashPalOperatorApiOptions {
  readonly runtime: ComposedRuntime
  readonly sessions: LocalDemoSessionStore
}

/**
 * Adds a browser-safe local operator facade while preserving the core bearer
 * routes unchanged. The facade is intentionally one tenant/case local demo.
 */
export function createTrashPalOperatorApi(options: CreateTrashPalOperatorApiOptions): FastifyInstance {
  const app = createTrashPalApi({ runtime: options.runtime })
  const runtime = options.runtime
  const sessions = options.sessions

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store')
    return payload
  })

  app.post('/v1/operator/session', async (request, reply) => {
    assertEmptyBody(request.body)
    const session = sessions.issue()
    setLocalDemoCookie(reply, session.id)
    return {
      session: {
        mode: 'local_demo' as const,
        actor: {
          label: 'Demo dispatcher',
          capabilities: ['read_case', 'prepare_recovery', 'approve_recovery', 'monitor_operations'],
        },
      },
    }
  })

  app.get('/v1/operator/help', async (request) => {
    resolveOperatorSession(request, sessions)
    const topic = OperatorHelpTopicSchema.safeParse((request.query as Record<string, unknown>).topic ?? 'overview')
    if (!topic.success) throw new LifecycleError('help_topic_not_found', 'The requested operator help topic does not exist.')
    return { article: await canonicalHelpArticle(topic.data) }
  })

  app.get('/v1/operator/help/developer-reference', async (request, reply) => {
    resolveOperatorSession(request, sessions)
    return reply.type('text/markdown; charset=utf-8').send((await canonicalHelpArticle('developer-reference')).markdown)
  })

  app.get('/v1/operator/help/references/:referenceId', async (request, reply) => {
    resolveOperatorSession(request, sessions)
    const reference = OperatorHelpReferenceSchema.safeParse(pathParam(request, 'referenceId'))
    if (!reference.success) {
      throw new LifecycleError('help_reference_not_found', 'The requested technical reference does not exist.')
    }
    return reply.type('text/markdown; charset=utf-8').send(await canonicalHelpReference(reference.data))
  })

  app.get('/v1/operator/cases/:caseId', async (request) => {
    const session = resolveOperatorSession(request, sessions)
    return { case: await operatorCaseView(runtime, session, pathParam(request, 'caseId')) }
  })

  app.get('/v1/operator/cases', async (request) => {
    resolveOperatorSession(request, sessions)
    return { cases: Object.entries(operatorCases).map(([id, metadata]) => ({ id, ...metadata })) }
  })

  app.post('/v1/operator/cases/:caseId/prepare', async (request) => {
    assertEmptyBody(request.body)
    const session = resolveOperatorSession(request, sessions)
    const caseId = pathParam(request, 'caseId')
    assertOperatorScope(session.principal, caseId)
    const current = await runtime.getCaseLifecycleState(session.userSession, caseId)
    if (current.operation && operationNeedsResolution(current.operation.state)) {
      throw new LifecycleError('operator_operation_unresolved', 'Resolve the existing operation before preparing another recovery.')
    }
    const prepared = await runtime.pal.prepare({ tenantId: session.principal.tenantId, caseId })
    if (!('lifecycle' in prepared)) {
      throw new LifecycleError('operator_preparation_not_ready', 'Pal did not prepare an executable recovery.')
    }
    return {
      case: await operatorCaseView(runtime, session, caseId),
      preparation: { proposalId: prepared.proposal.id, outcome: 'prepare_recovery' as const },
    }
  })

  app.post('/v1/operator/proposals/:proposalId/approve', async (request) => {
    assertEmptyBody(request.body)
    const session = resolveOperatorSession(request, sessions)
    const proposal = await operatorProposal(runtime, session, pathParam(request, 'proposalId'))
    const approval = await runtime.repository.approve(session.userSession, proposal.id)
    const reservation = await runtime.repository.reserve(session.userSession, approval.digest)
    return {
      case: await operatorCaseView(runtime, session, proposal.caseId),
      approval: {
        digest: approval.digest,
        proposalDigest: approval.proposalDigest,
        validUntil: approval.validUntil,
      },
      operation: safeOperation(reservation.operation),
      replayed: reservation.replayed,
    }
  })

  app.post('/v1/operator/approvals/:approvalDigest/reserve', async (request) => {
    assertEmptyBody(request.body)
    const session = resolveOperatorSession(request, sessions)
    const current = await runtime.getCaseLifecycleState(session.userSession, GreenleafOperatorCaseId)
    if (current.approval?.digest !== pathParam(request, 'approvalDigest')) {
      throw new LifecycleError('approval_not_found', 'The approval does not belong to this operator case.')
    }
    const reservation = await runtime.repository.reserve(session.userSession, current.approval.digest)
    return {
      case: await operatorCaseView(runtime, session, GreenleafOperatorCaseId),
      operation: safeOperation(reservation.operation),
      replayed: reservation.replayed,
    }
  })

  app.post('/v1/operator/operations/:operationId/dispatch', async (request) => {
    assertEmptyBody(request.body)
    const session = resolveOperatorSession(request, sessions)
    const operationId = pathParam(request, 'operationId')
    const existing = await assertOperatorOperation(runtime, session, operationId)
    const operation = await runtime.dispatchOperation(runtime.workers.dispatch, operationId)
    return {
      case: await operatorCaseView(runtime, session, existing.snapshot.caseId),
      operation: safeOperation(operation),
    }
  })

  app.post('/v1/operator/operations/:operationId/reconcile', async (request) => {
    assertEmptyBody(request.body)
    const session = resolveOperatorSession(request, sessions)
    const operationId = pathParam(request, 'operationId')
    const existing = await assertOperatorOperation(runtime, session, operationId)
    const operation = await runtime.reconcile(runtime.workers.dispatch, operationId)
    const receipt = await runtime.repository.receipt(session.userSession, operationId)
    return {
      case: await operatorCaseView(runtime, session, existing.snapshot.caseId),
      operation: safeOperation(operation),
      receipt: safeReceipt(receipt, operation),
    }
  })

  app.get('/v1/operator/operations/:operationId/receipt', async (request) => {
    const session = resolveOperatorSession(request, sessions)
    const operationId = pathParam(request, 'operationId')
    const operation = await assertOperatorOperation(runtime, session, operationId)
    return {
      case: await operatorCaseView(runtime, session, operation.snapshot.caseId),
      receipt: safeReceipt(await runtime.repository.receipt(session.userSession, operationId), operation),
    }
  })

  return app
}

type OperatorSession = Readonly<{ userSession: string; principal: Principal; sourceSnapshotAt: Date }>

async function operatorCaseView(runtime: ComposedRuntime, session: OperatorSession, caseId: string): Promise<CaseOperatorView> {
  assertOperatorScope(session.principal, caseId)
  const metadata = operatorCases[OperatorCaseIdSchema.parse(caseId)]
  const state = await runtime.getCaseLifecycleState(session.userSession, caseId)
  const proposal = state.proposal ? safeProposalFromBinding(state.proposal) : undefined
  const palRun = runtime.pal.getLatestRun({ tenantId: session.principal.tenantId, caseId })
  const historicalOperation = !proposal && state.operation !== undefined
  const serviceWindowEndsAt = state.serviceDeadline ?? createSyntheticRecordedRecoveryCase({
    tenantId: session.principal.tenantId,
    caseId,
    now: session.sourceSnapshotAt,
  }).serviceWindowEndsAt
  const summary = proposal
    ? {
      phase: 'recovery_prepared' as const,
      whatHappened: sourceRecordsWhatHappened,
      whatPalChecked: [
        'An active service agreement permits recovery.',
        'Access is confirmed for the next recovery window.',
        'The original field attempt could not be completed.',
        'A vehicle has capacity for one recovery stop.',
      ],
      whatIsUnknown: ['Provider acceptance is not proof that collection is complete.'],
    }
    : historicalOperation
      ? {
        phase: 'historical_decision' as const,
        whatHappened: historicalDecisionWhatHappened,
        whatPalChecked: [
          'Pal prepared the existing recovery from a prior immutable evidence snapshot.',
          'The original operation remains the only authorized recovery for this exception.',
        ],
        whatIsUnknown: ['Whether the provider-side recovery reached a final outcome.'],
      }
      : {
        phase: 'source_records_available' as const,
        whatHappened: sourceRecordsWhatHappened,
        whatPalChecked: ['Pal has not prepared a recovery yet.'],
        whatIsUnknown: ['Whether the available records support one safe, policy-bound recovery.'],
      }
  const evidence = proposal
    ? [
      { id: 'agreement', label: 'Active service agreement', status: 'confirmed' as const, detail: 'Recovery is permitted while the current agreement remains valid.' },
      { id: 'access', label: 'Current access confirmation', status: 'confirmed' as const, detail: 'Access is confirmed for the recovery window.' },
      { id: 'field_attempt', label: 'Field attempt', status: 'observed' as const, detail: 'The scheduled collection could not be completed.' },
      { id: 'completion_proof', label: 'Completion proof', status: 'pending' as const, detail: 'A dispatch acknowledgement is not proof of completed collection.' },
    ]
    : historicalOperation
      ? [
        { id: 'agreement', label: 'Prior service agreement', status: 'observed' as const, detail: 'This record supported the existing recovery. It is not a current authorization.' },
        { id: 'access', label: 'Prior access confirmation', status: 'observed' as const, detail: 'This record supported the existing recovery. It is not a current access check.' },
        { id: 'field_attempt', label: 'Field attempt', status: 'observed' as const, detail: 'The scheduled collection could not be completed.' },
        { id: 'completion_proof', label: 'Completion proof', status: 'pending' as const, detail: 'The existing provider operation has not yet established a final outcome.' },
      ]
      : [
        { id: 'agreement', label: 'Service agreement record', status: 'observed' as const, detail: 'A source record is available for Pal to evaluate.' },
        { id: 'access', label: 'Access confirmation record', status: 'observed' as const, detail: 'A source record is available for Pal to evaluate.' },
        { id: 'field_attempt', label: 'Field attempt record', status: 'observed' as const, detail: 'A source record is available for Pal to evaluate.' },
        { id: 'completion_proof', label: 'Completion proof', status: 'pending' as const, detail: 'No recovery has been prepared or dispatched.' },
      ]
  const view = {
    case: {
      id: caseId,
      title: metadata.title,
      serviceType: 'Organics collection',
      priority: metadata.priority,
      timeZone: 'America/Chicago',
      serviceWindowEndsAt,
    },
    summary,
    evidence,
    activity: operatorActivity(state, session.sourceSnapshotAt),
    ...(palRun ? { palRun: {
      outcome: palRun.trace.outcome,
      stopCode: palRun.trace.stopCode,
      skillCount: palRun.trace.skillInvocations.length,
      includedEvidence: palRun.contextEnvelope.includedEvidence.map((item) => item.evidenceId),
      omittedEvidence: palRun.contextEnvelope.omittedEvidence.map((item) => item.evidenceId),
      conflicts: palRun.contextEnvelope.conflicts.map((item) => item.reason),
      reasoner: 'deterministic_local' as const,
    } } : {}),
    ...(proposal ? {
      proposal: {
        id: proposal.id,
        digest: proposal.approvalBinding.digest,
        validUntil: proposal.validUntil,
        workOrder: { ...proposal.workOrder },
        claims: proposal.factualClaims.map((claim) => ({ text: claim.text, evidenceIds: [...claim.evidenceIds] })),
      },
    } : {}),
    ...(state.approval ? {
      approval: {
        digest: state.approval.digest,
        proposalDigest: state.approval.proposalDigest,
        validUntil: state.approval.validUntil,
      },
    } : {}),
    ...(state.operation ? { operation: safeOperation(state.operation) } : {}),
    receiptAvailable: state.receiptAvailable,
    nextAction: nextAction(state),
  }
  return CaseOperatorViewSchema.parse(view)
}

function operatorActivity(
  state: Awaited<ReturnType<ComposedRuntime['getCaseLifecycleState']>>,
  sourceSnapshotAt: Date,
): z.output<typeof OperatorActivitySchema>[] {
  const activity: z.output<typeof OperatorActivitySchema>[] = [{
    id: 'signal',
    label: 'Signal received',
    detail: 'The service exception entered the case record.',
    status: state.proposal ? 'complete' : 'current',
    occurredAt: sourceSnapshotAt.toISOString(),
  }]
  if (state.proposal) {
    activity.push(
      {
        id: 'checks',
        label: 'Checks run',
        detail: 'Pal checked agreement, access, field-attempt, and route-capacity evidence.',
        status: 'complete',
      },
      {
        id: 'uncertainty',
        label: 'Uncertainty found',
        detail: 'Provider acceptance would not prove completed collection.',
        status: 'complete',
      },
      {
        id: 'proposal',
        label: 'Proposal built',
        detail: 'Pal bound one recovery work order to the evidence snapshot.',
        status: state.approval ? 'complete' : 'current',
      },
    )
  }
  if (state.approval) {
    activity.push({
      id: 'approval',
      label: 'Approval bound',
      detail: 'The dispatcher approved the exact proposal digest and validity window.',
      status: state.operation ? 'complete' : 'current',
    })
  }
  for (const event of state.operation?.events ?? []) {
    activity.push({
      id: `operation-${event.sequence}`,
      label: operationActivityLabel(event.state),
      detail: operationActivityDetail(event.state),
      status: event.sequence === state.operation?.revision && !state.receiptAvailable ? 'current' : 'complete',
      occurredAt: event.occurredAt,
    })
  }
  if (state.receiptAvailable) {
    activity.push({
      id: 'receipt',
      label: 'Outcome recorded',
      detail: 'The reconciled operation and its approval binding are available as a receipt.',
      status: 'current',
    })
  }
  return activity
}

function operationActivityLabel(state: OperationState): string {
  if (state === 'reserved') return 'Operation reserved'
  if (state === 'unknown') return 'Dispatch uncertain'
  if (state === 'assignment_reconciled') return 'Operation reconciled'
  return `Operation ${state.replaceAll('_', ' ')}`
}

function operationActivityDetail(state: OperationState): string {
  if (state === 'reserved') return 'Deterministic code created the approved operation before any provider call.'
  if (state === 'unknown') return 'Dispatch outcome unknown — Pal queried the existing operation instead of retrying.'
  if (state === 'assignment_reconciled') return 'The existing provider assignment was found without sending a duplicate recovery.'
  return `The durable operation advanced to ${state.replaceAll('_', ' ')}.`
}

function nextAction(state: Awaited<ReturnType<ComposedRuntime['getCaseLifecycleState']>>): CaseOperatorView['nextAction'] {
  if (state.operation?.state === 'reserved') return { kind: 'dispatch', label: 'Dispatch the approved recovery', requiresApproval: false }
  if (state.operation?.state === 'unknown') return { kind: 'reconcile', label: 'Reconcile the provider outcome', requiresApproval: false }
  if (state.operation) {
    if (!state.receiptAvailable) return { kind: 'view_receipt', label: 'Create and inspect the operation receipt', requiresApproval: false }
    return { kind: 'monitor', label: 'Monitor the recovery outcome', requiresApproval: false }
  }
  if (!state.proposal) return { kind: 'prepare', label: 'Ask Pal to prepare a recovery', requiresApproval: false }
  if (!state.approval) return { kind: 'approve', label: 'Review and approve this exact recovery', requiresApproval: true }
  if (!state.operation) return { kind: 'reserve', label: 'Create the approved recovery operation', requiresApproval: false }
  throw new LifecycleError('operator_state_invalid', 'The operator state could not determine a next action.')
}

function operationNeedsResolution(state: OperationState): boolean {
  return state === 'reserved'
    || state === 'sending'
    || state === 'accepted'
    || state === 'unknown'
    || state === 'assignment_reconciled'
    || state === 'driver_reported'
    || state === 'supporting_evidence_received'
    || state === 'evidence_reconciled'
}

async function operatorProposal(runtime: ComposedRuntime, session: OperatorSession, proposalId: string): Promise<ReturnType<typeof safeProposalFromBinding>> {
  const binding = await runtime.getProposalBinding(session.userSession, proposalId)
  const proposal = safeProposalFromBinding(binding)
  assertOperatorScope(session.principal, proposal.caseId)
  return proposal
}

async function assertOperatorOperation(
  runtime: ComposedRuntime,
  session: OperatorSession,
  operationId: string,
): Promise<Awaited<ReturnType<ComposedRuntime['repository']['getOperation']>>> {
  const operation = await runtime.repository.getOperation(session.userSession, operationId)
  assertOperatorScope(session.principal, operation.snapshot.caseId)
  return operation
}

function assertOperatorScope(principal: Principal, caseId: string): void {
  if (principal.tenantId !== GreenleafOperatorTenantId || !OperatorCaseIdSchema.safeParse(caseId).success) {
    throw new LifecycleError('case_not_found', 'The local operator case does not exist in the resolved tenant.')
  }
}

function safeOperation(operation: Awaited<ReturnType<ComposedRuntime['repository']['getOperation']>>): CaseOperatorView['operation'] {
  return OperatorOperationSchema.parse({
    id: operation.id,
    state: operation.state,
    revision: operation.revision,
    updatedAt: operation.updatedAt,
    ...(operation.providerAssignmentId ? { providerAssignmentId: operation.providerAssignmentId } : {}),
  })
}

function safeReceipt(
  receipt: Awaited<ReturnType<ComposedRuntime['repository']['receipt']>>,
  operation: Awaited<ReturnType<ComposedRuntime['repository']['getOperation']>>,
): OperatorReceipt {
  if (receipt.operationId !== operation.id
    || receipt.proposalDigest !== operation.snapshot.proposalDigest
    || receipt.approvalDigest !== operation.snapshot.approvalDigest
    || receipt.routeQuoteHash !== operation.snapshot.routeQuoteHash) {
    throw new LifecycleError('database_binding_invalid', 'Receipt does not match the operation execution snapshot.')
  }
  return OperatorReceiptSchema.parse({
    operationId: receipt.operationId,
    operationRevision: receipt.operationRevision,
    state: receipt.state,
    evidenceCount: receipt.evidenceIds.length,
    digest: receipt.digest,
    recordedAt: receipt.recordedAt,
    binding: {
      proposalDigest: receipt.proposalDigest,
      approvalDigest: receipt.approvalDigest,
      routeQuoteHash: receipt.routeQuoteHash,
      workOrder: {
        vehicleId: operation.snapshot.vehicleId,
        serviceStart: operation.snapshot.serviceStart,
        serviceEnd: operation.snapshot.serviceEnd,
      },
      evidenceIds: [...receipt.evidenceIds],
    },
  })
}

function resolveOperatorSession(request: FastifyRequest, sessions: LocalDemoSessionStore): OperatorSession {
  return sessions.resolve(cookieValue(request.headers.cookie, demoCookieName))
}

function setLocalDemoCookie(reply: FastifyReply, value: string): void {
  reply.header('set-cookie', `${demoCookieName}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${localSessionTtlSeconds}`)
}

function cookieValue(header: string | undefined, key: string): string | undefined {
  if (!header) return undefined
  for (const pair of header.split(';')) {
    const [name, ...value] = pair.trim().split('=')
    if (name === key && value.length > 0) return decodeURIComponent(value.join('='))
  }
  return undefined
}

function pathParam(request: FastifyRequest, key: string): string {
  const value = (request.params as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new LifecycleError('invalid_identifier', `Path parameter ${key} is required.`)
  }
  return value
}

function assertEmptyBody(body: unknown): void {
  if (body === undefined) return
  if (body === null || Array.isArray(body) || typeof body !== 'object') {
    throw new LifecycleError('request_payload_forbidden', 'This route does not accept a request payload.')
  }
  const record = body as Record<string, unknown>
  rejectCallerIdentity(record)
  if (Object.keys(record).length > 0) {
    throw new LifecycleError('request_payload_forbidden', 'This route derives bindings from server-side records.')
  }
}

async function canonicalHelpArticle(topic: z.output<typeof OperatorHelpTopicSchema>): Promise<{
  readonly topic: z.output<typeof OperatorHelpTopicSchema>
  readonly title: string
  readonly markdown: string
}> {
  const file = operatorHelpFiles[topic]
  const markdown = await readFile(new URL(`../../../docs/help/${file}`, import.meta.url), 'utf8')
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim()
  if (!title) throw new LifecycleError('help_document_invalid', `Canonical help document ${file} lacks an H1 title.`)
  return { topic, title, markdown }
}

async function canonicalHelpReference(reference: z.output<typeof OperatorHelpReferenceSchema>): Promise<string> {
  const file = operatorHelpReferenceFiles[reference]
  return await readFile(new URL(`../../../docs/${file}`, import.meta.url), 'utf8')
}
