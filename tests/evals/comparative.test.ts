import { describe, expect, it } from 'vitest'
import {
  evaluateComparative,
  type ComparativeRun,
  type ComparativeVariant,
} from '../../packages/evals/src/comparative.mjs'

const variants: ComparativeVariant[] = [
  'deterministic_template',
  'deterministic_investigator',
  'uncurated_one_shot_fixture',
  'curated_one_shot_fixture',
  'bounded_fixture_pal',
]

const cases = [
  { caseId: 'case-resolved', expectedOutcome: 'prepare_recovery' as const },
  { caseId: 'case-conflict', expectedOutcome: 'hold_for_confirmation' as const },
]

function row(variant: ComparativeVariant, caseId: string, overrides: Partial<ComparativeRun> = {}): ComparativeRun {
  return {
    correctOutcomeOrAbstention: true,
    unsafeProposalCount: 0,
    unsupportedClaimCount: 0,
    missingCriticalEvidenceCount: 0,
    correctSkillCalls: variant.includes('investigator') || variant === 'bounded_fixture_pal' ? 2 : 0,
    unnecessarySkillCalls: 0,
    approvalPayloadValid: true,
    contextTokens: 120,
    stepCount: 2,
    latencyMs: 4,
    estimatedCostUsd: 0,
    variant,
    caseId,
    ...overrides,
  }
}

function matrix(overrides: (variant: ComparativeVariant, caseId: string) => Partial<ComparativeRun> = () => ({})) {
  return variants.flatMap((variant) => cases.map((entry) => row(variant, entry.caseId, overrides(variant, entry.caseId))))
}

describe('comparative evaluator', () => {
  it('preserves independently scored rows and refuses fixture-based promotion', () => {
    const runs = matrix()
    const result = evaluateComparative({ schemaVersion: '1.0', variants, cases, runs, evidenceClass: 'deterministic_fixture' })

    expect(result.results).toEqual(runs)
    expect(result.promotion).toEqual({
      eligible: false,
      reason: 'Deterministic fixture evidence cannot promote a model path. A credentialed live statistical evaluation is required.',
    })
  })

  it('marks Pal unnecessary when it does not beat the equal-information deterministic investigator', () => {
    const result = evaluateComparative({ schemaVersion: '1.0', variants, cases, runs: matrix(), evidenceClass: 'deterministic_fixture' })

    expect(result.necessity).toMatchObject({
      status: 'not_needed',
      correctOutcomeOrAbstentionDelta: 0,
      unsafeProposalDelta: 0,
    })
  })

  it('marks a less safe bounded path unnecessary even when it improves correct behavior', () => {
    const result = evaluateComparative({
      schemaVersion: '1.0',
      variants,
      cases,
      runs: matrix((variant, caseId) => {
        if (variant === 'deterministic_investigator' && caseId === 'case-conflict') return { correctOutcomeOrAbstention: false }
        if (variant === 'bounded_fixture_pal' && caseId === 'case-resolved') return { unsafeProposalCount: 1 }
        return {}
      }),
      evidenceClass: 'deterministic_fixture',
    })

    expect(result.necessity).toMatchObject({ status: 'not_needed', correctOutcomeOrAbstentionDelta: 1, unsafeProposalDelta: 1 })
  })

  it('requires credentialed live evidence after a safe fixture improvement', () => {
    const result = evaluateComparative({
      schemaVersion: '1.0',
      variants,
      cases,
      runs: matrix((variant, caseId) => (
        variant === 'deterministic_investigator' && caseId === 'case-conflict'
          ? { correctOutcomeOrAbstention: false }
          : {}
      )),
      evidenceClass: 'deterministic_fixture',
    })

    expect(result.necessity).toMatchObject({ status: 'requires_live_evidence', correctOutcomeOrAbstentionDelta: 1, unsafeProposalDelta: 0 })
    expect(result.promotion.eligible).toBe(false)
  })

  it('rejects an incomplete or duplicated variant-case matrix', () => {
    const runs = matrix()
    expect(() => evaluateComparative({
      schemaVersion: '1.0',
      variants,
      cases,
      runs: runs.slice(1),
      evidenceClass: 'deterministic_fixture',
    })).toThrow('comparative run matrix is incomplete')

    expect(() => evaluateComparative({
      schemaVersion: '1.0',
      variants,
      cases,
      runs: [...runs.slice(0, -1), runs[0]],
      evidenceClass: 'deterministic_fixture',
    })).toThrow('comparative row is duplicated')
  })
})
