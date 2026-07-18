import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ExecutionSnapshot {
  operationId: string
  tenantId: string
  caseId: string
  proposalId: string
  proposalDigest: string
  contextBundleHash: string
  evidencePacketHash: string
  approvalDigest: string
  approverId: string
  approverCapability: 'approve_recovery'
  approvalValidUntil: string
  evidenceRevision: number
  routeRevision: number
  routeQuoteHash: string
  vehicleId: string
  serviceStart: string
  serviceEnd: string
  idempotencyKey: string
  capturedAt: string
  digest: string
}

export interface DispatchAssignment {
  id: string
  tenantId: string
  operationId: string
  idempotencyKey: string
  snapshotDigest: string
  proposalDigest: string
  approvalDigest: string
  routeQuoteHash: string
  vehicleId: string
  serviceStart: string
  serviceEnd: string
}

export interface DispatchConnector {
  send(snapshot: ExecutionSnapshot): Promise<DispatchAssignment>
  lookup(idempotencyKey: string): Promise<DispatchAssignment | undefined>
}

export type ProviderAssignmentRecord = Readonly<DispatchAssignment & {
  acceptedAt: string
}>

export interface ProviderAssignmentStore {
  createOrGet(record: ProviderAssignmentRecord): Promise<Readonly<{ assignment: ProviderAssignmentRecord; created: boolean }>>
  findByIdempotencyKey(idempotencyKey: string): Promise<ProviderAssignmentRecord | undefined>
  findByOperation(tenantId: string, operationId: string): Promise<ProviderAssignmentRecord | undefined>
  count(): Promise<number>
}

export type DispatchEvidenceEvent = Readonly<{
  eventId: string
  tenantId: string
  operationId: string
  providerAssignmentId: string
  type:
    | 'driver_completion_report_received'
    | 'supporting_attachment_received'
    | 'customer_confirmation_received'
    | 'outcome_disputed'
  occurredAt: string
  payload: Readonly<Record<string, unknown>>
  digest: string
}>

export type SimulatedDispatchMode = 'accept' | 'accept_then_lose_ack' | 'unavailable'

export class SimulatedAcknowledgementLostError extends Error {
  readonly code = 'ACKNOWLEDGEMENT_LOST' as const

  constructor(readonly idempotencyKey: string) {
    super('The provider accepted the assignment but its acknowledgement was lost.')
    this.name = 'SimulatedAcknowledgementLostError'
  }
}

export class ProviderUnavailableError extends Error {
  readonly retryable = true

  constructor() {
    super('The simulated dispatch provider is unavailable.')
    this.name = 'ProviderUnavailableError'
  }
}

export class ProviderAssignmentConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderAssignmentConflictError'
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

export function dispatchDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function unsignedExecutionSnapshot(snapshot: ExecutionSnapshot): Omit<ExecutionSnapshot, 'digest'> {
  return {
    operationId: snapshot.operationId,
    tenantId: snapshot.tenantId,
    caseId: snapshot.caseId,
    proposalId: snapshot.proposalId,
    proposalDigest: snapshot.proposalDigest,
    contextBundleHash: snapshot.contextBundleHash,
    evidencePacketHash: snapshot.evidencePacketHash,
    approvalDigest: snapshot.approvalDigest,
    approverId: snapshot.approverId,
    approverCapability: snapshot.approverCapability,
    approvalValidUntil: snapshot.approvalValidUntil,
    evidenceRevision: snapshot.evidenceRevision,
    routeRevision: snapshot.routeRevision,
    routeQuoteHash: snapshot.routeQuoteHash,
    vehicleId: snapshot.vehicleId,
    serviceStart: snapshot.serviceStart,
    serviceEnd: snapshot.serviceEnd,
    idempotencyKey: snapshot.idempotencyKey,
    capturedAt: snapshot.capturedAt,
  }
}

export function sealExecutionSnapshot(snapshot: Omit<ExecutionSnapshot, 'digest'>): Readonly<ExecutionSnapshot> {
  const sealed = { ...structuredClone(snapshot), digest: dispatchDigest(snapshot) }
  return Object.freeze(sealed)
}

function validateSnapshot(snapshot: ExecutionSnapshot): void {
  const hex = /^[a-f0-9]{64}$/
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!/^op[-_][a-z0-9-]+$/.test(snapshot.operationId)
    || !/^ten[-_][a-z0-9-]+$/.test(snapshot.tenantId)
    || !/^case[-_][a-z0-9-]+$/.test(snapshot.caseId)
    || !/^proposal[-_][a-z0-9-]+$/.test(snapshot.proposalId)
    || !snapshot.approverId
    || snapshot.approverCapability !== 'approve_recovery'
    || !snapshot.vehicleId
    || !uuid.test(snapshot.idempotencyKey)) throw new Error('execution snapshot identity is incomplete or malformed')
  if (![snapshot.proposalDigest, snapshot.contextBundleHash, snapshot.evidencePacketHash, snapshot.approvalDigest, snapshot.routeQuoteHash, snapshot.digest].every((item) => hex.test(item))) {
    throw new Error('execution snapshot bindings are invalid')
  }
  if (![snapshot.evidenceRevision, snapshot.routeRevision].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('execution snapshot revisions are invalid')
  const capturedAt = Date.parse(snapshot.capturedAt)
  const approvalValidUntil = Date.parse(snapshot.approvalValidUntil)
  const serviceStart = Date.parse(snapshot.serviceStart)
  const serviceEnd = Date.parse(snapshot.serviceEnd)
  if (![capturedAt, approvalValidUntil, serviceStart, serviceEnd].every(Number.isFinite) || capturedAt >= approvalValidUntil || serviceStart >= serviceEnd) throw new Error('execution snapshot timestamps are invalid')
  if (dispatchDigest(unsignedExecutionSnapshot(snapshot)) !== snapshot.digest) throw new Error('execution snapshot digest does not match its full immutable payload')
}

function assignmentConflict(assignments: readonly ProviderAssignmentRecord[], candidate: ProviderAssignmentRecord): ProviderAssignmentRecord | undefined {
  const sameKey = assignments.find((item) => item.idempotencyKey === candidate.idempotencyKey)
  if (sameKey && !sameAssignmentBinding(sameKey, candidate)) {
    throw new ProviderAssignmentConflictError('idempotency key is already bound to another tenant, operation, or snapshot')
  }
  const sameOperation = assignments.find((item) => item.tenantId === candidate.tenantId && item.operationId === candidate.operationId)
  if (sameOperation && !sameAssignmentBinding(sameOperation, candidate)) {
    throw new ProviderAssignmentConflictError('tenant operation is already bound to another idempotency key or snapshot')
  }
  return sameKey ?? sameOperation
}

function sameAssignmentBinding(left: ProviderAssignmentRecord, right: ProviderAssignmentRecord): boolean {
  return left.id === right.id
    && left.tenantId === right.tenantId
    && left.operationId === right.operationId
    && left.idempotencyKey === right.idempotencyKey
    && left.snapshotDigest === right.snapshotDigest
    && left.proposalDigest === right.proposalDigest
    && left.approvalDigest === right.approvalDigest
    && left.routeQuoteHash === right.routeQuoteHash
    && left.vehicleId === right.vehicleId
    && left.serviceStart === right.serviceStart
    && left.serviceEnd === right.serviceEnd
}

function copyAssignment(record: ProviderAssignmentRecord): ProviderAssignmentRecord {
  return Object.freeze(structuredClone(record))
}

function publicAssignment(record: ProviderAssignmentRecord): DispatchAssignment {
  return structuredClone({
    id: record.id,
    tenantId: record.tenantId,
    operationId: record.operationId,
    idempotencyKey: record.idempotencyKey,
    snapshotDigest: record.snapshotDigest,
    proposalDigest: record.proposalDigest,
    approvalDigest: record.approvalDigest,
    routeQuoteHash: record.routeQuoteHash,
    vehicleId: record.vehicleId,
    serviceStart: record.serviceStart,
    serviceEnd: record.serviceEnd,
  })
}

function validateAssignment(record: ProviderAssignmentRecord): void {
  const hex = /^[a-f0-9]{64}$/
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const expectedId = `assignment_${dispatchDigest({
    tenantId: record.tenantId,
    operationId: record.operationId,
    idempotencyKey: record.idempotencyKey,
    snapshotDigest: record.snapshotDigest,
  }).slice(0, 24)}`
  if (record.id !== expectedId
    || !/^ten[-_][a-z0-9-]+$/.test(record.tenantId)
    || !/^op[-_][a-z0-9-]+$/.test(record.operationId)
    || !uuid.test(record.idempotencyKey)
    || !record.vehicleId
    || ![record.snapshotDigest, record.proposalDigest, record.approvalDigest, record.routeQuoteHash].every((value) => hex.test(value))) {
    throw new Error('provider assignment binding is malformed')
  }
  const serviceStart = Date.parse(record.serviceStart)
  const serviceEnd = Date.parse(record.serviceEnd)
  if (!Number.isFinite(serviceStart) || !Number.isFinite(serviceEnd) || serviceStart >= serviceEnd || !Number.isFinite(Date.parse(record.acceptedAt))) {
    throw new Error('provider assignment timestamps are malformed')
  }
}

export class InMemoryProviderAssignmentStore implements ProviderAssignmentStore {
  readonly #assignments: ProviderAssignmentRecord[] = []

  async createOrGet(record: ProviderAssignmentRecord): Promise<Readonly<{ assignment: ProviderAssignmentRecord; created: boolean }>> {
    validateAssignment(record)
    const prior = assignmentConflict(this.#assignments, record)
    if (prior) return { assignment: copyAssignment(prior), created: false }
    this.#assignments.push(copyAssignment(record))
    return { assignment: copyAssignment(record), created: true }
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ProviderAssignmentRecord | undefined> {
    const assignment = this.#assignments.find((item) => item.idempotencyKey === idempotencyKey)
    return assignment ? copyAssignment(assignment) : undefined
  }

  async findByOperation(tenantId: string, operationId: string): Promise<ProviderAssignmentRecord | undefined> {
    const assignment = this.#assignments.find((item) => item.tenantId === tenantId && item.operationId === operationId)
    return assignment ? copyAssignment(assignment) : undefined
  }

  async count(): Promise<number> {
    return this.#assignments.length
  }
}

type AssignmentFile = Readonly<{ version: 1; assignments: readonly ProviderAssignmentRecord[] }>

function parseAssignmentFile(value: unknown): AssignmentFile {
  if (value === null || typeof value !== 'object') throw new Error('provider assignment store is malformed')
  const document = value as Record<string, unknown>
  if (document.version !== 1 || !Array.isArray(document.assignments)) throw new Error('provider assignment store is malformed')
  const idempotencyKeys = new Set<string>()
  const operations = new Set<string>()
  for (const item of document.assignments) {
    if (item === null || typeof item !== 'object') throw new Error('provider assignment store is malformed')
    const record = item as ProviderAssignmentRecord
    try {
      validateAssignment(record)
    } catch {
      throw new Error('provider assignment store is malformed')
    }
    const operationKey = `${record.tenantId}\u0000${record.operationId}`
    if (idempotencyKeys.has(record.idempotencyKey) || operations.has(operationKey)) throw new Error('provider assignment store contains duplicate bindings')
    idempotencyKeys.add(record.idempotencyKey)
    operations.add(operationKey)
  }
  return document as unknown as AssignmentFile
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class FileProviderAssignmentStore implements ProviderAssignmentStore {
  readonly #path: string
  readonly #lockPath: string

  constructor(path: string) {
    if (!path) throw new Error('provider assignment store path is required')
    this.#path = path
    this.#lockPath = `${path}.lock`
  }

  async createOrGet(record: ProviderAssignmentRecord): Promise<Readonly<{ assignment: ProviderAssignmentRecord; created: boolean }>> {
    validateAssignment(record)
    return this.#withLock<{ assignment: ProviderAssignmentRecord; created: boolean }>(async (document) => {
      const prior = assignmentConflict(document.assignments, record)
      if (prior) return { value: { assignment: copyAssignment(prior), created: false }, next: document }
      const next = { version: 1 as const, assignments: [...document.assignments, copyAssignment(record)] }
      return { value: { assignment: copyAssignment(record), created: true }, next }
    })
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ProviderAssignmentRecord | undefined> {
    return this.#withLock(async (document) => ({
      value: document.assignments.find((item) => item.idempotencyKey === idempotencyKey),
      next: document,
    })).then((item) => item ? copyAssignment(item) : undefined)
  }

  async findByOperation(tenantId: string, operationId: string): Promise<ProviderAssignmentRecord | undefined> {
    return this.#withLock(async (document) => ({
      value: document.assignments.find((item) => item.tenantId === tenantId && item.operationId === operationId),
      next: document,
    })).then((item) => item ? copyAssignment(item) : undefined)
  }

  async count(): Promise<number> {
    return this.#withLock(async (document) => ({ value: document.assignments.length, next: document }))
  }

  async #withLock<T>(operation: (document: AssignmentFile) => Promise<Readonly<{ value: T; next: AssignmentFile }>>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true })
    let lock: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        lock = await open(this.#lockPath, 'wx', 0o600)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await delay(5)
      }
    }
    if (!lock) throw new Error('provider assignment store lock timed out')
    try {
      const document = await this.#read()
      const result = await operation(document)
      if (JSON.stringify(result.next) !== JSON.stringify(document)) await this.#write(result.next)
      return result.value
    } finally {
      await lock.close()
      await unlink(this.#lockPath).catch(() => undefined)
    }
  }

  async #read(): Promise<AssignmentFile> {
    try {
      return parseAssignmentFile(JSON.parse(await readFile(this.#path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, assignments: [] }
      throw error
    }
  }

  async #write(document: AssignmentFile): Promise<void> {
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      await rename(temporary, this.#path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}

export class SimulatedDispatchConnector implements DispatchConnector {
  readonly #mode: SimulatedDispatchMode
  readonly #clock: () => Date
  readonly #store: ProviderAssignmentStore
  readonly #eventsByExternalId = new Map<string, DispatchEvidenceEvent>()
  #sendAttempts = 0

  constructor(options: Readonly<{
    store: ProviderAssignmentStore
    mode?: SimulatedDispatchMode
    clock?: () => Date
  }>) {
    if (!options?.store) throw new Error('simulated dispatch requires an explicit provider assignment store')
    this.#mode = options.mode ?? 'accept'
    this.#clock = options.clock ?? (() => new Date())
    this.#store = options.store
  }

  async send(snapshot: ExecutionSnapshot): Promise<DispatchAssignment> {
    validateSnapshot(snapshot)
    this.#sendAttempts += 1
    if (this.#mode === 'unavailable') throw new ProviderUnavailableError()
    const acceptedAtDate = this.#clock()
    const acceptedAtMs = acceptedAtDate.getTime()
    if (!Number.isFinite(acceptedAtMs)
      || acceptedAtMs < Date.parse(snapshot.capturedAt)
      || acceptedAtMs >= Date.parse(snapshot.approvalValidUntil)) {
      throw new Error('execution snapshot approval is not valid at provider acceptance')
    }
    const acceptedAt = acceptedAtDate.toISOString()
    const candidate: ProviderAssignmentRecord = {
      id: `assignment_${dispatchDigest({ tenantId: snapshot.tenantId, operationId: snapshot.operationId, idempotencyKey: snapshot.idempotencyKey, snapshotDigest: snapshot.digest }).slice(0, 24)}`,
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
      acceptedAt,
    }
    const { assignment, created } = await this.#store.createOrGet(candidate)
    if (this.#mode === 'accept_then_lose_ack' && created) throw new SimulatedAcknowledgementLostError(snapshot.idempotencyKey)
    return publicAssignment(assignment)
  }

  async lookup(idempotencyKey: string): Promise<DispatchAssignment | undefined> {
    if (this.#mode === 'unavailable') throw new ProviderUnavailableError()
    const assignment = await this.#store.findByIdempotencyKey(idempotencyKey)
    return assignment ? publicAssignment(assignment) : undefined
  }

  async recordDriverCompletion(input: Readonly<{
    externalEventId: string
    tenantId: string
    operationId: string
    reportedAt: string
    result: 'completed' | 'unable_to_complete'
    reason?: string
  }>): Promise<DispatchEvidenceEvent> {
    return this.#recordEvent(input, 'driver_completion_report_received', { result: input.result, ...(input.reason ? { reason: input.reason } : {}) })
  }

  async recordSupportingAttachment(input: Readonly<{
    externalEventId: string
    tenantId: string
    operationId: string
    receivedAt: string
    attachmentId: string
    mediaType: string
    sha256: string
  }>): Promise<DispatchEvidenceEvent> {
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('supporting attachment requires a SHA-256 digest')
    return this.#recordEvent({ ...input, reportedAt: input.receivedAt }, 'supporting_attachment_received', { attachmentId: input.attachmentId, mediaType: input.mediaType, sha256: input.sha256 })
  }

  async recordCustomerConfirmation(input: Readonly<{
    externalEventId: string
    tenantId: string
    operationId: string
    confirmedAt: string
    channel: 'support' | 'portal' | 'phone'
  }>): Promise<DispatchEvidenceEvent> {
    return this.#recordEvent({ ...input, reportedAt: input.confirmedAt }, 'customer_confirmation_received', { channel: input.channel })
  }

  async recordDispute(input: Readonly<{
    externalEventId: string
    tenantId: string
    operationId: string
    disputedAt: string
    reasonCode: string
  }>): Promise<DispatchEvidenceEvent> {
    return this.#recordEvent({ ...input, reportedAt: input.disputedAt }, 'outcome_disputed', { reasonCode: input.reasonCode })
  }

  async diagnostics(): Promise<Readonly<{ sendAttempts: number; assignmentCount: number; evidenceEventCount: number }>> {
    return { sendAttempts: this.#sendAttempts, assignmentCount: await this.#store.count(), evidenceEventCount: this.#eventsByExternalId.size }
  }

  async #recordEvent(
    input: Readonly<{ externalEventId: string; tenantId: string; operationId: string; reportedAt: string }>,
    type: DispatchEvidenceEvent['type'],
    payload: Readonly<Record<string, unknown>>,
  ): Promise<DispatchEvidenceEvent> {
    const assignment = await this.#store.findByOperation(input.tenantId, input.operationId)
    if (!assignment) throw new Error('dispatch evidence does not match a provider assignment in this tenant')
    if (!input.externalEventId || !Number.isFinite(Date.parse(input.reportedAt))) throw new Error('dispatch evidence identity and timestamp are required')
    const prior = this.#eventsByExternalId.get(input.externalEventId)
    const unsigned = {
      eventId: input.externalEventId,
      tenantId: input.tenantId,
      operationId: input.operationId,
      providerAssignmentId: assignment.id,
      type,
      occurredAt: new Date(input.reportedAt).toISOString(),
      payload,
    }
    const event = Object.freeze({ ...unsigned, digest: dispatchDigest(unsigned) })
    if (prior) {
      if (prior.digest !== event.digest) throw new Error('provider event ID was reused for different evidence')
      return Object.freeze(structuredClone(prior))
    }
    this.#eventsByExternalId.set(input.externalEventId, event)
    return Object.freeze(structuredClone(event))
  }
}
