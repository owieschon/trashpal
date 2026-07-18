import { describe, expect, it } from 'vitest'
import { InMemoryDispatchConnector } from '../../packages/lifecycle/src/index.js'
import { decisionInputs, lifecycleFixture, outcomeEvidence } from './helpers.js'

describe('dispatch uncertainty and outcome evidence', () => {
  it('reconciles a lost acknowledgement before retry and preserves exactly one assignment', async () => {
    const fixture = lifecycleFixture()
    const current = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, current)
    const approval = fixture.engine.approve(fixture.dispatcherSession, { proposalId: current.proposalId })
    const { operation } = fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest })
    const connector = new InMemoryDispatchConnector('lose_once')

    expect((await fixture.engine.dispatch(fixture.dispatchWorkerSession, operation.id, connector)).state).toBe('unknown')
    await expect(fixture.engine.dispatch(fixture.dispatchWorkerSession, operation.id, connector))
      .rejects.toMatchObject({ code: 'reconciliation_required' })
    expect(connector.sendCount).toBe(1)

    const reconciled = await fixture.engine.reconcile(fixture.dispatchWorkerSession, operation.id, connector)
    expect(reconciled.assignmentFound).toBe(true)
    expect(reconciled.operation.state).toBe('assignment_reconciled')
    expect(connector.lookupCount).toBe(1)
    expect(connector.sendCount).toBe(1)
  })

  it('treats a stable acknowledgement-loss code as uncertain across package boundaries', async () => {
    const fixture = lifecycleFixture()
    const current = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, current)
    const approval = fixture.engine.approve(fixture.dispatcherSession, { proposalId: current.proposalId })
    const { operation } = fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest })
    const connector = {
      async send() {
        throw Object.assign(new Error('cross-package acknowledgement loss'), { code: 'ACKNOWLEDGEMENT_LOST' as const })
      },
      async lookup() { return undefined },
    }

    await expect(fixture.engine.dispatch(fixture.dispatchWorkerSession, operation.id, connector))
      .resolves.toMatchObject({ state: 'unknown' })
  })

  it('keeps typed provider evidence, customer confirmation, dispute, and reopen distinct', async () => {
    const fixture = lifecycleFixture()
    const current = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, current)
    const approval = fixture.engine.approve(fixture.dispatcherSession, { proposalId: current.proposalId })
    const { operation } = fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest })
    const connector = new InMemoryDispatchConnector()
    expect((await fixture.engine.dispatch(fixture.dispatchWorkerSession, operation.id, connector)).state).toBe('accepted')

    expect(fixture.engine.recordDriverReport(
      fixture.dispatchWorkerSession,
      operation.id,
      outcomeEvidence(operation.id, 'driver_report', 'ev_driver-report-001'),
    ).state).toBe('driver_reported')
    expect(() => fixture.engine.confirmCustomerOutcome(
      fixture.customerSession,
      operation.id,
      outcomeEvidence(operation.id, 'customer_confirmation', 'ev_invalid-confirmation-001'),
    )).toThrowError(expect.objectContaining({ code: 'invalid_transition' }))
    expect(fixture.engine.recordSupportingEvidence(
      fixture.dispatchWorkerSession,
      operation.id,
      outcomeEvidence(operation.id, 'supporting_attachment', 'ev_attachment-001'),
    ).state).toBe('supporting_evidence_received')
    expect(fixture.engine.reconcileEvidence(
      fixture.dispatchWorkerSession,
      operation.id,
      outcomeEvidence(operation.id, 'reconciliation', 'ev_reconciliation-001'),
    ).state).toBe('evidence_reconciled')
    expect(fixture.engine.getOperation(fixture.dispatcherSession, operation.id).state).not.toBe('customer_confirmed')
    expect(() => fixture.engine.confirmCustomerOutcome(
      fixture.customerSession,
      operation.id,
      outcomeEvidence(operation.id, 'customer_confirmation', 'ev_ancient-confirmation-001', {
        observedAt: '2000-01-01T00:00:00.000Z',
      }),
    )).toThrowError(expect.objectContaining({ code: 'evidence_time_invalid' }))
    expect(() => fixture.engine.confirmCustomerOutcome(
      fixture.customerSession,
      operation.id,
      outcomeEvidence(operation.id, 'customer_confirmation', 'ev_attachment-001'),
    )).toThrowError(expect.objectContaining({ code: 'evidence_exists' }))
    expect(fixture.engine.confirmCustomerOutcome(
      fixture.customerSession,
      operation.id,
      outcomeEvidence(operation.id, 'customer_confirmation', 'ev_customer-confirmation-001'),
    ).state).toBe('customer_confirmed')
    expect(fixture.engine.dispute(
      fixture.customerSession,
      operation.id,
      outcomeEvidence(operation.id, 'customer_dispute', 'ev_customer-dispute-001'),
    ).state).toBe('disputed')
    expect(fixture.engine.reopen(
      fixture.customerSession,
      operation.id,
      outcomeEvidence(operation.id, 'reopen', 'ev_reopen-001'),
    ).state).toBe('reopened')

    const receipt = fixture.engine.receipt(fixture.dispatcherSession, operation.id)
    const replay = fixture.engine.receipt(fixture.dispatcherSession, operation.id)
    expect(replay).toEqual(receipt)
    expect(receipt).toMatchObject({
      state: 'reopened',
      operationRevision: 8,
      proposalDigest: current.proposalDigest,
      approvalDigest: approval.digest,
      executionSnapshotDigest: operation.snapshot.digest,
      idempotencyKey: operation.snapshot.idempotencyKey,
      approverId: 'usr_maya',
    })
    expect(receipt.evidenceIds).toEqual([
      'ev_attachment-001',
      'ev_customer-confirmation-001',
      'ev_customer-dispute-001',
      'ev_driver-report-001',
      'ev_reconciliation-001',
      'ev_reopen-001',
    ])
    expect(receipt.evidenceIds).not.toContain('ev_invalid-confirmation-001')
  })

  it('rejects hostile connector bindings and cross-tenant operation access', async () => {
    const fixture = lifecycleFixture()
    const current = decisionInputs()
    fixture.engine.registerDecisionInputs(fixture.preparationWorkerSession, current)
    const approval = fixture.engine.approve(fixture.dispatcherSession, { proposalId: current.proposalId })
    const { operation } = fixture.engine.reserve(fixture.dispatcherSession, { approvalDigest: approval.digest })
    const hostileConnector = {
      async send(snapshot: typeof operation.snapshot) {
        return {
          id: 'assignment-hostile',
          tenantId: snapshot.tenantId,
          operationId: snapshot.operationId,
          idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          snapshotDigest: snapshot.digest,
          proposalDigest: snapshot.proposalDigest,
          approvalDigest: snapshot.approvalDigest,
          routeQuoteHash: snapshot.routeQuoteHash,
          vehicleId: snapshot.vehicleId,
          serviceStart: snapshot.serviceStart,
          serviceEnd: snapshot.serviceEnd,
        }
      },
      async lookup() { return undefined },
    }
    await expect(fixture.engine.dispatch(fixture.dispatchWorkerSession, operation.id, hostileConnector))
      .rejects.toMatchObject({ code: 'connector_binding_mismatch' })
    expect(() => fixture.engine.getOperation(fixture.foreignDispatcherSession, operation.id))
      .toThrowError(expect.objectContaining({ code: 'operation_not_found' }))
  })
})
