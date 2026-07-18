import {
  ContextBundleSchema,
  EvidenceItemSchema,
  RecoveryProposalSchema,
  RouteQuoteSchema,
  contentDigest,
  earliestValidityBoundary,
} from '@trashpal/contracts'
import { z } from 'zod'

type ContextBundle = z.infer<typeof ContextBundleSchema>
type EvidenceItem = z.infer<typeof EvidenceItemSchema>
type RecoveryProposal = z.infer<typeof RecoveryProposalSchema>
type RouteQuote = z.infer<typeof RouteQuoteSchema>
type MaybePromise<T> = T | Promise<T>

export const RecoverySkillIdSchema = z.enum([
  'inspect_service_exception',
  'get_customer_commitments',
  'get_access_evidence',
  'get_field_attempt',
  'quote_recovery_options',
  'submit_typed_proposal',
])

const ApprovalPolicyBindingSchema = z.object({
  action: z.literal('dispatcher_approval_required'),
  policyVersion: z.string().min(1),
  validUntil: z.iso.datetime({ offset: true }),
}).strict()

export type RecoverySkillId = z.infer<typeof RecoverySkillIdSchema>
export interface CaseScope { tenantId: string; caseId: string }
export interface CandidateEvidenceDescriptor { evidenceId: string; reason: string }

export interface RecoveryContextSource {
  inspectServiceException(scope: CaseScope, signal?: AbortSignal): MaybePromise<{
    caseEvidence: EvidenceItem
    candidateEvidence: CandidateEvidenceDescriptor[]
    optionalEvidenceResidualCount: number
  }>
  getCustomerCommitments(scope: CaseScope, signal?: AbortSignal): MaybePromise<EvidenceItem | null>
  getAccessEvidence(scope: CaseScope, signal?: AbortSignal): MaybePromise<EvidenceItem[]>
  getFieldAttempt(scope: CaseScope, signal?: AbortSignal): MaybePromise<EvidenceItem | null>
}

export interface RecoveryRoutePlannerPort {
  quoteRecovery(input: {
    tenantId: string
    caseId: string
    agreement: EvidenceItem
    accessEvidence: EvidenceItem[]
    fieldAttempt: EvidenceItem
    signal?: AbortSignal
  }): Promise<
    | { status: 'feasible'; quote: RouteQuote }
    | { status: 'infeasible'; reasons: string[] }
    | { status: 'unavailable'; retryable: boolean }
  >
}

export interface SkillHostState {
  evidence: Map<string, EvidenceItem>
  evidenceReasons: Map<string, string>
  requiredEvidenceIds: Set<string>
  candidateEvidence: Map<string, string>
  candidateInventoryResidual: number
  conflicts: Array<{ evidenceIds: string[]; reason: string }>
  completedSkills: Set<RecoverySkillId>
  routeQuote?: RouteQuote
  proposal?: RecoveryProposal
}

export interface SkillExecution {
  result: unknown
  receipt: string
  status: number
}

export interface ExternalExecutionReceiptPort {
  resolve(input: {
    skillId: RecoverySkillId
    scope: CaseScope
    payload: Record<string, unknown>
    localResult: unknown
    signal?: AbortSignal
  }): Promise<{ receipt: string; status: number }>
}

export class SkillPolicyError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: 'hold_for_confirmation' | 'escalate' = 'escalate',
  ) {
    super(code)
  }
}

export function canonicalEvidenceClaim(item: Pick<EvidenceItem, 'id'>): {
  text: string
  evidenceIds: [EvidenceItem['id']]
} {
  return {
    text: `Evidence ${item.id}.`,
    evidenceIds: [item.id],
  }
}

export function createEmptySkillState(): SkillHostState {
  return {
    evidence: new Map(),
    evidenceReasons: new Map(),
    requiredEvidenceIds: new Set(),
    candidateEvidence: new Map(),
    candidateInventoryResidual: 0,
    conflicts: [],
    completedSkills: new Set(),
  }
}

export function createRecoverySkillHost(rawInput: {
  source: RecoveryContextSource
  routePlanner: RecoveryRoutePlannerPort
  contextBundle: ContextBundle
  approvalPolicy: z.input<typeof ApprovalPolicyBindingSchema>
  externalReceipts?: ExternalExecutionReceiptPort
  clock?: { nowMs(): number }
}) {
  const contextBundle = ContextBundleSchema.parse(rawInput.contextBundle)
  const approvalPolicy = ApprovalPolicyBindingSchema.parse(rawInput.approvalPolicy)
  const clock = rawInput.clock ?? { nowMs: () => Date.now() }
  if (approvalPolicy.policyVersion !== contextBundle.policyVersion) throw new Error('APPROVAL_POLICY_VERSION_MISMATCH')

  async function execute(params: {
    skillId: RecoverySkillId
    scope: CaseScope
    payload: Record<string, unknown>
    state: SkillHostState
    signal?: AbortSignal
  }): Promise<SkillExecution> {
    const { skillId, scope, state, signal } = params
    if (scope.tenantId !== contextBundle.tenantId) throw new SkillPolicyError('TENANT_SCOPE_VIOLATION')
    if (state.completedSkills.has(skillId)) throw new SkillPolicyError('DUPLICATE_SKILL_CALL')
    if (signal?.aborted) throw new SkillPolicyError('SKILL_DEADLINE_EXCEEDED')
    let result: unknown

    switch (skillId) {
      case 'inspect_service_exception': {
        if (state.completedSkills.size > 0) throw new SkillPolicyError('INSPECTION_MUST_BE_FIRST')
        const inspection = await rawInput.source.inspectServiceException(scope, signal)
        addEvidence(state, inspection.caseEvidence, scope, 'Active service exception.')
        for (const candidate of inspection.candidateEvidence) {
          if (!state.evidence.has(candidate.evidenceId)) state.candidateEvidence.set(candidate.evidenceId, candidate.reason)
        }
        state.candidateInventoryResidual += inspection.optionalEvidenceResidualCount
        addEvidence(state, makePolicyEvidence(contextBundle, approvalPolicy, scope), scope, 'Dispatcher approval required.')
        result = inspection
        break
      }
      case 'get_customer_commitments': {
        requireSkill(state, 'inspect_service_exception')
        const agreement = await rawInput.source.getCustomerCommitments(scope, signal)
        if (agreement) addEvidence(state, agreement, scope, 'Current service commitment.')
        result = { agreement }
        break
      }
      case 'get_access_evidence': {
        requireSkill(state, 'get_customer_commitments')
        const accessEvidence = await rawInput.source.getAccessEvidence(scope, signal)
        for (const item of accessEvidence) addEvidence(state, item, scope, 'Current access observation.')
        state.conflicts.push(...findAccessConflicts(accessEvidence))
        result = { accessEvidence }
        break
      }
      case 'get_field_attempt': {
        requireSkill(state, 'get_access_evidence')
        const fieldAttempt = await rawInput.source.getFieldAttempt(scope, signal)
        if (fieldAttempt) addEvidence(state, fieldAttempt, scope, 'Latest field-service attempt.')
        result = { fieldAttempt }
        break
      }
      case 'quote_recovery_options': {
        requireSkill(state, 'get_field_attempt')
        assertRequiredEvidenceCurrent(state, clock.nowMs())
        if (state.conflicts.some((conflict) => conflict.evidenceIds.length > 0)) {
          throw new SkillPolicyError('UNRESOLVED_EVIDENCE_CONFLICT', 'hold_for_confirmation')
        }
        const agreement = [...state.evidence.values()].find((item) => item.authority === 'agreement')
        const accessEvidence = [...state.evidence.values()].filter((item) =>
          (item.authority === 'customer_report' || item.authority === 'field_operation')
          && typeof item.content.status === 'string'
          && typeof item.content.validFrom === 'string'
          && typeof item.content.validUntil === 'string',
        )
        const fieldAttempt = [...state.evidence.values()].find((item) =>
          item.authority === 'field_operation' && item.content.status === 'unable_to_complete',
        )
        if (!agreement || agreement.freshness !== 'fresh') {
          throw new SkillPolicyError('CURRENT_AGREEMENT_REQUIRED', 'hold_for_confirmation')
        }
        if (!fieldAttempt || fieldAttempt.freshness !== 'fresh') {
          throw new SkillPolicyError('CURRENT_FIELD_ATTEMPT_REQUIRED', 'hold_for_confirmation')
        }
        if (!accessEvidence.some((item) => item.freshness === 'fresh' && item.content.status === 'confirmed_clear')) {
          throw new SkillPolicyError('FRESH_ACCESS_CONFIRMATION_REQUIRED', 'hold_for_confirmation')
        }
        const quoteResult = await rawInput.routePlanner.quoteRecovery({
          tenantId: scope.tenantId,
          caseId: scope.caseId,
          agreement,
          accessEvidence,
          fieldAttempt,
          ...(signal ? { signal } : {}),
        })
        if (quoteResult.status !== 'feasible') {
          result = quoteResult
          break
        }
        state.routeQuote = validateRouteQuote(quoteResult.quote, scope)
        const quoteEvidence = evidenceItemFromQuote(state.routeQuote, scope)
        addEvidence(state, quoteEvidence, scope, 'Feasible recovery quote.')
        state.candidateEvidence.set(quoteEvidence.id, 'The quote was loaded after all deterministic prerequisites passed.')
        result = { status: 'feasible', quote: state.routeQuote, quoteEvidence }
        break
      }
      case 'submit_typed_proposal': {
        requireSkill(state, 'quote_recovery_options')
        assertRequiredEvidenceCurrent(state, clock.nowMs())
        if (hasForbiddenAuthority(params.payload)) throw new SkillPolicyError('UNAUTHORIZED_OPERATIONAL_AUTHORITY')
        const proposal = RecoveryProposalSchema.parse(params.payload.proposal)
        if (proposal.tenantId !== scope.tenantId || proposal.caseId !== scope.caseId) {
          throw new SkillPolicyError('PROPOSAL_SCOPE_MISMATCH')
        }
        if (proposal.digest !== proposalDigest(proposal)) throw new SkillPolicyError('PROPOSAL_DIGEST_MISMATCH')
        const citedIds = proposal.factualClaims.flatMap((claim) => claim.evidenceIds)
        if (citedIds.some((evidenceId) => !state.evidence.has(evidenceId))) {
          throw new SkillPolicyError('INVENTED_EVIDENCE_CITATION')
        }
        const expectedClaims = [...state.requiredEvidenceIds]
          .sort()
          .map((evidenceId) => canonicalEvidenceClaim(state.evidence.get(evidenceId)!))
        if (JSON.stringify(proposal.factualClaims) !== JSON.stringify(expectedClaims)) {
          throw new SkillPolicyError('NON_CANONICAL_EVIDENCE_CLAIMS')
        }
        if (proposal.outcome !== 'prepare_recovery' || !state.routeQuote || !proposal.workOrder) {
          throw new SkillPolicyError('PREPARE_PROPOSAL_REQUIRED')
        }
        if (proposal.routeQuoteId !== state.routeQuote.id
          || proposal.workOrder.vehicleId !== state.routeQuote.vehicleId
          || proposal.workOrder.serviceStart !== state.routeQuote.serviceStart
          || proposal.workOrder.serviceEnd !== state.routeQuote.serviceEnd) {
          throw new SkillPolicyError('PROPOSAL_QUOTE_MISMATCH')
        }
        const requiredItems = [...state.requiredEvidenceIds].map((evidenceId) => state.evidence.get(evidenceId)!)
        const expectedValidUntil = earliestValidityBoundary(requiredItems.map(validityBoundary))
        if (Date.parse(expectedValidUntil) <= clock.nowMs()) {
          throw new SkillPolicyError('REQUIRED_EVIDENCE_EXPIRED', 'hold_for_confirmation')
        }
        if (proposal.validUntil !== expectedValidUntil) throw new SkillPolicyError('PROPOSAL_VALIDITY_BOUNDARY_MISMATCH')
        state.proposal = proposal
        result = {
          accepted: true,
          proposalDigest: proposal.digest,
          approvalAction: approvalPolicy.action,
          policyVersion: approvalPolicy.policyVersion,
        }
        break
      }
    }
    state.completedSkills.add(skillId)
    if (rawInput.externalReceipts) {
      const external = await rawInput.externalReceipts.resolve({
        skillId,
        scope,
        payload: params.payload,
        localResult: result,
        ...(signal ? { signal } : {}),
      })
      return { result, receipt: z.string().regex(/^[a-f0-9]{64}$/).parse(external.receipt), status: external.status }
    }
    return { result, receipt: contentDigest({ skillId, scope, result }), status: 200 }
  }

  return { execute }
}

function addEvidence(
  state: SkillHostState,
  itemInput: EvidenceItem,
  scope: CaseScope,
  reason: string,
  required = true,
): void {
  const item = validateEvidenceItem(itemInput, scope)
  state.evidence.set(item.id, item)
  state.evidenceReasons.set(item.id, reason)
  state.candidateEvidence.delete(item.id)
  if (required) state.requiredEvidenceIds.add(item.id)
}

function validateEvidenceItem(input: EvidenceItem, scope: CaseScope): EvidenceItem {
  const item = EvidenceItemSchema.parse(input)
  if (item.tenantId !== scope.tenantId) throw new SkillPolicyError('CROSS_TENANT_EVIDENCE')
  if (item.content.caseId !== scope.caseId) throw new SkillPolicyError('CROSS_CASE_EVIDENCE')
  if (item.contentHash !== contentDigest(item.content)) throw new SkillPolicyError('EVIDENCE_HASH_MISMATCH')
  return item
}

function validateRouteQuote(input: RouteQuote, scope: CaseScope): RouteQuote {
  const quote = RouteQuoteSchema.parse(input)
  if (quote.tenantId !== scope.tenantId) throw new SkillPolicyError('CROSS_TENANT_ROUTE_QUOTE')
  const { hash: _hash, ...unsigned } = quote
  if (quote.hash !== contentDigest(unsigned)) throw new SkillPolicyError('ROUTE_QUOTE_HASH_MISMATCH')
  return quote
}

function findAccessConflicts(items: EvidenceItem[]): Array<{ evidenceIds: string[]; reason: string }> {
  const fresh = items.filter((item) => item.freshness === 'fresh')
  const conflicts: Array<{ evidenceIds: string[]; reason: string }> = []
  for (let leftIndex = 0; leftIndex < fresh.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < fresh.length; rightIndex += 1) {
      const left = fresh[leftIndex]!
      const right = fresh[rightIndex]!
      if (left.authority === right.authority || left.content.status === right.content.status) continue
      if (!intervalsOverlap(left.content.validFrom, left.content.validUntil, right.content.validFrom, right.content.validUntil)) continue
      conflicts.push({
        evidenceIds: [left.id, right.id],
        reason: 'Fresh cross-authority access observations disagree over an overlapping validity window.',
      })
    }
  }
  return conflicts
}

function intervalsOverlap(leftFrom: unknown, leftUntil: unknown, rightFrom: unknown, rightUntil: unknown): boolean {
  if (![leftFrom, leftUntil, rightFrom, rightUntil].every((value) => typeof value === 'string')) return false
  return Date.parse(leftFrom as string) < Date.parse(rightUntil as string)
    && Date.parse(rightFrom as string) < Date.parse(leftUntil as string)
}

function hasForbiddenAuthority(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenAuthority)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) =>
    /^(credit|dispatch|execute|assignment|approve|authorization|certainty)$/i.test(key) || hasForbiddenAuthority(child),
  )
}

function proposalDigest(proposal: RecoveryProposal): string {
  const { digest: _digest, ...unsigned } = proposal
  return contentDigest(unsigned)
}

function requireSkill(state: SkillHostState, skillId: RecoverySkillId): void {
  if (!state.completedSkills.has(skillId)) throw new SkillPolicyError(`SKILL_PREREQUISITE_MISSING:${skillId}`)
}

function validityBoundary(item: EvidenceItem): string {
  const value = item.content.validUntil
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new SkillPolicyError('EVIDENCE_VALIDITY_BOUNDARY_MISSING')
  return value
}

function assertRequiredEvidenceCurrent(state: SkillHostState, nowMs: number): void {
  const requiredItems = [...state.requiredEvidenceIds].map((evidenceId) => state.evidence.get(evidenceId)!)
  if (requiredItems.some((item) => item.freshness !== 'fresh')) {
    throw new SkillPolicyError('STALE_REQUIRED_EVIDENCE', 'hold_for_confirmation')
  }
  const earliest = earliestValidityBoundary(requiredItems.map(validityBoundary))
  if (Date.parse(earliest) <= nowMs) {
    throw new SkillPolicyError('REQUIRED_EVIDENCE_EXPIRED', 'hold_for_confirmation')
  }
}

function makePolicyEvidence(
  contextBundle: ContextBundle,
  policy: z.infer<typeof ApprovalPolicyBindingSchema>,
  scope: CaseScope,
): EvidenceItem {
  const content = {
    caseId: scope.caseId,
    action: policy.action,
    policyVersion: policy.policyVersion,
    validUntil: policy.validUntil,
  }
  return EvidenceItemSchema.parse({
    id: `ev-policy-${contentDigest(content).slice(0, 20)}`,
    tenantId: scope.tenantId,
    sourceId: `${contextBundle.id}:${policy.policyVersion}`,
    observedAt: contextBundle.compiledAt,
    authority: 'policy',
    classification: 'trusted',
    freshness: 'fresh',
    content,
    contentHash: contentDigest(content),
  })
}

function evidenceItemFromQuote(quote: RouteQuote, scope: CaseScope): EvidenceItem {
  const content = {
    caseId: scope.caseId,
    routeQuoteId: quote.id,
    vehicleId: quote.vehicleId,
    serviceStart: quote.serviceStart,
    serviceEnd: quote.serviceEnd,
    validUntil: quote.validUntil,
    remainingCapacityKg: quote.remainingCapacityKg,
    incrementalMinutes: quote.incrementalMinutes,
  }
  return EvidenceItemSchema.parse({
    id: `ev-${quote.id.replaceAll('_', '-')}`,
    tenantId: scope.tenantId,
    sourceId: quote.id,
    observedAt: quote.serviceStart,
    authority: 'derived',
    classification: 'derived',
    freshness: 'fresh',
    content,
    contentHash: contentDigest(content),
  })
}
