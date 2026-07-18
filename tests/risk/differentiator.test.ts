import { describe, expect, it } from 'vitest'

describe('differentiator contract', () => {
  it('differentiator keeps the generic renderer non-agentic', () => {
    const renderer = {
      startsWithCaseTriggerOnly: true,
      mayUseSkills: false,
      mayPrepareFromConflict: false,
    }
    expect(renderer).toEqual({
      startsWithCaseTriggerOnly: true,
      mayUseSkills: false,
      mayPrepareFromConflict: false,
    })
  })
})
