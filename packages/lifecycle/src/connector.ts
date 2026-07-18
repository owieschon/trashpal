import { randomUUID } from 'node:crypto'
import { AcknowledgementLostError, LifecycleError } from './errors.js'
import type { DispatchAssignment, DispatchConnector, ExecutionSnapshot } from './types.js'

export type ConnectorAcknowledgement = 'return' | 'lose_once'

export class InMemoryDispatchConnector implements DispatchConnector {
  readonly #assignments = new Map<string, DispatchAssignment>()
  readonly #acknowledgement: ConnectorAcknowledgement
  readonly #lost = new Set<string>()
  sendCount = 0
  lookupCount = 0

  constructor(acknowledgement: ConnectorAcknowledgement = 'return') {
    this.#acknowledgement = acknowledgement
  }

  async send(snapshot: ExecutionSnapshot): Promise<DispatchAssignment> {
    this.sendCount += 1
    const existing = this.#assignments.get(snapshot.idempotencyKey)
    if (existing && existing.snapshotDigest !== snapshot.digest) {
      throw new LifecycleError('idempotency_conflict', 'An idempotency key cannot identify two execution snapshots.')
    }
    const assignment = existing ?? {
      id: `assignment_${randomUUID()}`,
      tenantId: snapshot.tenantId,
      operationId: snapshot.operationId,
      idempotencyKey: snapshot.idempotencyKey,
      snapshotDigest: snapshot.digest,
      proposalDigest: snapshot.proposalDigest,
      approvalDigest: snapshot.approvalDigest,
      routeQuoteHash: snapshot.routeQuoteHash,
      vehicleId: snapshot.vehicleId,
      serviceStart: snapshot.serviceStart,
      serviceEnd: snapshot.serviceEnd,
    }
    this.#assignments.set(snapshot.idempotencyKey, assignment)
    if (this.#acknowledgement === 'lose_once' && !this.#lost.has(snapshot.idempotencyKey)) {
      this.#lost.add(snapshot.idempotencyKey)
      throw new AcknowledgementLostError(snapshot.idempotencyKey)
    }
    return { ...assignment }
  }

  async lookup(idempotencyKey: string): Promise<DispatchAssignment | undefined> {
    this.lookupCount += 1
    const assignment = this.#assignments.get(idempotencyKey)
    return assignment ? { ...assignment } : undefined
  }
}
