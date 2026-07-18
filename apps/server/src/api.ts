import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { LifecycleError, rejectCallerIdentity, type Principal, type WorkerCapability } from '@trashpal/lifecycle'
import type { ComposedRuntime } from './composition.js'
import { safeProposalFromBinding } from './runtime.js'

export interface CreateTrashPalApiOptions {
  readonly runtime: ComposedRuntime
}

/** Core bearer API. The operator facade layers on top without changing it. */
export function createTrashPalApi(options: CreateTrashPalApiOptions): FastifyInstance {
  const app = Fastify({ logger: false })
  const runtime = options.runtime

  app.setErrorHandler((error, request, reply) => {
    const lifecycle = error instanceof LifecycleError ? error : null
    const code = lifecycle?.code ?? 'request_failed'
    if (code === 'invalid_session' && !request.url.startsWith('/v1/operator/')) reply.header('www-authenticate', 'Bearer')
    reply.status(statusFor(code)).send({ error: code })
  })

  app.post('/v1/cases/:caseId/prepare', async (request, reply) => {
    assertEmptyBody(request.body)
    const token = bearerToken(request)
    const worker = requireWorker(runtime, token, 'prepare_decision_inputs')
    if (token !== runtime.workers.preparation) throw new LifecycleError('worker_session_forbidden', 'This route is bound to the server preparation worker.')
    const caseId = pathParam(request, 'caseId')
    const prepared = await runtime.pal.prepare({ tenantId: worker.tenantId, caseId })
    if (!('lifecycle' in prepared)) {
      return reply.code(422).send({
        runToken: prepared.runToken,
        outcome: prepared.trace.outcome,
        stopCode: prepared.trace.stopCode,
        traceUrl: `/v1/cases/${encodeURIComponent(caseId)}/pal-runs/${encodeURIComponent(prepared.runToken)}`,
        traceRetention: 'process_local',
      })
    }
    return { proposalId: prepared.proposal.id, runToken: prepared.runToken, outcome: prepared.trace.outcome }
  })

  app.get('/v1/cases/:caseId/pal-runs/:runToken', async (request) => {
    const reader = requireReadable(runtime, bearerToken(request))
    const run = runtime.pal.getRun({
      tenantId: reader.tenantId,
      caseId: pathParam(request, 'caseId'),
      runToken: pathParam(request, 'runToken'),
    })
    if (!run) throw new LifecycleError('pal_run_not_found', 'The Pal run does not exist in the resolved tenant and case.')
    return { retention: 'process_local', modelContextEnvelope: run.contextEnvelope, agentRunTrace: run.trace }
  })

  app.get('/v1/proposals/:proposalId', async (request) => {
    const proposal = await runtime.getProposalBinding(bearerToken(request), pathParam(request, 'proposalId'))
    return { proposal: safeProposalFromBinding(proposal) }
  })
  app.post('/v1/proposals/:proposalId/approve', async (request) => {
    assertEmptyBody(request.body)
    return { approval: await runtime.repository.approve(bearerToken(request), pathParam(request, 'proposalId')) }
  })
  app.post('/v1/approvals/:approvalDigest/revoke', async (request) => {
    assertEmptyBody(request.body)
    return { approval: await runtime.repository.revokeApproval(bearerToken(request), pathParam(request, 'approvalDigest')) }
  })
  app.post('/v1/approvals/:approvalDigest/reserve', async (request) => {
    assertEmptyBody(request.body)
    const reserved = await runtime.repository.reserve(bearerToken(request), pathParam(request, 'approvalDigest'))
    return { operation: reserved.operation, replayed: reserved.replayed }
  })
  app.post('/v1/dispatch/next', async (request) => {
    assertEmptyBody(request.body)
    const token = bearerToken(request)
    requireWorker(runtime, token, 'dispatch_recovery')
    return { operation: await runtime.dispatch(token) }
  })
  app.post('/v1/operations/:operationId/reconcile', async (request) => {
    assertEmptyBody(request.body)
    const token = bearerToken(request)
    requireWorker(runtime, token, 'reconcile_dispatch')
    return { operation: await runtime.reconcile(token, pathParam(request, 'operationId')) }
  })
  app.get('/v1/operations/:operationId', async (request) => {
    requireReadable(runtime, bearerToken(request))
    return { operation: await runtime.repository.getOperation(bearerToken(request), pathParam(request, 'operationId')) }
  })
  app.post('/v1/operations/:operationId/evidence/:kind', async (request) => {
    assertEmptyBody(request.body)
    const token = bearerToken(request)
    requireWorker(runtime, token, 'record_provider_evidence')
    return { operation: await runtime.recordEvidence(token, pathParam(request, 'operationId'), providerEvidenceKind(pathParam(request, 'kind'))) }
  })
  app.post('/v1/operations/:operationId/confirm', async (request) => {
    assertEmptyBody(request.body)
    return { operation: await runtime.recordEvidence(bearerToken(request), pathParam(request, 'operationId'), 'customer_confirmation') }
  })
  app.post('/v1/operations/:operationId/dispute', async (request) => {
    assertEmptyBody(request.body)
    return { operation: await runtime.recordEvidence(bearerToken(request), pathParam(request, 'operationId'), 'customer_dispute') }
  })
  app.post('/v1/operations/:operationId/reopen', async (request) => {
    assertEmptyBody(request.body)
    return { operation: await runtime.recordEvidence(bearerToken(request), pathParam(request, 'operationId'), 'reopen') }
  })
  app.get('/v1/operations/:operationId/receipt', async (request) => {
    requireReadable(runtime, bearerToken(request))
    return { receipt: await runtime.repository.receipt(bearerToken(request), pathParam(request, 'operationId')) }
  })
  return app
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization
  const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null
  if (!match?.[1]) throw new LifecycleError('invalid_session', 'An opaque bearer session is required.')
  return match[1]
}

function requireReadable(runtime: ComposedRuntime, token: string): Principal {
  const principal = runtime.authority.resolve(token)
  if (principal.kind !== 'user' || !principal.capabilities.has('read_lifecycle')) {
    throw new LifecycleError('missing_capability', 'A readable user session is required.')
  }
  return principal
}

function requireWorker(runtime: ComposedRuntime, token: string, capability: WorkerCapability): Principal {
  const principal = runtime.authority.resolve(token)
  if (principal.kind !== 'worker' || !principal.capabilities.has(capability)) {
    throw new LifecycleError('missing_capability', `Worker capability ${capability} is required.`)
  }
  return principal
}

function pathParam(request: FastifyRequest, key: string): string {
  const value = (request.params as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value.length === 0) throw new LifecycleError('invalid_identifier', `Path parameter ${key} is required.`)
  return value
}

function assertEmptyBody(body: unknown): void {
  if (body === undefined) return
  if (body === null || Array.isArray(body) || typeof body !== 'object') {
    throw new LifecycleError('request_payload_forbidden', 'This route does not accept a request payload.')
  }
  const record = body as Record<string, unknown>
  rejectCallerIdentity(record)
  if (Object.keys(record).length > 0) throw new LifecycleError('request_payload_forbidden', 'This route derives bindings from the server-side record.')
}

function providerEvidenceKind(value: string): 'driver_report' | 'supporting_attachment' | 'reconciliation' {
  if (value === 'driver_report' || value === 'supporting_attachment' || value === 'reconciliation') return value
  throw new LifecycleError('invalid_evidence_kind', 'The provider evidence kind is not supported.')
}

function statusFor(code: string): number {
  if (code === 'request_failed') return 500
  if (code === 'invalid_session') return 401
  if (code === 'approval_stale_or_revoked' || code === 'operator_operation_unresolved' || code === 'operation_not_pending') return 409
  if (code.endsWith('_not_found')) return 404
  if (code === 'missing_capability' || code === 'capability_required' || code === 'tenant_scope_mismatch' || code === 'worker_session_forbidden') return 403
  return 400
}
