import { createHmac, randomBytes } from 'node:crypto'
import { equalText } from './canonical.js'
import { LifecycleError } from './errors.js'
import type { Capability, Clock, Principal, PrincipalKind, UserCapability, WorkerCapability } from './types.js'
import { assertIdentifier } from './validation.js'

interface StoredPrincipal {
  subjectId: string
  tenantId: string
  kind: PrincipalKind
  capabilities: Set<Capability>
  enabled: boolean
  issuedAtMs: number
  expiresAtMs: number
}

const systemClock: Clock = { now: () => new Date() }
const defaultSessionTtlMs = 5 * 60 * 1_000
const maxSessionTtlMs = 60 * 60 * 1_000
const userSubjectIdPattern = /^(?:usr|svc)[-_][a-z0-9_-]+$/
const workerSubjectIdPattern = /^(?:worker|wrk)[-_][a-z0-9_-]+$/

export class ProcessSessionAuthority {
  readonly #secret: Buffer
  readonly #clock: Clock
  readonly #defaultTtlMs: number
  readonly #sessions = new Map<string, StoredPrincipal>()

  constructor(
    secret: Buffer = randomBytes(32),
    options: { clock?: Clock; defaultTtlMs?: number } = {},
  ) {
    if (secret.length < 32) throw new LifecycleError('weak_session_secret', 'Session signing requires at least 256 bits.')
    this.#secret = Buffer.from(secret)
    this.#clock = options.clock ?? systemClock
    this.#defaultTtlMs = this.#validatedTtl(options.defaultTtlMs ?? defaultSessionTtlMs)
  }

  issue(input: {
    subjectId: string
    tenantId: string
    capabilities: readonly UserCapability[]
    ttlMs?: number
  }): string {
    return this.#issue('user', input.subjectId, input.tenantId, input.capabilities, input.ttlMs)
  }

  issueWorker(input: {
    workerId: string
    tenantId: string
    capabilities: readonly WorkerCapability[]
    ttlMs?: number
  }): string {
    return this.#issue('worker', input.workerId, input.tenantId, input.capabilities, input.ttlMs)
  }

  resolve(token: string): Principal {
    const match = /^tp_test_([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(token)
    if (!match || match[1] === undefined || match[2] === undefined || !equalText(this.#sign(match[1]), match[2])) {
      throw new LifecycleError('invalid_session', 'The session is invalid.')
    }
    const principal = this.#sessions.get(this.#tokenDigest(token))
    const nowMs = this.#clock.now().valueOf()
    if (!principal?.enabled || !Number.isFinite(nowMs) || nowMs >= principal.expiresAtMs) {
      if (principal) principal.enabled = false
      throw new LifecycleError('invalid_session', 'The session is invalid, expired, or revoked.')
    }
    return {
      subjectId: principal.subjectId,
      tenantId: principal.tenantId,
      kind: principal.kind,
      capabilities: new Set(principal.capabilities),
      enabled: principal.enabled,
      issuedAt: new Date(principal.issuedAtMs).toISOString(),
      expiresAt: new Date(principal.expiresAtMs).toISOString(),
    }
  }

  revokeSession(token: string): void {
    const principal = this.#sessions.get(this.#tokenDigest(token))
    if (principal) principal.enabled = false
  }

  revokeCapability(subjectId: string, tenantId: string, capability: Capability): void {
    for (const principal of this.#sessions.values()) {
      if (principal.subjectId === subjectId && principal.tenantId === tenantId) principal.capabilities.delete(capability)
    }
  }

  revokePrincipal(subjectId: string, tenantId: string): void {
    for (const principal of this.#sessions.values()) {
      if (principal.subjectId === subjectId && principal.tenantId === tenantId) principal.enabled = false
    }
  }

  hasCapability(subjectId: string, tenantId: string, capability: Capability, kind?: PrincipalKind): boolean {
    const nowMs = this.#clock.now().valueOf()
    for (const principal of this.#sessions.values()) {
      if (
        principal.enabled
        && principal.expiresAtMs > nowMs
        && principal.subjectId === subjectId
        && principal.tenantId === tenantId
        && (kind === undefined || principal.kind === kind)
        && principal.capabilities.has(capability)
      ) return true
    }
    return false
  }

  #issue(
    kind: PrincipalKind,
    subjectId: string,
    tenantId: string,
    capabilities: readonly Capability[],
    requestedTtlMs?: number,
  ): string {
    const subjectPattern = kind === 'user' ? userSubjectIdPattern : workerSubjectIdPattern
    if (!subjectPattern.test(subjectId)) {
      throw new LifecycleError('invalid_principal', `A ${kind} principal requires its matching branded subject identifier.`)
    }
    assertIdentifier(tenantId, 'tenant')
    const ttlMs = this.#validatedTtl(requestedTtlMs ?? this.#defaultTtlMs)
    const issuedAtMs = this.#clock.now().valueOf()
    if (!Number.isFinite(issuedAtMs)) throw new LifecycleError('invalid_time', 'Session clock returned an invalid time.')
    const nonce = randomBytes(24).toString('base64url')
    const signature = this.#sign(nonce)
    const token = `tp_test_${nonce}.${signature}`
    this.#sessions.set(this.#tokenDigest(token), {
      subjectId,
      tenantId,
      kind,
      capabilities: new Set(capabilities),
      enabled: true,
      issuedAtMs,
      expiresAtMs: issuedAtMs + ttlMs,
    })
    return token
  }

  #validatedTtl(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maxSessionTtlMs) {
      throw new LifecycleError('invalid_session_ttl', 'Session TTL must be between one millisecond and one hour.')
    }
    return value
  }

  #sign(nonce: string): string {
    return createHmac('sha256', this.#secret).update(`trashpal-test-session-v1:${nonce}`).digest('hex')
  }

  #tokenDigest(token: string): string {
    return createHmac('sha256', this.#secret).update(`registry:${token}`).digest('hex')
  }
}

export function rejectCallerIdentity(input: Readonly<Record<string, unknown>>): void {
  const forbidden = ['actorId', 'approverId', 'subjectId', 'tenantId', 'role', 'capability', 'capabilities']
  const supplied = forbidden.find((key) => Object.hasOwn(input, key))
  if (supplied) {
    throw new LifecycleError('caller_identity_forbidden', `Caller-supplied identity field ${supplied} is not accepted.`)
  }
}
