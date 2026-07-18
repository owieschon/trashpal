import { describe, expect, it } from 'vitest'
import { InMemoryDispatchConnector } from '../../packages/lifecycle/src/index.js'
import { decisionInputs, lifecycleFixture } from './helpers.js'

describe('approval and reservation binding', () => {
  it('binds approval and one idempotent reservation to current immutable inputs', () => {
    const fixture = lifecycleFixture()
    const current = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, current)
    const approval = fixture.engine.approve(fixture.dispatcherSession, { proposalId: current.proposalId })

    expect(approval).toMatchObject({
      proposalDigest: current.proposalDigest,
      contextBundleHash: current.contextBundleHash,
      evidencePacketHash: current.evidencePacketHash,
      routeQuoteHash: current.routeQuoteHash,
      evidenceRevision: 7,
      routeRevision: 3,
      approverId: 'usr_maya',
      capability: 'approve_recovery',
    })
    const first = fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest })
    const replay = fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest })

    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.operation.id).toBe(first.operation.id)
    expect(first.operation.snapshot).toMatchObject({
      proposalDigest: current.proposalDigest,
      approvalDigest: approval.digest,
      evidencePacketHash: current.evidencePacketHash,
      routeQuoteHash: current.routeQuoteHash,
      vehicleId: 'veh_v42',
    })
    expect(Object.isFrozen(first.operation.snapshot)).toBe(true)
    expect(() => {
      ;(first.operation.snapshot as { vehicleId: string }).vehicleId = 'veh_v17'
    }).toThrow()
  })

  it('rejects changed evidence, revoked authority, and an expired binding before reservation', () => {
    const changed = lifecycleFixture()
    const original = decisionInputs()
    changed.engine.registerDecisionInputs(changed.preparationWorkerSession, original)
    const approval = changed.engine.approve(changed.dispatcherSession, { proposalId: original.proposalId })
    changed.engine.replaceCurrentDecisionInputs(
      changed.preparationWorkerSession,
      decisionInputs({ evidenceRevision: 8 }),
    )
    expect(() => changed.engine.reserve(changed.dispatcherSession, { approvalDigest: approval.digest }))
      .toThrowError(expect.objectContaining({ code: 'approval_stale_or_revoked' }))

    const revokedApprovalFixture = lifecycleFixture()
    revokedApprovalFixture.engine.registerDecisionInputs(revokedApprovalFixture.preparationWorkerSession, original)
    const directlyRevoked = revokedApprovalFixture.engine.approve(
      revokedApprovalFixture.dispatcherSession,
      { proposalId: original.proposalId },
    )
    revokedApprovalFixture.engine.revokeApproval(revokedApprovalFixture.dispatcherSession, directlyRevoked.digest)
    expect(() => revokedApprovalFixture.engine.reserve(
      revokedApprovalFixture.dispatcherSession,
      { approvalDigest: directlyRevoked.digest },
    )).toThrowError(expect.objectContaining({ code: 'approval_stale_or_revoked' }))

    const revoked = lifecycleFixture()
    revoked.engine.registerDecisionInputs(revoked.preparationWorkerSession, original)
    const revokedApproval = revoked.engine.approve(revoked.dispatcherSession, { proposalId: original.proposalId })
    revoked.authority.revokeCapability('usr_maya', 'ten_harborworks', 'approve_recovery')
    expect(() => revoked.engine.reserve(revoked.dispatcherSession, { approvalDigest: revokedApproval.digest }))
      .toThrowError(expect.objectContaining({ code: 'capability_required' }))

    const expired = lifecycleFixture()
    const shortLived = decisionInputs({ validUntil: '2026-07-21T18:24:00.000Z' })
    expired.engine.registerDecisionInputs(expired.preparationWorkerSession, shortLived)
    const expiredApproval = expired.engine.approve(expired.dispatcherSession, { proposalId: shortLived.proposalId })
    expired.clock.set('2026-07-21T18:24:00.001Z')
    expect(() => expired.engine.reserve(expired.dispatcherSession, { approvalDigest: expiredApproval.digest }))
      .toThrowError(expect.objectContaining({ code: 'approval_stale_or_revoked' }))
  })

  it('revalidates after reservation and cancels before connector send', async () => {
    const fixture = lifecycleFixture()
    const current = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, current)
    const approval = fixture.engine.approve(fixture.dispatcherSession, { proposalId: current.proposalId })
    const { operation } = fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest })
    fixture.engine.replaceCurrentDecisionInputs(
      fixture.preparationWorkerSession,
      decisionInputs({ revoked: true, evidenceRevision: 8 }),
    )
    const connector = new InMemoryDispatchConnector()

    await expect(fixture.engine.dispatch(fixture.dispatchWorkerSession, operation.id, connector))
      .rejects.toMatchObject({ code: 'approval_stale_or_revoked' })
    expect(connector.sendCount).toBe(0)
    expect(fixture.engine.getOperation(fixture.dispatcherSession, operation.id).state).toBe('cancelled')
  })

  it('revalidates approver capability between reservation and connector send', async () => {
    const fixture = lifecycleFixture()
    const current = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, current)
    const approval = fixture.engine.approve(fixture.dispatcherSession, { proposalId: current.proposalId })
    const { operation } = fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest })
    fixture.authority.revokeCapability('usr_maya', 'ten_harborworks', 'approve_recovery')
    const connector = new InMemoryDispatchConnector()

    await expect(fixture.engine.dispatch(fixture.dispatchWorkerSession, operation.id, connector))
      .rejects.toMatchObject({ code: 'approval_stale_or_revoked' })
    expect(connector.sendCount).toBe(0)
    expect(fixture.engine.getOperation(fixture.dispatcherSession, operation.id).state).toBe('cancelled')
  })

  it('invalidates approval when executable work-order fields change', () => {
    const fixture = lifecycleFixture()
    const original = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, original)
    const approval = fixture.engine.approve(fixture.dispatcherSession, { proposalId: original.proposalId })
    fixture.engine.replaceCurrentDecisionInputs(
      fixture.preparationWorkerSession,
      decisionInputs({ vehicleId: 'veh_v17' }),
    )

    expect(() => fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest }))
      .toThrowError(expect.objectContaining({ code: 'approval_stale_or_revoked' }))
  })

  it('enforces one approval lineage across authorized dispatchers', () => {
    const fixture = lifecycleFixture()
    const otherDispatcher = fixture.authority.issue({
      subjectId: 'usr_joel',
      tenantId: 'ten_harborworks',
      capabilities: ['approve_recovery', 'read_lifecycle'],
    })
    const current = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, current)
    fixture.engine.approve(fixture.dispatcherSession, { proposalId: current.proposalId })

    expect(() => fixture.engine.approve(otherDispatcher, { proposalId: current.proposalId }))
      .toThrowError(expect.objectContaining({ code: 'proposal_version_required' }))
  })

  it('rejects non-JSON decision payloads before hashing or persistence', () => {
    const fixture = lifecycleFixture()
    const invalid = decisionInputs()
    invalid.proposalPayload = { ...invalid.proposalPayload, score: Number.NaN }
    invalid.proposalDigest = 'a'.repeat(64)

    expect(() => fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, invalid))
      .toThrowError(expect.objectContaining({ code: 'invalid_payload' }))
  })
})
