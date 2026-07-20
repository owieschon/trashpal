import { describe, expect, it } from 'vitest'
import {
  RunOutcomeSchema,
  recoveryProgramDefinition,
  recoverySkillDefinitions,
} from '../../packages/contracts/src/index.js'

describe('differentiator contract', () => {
  it('keeps the generic renderer non-agentic: no dispatch outcome, no write-authority skill', () => {
    // The unsafe generic answer ("veh_v17 is closest. Send it immediately.")
    // is inexpressible in the program contract: immediate dispatch is not an
    // outcome, and every skill the program may call is case-scoped read-only.
    expect(() => RunOutcomeSchema.parse('dispatch_immediately')).toThrow()
    expect(recoveryProgramDefinition.outcomes).toEqual([
      'prepare_recovery',
      'hold_for_confirmation',
      'escalate',
    ])

    const allowed = new Set<string>(recoveryProgramDefinition.allowedSkills)
    const allowedSkills = recoverySkillDefinitions.filter((skill) => allowed.has(skill.id))
    expect(allowedSkills).toHaveLength(recoveryProgramDefinition.allowedSkills.length)
    for (const skill of allowedSkills) {
      expect(skill.access).toBe('case_scoped_read_only')
    }
  })
})
