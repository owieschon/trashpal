import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  dispatchDigest,
  FileProviderAssignmentStore,
  InMemoryProviderAssignmentStore,
  ProviderAssignmentConflictError,
  ProviderUnavailableError,
  sealExecutionSnapshot,
  SimulatedDispatchConnector,
  type ExecutionSnapshot,
} from '../../packages/adapters/src/index.js'
import { type DispatchConnector as LifecycleDispatchConnector } from '../../packages/lifecycle/src/index.js'
import { decisionInputs, lifecycleFixture, outcomeEvidence } from '../lifecycle/helpers.js'

const clock = () => new Date('2026-07-21T14:00:00-05:00')
const binding = dispatchDigest({ binding: 'fixture' })

function snapshot(overrides: Partial<Omit<ExecutionSnapshot, 'digest'>> = {}): Readonly<ExecutionSnapshot> {
  return sealExecutionSnapshot({
    operationId: 'op_greenleaf-0881',
    tenantId: 'ten_harborworks',
    caseId: 'case_0881',
    proposalId: 'proposal_greenleaf-001',
    proposalDigest: binding,
    contextBundleHash: binding,
    evidencePacketHash: binding,
    approvalDigest: binding,
    approverId: 'usr_maya',
    approverCapability: 'approve_recovery',
    approvalValidUntil: '2026-07-21T15:00:00-05:00',
    evidenceRevision: 4,
    routeRevision: 2,
    routeQuoteHash: binding,
    vehicleId: 'veh_v42',
    serviceStart: '2026-07-21T14:24:00-05:00',
    serviceEnd: '2026-07-21T14:39:00-05:00',
    idempotencyKey: '788efe8c-c21c-4458-8e11-72251a8ba46f',
    capturedAt: '2026-07-21T13:59:00-05:00',
    ...overrides,
  })
}

async function temporaryStorePath(): Promise<Readonly<{ directory: string; path: string }>> {
  const directory = await mkdtemp(join(tmpdir(), 'trashpal-provider-store-'))
  return { directory, path: join(directory, 'assignments.json') }
}

describe('simulated dispatch connector', () => {
  test('requires an explicit assignment store', () => {
    expect(() => new SimulatedDispatchConnector({} as { store: InMemoryProviderAssignmentStore }))
      .toThrow('explicit provider assignment store')
  })

  test('implements the lifecycle connector shape and deduplicates the exact full snapshot', async () => {
    const connector = new SimulatedDispatchConnector({ clock, store: new InMemoryProviderAssignmentStore() })
    const lifecycleConnector: LifecycleDispatchConnector = connector
    const first = await lifecycleConnector.send(snapshot())
    const second = await lifecycleConnector.send(snapshot())
    expect(second).toEqual(first)
    expect(await connector.diagnostics()).toEqual({ sendAttempts: 2, assignmentCount: 1, evidenceEventCount: 0 })
  })

  test('persists provider acceptance across connector recreation after acknowledgement loss', async () => {
    const temporary = await temporaryStorePath()
    try {
      const operation = snapshot()
      const first = new SimulatedDispatchConnector({ mode: 'accept_then_lose_ack', clock, store: new FileProviderAssignmentStore(temporary.path) })
      await expect(first.send(operation)).rejects.toMatchObject({
        code: 'ACKNOWLEDGEMENT_LOST',
        idempotencyKey: operation.idempotencyKey,
        name: 'SimulatedAcknowledgementLostError',
      })

      const recreated = new SimulatedDispatchConnector({ clock, store: new FileProviderAssignmentStore(temporary.path) })
      expect(await recreated.lookup(operation.idempotencyKey)).toMatchObject({ idempotencyKey: operation.idempotencyKey, snapshotDigest: operation.digest })
      expect(await recreated.diagnostics()).toEqual({ sendAttempts: 0, assignmentCount: 1, evidenceEventCount: 0 })
    } finally {
      await rm(temporary.directory, { recursive: true, force: true })
    }
  })

  test('atomically prevents two assignments for one tenant operation or idempotency key', async () => {
    const temporary = await temporaryStorePath()
    try {
      const first = new SimulatedDispatchConnector({ clock, store: new FileProviderAssignmentStore(temporary.path) })
      const second = new SimulatedDispatchConnector({ clock, store: new FileProviderAssignmentStore(temporary.path) })
      const competing = snapshot({ idempotencyKey: 'a6f69843-150d-4059-95fa-e8a82127e312', vehicleId: 'veh_v83' })
      const results = await Promise.allSettled([first.send(snapshot()), second.send(competing)])
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((item): item is PromiseRejectedResult => item.status === 'rejected')
      expect(rejected?.reason).toBeInstanceOf(ProviderAssignmentConflictError)
      expect(await new FileProviderAssignmentStore(temporary.path).count()).toBe(1)
    } finally {
      await rm(temporary.directory, { recursive: true, force: true })
    }
  })

  test('rejects full-snapshot tampering and an idempotency-key binding conflict', async () => {
    const connector = new SimulatedDispatchConnector({ clock, store: new InMemoryProviderAssignmentStore() })
    const original = snapshot()
    await connector.send(original)
    await expect(connector.send({ ...original, vehicleId: 'veh_v17' })).rejects.toThrow('full immutable payload')
    await expect(connector.send(snapshot({ operationId: 'op_other', vehicleId: 'veh_v83' }))).rejects.toBeInstanceOf(ProviderAssignmentConflictError)
  })

  test('keeps provider unavailability explicit and retryable', async () => {
    const connector = new SimulatedDispatchConnector({ mode: 'unavailable', clock, store: new InMemoryProviderAssignmentStore() })
    await expect(connector.send(snapshot())).rejects.toBeInstanceOf(ProviderUnavailableError)
    await expect(connector.lookup(snapshot().idempotencyKey)).rejects.toMatchObject({ retryable: true })
  })

  test('rejects provider acceptance outside the frozen approval interval', async () => {
    const connector = new SimulatedDispatchConnector({
      clock: () => new Date('2026-07-21T15:00:00-05:00'),
      store: new InMemoryProviderAssignmentStore(),
    })
    await expect(connector.send(snapshot())).rejects.toThrow('approval is not valid')
  })

  test('records driver report, attachment, customer confirmation, and dispute as distinct evidence', async () => {
    const connector = new SimulatedDispatchConnector({ clock, store: new InMemoryProviderAssignmentStore() })
    await connector.send(snapshot())
    const driver = await connector.recordDriverCompletion({
      externalEventId: 'ev_driver-1', tenantId: 'ten_harborworks', operationId: 'op_greenleaf-0881',
      reportedAt: '2026-07-21T14:42:00-05:00', result: 'completed',
    })
    const attachment = await connector.recordSupportingAttachment({
      externalEventId: 'ev_attachment-1', tenantId: 'ten_harborworks', operationId: 'op_greenleaf-0881',
      receivedAt: '2026-07-21T14:43:00-05:00', attachmentId: 'provider-attachment-44', mediaType: 'image/jpeg', sha256: binding,
    })
    const confirmation = await connector.recordCustomerConfirmation({
      externalEventId: 'ev_confirmation-1', tenantId: 'ten_harborworks', operationId: 'op_greenleaf-0881',
      confirmedAt: '2026-07-21T15:10:00-05:00', channel: 'portal',
    })
    const dispute = await connector.recordDispute({
      externalEventId: 'ev_dispute-1', tenantId: 'ten_harborworks', operationId: 'op_greenleaf-0881',
      disputedAt: '2026-07-21T16:00:00-05:00', reasonCode: 'service_not_received',
    })
    expect([driver.type, attachment.type, confirmation.type, dispute.type]).toEqual([
      'driver_completion_report_received', 'supporting_attachment_received', 'customer_confirmation_received', 'outcome_disputed',
    ])
    expect(await connector.diagnostics()).toEqual({ sendAttempts: 1, assignmentCount: 1, evidenceEventCount: 4 })
  })
})

describe('lifecycle-shaped adapter composition', () => {
  test('reconciles durable provider acceptance and preserves evidence-state distinctions end to end', async () => {
    const temporary = await temporaryStorePath()
    try {
      const { engine, dispatcherSession, preparationWorkerSession, dispatchWorkerSession, customerSession } = lifecycleFixture()
      const decision = decisionInputs()
      engine.registerDecisionInputs(preparationWorkerSession, decision)
      const approval = engine.approve(dispatcherSession, { proposalId: decision.proposalId })
      const { operation } = engine.reserve(dispatcherSession, { approvalDigest: approval.digest })

      const first: LifecycleDispatchConnector = new SimulatedDispatchConnector({
        mode: 'accept_then_lose_ack', clock, store: new FileProviderAssignmentStore(temporary.path),
      })
      expect((await engine.dispatch(dispatchWorkerSession, operation.id, first)).state).toBe('unknown')

      const recreated = new SimulatedDispatchConnector({ clock, store: new FileProviderAssignmentStore(temporary.path) })
      const second: LifecycleDispatchConnector = recreated
      expect((await engine.reconcile(dispatchWorkerSession, operation.id, second)).operation.state).toBe('assignment_reconciled')

      const driver = await recreated.recordDriverCompletion({
        externalEventId: 'ev_driver-report-001', tenantId: decision.tenantId, operationId: operation.id,
        reportedAt: '2026-07-21T19:42:00.000Z', result: 'completed',
      })
      expect(engine.recordDriverReport(dispatchWorkerSession, operation.id, outcomeEvidence(operation.id, 'driver_report', driver.eventId)).state).toBe('driver_reported')
      expect(engine.getOperation(dispatcherSession, operation.id).state).not.toBe('customer_confirmed')
      const attachment = await recreated.recordSupportingAttachment({
        externalEventId: 'ev_attachment-001', tenantId: decision.tenantId, operationId: operation.id,
        receivedAt: '2026-07-21T19:43:00.000Z', attachmentId: 'attachment_1', mediaType: 'image/jpeg', sha256: binding,
      })
      expect(engine.recordSupportingEvidence(dispatchWorkerSession, operation.id, outcomeEvidence(operation.id, 'supporting_attachment', attachment.eventId)).state).toBe('supporting_evidence_received')
      expect(engine.reconcileEvidence(dispatchWorkerSession, operation.id, outcomeEvidence(operation.id, 'reconciliation', 'ev_reconciliation-001')).state).toBe('evidence_reconciled')
      const confirmation = await recreated.recordCustomerConfirmation({
        externalEventId: 'ev_customer-confirmation-001', tenantId: decision.tenantId, operationId: operation.id,
        confirmedAt: '2026-07-21T20:00:00.000Z', channel: 'portal',
      })
      expect(engine.confirmCustomerOutcome(customerSession, operation.id, outcomeEvidence(operation.id, 'customer_confirmation', confirmation.eventId)).state).toBe('customer_confirmed')
      const dispute = await recreated.recordDispute({
        externalEventId: 'ev_customer-dispute-001', tenantId: decision.tenantId, operationId: operation.id,
        disputedAt: '2026-07-21T20:05:00.000Z', reasonCode: 'service_not_received',
      })
      expect(engine.dispute(customerSession, operation.id, outcomeEvidence(operation.id, 'customer_dispute', dispute.eventId)).state).toBe('disputed')
      expect(await new FileProviderAssignmentStore(temporary.path).count()).toBe(1)
    } finally {
      await rm(temporary.directory, { recursive: true, force: true })
    }
  })
})
