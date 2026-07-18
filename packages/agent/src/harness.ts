import { assembleModelContext, type ContextAssembly } from '@trashpal/context'
import {
  AgentRunTraceSchema,
  ContextBundleSchema,
  ModelContextEnvelopeSchema,
  ProgramDefinitionSchema,
  RecoveryProposalSchema,
  RunBudgetSchema,
  RunOutcomeSchema,
  SkillInvocationSchema,
  contentDigest,
} from '@trashpal/contracts'
import { z } from 'zod'
import {
  RecoverySkillIdSchema,
  SkillPolicyError,
  createEmptySkillState,
  type RecoverySkillId,
  type SkillExecution,
  type SkillHostState,
} from './skills.js'

const TriggerSchema = z.object({
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  programId: z.string().min(1),
}).strict()

const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('call_skill'),
    skillId: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    type: z.literal('stop'),
    outcome: z.enum(['hold_for_confirmation', 'escalate']),
    reason: z.string().min(1),
  }).strict(),
])

const ProviderMeteringSchema = z.object({
  providerRequestId: z.string().min(1).max(200),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
}).strict()

const ProviderInvocationSchema = z.object({
  decision: z.unknown(),
  metering: ProviderMeteringSchema,
}).strict()

const PricingSchema = z.object({
  inputUsdPerMillion: z.number().nonnegative(),
  outputUsdPerMillion: z.number().nonnegative(),
}).strict()

type Trigger = z.infer<typeof TriggerSchema>
type AgentRunTrace = z.infer<typeof AgentRunTraceSchema>
type ContextBundle = z.infer<typeof ContextBundleSchema>
type ModelContextEnvelope = z.infer<typeof ModelContextEnvelopeSchema>
type ProgramDefinition = z.infer<typeof ProgramDefinitionSchema>
type RecoveryProposal = z.infer<typeof RecoveryProposalSchema>
type RunBudget = z.infer<typeof RunBudgetSchema>
type RunOutcome = z.infer<typeof RunOutcomeSchema>
type SkillInvocation = z.infer<typeof SkillInvocationSchema>

export interface PalReasoningView {
  staticContext: {
    trigger: Trigger
    bundleId: string
    bundleHash: string
    programVersion: string
    policyVersion: string
    mappingVersion: string
    allowedSkills: string[]
    completedSkills: string[]
  }
  evidence: ContextAssembly['modelItems']
  envelope: ModelContextEnvelope
}

export interface PalReasoner {
  decide(view: PalReasoningView, options: { signal: AbortSignal }): Promise<unknown>
}

export interface ProviderMetering {
  providerRequestId: string
  inputTokens: number
  outputTokens: number
}

export interface PalProviderAdapter {
  invoke(view: PalReasoningView, options: { signal: AbortSignal }): Promise<{
    decision: unknown
    metering: ProviderMetering
  }>
}

export function createLocalProviderAdapter(
  reasoner: PalReasoner,
  options: { requestIdPrefix?: string } = {},
): PalProviderAdapter {
  const requestIdPrefix = options.requestIdPrefix ?? 'local-provider'
  let request = 0
  return {
    invoke: async (view, { signal }) => {
      const decision = await reasoner.decide(view, { signal })
      request += 1
      return {
        decision,
        metering: {
          providerRequestId: `${requestIdPrefix}-${request}`,
          inputTokens: view.envelope.tokenEstimate,
          outputTokens: estimateTokens(decision),
        },
      }
    },
  }
}

export interface PalSkillHost {
  execute(input: {
    skillId: RecoverySkillId
    scope: { tenantId: string; caseId: string }
    payload: Record<string, unknown>
    state: SkillHostState
    signal?: AbortSignal
  }): Promise<SkillExecution>
}

export interface PalRunResult {
  outcome: RunOutcome
  stoppedReason: string
  agentRunTrace: AgentRunTrace & { providerMetering: ProviderMetering[] }
  modelContextEnvelope: ModelContextEnvelope
  proposal?: RecoveryProposal
  estimatedCostUsd: number
  reasoningTokens: number
}

export async function runBoundedPal(rawInput: {
  trigger: Trigger
  program: ProgramDefinition
  contextBundle: ContextBundle
  budget: RunBudget
  provider: PalProviderAdapter
  skillHost: PalSkillHost
  runToken: string
  pricing?: z.input<typeof PricingSchema>
  clock?: { nowMs(): number }
}): Promise<PalRunResult> {
  const trigger = TriggerSchema.parse(rawInput.trigger)
  const program = ProgramDefinitionSchema.parse(rawInput.program)
  const contextBundle = ContextBundleSchema.parse(rawInput.contextBundle)
  const budget = RunBudgetSchema.parse(rawInput.budget)
  const pricing = PricingSchema.parse(rawInput.pricing ?? { inputUsdPerMillion: 0, outputUsdPerMillion: 0 })
  if (program.id !== trigger.programId) throw new Error('PROGRAM_TRIGGER_MISMATCH')
  if (contextBundle.tenantId !== trigger.tenantId) throw new Error('CONTEXT_TENANT_MISMATCH')

  const state = createEmptySkillState()
  const invocations: SkillInvocation[] = []
  const providerMetering: ProviderMetering[] = []
  const usageReceiptIds = new Set<string>()
  const clock = rawInput.clock ?? { nowMs: () => Date.now() }
  const startedAt = clock.nowMs()
  let estimatedCostUsd = 0
  let reasoningTokens = 0
  let assembly = assemble(state, budget, program, contextBundle, trigger)
  const maxReasoningSteps = budget.maxSkillCalls + 2

  for (let step = 0; step < maxReasoningSteps; step += 1) {
    const preflightFailure = contextPreflightFailure(assembly, state, budget)
    if (preflightFailure) return finish('escalate', preflightFailure)
    const remainingMs = budget.maxLatencyMs - (clock.nowMs() - startedAt)
    if (remainingMs <= 0) return finish('escalate', 'LATENCY_BUDGET_EXHAUSTED')
    const view = reasoningView(trigger, program, contextBundle, state, assembly)

    let providerInvocation: z.output<typeof ProviderInvocationSchema>
    try {
      providerInvocation = ProviderInvocationSchema.parse(await withinDeadline(
        (signal) => rawInput.provider.invoke(view, { signal }),
        remainingMs,
      ))
    } catch (error) {
      return finish('escalate', error instanceof DeadlineExceeded ? 'REASONER_DEADLINE_EXCEEDED' : 'INVALID_REASONER_RESPONSE')
    }
    providerMetering.push(providerInvocation.metering)
    if (usageReceiptIds.has(providerInvocation.metering.providerRequestId)) return finish('escalate', 'USAGE_RECEIPT_REPLAYED')
    usageReceiptIds.add(providerInvocation.metering.providerRequestId)

    // `tokenEstimate` already covers the canonical prompt payload: static context,
    // selected evidence, omissions, conflicts, reasons, versions, and envelope.
    // Transport-only counters in `PalReasoningView` are not sent to the provider.
    const hostInputFloor = assembly.envelope.tokenEstimate
    const hostOutputFloor = estimateTokens(providerInvocation.decision)
    const inputTokens = Math.max(providerInvocation.metering.inputTokens, hostInputFloor)
    const outputTokens = Math.max(providerInvocation.metering.outputTokens, hostOutputFloor)
    if (inputTokens > budget.maxContextTokens || outputTokens > budget.maxContextTokens) {
      return finish('escalate', 'TOKEN_BUDGET_EXHAUSTED')
    }
    reasoningTokens += inputTokens + outputTokens
    estimatedCostUsd += (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) / 1_000_000
    if (estimatedCostUsd > budget.maxEstimatedCostUsd) return finish('escalate', 'COST_BUDGET_EXHAUSTED')
    if (clock.nowMs() - startedAt >= budget.maxLatencyMs) return finish('escalate', 'LATENCY_BUDGET_EXHAUSTED')

    let decision: z.output<typeof ActionSchema>
    try {
      decision = ActionSchema.parse(providerInvocation.decision)
    } catch {
      return finish('escalate', 'INVALID_REASONER_RESPONSE')
    }
    if (decision.type === 'stop') return finish(decision.outcome, decision.reason)
    if (invocations.length >= budget.maxSkillCalls) return finish('escalate', 'SKILL_CALL_BUDGET_EXHAUSTED')
    if (!program.allowedSkills.includes(decision.skillId)) return finish('escalate', 'SKILL_NOT_ALLOWED')

    let skillId: RecoverySkillId
    try {
      skillId = RecoverySkillIdSchema.parse(decision.skillId)
    } catch {
      return finish('escalate', 'UNKNOWN_SKILL')
    }
    const skillRemainingMs = budget.maxLatencyMs - (clock.nowMs() - startedAt)
    if (skillRemainingMs <= 0) return finish('escalate', 'LATENCY_BUDGET_EXHAUSTED')
    try {
      const execution = await withinDeadline(
        (signal) => rawInput.skillHost.execute({
          skillId,
          scope: { tenantId: trigger.tenantId, caseId: trigger.caseId },
          payload: decision.input,
          state,
          signal,
        }),
        skillRemainingMs,
      )
      invocations.push({ skillId, runToken: rawInput.runToken, receipt: execution.receipt, status: execution.status })
      if (execution.status < 200 || execution.status >= 300) return finish('escalate', 'SKILL_EXECUTION_REJECTED')
    } catch (error) {
      if (error instanceof DeadlineExceeded) return finish('escalate', 'SKILL_DEADLINE_EXCEEDED')
      const policyError = error instanceof SkillPolicyError
        ? error
        : new SkillPolicyError(error instanceof Error ? error.message : 'SKILL_EXECUTION_FAILED')
      invocations.push({
        skillId,
        runToken: rawInput.runToken,
        receipt: contentDigest({ skillId, code: policyError.code, trigger }),
        status: 422,
      })
      return finish(policyError.outcome, policyError.code)
    }

    assembly = assemble(state, budget, program, contextBundle, trigger)
    const postSkillPreflightFailure = contextPreflightFailure(assembly, state, budget)
    if (postSkillPreflightFailure) return finish('escalate', postSkillPreflightFailure)
    if (state.proposal) return finish('prepare_recovery', 'CITED_PROPOSAL_VALIDATED')
  }
  return finish('escalate', 'REASONING_STEP_BUDGET_EXHAUSTED')

  function finish(outcome: RunOutcome, stoppedReason: string): PalRunResult {
    assembly = assemble(state, budget, program, contextBundle, trigger)
    const baseTrace = AgentRunTraceSchema.parse({
      trigger,
      runToken: rawInput.runToken,
      runBudget: budget,
      skillInvocations: invocations,
      outcome,
      stoppedReason,
    })
    const agentRunTrace = { ...baseTrace, providerMetering: [...providerMetering] }
    return {
      outcome,
      stoppedReason,
      agentRunTrace,
      modelContextEnvelope: assembly.envelope,
      ...(state.proposal ? { proposal: state.proposal } : {}),
      estimatedCostUsd,
      reasoningTokens,
    }
  }
}

function reasoningView(
  trigger: Trigger,
  program: ProgramDefinition,
  contextBundle: ContextBundle,
  state: SkillHostState,
  assembly: ContextAssembly,
): PalReasoningView {
  return {
    staticContext: staticContext(program, contextBundle, trigger, state),
    evidence: assembly.modelItems,
    envelope: assembly.envelope,
  }
}

function staticContext(
  program: ProgramDefinition,
  contextBundle: ContextBundle,
  trigger: Trigger,
  state: SkillHostState,
) {
  return {
    trigger,
    bundleId: contextBundle.id,
    bundleHash: contextBundle.hash,
    programVersion: contextBundle.programVersion,
    policyVersion: contextBundle.policyVersion,
    mappingVersion: contextBundle.mappingVersion,
    allowedSkills: [...program.allowedSkills],
    completedSkills: [...state.completedSkills],
  }
}

function assemble(
  state: SkillHostState,
  budget: RunBudget,
  program: ProgramDefinition,
  contextBundle: ContextBundle,
  trigger: Trigger,
): ContextAssembly {
  return assembleModelContext({
    candidates: [...state.evidence.values()].map((item) => ({
      item,
      reason: state.evidenceReasons.get(item.id) ?? 'Supports the active case decision.',
      required: state.requiredEvidenceIds.has(item.id),
    })),
    knownCandidates: [...state.candidateEvidence].map(([evidenceId, reason]) => ({ evidenceId, reason })),
    conflicts: state.conflicts,
    tokenBudget: budget.maxContextTokens,
    versions: {
      program: `${program.id}@${program.version}`,
      contextBundle: `${contextBundle.id}@${contextBundle.version}`,
      skills: contextBundle.skillVersions,
    },
    modelFacingStaticContext: staticContext(program, contextBundle, trigger, state),
  })
}

function contextPreflightFailure(
  assembly: ContextAssembly,
  state: SkillHostState,
  budget: RunBudget,
): string | undefined {
  if (assembly.overflowedRequiredEvidenceIds.length > 0) return 'REQUIRED_CONTEXT_OVERFLOW'
  if (assembly.omissionMetadataTruncated || state.candidateInventoryResidual > 0) {
    return 'CONTEXT_INVENTORY_INCOMPLETE'
  }
  if (assembly.envelope.tokenEstimate > budget.maxContextTokens) return 'TOKEN_BUDGET_EXHAUSTED'
  return undefined
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
}

class DeadlineExceeded extends Error {}

async function withinDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw new DeadlineExceeded()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DeadlineExceeded())
    }, timeoutMs)
  })
  try {
    return await Promise.race([work(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
