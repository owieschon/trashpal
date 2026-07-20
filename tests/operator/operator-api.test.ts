import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ProcessSessionAuthority,
  createLifecyclePostgresPool,
  type LifecyclePostgresPool,
} from '../../packages/lifecycle/src/index.js'
import {
  InMemoryProviderAssignmentStore,
  SimulatedDispatchConnector,
} from '../../packages/adapters/src/index.js'
import { RouteQuoteSchema, contentDigest } from '../../packages/contracts/src/index.js'
import type { RecoveryRoutePlannerPort } from '../../packages/agent/src/index.js'
import {
  GreenleafOperatorCaseId,
  LocalDemoSessionStore,
  createComposedRuntime,
  createTrashPalOperatorApi,
  type ComposedRuntime,
} from '../../apps/server/src/index.js'
import { createSyntheticRecordedRecoveryCase, type SyntheticRecoverySourceFactory } from '../../apps/server/src/synthetic-source.js'

type Api = ReturnType<typeof createTrashPalOperatorApi>
type JsonObject = Record<string, unknown>

interface Harness {
  readonly app: Api
  readonly runtime: ComposedRuntime
  readonly authority: ProcessSessionAuthority
  readonly sessions: LocalDemoSessionStore
  readonly connector: SimulatedDispatchConnector
  readonly dispatcherSession: string
  readonly foreignSession: string
  readonly workerTokens: readonly string[]
}

const tenantId = 'ten_harborworks'
const databaseUrl = process.env.TEST_DATABASE_URL ?? ''
const describePostgres = databaseUrl ? describe : describe.skip
const migrationUrl = new URL('../../drizzle/0000_durable_lifecycle.sql', import.meta.url)

let bootstrapPool: LifecyclePostgresPool
let pool: LifecyclePostgresPool
let schema = ''
const apps: Api[] = []

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as JsonObject
}

function field(value: JsonObject, key: string): JsonObject {
  return asObject(value[key], key)
}

function text(value: JsonObject, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error(`${key} must be a non-empty string.`)
  return candidate
}

function cookieFrom(response: Awaited<ReturnType<Api['inject']>>): string {
  const setCookie = response.headers['set-cookie']
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (typeof value !== 'string') throw new Error('Local session did not set a cookie.')
  expect(value).toContain('HttpOnly')
  expect(value).toContain('SameSite=Strict')
  return value.split(';')[0]!
}

async function request(
  app: Api,
  cookie: string | undefined,
  input: Readonly<{ method: 'GET' | 'POST'; url: string; payload?: JsonObject }>,
) {
  const response = await app.inject({
    method: input.method,
    url: input.url,
    ...(cookie ? { headers: { cookie } } : {}),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  })
  return { response, body: asObject(response.json(), 'response') }
}

function deterministicRoutePlanner(now: () => Date): RecoveryRoutePlannerPort {
  return {
    async quoteRecovery(input) {
      const base = now().valueOf()
      const unsigned = {
        id: `quote_${contentDigest({ tenantId: input.tenantId, caseId: input.caseId }).slice(0, 24)}`,
        tenantId: input.tenantId,
        vehicleId: 'veh_v42',
        serviceStart: new Date(base + 45 * 60 * 1_000).toISOString(),
        serviceEnd: new Date(base + 60 * 60 * 1_000).toISOString(),
        validUntil: new Date(base + 90 * 60 * 1_000).toISOString(),
        remainingCapacityKg: 430,
        incrementalMinutes: 15,
      }
      return { status: 'feasible' as const, quote: RouteQuoteSchema.parse({ ...unsigned, hash: contentDigest(unsigned) }) }
    },
  }
}

function harness(options: Readonly<{
  sourceFactory?: SyntheticRecoverySourceFactory
  connectorClock?: () => Date
}> = {}): Harness {
  const authority = new ProcessSessionAuthority(Buffer.alloc(32, 89), { defaultTtlMs: 60 * 60 * 1_000 })
  const dispatcherSession = authority.issue({
    subjectId: 'usr_operator_dispatcher',
    tenantId,
    capabilities: ['read_lifecycle', 'approve_recovery'],
  })
  const foreignSession = authority.issue({
    subjectId: 'usr_operator_foreign',
    tenantId: 'ten_riverview',
    capabilities: ['read_lifecycle', 'approve_recovery'],
  })
  const preparationWorker = authority.issueWorker({
    workerId: 'worker_operator_prepare',
    tenantId,
    capabilities: ['prepare_decision_inputs'],
  })
  const dispatchWorker = authority.issueWorker({
    workerId: 'worker_operator_dispatch',
    tenantId,
    capabilities: ['dispatch_recovery', 'reconcile_dispatch', 'record_provider_evidence'],
  })
  const connector = new SimulatedDispatchConnector({
    store: new InMemoryProviderAssignmentStore(),
    mode: 'accept_then_lose_ack',
    ...(options.connectorClock ? { clock: options.connectorClock } : {}),
  })
  const runtime = createComposedRuntime({
    pool,
    authority,
    connector,
    workers: { preparation: preparationWorker, dispatch: dispatchWorker },
    routePlanner: deterministicRoutePlanner(() => new Date()),
    ...(options.sourceFactory ? { sourceFactory: options.sourceFactory } : {}),
  })
  const sessions = new LocalDemoSessionStore({ authority, dispatcherSession })
  const app = createTrashPalOperatorApi({ runtime, sessions })
  apps.push(app)
  return {
    app,
    runtime,
    authority,
    sessions,
    connector,
    dispatcherSession,
    foreignSession,
    workerTokens: [preparationWorker, dispatchWorker],
  }
}

function expiringSourceFactory(validForMs: number): SyntheticRecoverySourceFactory {
  return (input) => ({
    ...createSyntheticRecordedRecoveryCase(input),
    evidenceValidUntil: new Date(input.now.valueOf() + validForMs).toISOString(),
  })
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function localCookie(value: Harness): Promise<string> {
  const response = await request(value.app, undefined, { method: 'POST', url: '/v1/operator/session' })
  expect(response.response.statusCode).toBe(200)
  expect(field(response.body, 'session').mode).toBe('local_demo')
  return cookieFrom(response.response)
}

function noWorkerLeak(value: Harness, response: Awaited<ReturnType<Api['inject']>>): void {
  const rendered = `${response.body}\n${JSON.stringify(response.headers)}`
  for (const token of value.workerTokens) expect(rendered).not.toContain(token)
  expect(rendered).not.toContain(value.dispatcherSession)
}

describePostgres('local operator facade', () => {
  beforeAll(async () => {
    schema = `operator_api_${randomUUID().replaceAll('-', '')}`
    bootstrapPool = createLifecyclePostgresPool({ connectionString: databaseUrl, max: 2 })
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`)
    pool = createLifecyclePostgresPool({ connectionString: databaseUrl, searchPath: schema, max: 12 })
    await pool.query(await readFile(migrationUrl, 'utf8'))
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE lifecycle_cases, lifecycle_principals CASCADE')
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => await app.close()))
  })

  afterAll(async () => {
    if (pool) await pool.end()
    if (bootstrapPool && schema) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await bootstrapPool.end()
    }
  })

  it('issues only an HttpOnly opaque cookie and keeps the initial view honestly pre-prepare', async () => {
    const value = harness()
    const cookie = await localCookie(value)
    const initial = await request(value.app, cookie, { method: 'GET', url: `/v1/operator/cases/${GreenleafOperatorCaseId}` })

    expect(initial.response.statusCode).toBe(200)
    const view = field(initial.body, 'case')
    expect(field(view, 'summary').phase).toBe('source_records_available')
    expect(field(view, 'nextAction').kind).toBe('prepare')
    expect(view.proposal).toBeUndefined()
    expect(JSON.stringify(view)).toContain('Pal has not prepared a recovery yet.')
    expect(view.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Signal received', status: 'current' }),
    ]))
    expect(initial.response.headers['cache-control']).toBe('no-store')
    noWorkerLeak(value, initial.response)
  })

  it('accepts one bounded access observation and returns distinct rerun results', async () => {
    const value = harness()
    const cookie = await localCookie(value)
    const queue = await request(value.app, cookie, { method: 'GET', url: '/v1/operator/cases' })
    expect(queue.response.statusCode).toBe(200)
    expect(queue.body.cases).toHaveLength(3)

    const blocked = await request(value.app, cookie, {
      method: 'POST',
      url: '/v1/operator/cases/case_riverbend-operator/evidence',
      payload: { accessStatus: 'blocked' },
    })
    expect(blocked.response.statusCode).toBe(200)
    expect(field(blocked.body, 'evidenceUpdate')).toMatchObject({ accessStatus: 'blocked', result: 'blocked_by_field_evidence' })
    const blockedCase = field(blocked.body, 'case')
    expect(blockedCase.proposal).toBeUndefined()
    expect(field(blockedCase, 'nextAction')).toMatchObject({ kind: 'record_evidence', label: 'Resolve the access conflict' })
    expect(blockedCase.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Fresh access observation recorded', status: 'complete' }),
      expect.objectContaining({ label: 'Held for confirmation', status: 'current' }),
    ]))
    expect(field(blockedCase, 'palRun').includedEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.any(String), source: expect.any(String), freshness: expect.any(String), reason: expect.any(String) }),
    ]))

    const unknown = await request(value.app, cookie, {
      method: 'POST',
      url: '/v1/operator/cases/case_northstar-operator/evidence',
      payload: { accessStatus: 'unknown' },
    })
    expect(unknown.response.statusCode).toBe(200)
    expect(field(unknown.body, 'evidenceUpdate')).toMatchObject({ accessStatus: 'unknown', result: 'needs_fresh_confirmation' })
    expect(field(field(unknown.body, 'case'), 'nextAction')).toMatchObject({ kind: 'record_evidence', label: 'Confirm access before recovery' })

    const refreshedQueue = await request(value.app, cookie, { method: 'GET', url: '/v1/operator/cases' })
    expect(refreshedQueue.body.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'case_riverbend-operator', state: 'held: blocked access' }),
      expect.objectContaining({ id: 'case_northstar-operator', state: 'needs access confirmation' }),
    ]))

    const clear = await request(value.app, cookie, {
      method: 'POST',
      url: `/v1/operator/cases/${GreenleafOperatorCaseId}/evidence`,
      payload: { accessStatus: 'confirmed_clear' },
    })
    expect(clear.response.statusCode).toBe(200)
    expect(field(clear.body, 'evidenceUpdate')).toMatchObject({ accessStatus: 'confirmed_clear', result: 'ready_for_review', outcome: 'prepare_recovery' })
    expect(field(clear.body, 'case').proposal).toBeDefined()
    noWorkerLeak(value, clear.response)
  })

  it('rejects caller identity, missing sessions, and cross-tenant operator access', async () => {
    const value = harness()
    const cookie = await localCookie(value)
    const missing = await request(value.app, undefined, { method: 'GET', url: `/v1/operator/cases/${GreenleafOperatorCaseId}` })
    expect(missing.response.statusCode).toBe(401)
    expect(missing.response.headers['www-authenticate']).toBeUndefined()

    const forged = await request(value.app, cookie, {
      method: 'POST',
      url: `/v1/operator/cases/${GreenleafOperatorCaseId}/prepare`,
      payload: { tenantId: 'ten_riverview' },
    })
    expect(forged.response.statusCode).toBe(400)
    expect(forged.body.error).toBe('caller_identity_forbidden')

    const foreignCookie = `tp_demo_session=${value.sessions.issueForServerSession(value.foreignSession).id}`
    const foreign = await request(value.app, foreignCookie, { method: 'GET', url: `/v1/operator/cases/${GreenleafOperatorCaseId}` })
    expect(foreign.response.statusCode).toBe(404)
    expect(foreign.body.error).toBe('case_not_found')
  })

  it('prepares, atomically approves and reserves, dispatches only the named operation, then reconciles once with a durable receipt', async () => {
    const value = harness()
    const cookie = await localCookie(value)
    const help = await request(value.app, cookie, { method: 'GET', url: '/v1/operator/help?topic=reconcile' })
    expect(help.response.statusCode).toBe(200)
    const article = field(help.body, 'article')
    expect(article).toMatchObject({ topic: 'reconcile', title: 'Check an uncertain dispatch' })
    expect(text(article, 'markdown')).toContain('# Check an uncertain dispatch')
    const unauthenticatedDeveloperReference = await value.app.inject({
      method: 'GET',
      url: '/v1/operator/help/developer-reference',
    })
    expect(unauthenticatedDeveloperReference.statusCode).toBe(401)
    const developerReference = await value.app.inject({
      method: 'GET',
      url: '/v1/operator/help/developer-reference',
      headers: { cookie },
    })
    expect(developerReference.statusCode).toBe(200)
    expect(developerReference.headers['content-type']).toContain('text/markdown')
    expect(developerReference.body).toContain('# Find technical references for a TrashPal integration')
    noWorkerLeak(value, developerReference)
    const coreContract = await value.app.inject({
      method: 'GET',
      url: '/v1/operator/help/references/core-build-contract',
      headers: { cookie },
    })
    expect(coreContract.statusCode).toBe(200)
    expect(coreContract.headers['content-type']).toContain('text/markdown')
    expect(coreContract.body).toContain('# TrashPal core build contract')
    const unknownReference = await request(value.app, cookie, {
      method: 'GET',
      url: '/v1/operator/help/references/not-a-real-document',
    })
    expect(unknownReference.response.statusCode).toBe(404)
    expect(unknownReference.body.error).toBe('help_reference_not_found')

    const prepared = await request(value.app, cookie, { method: 'POST', url: `/v1/operator/cases/${GreenleafOperatorCaseId}/prepare` })
    expect(prepared.response.statusCode).toBe(200)
    const preparedView = field(prepared.body, 'case')
    const proposal = field(preparedView, 'proposal')
    expect(field(preparedView, 'summary').phase).toBe('recovery_prepared')
    expect(field(preparedView, 'nextAction').kind).toBe('approve')
    expect(preparedView.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Checks run' }),
      expect.objectContaining({ label: 'Uncertainty found' }),
      expect.objectContaining({ label: 'Proposal built', status: 'current' }),
    ]))
    expect(field(prepared.body, 'preparation').runToken).toBeUndefined()
    const preparedDeadline = text(field(preparedView, 'case'), 'serviceWindowEndsAt')
    expect(preparedDeadline).not.toBe(text(proposal, 'validUntil'))
    noWorkerLeak(value, prepared.response)

    const reread = await request(value.app, cookie, { method: 'GET', url: `/v1/operator/cases/${GreenleafOperatorCaseId}` })
    expect(text(field(field(reread.body, 'case'), 'case'), 'serviceWindowEndsAt')).toBe(preparedDeadline)

    const approved = await request(value.app, cookie, {
      method: 'POST',
      url: `/v1/operator/proposals/${encodeURIComponent(text(proposal, 'id'))}/approve`,
    })
    expect(approved.response.statusCode).toBe(200)
    expect(text(field(approved.body, 'approval'), 'proposalDigest')).toBe(text(proposal, 'digest'))
    const greenleafOperation = field(approved.body, 'operation')
    expect(greenleafOperation.state).toBe('reserved')
    expect(field(field(approved.body, 'case'), 'nextAction').kind).toBe('dispatch')
    noWorkerLeak(value, approved.response)

    // A second pending operation proves the operator route uses the exact
    // named durable claim rather than dispatching whichever item is next.
    const neighbor = await value.runtime.pal.prepare({ tenantId, caseId: 'case_neighbor-operator' })
    if (!('lifecycle' in neighbor)) throw new Error('Neighbor recovery was not prepared.')
    const neighborApproval = await value.runtime.repository.approve(value.dispatcherSession, neighbor.proposal.id)
    const neighborReservation = await value.runtime.repository.reserve(value.dispatcherSession, neighborApproval.digest)

    const dispatched = await request(value.app, cookie, {
      method: 'POST',
      url: `/v1/operator/operations/${encodeURIComponent(text(greenleafOperation, 'id'))}/dispatch`,
    })
    expect(dispatched.response.statusCode).toBe(200)
    expect(field(dispatched.body, 'operation').state).toBe('unknown')
    expect(JSON.stringify(field(dispatched.body, 'case'))).toContain(
      'Dispatch outcome unknown: Pal queried the existing operation instead of retrying.',
    )
    noWorkerLeak(value, dispatched.response)
    const duplicateDispatch = await request(value.app, cookie, {
      method: 'POST',
      url: `/v1/operator/operations/${encodeURIComponent(text(greenleafOperation, 'id'))}/dispatch`,
    })
    expect(duplicateDispatch.response.statusCode).toBe(409)
    expect(duplicateDispatch.body.error).toBe('operation_not_pending')
    await expect(value.connector.diagnostics()).resolves.toMatchObject({ sendAttempts: 1 })
    await expect(value.runtime.repository.getOperation(value.runtime.workers.dispatch, neighborReservation.operation.id))
      .resolves.toMatchObject({ state: 'reserved' })

    // A new process issues new opaque sessions for the same server-owned
    // identities, then reconciles the durable unknown operation.
    const restartedAuthority = new ProcessSessionAuthority(Buffer.alloc(32, 91), { defaultTtlMs: 60 * 60 * 1_000 })
    const restartedDispatcher = restartedAuthority.issue({
      subjectId: 'usr_operator_dispatcher',
      tenantId,
      capabilities: ['read_lifecycle', 'approve_recovery'],
    })
    const restartedPreparationWorker = restartedAuthority.issueWorker({
      workerId: 'worker_operator_prepare',
      tenantId,
      capabilities: ['prepare_decision_inputs'],
    })
    const restartedDispatchWorker = restartedAuthority.issueWorker({
      workerId: 'worker_operator_dispatch',
      tenantId,
      capabilities: ['dispatch_recovery', 'reconcile_dispatch', 'record_provider_evidence'],
    })
    const restartedRuntime = createComposedRuntime({
      pool,
      authority: restartedAuthority,
      connector: value.connector,
      workers: { preparation: restartedPreparationWorker, dispatch: restartedDispatchWorker },
      routePlanner: deterministicRoutePlanner(() => new Date()),
    })
    const restartedSessions = new LocalDemoSessionStore({ authority: restartedAuthority, dispatcherSession: restartedDispatcher })
    const restartedApp = createTrashPalOperatorApi({ runtime: restartedRuntime, sessions: restartedSessions })
    apps.push(restartedApp)
    const restartedCookie = `tp_demo_session=${restartedSessions.issue().id}`
    const reconciled = await request(restartedApp, restartedCookie, {
      method: 'POST',
      url: `/v1/operator/operations/${encodeURIComponent(text(greenleafOperation, 'id'))}/reconcile`,
    })
    expect(reconciled.response.statusCode).toBe(200)
    expect(field(reconciled.body, 'operation').state).toBe('assignment_reconciled')
    const receipt = field(reconciled.body, 'receipt')
    expect(field(receipt, 'binding')).toMatchObject({
      proposalDigest: text(proposal, 'digest'),
      approvalDigest: text(field(approved.body, 'approval'), 'digest'),
      workOrder: field(proposal, 'workOrder'),
    })
    expect(Array.isArray(field(receipt, 'binding').evidenceIds)).toBe(true)
    noWorkerLeak(value, reconciled.response)

    const replay = await request(restartedApp, restartedCookie, {
      method: 'POST',
      url: `/v1/operator/operations/${encodeURIComponent(text(greenleafOperation, 'id'))}/reconcile`,
    })
    expect(replay.response.statusCode).toBe(200)
    expect(field(replay.body, 'receipt').digest).toBe(receipt.digest)
    await expect(value.connector.diagnostics()).resolves.toMatchObject({ sendAttempts: 1, assignmentCount: 1 })

    const reloaded = await request(restartedApp, restartedCookie, { method: 'GET', url: `/v1/operator/cases/${GreenleafOperatorCaseId}` })
    expect(field(field(reloaded.body, 'case'), 'operation')).toMatchObject({ id: text(greenleafOperation, 'id'), state: 'assignment_reconciled' })
    expect(field(reloaded.body, 'case').receiptAvailable).toBe(true)
    expect(text(field(field(reloaded.body, 'case'), 'case'), 'serviceWindowEndsAt')).toBe(preparedDeadline)
    const directReceipt = await request(restartedApp, restartedCookie, {
      method: 'GET',
      url: `/v1/operator/operations/${encodeURIComponent(text(greenleafOperation, 'id'))}/receipt`,
    })
    expect(directReceipt.response.statusCode).toBe(200)
    expect(field(directReceipt.body, 'receipt').binding).toEqual(field(receipt, 'binding'))
  })

  it('asks Pal to prepare again when the durable proposal expires without an operation', async () => {
    const value = harness({ sourceFactory: expiringSourceFactory(1_500) })
    const cookie = await localCookie(value)
    const prepared = await request(value.app, cookie, { method: 'POST', url: `/v1/operator/cases/${GreenleafOperatorCaseId}/prepare` })
    const proposalId = text(field(field(prepared.body, 'case'), 'proposal'), 'id')
    await wait(1_700)

    const staleApproval = await request(value.app, cookie, {
      method: 'POST',
      url: `/v1/operator/proposals/${encodeURIComponent(proposalId)}/approve`,
    })
    expect(staleApproval.response.statusCode).toBe(409)
    expect(staleApproval.body.error).toBe('approval_stale_or_revoked')
    await expect(pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM lifecycle_approvals WHERE tenant_id=$1 AND proposal_id=$2',
      [tenantId, proposalId],
    )).resolves.toMatchObject({ rows: [{ count: '0' }] })

    const stale = await request(value.app, cookie, { method: 'GET', url: `/v1/operator/cases/${GreenleafOperatorCaseId}` })
    expect(stale.response.statusCode).toBe(200)
    const view = field(stale.body, 'case')
    expect(view.proposal).toBeUndefined()
    expect(view.operation).toBeUndefined()
    expect(field(view, 'nextAction').kind).toBe('prepare')
  })

  it('does not reserve an operation when an existing approval expires', async () => {
    const value = harness({ sourceFactory: expiringSourceFactory(1_500) })
    const cookie = await localCookie(value)
    const prepared = await request(value.app, cookie, { method: 'POST', url: `/v1/operator/cases/${GreenleafOperatorCaseId}/prepare` })
    const proposalId = text(field(field(prepared.body, 'case'), 'proposal'), 'id')
    const approval = await value.runtime.repository.approve(value.dispatcherSession, proposalId)
    await wait(1_700)

    await expect(value.runtime.repository.reserve(value.dispatcherSession, approval.digest))
      .rejects.toMatchObject({ code: 'approval_stale_or_revoked' })
    await expect(pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM lifecycle_operations WHERE tenant_id=$1',
      [tenantId],
    )).resolves.toMatchObject({ rows: [{ count: '0' }] })
  })

  it('keeps an expired unknown operation on reconciliation and rejects direct re-prepare', async () => {
    let providerAcceptedAt = new Date()
    const value = harness({
      sourceFactory: expiringSourceFactory(4_500),
      connectorClock: () => providerAcceptedAt,
    })
    const cookie = await localCookie(value)
    const prepared = await request(value.app, cookie, { method: 'POST', url: `/v1/operator/cases/${GreenleafOperatorCaseId}/prepare` })
    const preparedView = field(prepared.body, 'case')
    const proposalId = text(field(preparedView, 'proposal'), 'id')
    const preparedDeadline = text(field(preparedView, 'case'), 'serviceWindowEndsAt')
    const approved = await request(value.app, cookie, {
      method: 'POST',
      url: `/v1/operator/proposals/${encodeURIComponent(proposalId)}/approve`,
    })
    const operationId = text(field(approved.body, 'operation'), 'id')
    const reservedOperation = await value.runtime.repository.getOperation(value.dispatcherSession, operationId)
    // Provider acceptance is a deterministic test fact. The later expiry
    // remains driven by PostgreSQL's real clock after the lost acknowledgement.
    providerAcceptedAt = new Date(reservedOperation.snapshot.capturedAt)
    const dispatched = await request(value.app, cookie, {
      method: 'POST',
      url: `/v1/operator/operations/${encodeURIComponent(operationId)}/dispatch`,
    })
    expect(dispatched.response.statusCode, JSON.stringify(dispatched.body)).toBe(200)
    expect(field(dispatched.body, 'operation').state).toBe('unknown')
    await wait(4_700)

    const unknown = await request(value.app, cookie, { method: 'GET', url: `/v1/operator/cases/${GreenleafOperatorCaseId}` })
    expect(field(field(unknown.body, 'case'), 'nextAction').kind).toBe('reconcile')
    expect(field(field(unknown.body, 'case'), 'summary').phase).toBe('historical_decision')

    // A new process has no local Pal cache or local source snapshot. The
    // historical view must still come from the durable execution binding.
    const restartedAuthority = new ProcessSessionAuthority(Buffer.alloc(32, 97), { defaultTtlMs: 60 * 60 * 1_000 })
    const restartedDispatcher = restartedAuthority.issue({
      subjectId: 'usr_operator_dispatcher',
      tenantId,
      capabilities: ['read_lifecycle', 'approve_recovery'],
    })
    const restartedPreparationWorker = restartedAuthority.issueWorker({
      workerId: 'worker_operator_prepare',
      tenantId,
      capabilities: ['prepare_decision_inputs'],
    })
    const restartedDispatchWorker = restartedAuthority.issueWorker({
      workerId: 'worker_operator_dispatch',
      tenantId,
      capabilities: ['dispatch_recovery', 'reconcile_dispatch', 'record_provider_evidence'],
    })
    const restartedRuntime = createComposedRuntime({
      pool,
      authority: restartedAuthority,
      connector: value.connector,
      workers: { preparation: restartedPreparationWorker, dispatch: restartedDispatchWorker },
      routePlanner: deterministicRoutePlanner(() => new Date()),
    })
    const restartedSessions = new LocalDemoSessionStore({ authority: restartedAuthority, dispatcherSession: restartedDispatcher })
    const restartedApp = createTrashPalOperatorApi({ runtime: restartedRuntime, sessions: restartedSessions })
    apps.push(restartedApp)
    const restartedCookie = `tp_demo_session=${restartedSessions.issue().id}`
    const restarted = await request(restartedApp, restartedCookie, {
      method: 'GET',
      url: `/v1/operator/cases/${GreenleafOperatorCaseId}`,
    })
    const restartedView = field(restarted.body, 'case')
    const restartedSummary = field(restartedView, 'summary')
    expect(restarted.response.statusCode).toBe(200)
    expect(restartedSummary.phase).toBe('historical_decision')
    expect(text(restartedSummary, 'whatHappened')).toContain('durable operation')
    expect(JSON.stringify(restartedSummary)).not.toContain('Pal has not prepared a recovery yet.')
    expect(text(field(restartedView, 'case'), 'serviceWindowEndsAt')).toBe(preparedDeadline)
    expect(field(restartedView, 'nextAction').kind).toBe('reconcile')

    const blocked = await request(restartedApp, restartedCookie, {
      method: 'POST',
      url: `/v1/operator/cases/${GreenleafOperatorCaseId}/prepare`,
    })
    expect(blocked.response.statusCode).toBe(409)
    expect(blocked.body.error).toBe('operator_operation_unresolved')
    await expect(pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM lifecycle_operations WHERE tenant_id=$1 AND id=$2',
      [tenantId, operationId],
    )).resolves.toMatchObject({ rows: [{ count: '1' }] })
  }, 15_000)
})
