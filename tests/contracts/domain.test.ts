import { describe, expect, it } from 'vitest'
import {
  ProgramDefinitionSchema,
  SkillDefinitionSchema,
  allowedOutcomeTransitions,
  canonicalJson,
  contentDigest,
  earliestValidityBoundary,
  recoveryProgramDefinition,
  recoverySkillDefinitions,
} from '../../packages/contracts/src/index.js'

describe('shared domain contracts', () => {
  it('canonicalizes object keys without reordering arrays', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: [3, 1] } })).toBe('{"a":{"b":[3,1],"d":2},"z":1}')
    expect(contentDigest({ b: 2, a: 1 })).toBe(contentDigest({ a: 1, b: 2 }))
  })

  it('selects the earliest validity boundary', () => {
    expect(earliestValidityBoundary([
      '2026-07-21T17:30:00-05:00',
      '2026-07-21T14:00:00-05:00',
      '2026-07-21T16:00:00-05:00',
    ])).toBe('2026-07-21T14:00:00-05:00')
  })

  it('keeps confirmation separate from evidence reconciliation', () => {
    expect(allowedOutcomeTransitions.evidence_reconciled).toContain('customer_confirmed')
    expect(allowedOutcomeTransitions.driver_reported).not.toContain('customer_confirmed')
    expect(allowedOutcomeTransitions.supporting_evidence_received).not.toContain('customer_confirmed')
  })

  it('validates generated program and skill definitions', () => {
    expect(ProgramDefinitionSchema.parse(recoveryProgramDefinition).allowedSkills).toHaveLength(6)
    expect(recoverySkillDefinitions.map((skill) => SkillDefinitionSchema.parse(skill))).toHaveLength(6)
  })
})
