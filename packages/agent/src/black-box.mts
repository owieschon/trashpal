import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  ProgramDefinitionSchema,
  RecoveryProposalSchema,
  RouteQuoteSchema,
  RunBudgetSchema,
  contentDigest,
  recoveryProgramDefinition,
  recoverySkillDefinitions,
} from '@trashpal/contracts'
import { compileStaticContext, recordedSalesforceFieldMapping } from '@trashpal/context'
import { z } from 'zod'
import {
  createLocalProviderAdapter,
  runBoundedPal,
  type PalReasoner,
  type PalReasoningView,
} from './harness.js'
import {
  canonicalEvidenceClaim,
  createRecoverySkillHost,
  type CandidateEvidenceDescriptor,
  type RecoveryContextSource,
  type RecoveryRoutePlannerPort,
  type RecoverySkillId,
} from './skills.js'

const LoopbackBaseUrlSchema = z.string().url().refine((value) => {
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(value)) return false
  const url = new URL(value)
  return url.username === '' && url.password === ''
}, 'skill transport must use a literal loopback host')

const InputSchema = z.object({
  schemaVersion: z.literal('1.0'),
  variant: z.enum([
    'deterministic_template',
    'deterministic_investigator',
    'uncurated_one_shot_fixture',
    'curated_one_shot_fixture',
    'bounded_fixture_pal',
  ]),
  trigger: z.object({
    tenantId: z.string().min(1),
    caseId: z.string().min(1),
    programId: z.string().min(1),
    issueClass: z.string().min(1),
  }),
  budget: RunBudgetSchema,
  skillTransport: z.object({
    baseUrl: LoopbackBaseUrlSchema,
    runToken: z.string().min(1),
  }).optional(),
  oneShotContext: z.unknown().optional(),
})

type Input = z.infer<typeof InputSchema>
type EvidenceRecord = Record<string, unknown> & {
  evidenceId?: string
  authority?: string
  freshness?: string
  observedAt?: string
  validFrom?: string
  validUntil?: string
}

function legacyDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export type BlackBoxSkillInvoker = (
  input: Input,
  skillId: RecoverySkillId,
  payload?: Record<string, unknown>,
) => Promise<{ result: unknown; receipt: string; status: number }>

const invoke: BlackBoxSkillInvoker = async (input, skillId, payload = {}) => {
  const transport = input.skillTransport
  if (!transport) throw new Error(`variant ${input.variant} has no skill transport`)
  const response = await fetch(`${transport.baseUrl}/${skillId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: input.trigger.tenantId, caseId: input.trigger.caseId, ...payload }),
  })
  const body = z.object({ result: z.unknown(), receipt: z.string().length(64) }).parse(await response.json())
  return { result: body.result, receipt: body.receipt, status: response.status }
}

class FixtureWorkflowReasoner implements PalReasoner {
  async decide(view: PalReasoningView) {
    const completed = new Set(view.staticContext.completedSkills)
    let action
    if (!completed.has('inspect_service_exception')) action = call('inspect_service_exception')
    else if (!completed.has('get_customer_commitments')) action = call('get_customer_commitments')
    else {
      const agreement = view.evidence.find((item) => item.authority === 'agreement')
      if (!agreement) action = stop('A current service agreement is required.')
      else if (!completed.has('get_access_evidence')) action = call('get_access_evidence')
      else if (!completed.has('get_field_attempt')) action = call('get_field_attempt')
      else if (view.envelope.conflicts.length > 0) action = stop('Access evidence conflicts and requires confirmation.')
      else if (!completed.has('quote_recovery_options')) action = call('quote_recovery_options')
      else {
        const quote = view.evidence.find((item) => item.authority === 'derived')
        if (!quote) action = stop('No feasible recovery quote is available.', 'escalate')
        else {
          const factualClaims = [...view.evidence]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(canonicalEvidenceClaim)
          const validUntil = view.evidence
            .map((item) => String(item.content.validUntil))
            .reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest)
          const unsigned = {
            id: 'proposal-oracle-recovery',
            tenantId: view.staticContext.trigger.tenantId,
            caseId: view.staticContext.trigger.caseId,
            outcome: 'prepare_recovery' as const,
            factualClaims,
            routeQuoteId: String(quote.content.routeQuoteId),
            workOrder: {
              vehicleId: String(quote.content.vehicleId),
              serviceStart: String(quote.content.serviceStart),
              serviceEnd: String(quote.content.serviceEnd),
            },
            validUntil,
          }
          action = call('submit_typed_proposal', { proposal: { ...unsigned, digest: contentDigest(unsigned) } })
        }
      }
    }
    return action
  }
}

function call(skillId: RecoverySkillId, input: Record<string, unknown> = {}) {
  return { type: 'call_skill' as const, skillId, input }
}

function stop(reason: string, outcome: 'hold_for_confirmation' | 'escalate' = 'hold_for_confirmation') {
  return { type: 'stop' as const, outcome, reason }
}

function internalEvidenceId(rawId: string): string {
  return `ev-${createHash('sha256').update(rawId).digest('hex').slice(0, 12)}`
}

function normalizeEvidence(input: {
  raw: EvidenceRecord
  rawId: string
  tenantId: string
  caseId: string
  authority: 'agreement' | 'field_operation' | 'customer_report'
  classification: 'trusted' | 'untrusted_content'
  defaultObservedAt: string
  defaultValidUntil: string
  content?: Record<string, unknown>
}) {
  const content = {
    caseId: input.caseId,
    ...(input.content ?? input.raw),
    validUntil: input.raw.validUntil ?? input.defaultValidUntil,
  }
  return {
    id: internalEvidenceId(input.rawId),
    tenantId: input.tenantId,
    sourceId: input.rawId,
    observedAt: input.raw.observedAt ?? input.defaultObservedAt,
    authority: input.authority,
    classification: input.classification,
    freshness: input.raw.freshness === 'stale' ? 'stale' as const : 'fresh' as const,
    content,
    contentHash: contentDigest(content),
  }
}

async function productionInvestigate(input: Input, skillInvoker: BlackBoxSkillInvoker) {
  const internalTenantId = 'ten-oracle'
  const internalCaseId = `case-${createHash('sha256').update(input.trigger.caseId).digest('hex').slice(0, 12)}`
  const rawByInternalId = new Map<string, string>()
  const pendingReceipts = new Map<RecoverySkillId, { receipt: string; status: number }>()

  const remember = (rawId: string) => {
    const internalId = internalEvidenceId(rawId)
    rawByInternalId.set(internalId, rawId)
    return internalId
  }
  const remote = async (skillId: RecoverySkillId, payload: Record<string, unknown> = {}) => {
    const execution = await skillInvoker(input, skillId, payload)
    pendingReceipts.set(skillId, { receipt: execution.receipt, status: execution.status })
    return execution.result
  }

  const source: RecoveryContextSource = {
    inspectServiceException: async () => {
      const value = z.object({
        case: z.record(z.string(), z.unknown()),
        candidateEvidence: z.array(z.string()),
      }).parse(await remote('inspect_service_exception'))
      const rawCase = value.case as EvidenceRecord
      const rawCaseId = String(rawCase.evidenceId)
      remember(rawCaseId)
      const caseEvidence = normalizeEvidence({
        raw: rawCase,
        rawId: rawCaseId,
        tenantId: internalTenantId,
        caseId: internalCaseId,
        authority: 'customer_report',
        classification: 'untrusted_content',
        defaultObservedAt: '2026-07-21T13:20:00-05:00',
        defaultValidUntil: '2026-07-22T13:20:00-05:00',
        content: { siteId: rawCase.siteId, issue: rawCase.issue },
      })
      const decisive = value.candidateEvidence.filter((rawId) => !rawId.startsWith('noise-'))
      const irrelevant = value.candidateEvidence.filter((rawId) => rawId.startsWith('noise-'))
      const candidateEvidence: CandidateEvidenceDescriptor[] = decisive.map((rawId) => ({
        evidenceId: remember(rawId),
        reason: 'Not yet needed.',
      }))
      if (irrelevant[0]) {
        candidateEvidence.push({
          evidenceId: remember(irrelevant[0]),
          reason: `${irrelevant.length} irrelevant history records omitted; set ${legacyDigest(irrelevant).slice(0, 12)}.`,
        })
      }
      return { caseEvidence: caseEvidence as never, candidateEvidence, optionalEvidenceResidualCount: 0 }
    },
    getCustomerCommitments: async () => {
      const value = await remote('get_customer_commitments')
      if (value === null) return null
      const raw = z.record(z.string(), z.unknown()).parse(value) as EvidenceRecord
      const rawId = String(raw.evidenceId)
      remember(rawId)
      return normalizeEvidence({
        raw,
        rawId,
        tenantId: internalTenantId,
        caseId: internalCaseId,
        authority: 'agreement',
        classification: 'trusted',
        defaultObservedAt: '2026-07-21T13:15:00-05:00',
        defaultValidUntil: String(raw.recoveryDeadline ?? '2026-07-21T17:30:00-05:00'),
        content: { recoveryDeadline: raw.recoveryDeadline, stream: raw.stream },
      }) as never
    },
    getAccessEvidence: async () => {
      const values = z.array(z.record(z.string(), z.unknown())).parse(await remote('get_access_evidence')) as EvidenceRecord[]
      return values.map((raw) => {
        const rawId = String(raw.evidenceId)
        remember(rawId)
        const isField = raw.authority === 'field_operation'
        const normalizedRaw = {
          ...raw,
          validFrom: raw.validFrom ?? raw.observedAt ?? '2026-07-21T13:18:00-05:00',
          validUntil: raw.validUntil ?? '2026-07-21T16:00:00-05:00',
        }
        return normalizeEvidence({
          raw: normalizedRaw,
          rawId,
          tenantId: internalTenantId,
          caseId: internalCaseId,
          authority: isField ? 'field_operation' : 'customer_report',
          classification: isField ? 'trusted' : 'untrusted_content',
          defaultObservedAt: '2026-07-21T13:17:00-05:00',
          defaultValidUntil: '2026-07-21T16:00:00-05:00',
          content: {
            status: raw['status'],
            validFrom: normalizedRaw.validFrom,
            validUntil: normalizedRaw.validUntil,
          },
        })
      }) as never
    },
    getFieldAttempt: async () => {
      const raw = z.record(z.string(), z.unknown()).parse(await remote('get_field_attempt')) as EvidenceRecord
      const rawId = String(raw.evidenceId)
      remember(rawId)
      return normalizeEvidence({
        raw,
        rawId,
        tenantId: internalTenantId,
        caseId: internalCaseId,
        authority: 'field_operation',
        classification: 'trusted',
        defaultObservedAt: '2026-07-21T07:18:00-05:00',
        defaultValidUntil: '2026-07-22T07:18:00-05:00',
        content: { status: raw.status, reason: raw.reason },
      }) as never
    },
  }

  const planner: RecoveryRoutePlannerPort = {
    quoteRecovery: async () => {
      const raw = z.record(z.string(), z.unknown()).parse(await remote('quote_recovery_options')) as EvidenceRecord
      const rawId = String(raw.evidenceId)
      const internalId = `quote-${createHash('sha256').update(rawId).digest('hex').slice(0, 12)}`
      rawByInternalId.set(`ev-${internalId}`, rawId)
      const unsigned = {
        id: internalId,
        tenantId: internalTenantId,
        vehicleId: String(raw.vehicleId),
        serviceStart: String(raw.serviceStart),
        serviceEnd: String(raw.serviceEnd),
        validUntil: String(raw.validUntil),
        remainingCapacityKg: 0,
        incrementalMinutes: 0,
      }
      return { status: 'feasible', quote: RouteQuoteSchema.parse({ ...unsigned, hash: contentDigest(unsigned) }) }
    },
  }

  const compiledContext = compileStaticContext({
    tenantId: internalTenantId,
    compiledAt: '2026-07-21T13:00:00-05:00',
    sourceMapping: {
      id: 'recorded-salesforce-oracle',
      tenantId: internalTenantId,
      version: '1',
      status: 'confirmed',
      verifiedAt: '2026-07-21T12:00:00-05:00',
      validUntil: '2026-07-22T13:00:00-05:00',
      coverage: {
        requiredObjects: ['Case', 'Service_Agreement__c', 'CaseComment', 'Field_Service_Attempt__c'],
        observedObjects: ['Case', 'Service_Agreement__c', 'CaseComment', 'Field_Service_Attempt__c'],
        complete: true,
        truncated: false,
      },
      fields: recordedSalesforceFieldMapping,
    },
    policy: {
      id: 'dispatcher-approval-policy',
      version: '1',
      rules: ['A dispatcher must approve the exact cited recovery proposal.'],
    },
    program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
    skills: [...recoverySkillDefinitions],
  })
  const contextBundle = compiledContext.bundle
  const host = createRecoverySkillHost({
    source,
    routePlanner: planner,
    contextBundle,
    approvalPolicy: {
      action: 'dispatcher_approval_required',
      policyVersion: '1',
      validUntil: '2026-07-21T18:00:00-05:00',
    },
    externalReceipts: {
      resolve: async ({ skillId, payload }) => {
        if (skillId === 'submit_typed_proposal') {
          const proposal = RecoveryProposalSchema.parse(payload.proposal)
          await remote(skillId, {
            proposal: {
              outcome: proposal.outcome,
              vehicleId: proposal.workOrder?.vehicleId,
              serviceStart: proposal.workOrder?.serviceStart,
              serviceEnd: proposal.workOrder?.serviceEnd,
              routeQuoteEvidenceId: rawByInternalId.get(`ev-${proposal.routeQuoteId?.replaceAll('_', '-')}`),
              requiresHumanApproval: true,
            },
          })
        }
        const receipt = pendingReceipts.get(skillId)
        if (!receipt) throw new Error(`missing external receipt for ${skillId}`)
        pendingReceipts.delete(skillId)
        return receipt
      },
    },
  })
  const result = await runBoundedPal({
    trigger: { tenantId: internalTenantId, caseId: internalCaseId, programId: input.trigger.programId },
    program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
    contextBundle,
    budget: input.budget,
    provider: createLocalProviderAdapter(new FixtureWorkflowReasoner(), { requestIdPrefix: 'fixture-provider' }),
    skillHost: host,
    runToken: input.skillTransport!.runToken,
  })
  return legacyProjection(input, result, rawByInternalId)
}

function legacyProjection(
  input: Input,
  result: Awaited<ReturnType<typeof runBoundedPal>>,
  rawByInternalId: Map<string, string>,
) {
  const mapEvidenceId = (evidenceId: string) => rawByInternalId.get(evidenceId)
  const includedEvidence = result.modelContextEnvelope.includedEvidence.flatMap((item) => {
    const evidenceId = mapEvidenceId(item.evidenceId)
    return evidenceId ? [{ ...item, evidenceId }] : []
  })
  const omittedEvidence = result.modelContextEnvelope.omittedEvidence.flatMap((item) => {
    const evidenceId = mapEvidenceId(item.evidenceId)
    return evidenceId ? [{ ...item, evidenceId }] : item.evidenceId === 'omission-residual' ? [item] : []
  })
  const conflicts = result.modelContextEnvelope.conflicts.map((conflict) => ({
    ...conflict,
    evidenceIds: conflict.evidenceIds.flatMap((evidenceId) => {
      const raw = mapEvidenceId(evidenceId)
      return raw ? [raw] : []
    }),
  }))
  const envelopeUnsigned = {
    includedEvidence,
    omittedEvidence,
    conflicts,
    tokenEstimate: result.modelContextEnvelope.tokenEstimate,
    tokenBudget: result.modelContextEnvelope.tokenBudget,
    versions: result.modelContextEnvelope.versions,
  }
  const proposal = result.proposal
    ? {
        outcome: result.proposal.outcome,
        vehicleId: result.proposal.workOrder?.vehicleId,
        serviceStart: result.proposal.workOrder?.serviceStart,
        serviceEnd: result.proposal.workOrder?.serviceEnd,
        routeQuoteEvidenceId: rawByInternalId.get(`ev-${result.proposal.routeQuoteId?.replaceAll('_', '-')}`),
        requiresHumanApproval: true,
      }
    : undefined
  return {
    schemaVersion: '1.0' as const,
    outcome: result.outcome,
    agentRunTrace: {
      ...result.agentRunTrace,
      trigger: {
        tenantId: input.trigger.tenantId,
        caseId: input.trigger.caseId,
        programId: input.trigger.programId,
      },
    },
    modelContextEnvelope: { ...envelopeUnsigned, digest: legacyDigest(envelopeUnsigned) },
    ...(proposal ? { proposal } : {}),
    claims: includedEvidence.map((item) => ({ text: item.reason, evidenceIds: [item.evidenceId] })),
    estimatedCostUsd: result.estimatedCostUsd,
  }
}

function oneShot(input: Input) {
  const context = z.record(z.string(), z.unknown()).parse(input.oneShotContext)
  const commitments = context.commitments as EvidenceRecord | null | undefined
  const access = Array.isArray(context.accessEvidence) ? context.accessEvidence as EvidenceRecord[] : []
  const statuses = new Set(access.map((item) => item.status))
  const canPrepare = Boolean(commitments) && statuses.has('confirmed_clear') && !statuses.has('blocked')
  return {
    schemaVersion: '1.0',
    outcome: canPrepare ? 'prepare_recovery' : 'hold_for_confirmation',
    ...(canPrepare ? { proposal: { vehicleId: 'veh-v42', requiresHumanApproval: true } } : {}),
    modelContextEnvelope: {
      includedEvidence: [],
      omittedEvidence: [],
      conflicts: statuses.has('confirmed_clear') && statuses.has('blocked') ? [{ evidenceIds: [], reason: 'Access conflict.' }] : [],
      tokenEstimate: Math.ceil(JSON.stringify(context).length / 4),
      tokenBudget: input.budget.maxContextTokens,
      versions: { program: 'one-shot@1.0.0', contextBundle: 'fixture@1.0.0', skills: {} },
      digest: legacyDigest(context),
    },
    claims: [],
    estimatedCostUsd: 0,
  }
}

export async function runBlackBox(inputValue: unknown, options: { skillInvoker?: BlackBoxSkillInvoker } = {}) {
  const input = InputSchema.parse(inputValue)
  if (input.variant === 'deterministic_template') {
    return { schemaVersion: '1.0', outcome: 'hold_for_confirmation', claims: [], estimatedCostUsd: 0 }
  }
  if (input.variant === 'uncurated_one_shot_fixture' || input.variant === 'curated_one_shot_fixture') return oneShot(input)
  return await productionInvestigate(input, options.skillInvoker ?? invoke)
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return await runBlackBox(JSON.parse(raw))
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
