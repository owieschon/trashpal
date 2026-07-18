import { z } from 'zod'

export const IdentifierSchema = z.string().min(1).max(160)

export const SkillDefinitionSchema = z.object({
  id: IdentifierSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1),
  access: z.literal('case_scoped_read_only'),
  inputSchemaId: IdentifierSchema,
  outputSchemaId: IdentifierSchema,
})

export const ProgramDefinitionSchema = z.object({
  id: IdentifierSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  allowedSkills: z.array(IdentifierSchema).min(1),
  outcomes: z.array(z.enum(['prepare_recovery', 'hold_for_confirmation', 'escalate'])).min(1),
})

export const RunBudgetSchema = z.object({
  maxSkillCalls: z.number().int().positive().max(24),
  maxContextTokens: z.number().int().positive().max(32_000),
  maxLatencyMs: z.number().int().positive().max(120_000),
  maxEstimatedCostUsd: z.number().nonnegative().max(100),
})

export const SkillInvocationSchema = z.object({
  skillId: IdentifierSchema,
  runToken: IdentifierSchema,
  receipt: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.number().int().min(100).max(599),
})

export const RunOutcomeSchema = z.enum(['prepare_recovery', 'hold_for_confirmation', 'escalate'])

export const ContextEvidenceSchema = z.object({
  evidenceId: IdentifierSchema,
  reason: z.string().min(1),
  authority: z.string().min(1).optional(),
  freshness: z.string().min(1).optional(),
})

export const ModelContextEnvelopeSchema = z.object({
  includedEvidence: z.array(ContextEvidenceSchema),
  omittedEvidence: z.array(ContextEvidenceSchema),
  conflicts: z.array(z.object({
    evidenceIds: z.array(IdentifierSchema).min(2),
    reason: z.string().min(1),
  })),
  tokenEstimate: z.number().int().nonnegative(),
  tokenBudget: z.number().int().positive(),
  versions: z.object({
    program: z.string().min(1),
    contextBundle: z.string().min(1),
    skills: z.record(z.string(), z.string()),
  }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
})

export const AgentRunTraceSchema = z.object({
  trigger: z.object({
    tenantId: IdentifierSchema,
    caseId: IdentifierSchema,
    programId: IdentifierSchema,
  }),
  runToken: IdentifierSchema,
  runBudget: RunBudgetSchema,
  skillInvocations: z.array(SkillInvocationSchema),
  outcome: RunOutcomeSchema,
  stoppedReason: z.string().min(1),
})

export type RunBudget = z.infer<typeof RunBudgetSchema>
export type SkillInvocation = z.infer<typeof SkillInvocationSchema>
export type RunOutcome = z.infer<typeof RunOutcomeSchema>
export type ModelContextEnvelope = z.infer<typeof ModelContextEnvelopeSchema>
export type AgentRunTrace = z.infer<typeof AgentRunTraceSchema>

export * from './domain.js'
export * from './generated/recovery-program.js'
