import { randomUUID } from 'node:crypto'
import {
  CaseIdSchema,
  ProgramDefinitionSchema,
  RecoveryProposalSchema,
  TenantIdSchema,
  contentDigest,
  recoveryProgramDefinition,
  type RunBudget,
} from '@trashpal/contracts'
import {
  canonicalEvidenceClaim,
  createLocalProviderAdapter,
  createRecoverySkillHost,
  runBoundedPal,
  type PalProviderAdapter,
  type PalReasoner,
  type PalReasoningView,
  type PalSkillHost,
  type RecoveryRoutePlannerPort,
} from '@trashpal/agent'
import {
  PostgresLifecycleRepository,
  digest as lifecycleDigest,
  type Clock,
  type CurrentDecisionInputs,
} from '@trashpal/lifecycle'
import {
  createSyntheticRecordedRecoveryCase,
  type OperatorAccessStatus,
  type SyntheticRecordedRecoveryCase,
  type SyntheticRecoverySourceFactory,
} from './synthetic-source.js'
import { z } from 'zod'

const localClock: Clock = { now: () => new Date() }

const defaultBudget: RunBudget = {
  maxSkillCalls: 6,
  maxContextTokens: 8_000,
  maxLatencyMs: 30_000,
  maxEstimatedCostUsd: 0.1,
}

export interface RuntimeScope {
  readonly tenantId: string
  readonly caseId: string
  readonly operatorAccessStatus?: OperatorAccessStatus
}

export interface SafeContextEnvelope {
  readonly includedEvidence: readonly {
    readonly evidenceId: string
    readonly reason: string
    readonly authority?: string
    readonly freshness?: string
  }[]
  readonly omittedEvidence: readonly {
    readonly evidenceId: string
    readonly reason: string
    readonly authority?: string
    readonly freshness?: string
  }[]
  readonly conflicts: readonly {
    readonly evidenceIds: readonly string[]
    readonly reason: string
  }[]
  readonly tokenEstimate: number
  readonly tokenBudget: number
  readonly versions: {
    readonly program: string
    readonly contextBundle: string
    readonly skills: Readonly<Record<string, string>>
  }
  readonly digest: string
}

const ProposalBindingPayloadSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  outcome: z.literal('prepare_recovery'),
  factualClaims: z.array(z.object({
    text: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
  }).strict()),
  routeQuoteId: z.string().min(1),
  workOrder: z.object({
    vehicleId: z.string().min(1),
    serviceStart: z.iso.datetime({ offset: true }),
    serviceEnd: z.iso.datetime({ offset: true }),
  }).strict(),
  validUntil: z.iso.datetime({ offset: true }),
  modelProposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type ProposalBindingPayload = z.output<typeof ProposalBindingPayloadSchema>

export interface SafeModelProposal {
  readonly id: string
  readonly tenantId: string
  readonly caseId: string
  readonly outcome: 'prepare_recovery'
  readonly factualClaims: readonly {
    readonly text: string
    readonly evidenceIds: readonly string[]
  }[]
  readonly routeQuoteId: string
  readonly workOrder: {
    readonly vehicleId: string
    readonly serviceStart: string
    readonly serviceEnd: string
  }
  readonly validUntil: string
  /** The host-validated digest supplied by the bounded Pal program. */
  readonly modelProposalDigest: string
}

export interface SafePalProposal extends SafeModelProposal {
  /**
   * The exact canonical payload and digest that the lifecycle repository
   * persists and binds to dispatcher approval.
   */
  readonly approvalBinding: {
    readonly payload: ProposalBindingPayload
    readonly digest: string
  }
}

export type SafeStopCode =
  | 'proposal_validated'
  | 'human_confirmation_required'
  | 'safe_recovery_not_prepared'

export interface SafePalRunTrace {
  readonly runToken: string
  readonly outcome: 'prepare_recovery' | 'hold_for_confirmation' | 'escalate'
  /** A host-owned reason code. Model-controlled stop text is never retained. */
  readonly stopCode: SafeStopCode
  readonly runBudget: RunBudget
  readonly skillInvocations: readonly {
    readonly skillId: string
    readonly status: number
    readonly receipt: string
  }[]
  readonly providerRequestCount: number
  readonly reasoningTokens: number
  readonly estimatedCostUsd: number
}

export interface RetainedPalRun {
  readonly tenantId: string
  readonly caseId: string
  readonly runToken: string
  readonly preparedAt: string
  readonly trace: SafePalRunTrace
  readonly contextEnvelope: SafeContextEnvelope
  readonly proposal?: SafeModelProposal
}

export interface PreparedPalRun extends RetainedPalRun {
  readonly proposal: SafePalProposal
  readonly lifecycle: {
    readonly proposalDigest: string
    readonly contextBundleHash: string
    readonly evidencePacketHash: string
    readonly routeQuoteHash: string
    readonly evidenceSnapshotId: string
    readonly evidenceRevision: number
    readonly routeRevision: number
  }
}

export interface LocalCompositionRuntimeOptions {
  readonly repository: PostgresLifecycleRepository
  readonly preparationWorkerToken: string
  readonly routePlanner: RecoveryRoutePlannerPort
  readonly clock?: Clock
  readonly sourceFactory?: SyntheticRecoverySourceFactory
  /**
   * Supplies a model provider only at the composition boundary. The default is
   * a local deterministic reasoner so this bounded local runtime never needs a
   * provider credential.
   */
  readonly providerFactory?: (input: Readonly<{ scope: RuntimeScope; runToken: string }>) => PalProviderAdapter
  readonly reasoner?: PalReasoner
  readonly runTokenFactory?: (scope: RuntimeScope) => string
  readonly budget?: RunBudget
  readonly pricing?: Readonly<{ inputUsdPerMillion: number; outputUsdPerMillion: number }>
}

export class PalPreparationError extends Error {
  constructor(
    readonly code: 'PAL_ROUTE_QUOTE_MISSING' | 'PAL_LIFECYCLE_BINDING_MISMATCH',
    readonly runToken: string,
  ) {
    super(code)
    this.name = 'PalPreparationError'
  }
}

/**
 * The P5 composition boundary. It accepts only server-owned dependencies,
 * runs Pal against a case-scoped recorded source, persists canonical decision
 * inputs through the durable lifecycle repository, and keeps only safe trace
 * metadata in memory for inspection.
 */
export class LocalCompositionRuntime {
  readonly #repository: PostgresLifecycleRepository
  readonly #preparationWorkerToken: string
  readonly #routePlanner: RecoveryRoutePlannerPort
  readonly #clock: Clock
  readonly #sourceFactory: SyntheticRecoverySourceFactory
  readonly #providerFactory?: LocalCompositionRuntimeOptions['providerFactory']
  readonly #reasoner?: PalReasoner
  readonly #runTokenFactory: (scope: RuntimeScope) => string
  readonly #budget: RunBudget
  readonly #pricing: Readonly<{ inputUsdPerMillion: number; outputUsdPerMillion: number }>
  readonly #runs = new Map<string, RetainedPalRun>()
  readonly #latestRunByScope = new Map<string, string>()

  constructor(options: LocalCompositionRuntimeOptions) {
    this.#repository = options.repository
    this.#preparationWorkerToken = options.preparationWorkerToken
    this.#routePlanner = options.routePlanner
    this.#clock = options.clock ?? localClock
    this.#sourceFactory = options.sourceFactory ?? createSyntheticRecordedRecoveryCase
    if (options.providerFactory) this.#providerFactory = options.providerFactory
    if (options.reasoner) this.#reasoner = options.reasoner
    this.#runTokenFactory = options.runTokenFactory ?? (() => `run_${randomUUID()}`)
    this.#budget = options.budget ?? defaultBudget
    this.#pricing = options.pricing ?? { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
  }

  async prepare(input: RuntimeScope): Promise<PreparedPalRun | RetainedPalRun> {
    const scope = normalizeScope(input)
    const now = currentTime(this.#clock)
    const synthetic = this.#sourceFactory({ ...scope, now })
    assertSyntheticScope(synthetic, scope)
    const runToken = this.#runTokenFactory(scope)
    if (!runToken) throw new Error('PAL_RUN_TOKEN_REQUIRED')

    let capturedQuote: { id: string; tenantId: string; vehicleId: string; serviceStart: string; serviceEnd: string; validUntil: string; remainingCapacityKg: number; incrementalMinutes: number; hash: string } | undefined
    const routePlanner: RecoveryRoutePlannerPort = {
      quoteRecovery: async (request) => {
        const result = await this.#routePlanner.quoteRecovery(request)
        if (result.status === 'feasible') {
          if (capturedQuote) throw new Error('PAL_MULTIPLE_ROUTE_QUOTES')
          capturedQuote = structuredClone(result.quote)
        }
        return result
      },
    }

    const baseSkillHost = createRecoverySkillHost({
      source: synthetic.source,
      routePlanner,
      contextBundle: synthetic.compiledContext.bundle,
      approvalPolicy: {
        action: 'dispatcher_approval_required',
        policyVersion: synthetic.compiledContext.bundle.policyVersion,
        validUntil: synthetic.evidenceValidUntil,
      },
      clock: { nowMs: () => currentTime(this.#clock).valueOf() },
    })
    const skillHost = createHostBoundSkillHost(baseSkillHost)
    const provider = this.#providerFactory?.({ scope, runToken })
      ?? createLocalProviderAdapter(this.#reasoner ?? createBoundedRecoveryReasoner(runToken), {
        requestIdPrefix: `pal-local-${runToken}`,
      })
    const result = await runBoundedPal({
      trigger: {
        tenantId: scope.tenantId,
        caseId: scope.caseId,
        programId: recoveryProgramDefinition.id,
      },
      program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
      contextBundle: synthetic.compiledContext.bundle,
      budget: this.#budget,
      provider,
      skillHost,
      runToken,
      pricing: this.#pricing,
      clock: { nowMs: () => currentTime(this.#clock).valueOf() },
    })

    const retained = retainRun(scope, now, result)
    this.#runs.set(runKey(scope, runToken), retained)
    this.#latestRunByScope.set(scopeKey(scope), runToken)
    if (!result.proposal || result.outcome !== 'prepare_recovery') {
      return structuredClone(retained)
    }
    if (!capturedQuote) throw new PalPreparationError('PAL_ROUTE_QUOTE_MISSING', runToken)

    const decisionInputs = deriveDecisionInputs({
      scope,
      runToken,
      synthetic,
      result,
      quote: capturedQuote,
    })
    await this.#repository.prepareDecisionInputs(this.#preparationWorkerToken, decisionInputs)

    const proposal = safeProposalFromBinding({
      payload: decisionInputs.proposalPayload,
      digest: decisionInputs.proposalDigest,
    })
    const prepared: PreparedPalRun = {
      ...retained,
      proposal,
      lifecycle: {
        proposalDigest: decisionInputs.proposalDigest,
        contextBundleHash: decisionInputs.contextBundleHash,
        evidencePacketHash: decisionInputs.evidencePacketHash,
        routeQuoteHash: decisionInputs.routeQuoteHash,
        evidenceSnapshotId: decisionInputs.evidenceSnapshotId,
        evidenceRevision: decisionInputs.evidenceRevision,
        routeRevision: decisionInputs.routeRevision,
      },
    }
    this.#runs.set(runKey(scope, runToken), prepared)
    return structuredClone(prepared)
  }

  getRun(input: RuntimeScope & Readonly<{ runToken: string }>): RetainedPalRun | undefined {
    const scope = normalizeScope(input)
    const run = this.#runs.get(runKey(scope, input.runToken))
    return run ? structuredClone(run) : undefined
  }

  /** Safe local-demo inspection seam; the browser receives a reduced projection. */
  getLatestRun(input: RuntimeScope): RetainedPalRun | undefined {
    const scope = normalizeScope(input)
    const token = this.#latestRunByScope.get(scopeKey(scope))
    return token ? this.getRun({ ...scope, runToken: token }) : undefined
  }

}

export function createLocalCompositionRuntime(options: LocalCompositionRuntimeOptions): LocalCompositionRuntime {
  return new LocalCompositionRuntime(options)
}

/**
 * This reasoner has no authority to execute a recovery. It can only request the
 * six host-owned read/propose skills and must stop if the typed evidence is not
 * sufficient for the next step.
 */
export function createBoundedRecoveryReasoner(proposalSeed: string): PalReasoner {
  return {
    async decide(view: PalReasoningView): Promise<unknown> {
      const completed = new Set(view.staticContext.completedSkills)
      if (!completed.has('inspect_service_exception')) return call('inspect_service_exception')
      if (!completed.has('get_customer_commitments')) return call('get_customer_commitments')

      const agreement = view.evidence.find((item) => item.authority === 'agreement')
      if (!agreement || agreement.freshness !== 'fresh') {
        return stop('hold_for_confirmation', 'A current service agreement is required before recovery planning.')
      }
      if (!completed.has('get_access_evidence')) return call('get_access_evidence')
      if (!completed.has('get_field_attempt')) return call('get_field_attempt')
      if (view.envelope.conflicts.length > 0) {
        return stop('hold_for_confirmation', 'Current access evidence conflicts and needs human review.')
      }

      const confirmedAccess = view.evidence.some((item) => item.freshness === 'fresh' && item.content.status === 'confirmed_clear')
      if (!confirmedAccess) {
        return stop('hold_for_confirmation', 'Fresh access confirmation is required before route feasibility can be checked.')
      }
      if (!completed.has('quote_recovery_options')) return call('quote_recovery_options')

      const quoteEvidence = view.evidence.find((item) => item.authority === 'derived'
        && typeof item.content.routeQuoteId === 'string'
        && typeof item.content.vehicleId === 'string'
        && typeof item.content.serviceStart === 'string'
        && typeof item.content.serviceEnd === 'string')
      if (!quoteEvidence) return stop('escalate', 'A feasible route quote is not available.')
      if (completed.has('submit_typed_proposal')) {
        return stop('escalate', 'Proposal submission did not terminate the bounded run.')
      }

      const validUntilValues = view.evidence
        .map((item) => item.content.validUntil)
        .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
      if (validUntilValues.length !== view.evidence.length) {
        return stop('escalate', 'The recovered evidence is missing a validity boundary.')
      }
      const validUntil = earliest(validUntilValues)
      const factualClaims = [...view.evidence]
        // The host's canonical validator uses ECMAScript's default string sort,
        // not locale collation. Keep the proposal byte-for-byte aligned with it.
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map((item) => canonicalEvidenceClaim(item))
      const proposalIdentity = contentDigest({
        proposalSeed,
        bundleHash: view.staticContext.bundleHash,
        caseId: view.staticContext.trigger.caseId,
        routeQuoteId: quoteEvidence.content.routeQuoteId,
        evidenceIds: factualClaims.flatMap((claim) => claim.evidenceIds),
        validUntil,
      }).slice(0, 24)
      const unsigned = {
        id: `proposal_${proposalIdentity}`,
        tenantId: view.staticContext.trigger.tenantId,
        caseId: view.staticContext.trigger.caseId,
        outcome: 'prepare_recovery' as const,
        factualClaims,
        routeQuoteId: quoteEvidence.content.routeQuoteId,
        workOrder: {
          vehicleId: quoteEvidence.content.vehicleId,
          serviceStart: quoteEvidence.content.serviceStart,
          serviceEnd: quoteEvidence.content.serviceEnd,
        },
        validUntil,
      }
      return call('submit_typed_proposal', { proposal: { ...unsigned, digest: contentDigest(unsigned) } })
    },
  }
}

function deriveDecisionInputs(input: {
  readonly scope: RuntimeScope
  readonly runToken: string
  readonly synthetic: SyntheticRecordedRecoveryCase
  readonly result: Awaited<ReturnType<typeof runBoundedPal>>
  readonly quote: {
    readonly id: string
    readonly tenantId: string
    readonly vehicleId: string
    readonly serviceStart: string
    readonly serviceEnd: string
    readonly validUntil: string
    readonly remainingCapacityKg: number
    readonly incrementalMinutes: number
    readonly hash: string
  }
}): CurrentDecisionInputs {
  const proposal = input.result.proposal
  if (!proposal?.routeQuoteId || !proposal.workOrder) {
    throw new PalPreparationError('PAL_LIFECYCLE_BINDING_MISMATCH', input.runToken)
  }
  if (input.quote.tenantId !== input.scope.tenantId || proposal.routeQuoteId !== input.quote.id) {
    throw new PalPreparationError('PAL_LIFECYCLE_BINDING_MISMATCH', input.runToken)
  }
  const evidenceValidUntil = input.synthetic.evidenceValidUntil
  const validUntil = earliest([evidenceValidUntil, input.quote.validUntil])
  if (proposal.validUntil !== validUntil
    || proposal.workOrder.vehicleId !== input.quote.vehicleId
    || proposal.workOrder.serviceStart !== input.quote.serviceStart
    || proposal.workOrder.serviceEnd !== input.quote.serviceEnd) {
    throw new PalPreparationError('PAL_LIFECYCLE_BINDING_MISMATCH', input.runToken)
  }

  const proposalPayload = proposalBindingPayload(proposal)
  const contextBundlePayload = {
    id: input.synthetic.compiledContext.bundle.id,
    tenantId: input.scope.tenantId,
    version: input.synthetic.compiledContext.bundle.version,
    programVersion: input.synthetic.compiledContext.bundle.programVersion,
    policyVersion: input.synthetic.compiledContext.bundle.policyVersion,
    mappingVersion: input.synthetic.compiledContext.bundle.mappingVersion,
    skillVersions: { ...input.synthetic.compiledContext.bundle.skillVersions },
    compiledAt: input.synthetic.compiledContext.bundle.compiledAt,
    bundleHash: input.synthetic.compiledContext.bundle.hash,
    modelContextEnvelopeDigest: input.result.modelContextEnvelope.digest,
  }
  const evidencePacketUnsigned = {
    tenantId: input.scope.tenantId,
    caseId: input.scope.caseId,
    validUntil: evidenceValidUntil,
    // This is a source fact, not a proposal validity boundary. Persist it in
    // the evidence packet so the operator presentation keeps the same service
    // deadline across session and process restarts.
    recoveryDeadline: input.synthetic.serviceWindowEndsAt,
    includedEvidence: input.result.modelContextEnvelope.includedEvidence.map((item) => ({
      evidenceId: item.evidenceId,
      authority: item.authority ?? null,
      freshness: item.freshness ?? null,
    })),
    omittedEvidence: input.result.modelContextEnvelope.omittedEvidence.map((item) => ({
      evidenceId: item.evidenceId,
      reason: item.reason,
    })),
    conflicts: input.result.modelContextEnvelope.conflicts.map((conflict) => ({
      evidenceIds: [...conflict.evidenceIds],
      reason: conflict.reason,
    })),
    envelopeDigest: input.result.modelContextEnvelope.digest,
  }
  const evidenceSnapshotId = `ev_packet-${contentDigest(evidencePacketUnsigned).slice(0, 24)}`
  const evidencePacketPayload = {
    id: evidenceSnapshotId,
    revision: input.synthetic.evidenceRevision,
    ...evidencePacketUnsigned,
  }
  const routeQuotePayload = {
    id: input.quote.id,
    tenantId: input.scope.tenantId,
    caseId: input.scope.caseId,
    revision: input.synthetic.routeRevision,
    vehicleId: input.quote.vehicleId,
    serviceStart: input.quote.serviceStart,
    serviceEnd: input.quote.serviceEnd,
    validUntil: input.quote.validUntil,
    remainingCapacityKg: input.quote.remainingCapacityKg,
    incrementalMinutes: input.quote.incrementalMinutes,
    solverQuoteHash: input.quote.hash,
  }

  return {
    tenantId: input.scope.tenantId,
    caseId: input.scope.caseId,
    proposalId: proposal.id,
    evidenceSnapshotId,
    routeQuoteId: input.quote.id,
    proposalDigest: lifecycleDigest(proposalPayload),
    contextBundleHash: lifecycleDigest(contextBundlePayload),
    evidencePacketHash: lifecycleDigest(evidencePacketPayload),
    routeQuoteHash: lifecycleDigest(routeQuotePayload),
    evidenceRevision: input.synthetic.evidenceRevision,
    routeRevision: input.synthetic.routeRevision,
    vehicleId: input.quote.vehicleId,
    serviceStart: input.quote.serviceStart,
    serviceEnd: input.quote.serviceEnd,
    validUntil,
    revoked: false,
    proposalPayload,
    contextBundlePayload,
    evidencePacketPayload,
    routeQuotePayload,
  }
}

function retainRun(
  scope: RuntimeScope,
  preparedAt: Date,
  result: Awaited<ReturnType<typeof runBoundedPal>>,
): RetainedPalRun {
  return {
    tenantId: scope.tenantId,
    caseId: scope.caseId,
    runToken: result.agentRunTrace.runToken,
    preparedAt: preparedAt.toISOString(),
    trace: {
      runToken: result.agentRunTrace.runToken,
      outcome: result.outcome,
      stopCode: safeStopCode(result.outcome),
      runBudget: { ...result.agentRunTrace.runBudget },
      skillInvocations: result.agentRunTrace.skillInvocations.map((item) => ({
        skillId: item.skillId,
        status: item.status,
        receipt: item.receipt,
      })),
      providerRequestCount: result.agentRunTrace.providerMetering.length,
      reasoningTokens: result.reasoningTokens,
      estimatedCostUsd: result.estimatedCostUsd,
    },
    contextEnvelope: safeEnvelope(result.modelContextEnvelope),
    ...(result.proposal ? { proposal: safeModelProposal(result.proposal) } : {}),
  }
}

function safeEnvelope(envelope: Awaited<ReturnType<typeof runBoundedPal>>['modelContextEnvelope']): SafeContextEnvelope {
  return {
    includedEvidence: envelope.includedEvidence.map((item) => ({
      evidenceId: item.evidenceId,
      reason: item.reason,
      ...(item.authority ? { authority: item.authority } : {}),
      ...(item.freshness ? { freshness: item.freshness } : {}),
    })),
    omittedEvidence: envelope.omittedEvidence.map((item) => ({
      evidenceId: item.evidenceId,
      reason: item.reason,
      ...(item.authority ? { authority: item.authority } : {}),
      ...(item.freshness ? { freshness: item.freshness } : {}),
    })),
    conflicts: envelope.conflicts.map((conflict) => ({
      evidenceIds: [...conflict.evidenceIds],
      reason: conflict.reason,
    })),
    tokenEstimate: envelope.tokenEstimate,
    tokenBudget: envelope.tokenBudget,
    versions: {
      program: envelope.versions.program,
      contextBundle: envelope.versions.contextBundle,
      skills: { ...envelope.versions.skills },
    },
    digest: envelope.digest,
  }
}

function proposalBindingPayload(proposal: NonNullable<Awaited<ReturnType<typeof runBoundedPal>>['proposal']>): ProposalBindingPayload {
  if (!proposal.routeQuoteId || !proposal.workOrder || proposal.outcome !== 'prepare_recovery') {
    throw new Error('PAL_PROPOSAL_NOT_EXECUTABLE')
  }
  return ProposalBindingPayloadSchema.parse({
    id: proposal.id,
    tenantId: proposal.tenantId,
    caseId: proposal.caseId,
    outcome: proposal.outcome,
    factualClaims: proposal.factualClaims.map((claim) => ({ text: claim.text, evidenceIds: [...claim.evidenceIds] })),
    routeQuoteId: proposal.routeQuoteId,
    workOrder: {
      vehicleId: proposal.workOrder.vehicleId,
      serviceStart: proposal.workOrder.serviceStart,
      serviceEnd: proposal.workOrder.serviceEnd,
    },
    validUntil: proposal.validUntil,
    modelProposalDigest: proposal.digest,
  })
}

function safeModelProposal(proposal: NonNullable<Awaited<ReturnType<typeof runBoundedPal>>['proposal']>): SafeModelProposal {
  return modelProposalFromBindingPayload(proposalBindingPayload(proposal))
}

function modelProposalFromBindingPayload(payload: ProposalBindingPayload): SafeModelProposal {
  return {
    id: payload.id,
    tenantId: payload.tenantId,
    caseId: payload.caseId,
    outcome: payload.outcome,
    factualClaims: payload.factualClaims.map((claim) => ({ text: claim.text, evidenceIds: [...claim.evidenceIds] })),
    routeQuoteId: payload.routeQuoteId,
    workOrder: {
      vehicleId: payload.workOrder.vehicleId,
      serviceStart: payload.workOrder.serviceStart,
      serviceEnd: payload.workOrder.serviceEnd,
    },
    validUntil: payload.validUntil,
    modelProposalDigest: payload.modelProposalDigest,
  }
}

/**
 * Converts the durable proposal record into the only review representation the
 * API exposes. The client can independently hash `approvalBinding.payload` and
 * compare it with the approval's `proposalDigest`.
 */
export function safeProposalFromBinding(input: Readonly<{ payload: unknown; digest: string }>): SafePalProposal {
  const payload = ProposalBindingPayloadSchema.parse(input.payload)
  const digest = z.string().regex(/^[a-f0-9]{64}$/).parse(input.digest)
  if (lifecycleDigest(payload) !== digest) throw new Error('PAL_PROPOSAL_BINDING_DIGEST_MISMATCH')
  return {
    ...modelProposalFromBindingPayload(payload),
    approvalBinding: {
      payload: structuredClone(payload),
      digest,
    },
  }
}

function safeStopCode(outcome: Awaited<ReturnType<typeof runBoundedPal>>['outcome']): SafeStopCode {
  if (outcome === 'prepare_recovery') return 'proposal_validated'
  if (outcome === 'hold_for_confirmation') return 'human_confirmation_required'
  return 'safe_recovery_not_prepared'
}

function normalizeScope(input: RuntimeScope): RuntimeScope {
  const accessStatus = input.operatorAccessStatus
  if (accessStatus !== undefined && accessStatus !== 'confirmed_clear' && accessStatus !== 'blocked' && accessStatus !== 'unknown') {
    throw new Error('PAL_OPERATOR_ACCESS_STATUS_INVALID')
  }
  return {
    tenantId: TenantIdSchema.parse(input.tenantId),
    caseId: CaseIdSchema.parse(input.caseId),
    ...(accessStatus ? { operatorAccessStatus: accessStatus } : {}),
  }
}

function assertSyntheticScope(source: SyntheticRecordedRecoveryCase, scope: RuntimeScope): void {
  if (source.scope.tenantId !== scope.tenantId || source.scope.caseId !== scope.caseId
    || source.compiledContext.bundle.tenantId !== scope.tenantId) {
    throw new Error('PAL_SYNTHETIC_SCOPE_MISMATCH')
  }
}

function currentTime(clock: Clock): Date {
  const now = clock.now()
  if (!Number.isFinite(now.valueOf())) throw new Error('PAL_CLOCK_INVALID')
  return new Date(Math.floor(now.valueOf() / 1_000) * 1_000)
}

function runKey(scope: RuntimeScope, runToken: string): string {
  return contentDigest({ tenantId: scope.tenantId, caseId: scope.caseId, runToken })
}

function scopeKey(scope: RuntimeScope): string {
  return `${scope.tenantId}:${scope.caseId}`
}

/**
 * A provider can propose content but never choose the durable proposal key.
 * Replacing the ID before the policy host validates the proposal prevents a
 * syntactically valid provider ID from becoming an identifier or redaction
 * channel on the lifecycle surface.
 */
function createHostBoundSkillHost(delegate: PalSkillHost): PalSkillHost {
  return {
    async execute(input) {
      if (input.skillId !== 'submit_typed_proposal') return await delegate.execute(input)
      const proposal = hostBoundProposal(input.payload.proposal)
      return await delegate.execute({
        ...input,
        payload: { ...input.payload, proposal },
      })
    },
  }
}

function hostBoundProposal(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
  try {
    const parsed = RecoveryProposalSchema.parse({
      ...(candidate as Record<string, unknown>),
      id: 'proposal_host',
      digest: '0'.repeat(64),
    })
    const { id: _modelId, digest: _modelDigest, ...unsigned } = parsed
    const id = `proposal_${contentDigest({ proposal: unsigned }).slice(0, 24)}`
    const hostProposal = { ...unsigned, id }
    return { ...hostProposal, digest: contentDigest(hostProposal) }
  } catch {
    // Let the policy host classify malformed proposal content through its
    // ordinary typed validation path; no provider value is retained here.
    return candidate
  }
}

function call(skillId: string, input: Record<string, unknown> = {}): { type: 'call_skill'; skillId: string; input: Record<string, unknown> } {
  return { type: 'call_skill', skillId, input }
}

function stop(outcome: 'hold_for_confirmation' | 'escalate', reason: string): { type: 'stop'; outcome: 'hold_for_confirmation' | 'escalate'; reason: string } {
  return { type: 'stop', outcome, reason }
}

function earliest(values: readonly string[]): string {
  const first = values[0]
  if (!first) throw new Error('PAL_VALIDITY_BOUNDARY_MISSING')
  return values.reduce((candidate, value) => Date.parse(value) < Date.parse(candidate) ? value : candidate, first)
}
