import { describe, expect, it } from 'vitest'
import { LifecycleError, ProcessSessionAuthority } from '../../packages/lifecycle/src/index.js'
import { decisionInputs, FixedClock, lifecycleFixture } from './helpers.js'

describe('opaque process sessions', () => {
  it('resolves signed opaque tokens without exposing caller-selected identity', () => {
    const clock = new FixedClock()
    const authority = new ProcessSessionAuthority(Buffer.alloc(32, 3), { clock })
    const token = authority.issue({
      subjectId: 'usr_maya',
      tenantId: 'ten_harborworks',
      capabilities: ['approve_recovery'],
    })

    expect(token).not.toContain('usr_maya')
    expect(token).not.toContain('ten_harborworks')
    expect(authority.resolve(token)).toMatchObject({
      subjectId: 'usr_maya',
      tenantId: 'ten_harborworks',
      kind: 'user',
    })
    const replacement = token.endsWith('0') ? '1' : '0'
    expect(() => authority.resolve(`${token.slice(0, -1)}${replacement}`)).toThrow(LifecycleError)
  })

  it('expires sessions at their server-side TTL boundary', () => {
    const clock = new FixedClock()
    const authority = new ProcessSessionAuthority(Buffer.alloc(32, 4), { clock, defaultTtlMs: 1_000 })
    const token = authority.issue({
      subjectId: 'usr_maya',
      tenantId: 'ten_harborworks',
      capabilities: ['approve_recovery'],
    })
    clock.set('2026-07-21T18:20:00.999Z')
    expect(authority.resolve(token).subjectId).toBe('usr_maya')
    clock.set('2026-07-21T18:20:01.000Z')
    expect(() => authority.resolve(token)).toThrowError(expect.objectContaining({ code: 'invalid_session' }))
  })

  it('does not allow a user identifier to be reissued as a worker identity', () => {
    const authority = new ProcessSessionAuthority(Buffer.alloc(32, 5))
    expect(() => authority.issueWorker({
      workerId: 'usr_maya',
      tenantId: 'ten_harborworks',
      capabilities: ['dispatch_recovery'],
    })).toThrowError(expect.objectContaining({ code: 'invalid_principal' }))
    expect(() => authority.issue({
      subjectId: 'worker_dispatch',
      tenantId: 'ten_harborworks',
      capabilities: ['approve_recovery'],
    })).toThrowError(expect.objectContaining({ code: 'invalid_principal' }))
  })

  it('rejects caller identities, same-tenant viewers, and cross-tenant proposal access', () => {
    const fixture = lifecycleFixture()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, decisionInputs())

    expect(() => fixture.engine.approve(fixture.dispatcherSession, {
      proposalId: 'proposal_greenleaf-001',
      actorId: 'usr_maya',
    })).toThrowError(expect.objectContaining({ code: 'caller_identity_forbidden' }))
    expect(() => fixture.engine.approve(fixture.viewerSession, { proposalId: 'proposal_greenleaf-001' }))
      .toThrowError(expect.objectContaining({ code: 'capability_required' }))
    expect(() => fixture.engine.approve(fixture.foreignDispatcherSession, { proposalId: 'proposal_greenleaf-001' }))
      .toThrowError(expect.objectContaining({ code: 'proposal_not_found' }))
  })

  it('rejects delimiter-bearing identifiers before they can collide across tenants', () => {
    const fixture = lifecycleFixture()
    expect(() => fixture.engine.registerDecisionInputs(
      fixture.preparationWorkerSession,
      decisionInputs({ proposalId: 'proposal_bad\u0000id' }),
    )).toThrowError(expect.objectContaining({ code: 'invalid_identifier' }))
  })
})
