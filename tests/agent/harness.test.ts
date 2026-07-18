import { describe, expect, it, vi } from 'vitest'
import {
  ProgramDefinitionSchema,
  RouteQuoteSchema,
  contentDigest,
  recoveryProgramDefinition,
} from '../../packages/contracts/src/index.js'
import { RecordedSalesforceContextSource } from '../../packages/context/src/index.js'
import {
  canonicalEvidenceClaim,
  createLocalProviderAdapter,
  createRecoverySkillHost,
  runBoundedPal,
  type PalProviderAdapter,
  type PalReasoner,
  type PalReasoningView,
  type PalSkillHost,
  type RecoveryContextSource,
} from '../../packages/agent/src/index.js'
import {
  compileTestContext,
  fixedNow,
  makeMapping,
  makeRouteQuote,
  makeSnapshot,
  makeSource,
} from '../context/fixtures.js'

const defaultBudget = {
  maxSkillCalls: 6,
  maxContextTokens: 8_000,
  maxLatencyMs: 30_000,
  maxEstimatedCostUsd: 0.1,
}

function metering(providerRequestId: string, inputTokens = 8, outputTokens = 4) {
  return { providerRequestId, inputTokens, outputTokens }
}

function call(skillId: string, input: Record<string, unknown> = {}) {
  return { type: 'call_skill' as const, skillId, input }
}

function stop(outcome: 'hold_for_confirmation' | 'escalate', reason: string) {
  return { type: 'stop' as const, outcome, reason }
}

class RecoveryWorkflowReasoner implements PalReasoner {
  async decide(view: PalReasoningView) {
    const completed = new Set(view.staticContext.completedSkills)
    let action
    if (!completed.has('inspect_service_exception')) action = call('inspect_service_exception')
    else if (!completed.has('get_customer_commitments')) action = call('get_customer_commitments')
    else {
      const agreement = view.evidence.find((item) => item.authority === 'agreement')
      if (!agreement || agreement.freshness !== 'fresh') action = stop('hold_for_confirmation', 'A current agreement is required.')
      else if (!completed.has('get_access_evidence')) action = call('get_access_evidence')
      else if (!completed.has('get_field_attempt')) action = call('get_field_attempt')
      else if (view.envelope.conflicts.length > 0) action = stop('hold_for_confirmation', 'Access evidence conflicts.')
      else {
        const access = view.evidence.filter((item) => item.content.status === 'confirmed_clear')
        if (!access.some((item) => item.freshness === 'fresh')) {
          action = stop('hold_for_confirmation', 'Fresh access confirmation is required.')
        } else if (!completed.has('quote_recovery_options')) action = call('quote_recovery_options')
        else {
          const quoteEvidence = view.evidence.find((item) => item.authority === 'derived')
          if (!quoteEvidence) action = stop('escalate', 'No feasible route quote is available.')
          else if (!completed.has('submit_typed_proposal')) {
            const claims = [...view.evidence].sort((left, right) => left.id.localeCompare(right.id)).map(canonicalEvidenceClaim)
            const validUntil = view.evidence
              .map((item) => String(item.content.validUntil))
              .reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest)
            const unsigned = {
              id: 'proposal_recovery-1',
              tenantId: view.staticContext.trigger.tenantId,
              caseId: view.staticContext.trigger.caseId,
              outcome: 'prepare_recovery' as const,
              factualClaims: claims,
              routeQuoteId: String(quoteEvidence.content.routeQuoteId),
              workOrder: {
                vehicleId: String(quoteEvidence.content.vehicleId),
                serviceStart: String(quoteEvidence.content.serviceStart),
                serviceEnd: String(quoteEvidence.content.serviceEnd),
              },
              validUntil,
            }
            action = call('submit_typed_proposal', { proposal: { ...unsigned, digest: contentDigest(unsigned) } })
          } else action = stop('escalate', 'Proposal submission did not terminate the run.')
        }
      }
    }
    return action
  }
}

function makePlanner(quote = makeRouteQuote()) {
  return { quoteRecovery: vi.fn(async () => ({ status: 'feasible' as const, quote })) }
}

async function execute(input: {
  source?: RecoveryContextSource
  reasoner?: PalReasoner
  provider?: PalProviderAdapter
  budget?: typeof defaultBudget
  clock?: { nowMs(): number }
  pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number }
  planner?: ReturnType<typeof makePlanner>
  skillHost?: PalSkillHost
} = {}) {
  const compiled = compileTestContext()
  const planner = input.planner ?? makePlanner()
  const source = input.source ?? makeSource()
  const skillHost = input.skillHost ?? createRecoverySkillHost({
    source,
    routePlanner: planner,
    contextBundle: compiled.bundle,
    approvalPolicy: {
      action: 'dispatcher_approval_required',
      policyVersion: compiled.bundle.policyVersion,
      validUntil: '2026-07-21T18:00:00-05:00',
    },
    ...(input.clock ? { clock: input.clock } : { clock: { nowMs: () => Date.parse(fixedNow) } }),
  })
  const result = await runBoundedPal({
    trigger: { tenantId: 'ten_harborworks', caseId: 'case_0881', programId: 'resolve-commercial-service-exception' },
    program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
    contextBundle: compiled.bundle,
    budget: input.budget ?? defaultBudget,
    provider: input.provider ?? createLocalProviderAdapter(input.reasoner ?? new RecoveryWorkflowReasoner(), {
      requestIdPrefix: 'fixture-provider',
    }),
    skillHost,
    runToken: 'run-recovery-1',
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.pricing ? { pricing: input.pricing } : {}),
  })
  return { result, planner }
}

function wrapSource(overrides: Partial<RecoveryContextSource>): RecoveryContextSource {
  const source = makeSource()
  return {
    inspectServiceException: overrides.inspectServiceException ?? ((scope, signal) => source.inspectServiceException(scope, signal)),
    getCustomerCommitments: overrides.getCustomerCommitments ?? ((scope, signal) => source.getCustomerCommitments(scope, signal)),
    getAccessEvidence: overrides.getAccessEvidence ?? ((scope, signal) => source.getAccessEvidence(scope, signal)),
    getFieldAttempt: overrides.getFieldAttempt ?? ((scope, signal) => source.getFieldAttempt(scope, signal)),
  }
}

describe('bounded Pal recovery harness', () => {
  it('composes snapshot-transport output through context normalization into the bounded run', async () => {
    const snapshotTransport = {
      loadSnapshot: vi.fn(async () => ({ mapping: makeMapping(), snapshot: makeSnapshot() })),
    }
    const loaded = await snapshotTransport.loadSnapshot()
    const source = new RecordedSalesforceContextSource({ ...loaded, now: fixedNow })
    const { result } = await execute({ source })

    expect(snapshotTransport.loadSnapshot).toHaveBeenCalledOnce()
    expect(result.outcome).toBe('prepare_recovery')
    expect(result.agentRunTrace.skillInvocations).toHaveLength(6)
  })

  it('investigates hostile customer content and submits an exact, policy-bound, canonical proposal', async () => {
    const { result, planner } = await execute()
    expect(result.outcome).toBe('prepare_recovery')
    expect(result.agentRunTrace.skillInvocations.map((item) => item.skillId)).toEqual([
      'inspect_service_exception', 'get_customer_commitments', 'get_access_evidence',
      'get_field_attempt', 'quote_recovery_options', 'submit_typed_proposal',
    ])
    expect(result.proposal?.workOrder?.vehicleId).toBe('veh_v42')
    expect(result.proposal?.validUntil).toBe('2026-07-21T14:00:00-05:00')
    expect(result.proposal?.factualClaims).toContainEqual(expect.objectContaining({ text: expect.stringContaining('policy') }))
    expect(result.modelContextEnvelope.omittedEvidence).toContainEqual(expect.objectContaining({ evidenceId: 'ev-noise-0' }))
    expect(result.agentRunTrace.providerMetering).toHaveLength(6)
    expect(planner.quoteRecovery).toHaveBeenCalledOnce()
  })

  it('stops at the minimal point when the agreement is missing or stale', async () => {
    const missingSnapshot = makeSnapshot()
    missingSnapshot.records.serviceAgreements = []
    const missing = new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot: missingSnapshot, now: fixedNow })
    const missingRun = await execute({ source: missing })
    expect(missingRun.result.outcome).toBe('hold_for_confirmation')
    expect(missingRun.result.agentRunTrace.skillInvocations).toHaveLength(2)

    const staleSnapshot = makeSnapshot()
    staleSnapshot.records.serviceAgreements[0]!.Valid_Through__c = '2026-07-21T13:19:59-05:00'
    const stale = new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot: staleSnapshot, now: fixedNow })
    const staleRun = await execute({ source: stale })
    expect(staleRun.result.outcome).toBe('hold_for_confirmation')
    expect(staleRun.planner.quoteRecovery).not.toHaveBeenCalled()
  })

  it('blocks routing when any required evidence is stale or no longer valid at the host clock', async () => {
    const base = makeSource()
    const staleCase = wrapSource({
      inspectServiceException: (scope) => {
        const inspection = base.inspectServiceException(scope)
        return { ...inspection, caseEvidence: { ...inspection.caseEvidence, freshness: 'stale' } }
      },
    })
    const staleRun = await execute({ source: staleCase })
    expect(staleRun.result.stoppedReason).toBe('STALE_REQUIRED_EVIDENCE')
    expect(staleRun.planner.quoteRecovery).not.toHaveBeenCalled()

    const expiredCase = wrapSource({
      inspectServiceException: (scope) => {
        const inspection = base.inspectServiceException(scope)
        const content = { ...inspection.caseEvidence.content, validUntil: fixedNow }
        return {
          ...inspection,
          caseEvidence: { ...inspection.caseEvidence, content, contentHash: contentDigest(content) },
        }
      },
    })
    const expiredRun = await execute({ source: expiredCase })
    expect(expiredRun.result.stoppedReason).toBe('REQUIRED_EVIDENCE_EXPIRED')
    expect(expiredRun.planner.quoteRecovery).not.toHaveBeenCalled()
  })

  it('detects C09 as an overlapping fresh cross-authority access conflict', async () => {
    const snapshot = makeSnapshot()
    Object.assign(snapshot.records.fieldAttempts[0]!, {
      Access_Status__c: 'blocked' as const,
      Access_Valid_From__c: '2026-07-21T13:18:00-05:00',
      Access_Valid_Until__c: '2026-07-21T15:00:00-05:00',
    })
    const source = new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot, now: fixedNow })
    const { result, planner } = await execute({ source })
    expect(result.outcome).toBe('hold_for_confirmation')
    expect(result.modelContextEnvelope.conflicts[0]?.evidenceIds).toEqual(['ev-access-1317', 'ev-attempt-0718-access'])
    const conflicting = result.modelContextEnvelope.includedEvidence
      .filter((item) => result.modelContextEnvelope.conflicts[0]?.evidenceIds.includes(item.evidenceId))
    expect(new Set(conflicting.map((item) => item.authority))).toEqual(new Set(['customer_report', 'field_operation']))
    expect(planner.quoteRecovery).not.toHaveBeenCalled()
  })

  it('does not report a conflict for non-overlapping access observations', async () => {
    const snapshot = makeSnapshot()
    Object.assign(snapshot.records.fieldAttempts[0]!, {
      Access_Status__c: 'blocked' as const,
      Access_Valid_From__c: '2026-07-21T12:00:00-05:00',
      Access_Valid_Until__c: '2026-07-21T13:00:00-05:00',
    })
    const source = new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot, now: fixedNow })
    const { result } = await execute({ source })
    expect(result.modelContextEnvelope.conflicts).toEqual([])
  })

  it('rejects out-of-order, arbitrary, and direct-dispatch actions before execution', async () => {
    const outOfOrder: PalReasoner = { decide: async () => call('quote_recovery_options') }
    expect((await execute({ reasoner: outOfOrder })).result.stoppedReason).toBe('SKILL_PREREQUISITE_MISSING:get_field_attempt')

    const arbitrary: PalReasoner = { decide: async () => call('read_all_accounts') }
    expect((await execute({ reasoner: arbitrary })).result.stoppedReason).toBe('SKILL_NOT_ALLOWED')

    const direct: PalReasoner = { decide: async () => ({ type: 'dispatch_assignment', vehicleId: 'veh_v17' }) }
    const directRun = await execute({ reasoner: direct })
    expect(directRun.result.stoppedReason).toBe('INVALID_REASONER_RESPONSE')
    expect(directRun.result.agentRunTrace.skillInvocations).toHaveLength(0)

    const forgedMetering: PalReasoner = {
      decide: async () => ({ ...call('inspect_service_exception'), usage: metering('model-forged', 0, 0) }),
    }
    const forgedRun = await execute({ reasoner: forgedMetering })
    expect(forgedRun.result.stoppedReason).toBe('INVALID_REASONER_RESPONSE')
    expect(forgedRun.result.agentRunTrace.providerMetering[0]?.providerRequestId).toBe('fixture-provider-1')
  })

  it.each([
    ['credit authority', (proposal: Record<string, unknown>) => ({ proposal, credit: { amount: 75 } }), 'UNAUTHORIZED_OPERATIONAL_AUTHORITY'],
    ['invented citation', (proposal: Record<string, unknown>) => {
      const claims = structuredClone(proposal.factualClaims) as Array<{ text: string; evidenceIds: string[] }>
      claims[0]!.evidenceIds = ['ev-invented']
      const { digest: _digest, ...rest } = proposal
      const unsigned = { ...rest, factualClaims: claims }
      return { proposal: { ...unsigned, digest: contentDigest(unsigned) } }
    }, 'INVENTED_EVIDENCE_CITATION'],
    ['arbitrary certainty prose', (proposal: Record<string, unknown>) => {
      const claims = structuredClone(proposal.factualClaims) as Array<{ text: string; evidenceIds: string[] }>
      claims[0]!.text = 'This recovery is certainly complete.'
      const { digest: _digest, ...rest } = proposal
      const unsigned = { ...rest, factualClaims: claims }
      return { proposal: { ...unsigned, digest: contentDigest(unsigned) } }
    }, 'NON_CANONICAL_EVIDENCE_CLAIMS'],
    ['extended validity', (proposal: Record<string, unknown>) => {
      const { digest: _digest, ...rest } = proposal
      const unsigned = { ...rest, validUntil: '2026-07-21T14:01:00-05:00' }
      return { proposal: { ...unsigned, digest: contentDigest(unsigned) } }
    }, 'PROPOSAL_VALIDITY_BOUNDARY_MISMATCH'],
  ])('rejects %s in proposal submission', async (_label, mutate, expected) => {
    const workflow = new RecoveryWorkflowReasoner()
    const reasoner: PalReasoner = {
      decide: async (view) => {
        const response = await workflow.decide(view) as ReturnType<typeof call> | ReturnType<typeof stop>
        if (response.type !== 'call_skill' || response.skillId !== 'submit_typed_proposal') return response
        const proposal = structuredClone(response.input.proposal) as Record<string, unknown>
        return { ...response, input: mutate(proposal) }
      },
    }
    expect((await execute({ reasoner })).result.stoppedReason).toBe(expected)
  })

  it.each([
    ['cross-tenant evidence', (item: Record<string, unknown>) => ({ ...item, tenantId: 'ten_other' }), 'CROSS_TENANT_EVIDENCE'],
    ['cross-case evidence', (item: Record<string, unknown>) => {
      const content = { ...(item.content as Record<string, unknown>), caseId: 'case_other' }
      return { ...item, content, contentHash: contentDigest(content) }
    }, 'CROSS_CASE_EVIDENCE'],
    ['tampered evidence', (item: Record<string, unknown>) => ({ ...item, contentHash: '0'.repeat(64) }), 'EVIDENCE_HASH_MISMATCH'],
  ])('rejects %s at the host boundary', async (_label, mutate, expected) => {
    const base = makeSource()
    const source = wrapSource({
      inspectServiceException: (scope) => {
        const inspection = base.inspectServiceException(scope)
        return { ...inspection, caseEvidence: mutate(inspection.caseEvidence) as never }
      },
    })
    expect((await execute({ source })).result.stoppedReason).toBe(expected)
  })

  it('rejects a cross-tenant or tampered route quote', async () => {
    for (const mutation of ['tenant', 'hash'] as const) {
      const quote = makeRouteQuote()
      const unsigned = { ...quote, ...(mutation === 'tenant' ? { tenantId: 'ten_other' } : {}) }
      delete (unsigned as Partial<typeof quote>).hash
      const bad = RouteQuoteSchema.parse({
        ...unsigned,
        hash: mutation === 'hash' ? '0'.repeat(64) : contentDigest(unsigned),
      })
      const run = await execute({ planner: makePlanner(bad) })
      expect(run.result.stoppedReason).toBe(mutation === 'tenant' ? 'CROSS_TENANT_ROUTE_QUOTE' : 'ROUTE_QUOTE_HASH_MISMATCH')
    }
  })

  it('enforces call, host-priced cost, and replay-safe usage budgets', async () => {
    expect((await execute({ budget: { ...defaultBudget, maxSkillCalls: 2 } })).result.stoppedReason)
      .toBe('SKILL_CALL_BUDGET_EXHAUSTED')
    expect((await execute({
      budget: { ...defaultBudget, maxEstimatedCostUsd: 0.0001 },
      pricing: { inputUsdPerMillion: 1_000, outputUsdPerMillion: 1_000 },
    })).result.stoppedReason).toBe('COST_BUDGET_EXHAUSTED')

    let count = 0
    const replayed: PalProviderAdapter = {
      invoke: async () => ({
        decision: call(count++ === 0 ? 'inspect_service_exception' : 'get_customer_commitments'),
        metering: metering('replayed'),
      }),
    }
    const replayedRun = await execute({ provider: replayed })
    expect(replayedRun.result.stoppedReason).toBe('USAGE_RECEIPT_REPLAYED')
    expect(replayedRun.result.agentRunTrace.providerMetering).toHaveLength(2)
  })

  it('preflights the complete payload and uses host token floors for provider metering', async () => {
    const preflightProvider: PalProviderAdapter = { invoke: vi.fn() }
    const preflight = await execute({
      provider: preflightProvider,
      budget: { ...defaultBudget, maxContextTokens: 1 },
    })
    expect(preflight.result.stoppedReason).toBe('TOKEN_BUDGET_EXHAUSTED')
    expect(preflightProvider.invoke).not.toHaveBeenCalled()

    const underreporting: PalProviderAdapter = {
      invoke: async () => ({
        decision: call('inspect_service_exception', { padding: 'x'.repeat(4_000) }),
        metering: metering('zero', 0, 0),
      }),
    }
    const run = await execute({ provider: underreporting, budget: { ...defaultBudget, maxContextTokens: 800 } })
    expect(run.result.stoppedReason).toBe('TOKEN_BUDGET_EXHAUSTED')
    expect(run.result.agentRunTrace.skillInvocations).toHaveLength(0)
  })

  it('aborts a hung reasoner and a hung skill with real deadlines', async () => {
    const hungReasoner: PalReasoner = {
      decide: async (_view, { signal }) => await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }
    expect((await execute({ reasoner: hungReasoner, budget: { ...defaultBudget, maxLatencyMs: 20 } })).result.stoppedReason)
      .toBe('REASONER_DEADLINE_EXCEEDED')

    const oneCall: PalReasoner = { decide: async () => call('inspect_service_exception') }
    const hungSkill: PalSkillHost = {
      execute: async ({ signal }) => await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }
    expect((await execute({ reasoner: oneCall, skillHost: hungSkill, budget: { ...defaultBudget, maxLatencyMs: 20 } })).result.stoppedReason)
      .toBe('SKILL_DEADLINE_EXCEEDED')
  })

  it('fails closed when required evidence or candidate inventory exceeds context capacity', async () => {
    const requiredOverflow = await execute({ budget: { ...defaultBudget, maxContextTokens: 500 } })
    expect([
      'TOKEN_BUDGET_EXHAUSTED',
      'REQUIRED_CONTEXT_OVERFLOW',
      'CONTEXT_INVENTORY_INCOMPLETE',
    ]).toContain(requiredOverflow.result.stoppedReason)

    const source = makeSource()
    const incomplete = wrapSource({
      inspectServiceException: (scope) => ({
        ...source.inspectServiceException(scope),
        optionalEvidenceResidualCount: 1,
      }),
    })
    expect((await execute({ source: incomplete })).result.stoppedReason).toBe('CONTEXT_INVENTORY_INCOMPLETE')
  })
})
