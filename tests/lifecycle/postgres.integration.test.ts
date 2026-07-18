import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectorRejectedError,
  digest,
  InMemoryDispatchConnector,
  createLifecyclePostgresPool,
  PostgresLifecycleRepository,
  PostgresOutboxWorker,
  ProcessSessionAuthority,
} from '../../packages/lifecycle/src/index.js'
import type { CurrentDecisionInputs, LifecyclePostgresPool } from '../../packages/lifecycle/src/index.js'
import { decisionInputs, outcomeEvidence } from './helpers.js'

interface Harness {
  authority: ProcessSessionAuthority
  repository: PostgresLifecycleRepository
  admin: string
  dispatcher: string
  viewer: string
  customer: string
  preparationWorker: string
  dispatchWorker: string
}

const databaseUrl = process.env.TEST_DATABASE_URL ?? ''
if (process.env.POSTGRES_REQUIRE_REAL === '1' && !databaseUrl) {
  throw new Error('POSTGRES_REQUIRE_REAL=1 requires TEST_DATABASE_URL for lifecycle integration tests.')
}
const describePostgres = databaseUrl ? describe : describe.skip
const migrationUrl = new URL('../../drizzle/0000_durable_lifecycle.sql', import.meta.url)

function harness(authority = new ProcessSessionAuthority(Buffer.alloc(32, 13), { defaultTtlMs: 60 * 60 * 1_000 })): Harness {
  return {
    authority,
    repository: new PostgresLifecycleRepository(pool, authority),
    admin: authority.issue({
      subjectId: 'usr_db_admin',
      tenantId: 'ten_harborworks',
      capabilities: ['manage_lifecycle_authority', 'read_lifecycle'],
    }),
    dispatcher: authority.issue({
      subjectId: 'usr_db_dispatcher',
      tenantId: 'ten_harborworks',
      capabilities: ['approve_recovery', 'read_lifecycle'],
    }),
    viewer: authority.issue({
      subjectId: 'usr_db_viewer',
      tenantId: 'ten_harborworks',
      capabilities: ['read_lifecycle'],
    }),
    customer: authority.issue({
      subjectId: 'usr_db_customer',
      tenantId: 'ten_harborworks',
      capabilities: ['read_lifecycle', 'confirm_customer_outcome', 'dispute_customer_outcome', 'reopen_recovery'],
    }),
    preparationWorker: authority.issueWorker({
      workerId: 'worker_db_context',
      tenantId: 'ten_harborworks',
      capabilities: ['prepare_decision_inputs'],
    }),
    dispatchWorker: authority.issueWorker({
      workerId: 'worker_db_dispatch',
      tenantId: 'ten_harborworks',
      capabilities: ['dispatch_recovery', 'reconcile_dispatch', 'record_provider_evidence'],
    }),
  }
}

function inputs(suffix: string, overrides: Partial<CurrentDecisionInputs> = {}): CurrentDecisionInputs {
  return decisionInputs({
    caseId: `case_db-${suffix}`,
    proposalId: `proposal_db-${suffix}`,
    evidenceSnapshotId: `ev_db-${suffix}`,
    routeQuoteId: `quote_db-${suffix}`,
    serviceStart: new Date(databaseEpochMs + 60 * 60 * 1_000).toISOString(),
    serviceEnd: new Date(databaseEpochMs + 90 * 60 * 1_000).toISOString(),
    validUntil: new Date(databaseEpochMs + 2 * 60 * 60 * 1_000).toISOString(),
    ...overrides,
  })
}

async function seedReservation(value: Harness, suffix: string): Promise<{
  input: CurrentDecisionInputs
  operationId: string
  approvalDigest: string
}> {
  const input = inputs(suffix)
  await value.repository.prepareDecisionInputs(value.preparationWorker, input)
  const approval = await value.repository.approve(value.dispatcher, input.proposalId)
  const reservation = await value.repository.reserve(value.dispatcher, approval.digest)
  return { input, operationId: reservation.operation.id, approvalDigest: approval.digest }
}

let bootstrapPool: LifecyclePostgresPool
let pool: LifecyclePostgresPool
let schema: string
let databaseEpochMs = 0

describePostgres('PostgreSQL lifecycle repository', () => {
  beforeAll(async () => {
    schema = `lifecycle_it_${randomUUID().replaceAll('-', '')}`
    bootstrapPool = createLifecyclePostgresPool({ connectionString: databaseUrl, max: 2 })
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`)
    pool = createLifecyclePostgresPool({ connectionString: databaseUrl, searchPath: schema, max: 12 })
    await pool.query(await readFile(migrationUrl, 'utf8'))
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE lifecycle_cases, lifecycle_principals CASCADE')
    const time = await pool.query<{ now: Date | string }>('SELECT clock_timestamp() AS now')
    databaseEpochMs = new Date(time.rows[0]!.now).valueOf()
  })

  afterAll(async () => {
    if (pool) await pool.end()
    if (bootstrapPool && schema) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await bootstrapPool.end()
    }
  })

  it('survives worker restart, reconciles a lost acknowledgement once, and replays one durable receipt', async () => {
    const first = harness()
    const seeded = await seedReservation(first, 'restart')
    const provider = new InMemoryDispatchConnector()
    let acknowledgementLost = false
    const connector = {
      async send(snapshot: Parameters<typeof provider.send>[0]) {
        const assignment = await provider.send(snapshot)
        if (!acknowledgementLost) {
          acknowledgementLost = true
          throw Object.assign(new Error('cross-package acknowledgement loss'), { code: 'ACKNOWLEDGEMENT_LOST' as const })
        }
        return assignment
      },
      async lookup(idempotencyKey: string) {
        return await provider.lookup(idempotencyKey)
      },
    }
    const firstWorker = new PostgresOutboxWorker({
      repository: first.repository,
      connector,
      workerToken: first.dispatchWorker,
      leaseOwner: 'worker-before-restart',
    })

    await expect(firstWorker.dispatchNext()).resolves.toMatchObject({ state: 'unknown' })

    const restartedAuthority = new ProcessSessionAuthority(Buffer.alloc(32, 17), { defaultTtlMs: 60 * 60 * 1_000 })
    const restarted = harness(restartedAuthority)
    const restartedWorker = new PostgresOutboxWorker({
      repository: restarted.repository,
      connector,
      workerToken: restarted.dispatchWorker,
      leaseOwner: 'worker-after-restart',
    })
    const reconciled = await restartedWorker.reconcile(seeded.operationId)

    expect(reconciled).toMatchObject({ state: 'assignment_reconciled', revision: 3 })
    expect(provider.sendCount).toBe(1)
    await expect(pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM lifecycle_assignments WHERE operation_id=$1',
      [seeded.operationId],
    )).resolves.toMatchObject({ rows: [{ count: '1' }] })

    const receipt = await restarted.repository.receipt(restarted.viewer, seeded.operationId)
    const replay = await restarted.repository.receipt(restarted.viewer, seeded.operationId)
    expect(replay).toEqual(receipt)
    await expect(pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM lifecycle_outcome_receipts WHERE operation_id=$1',
      [seeded.operationId],
    )).resolves.toMatchObject({ rows: [{ count: '1' }] })
  })

  it('serializes concurrent reservation and SKIP LOCKED claim attempts to one operation and one lease', async () => {
    const value = harness()
    const input = inputs('concurrency')
    await value.repository.prepareDecisionInputs(value.preparationWorker, input)
    const approval = await value.repository.approve(value.dispatcher, input.proposalId)

    const reservations = await Promise.all([
      value.repository.reserve(value.dispatcher, approval.digest),
      value.repository.reserve(value.dispatcher, approval.digest),
    ])
    expect(new Set(reservations.map(({ operation }) => operation.id))).toHaveLength(1)
    expect(reservations.filter(({ replayed }) => replayed)).toHaveLength(1)
    await expect(pool.query<{ reservations: string; snapshots: string; operations: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM lifecycle_reservations)::text AS reservations,
         (SELECT count(*) FROM lifecycle_execution_snapshots)::text AS snapshots,
         (SELECT count(*) FROM lifecycle_operations)::text AS operations,
         (SELECT count(*) FROM lifecycle_dispatch_outbox)::text AS outbox`,
    )).resolves.toMatchObject({ rows: [{ reservations: '1', snapshots: '1', operations: '1', outbox: '1' }] })

    const claims = await Promise.all([
      value.repository.claimNext(value.dispatchWorker, 'concurrent-worker-a'),
      value.repository.claimNext(value.dispatchWorker, 'concurrent-worker-b'),
    ])
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
    const claim = claims.find((candidate) => candidate !== null)
    expect(claim).not.toBeNull()
    await value.repository.markUnknown(value.dispatchWorker, claim!.operation.id, 'test_cleanup')
  })

  it('rejects backdating, cross-case graphs, duplicate snapshots, bad assignments, and evidence-free confirmation', async () => {
    const value = harness()
    const seeded = await seedReservation(value, 'hostile')
    const unapproved = inputs('backdate')
    await value.repository.prepareDecisionInputs(value.preparationWorker, unapproved)

    await expect(pool.query(
      `INSERT INTO lifecycle_approvals
         (tenant_id,digest,proposal_id,proposal_digest,context_bundle_hash,evidence_packet_hash,
          evidence_revision,route_quote_hash,route_revision,approver_subject_id,capability,approved_at,valid_until)
       SELECT tenant_id,$2,id,digest,context_bundle_hash,evidence_packet_hash,evidence_revision,
          route_quote_hash,route_revision,'usr_db_dispatcher','approve_recovery',clock_timestamp()-interval '1 day',valid_until
       FROM lifecycle_proposals WHERE tenant_id=$1 AND id=$3`,
      ['ten_harborworks', 'a'.repeat(64), unapproved.proposalId],
    )).rejects.toThrow(/approval binding does not match current proposal inputs/)

    await pool.query(
      `INSERT INTO lifecycle_cases (tenant_id,id,source_id,evidence_revision,route_revision,state)
       VALUES ('ten_harborworks','case_db-cross','case_db-cross',7,3,'open')`,
    )
    await expect(pool.query(
      `INSERT INTO lifecycle_proposals
         (tenant_id,id,case_id,digest,context_bundle_hash,context_bundle_payload,evidence_snapshot_id,evidence_packet_hash,
          evidence_revision,route_quote_id,route_quote_hash,route_revision,vehicle_id,service_start,
          service_end,payload,valid_until)
       SELECT tenant_id,'proposal_db-cross','case_db-cross',$2,context_bundle_hash,context_bundle_payload,evidence_snapshot_id,
          evidence_packet_hash,evidence_revision,route_quote_id,route_quote_hash,route_revision,vehicle_id,
          service_start,service_end,payload || jsonb_build_object('id','proposal_db-cross','caseId','case_db-cross'),valid_until
       FROM lifecycle_proposals WHERE tenant_id=$1 AND id=$3`,
      ['ten_harborworks', 'b'.repeat(64), seeded.input.proposalId],
    )).rejects.toThrow(/foreign key constraint/)

    await expect(pool.query(
      `WITH source AS MATERIALIZED (
         SELECT snapshot.*,clock_timestamp() AS hostile_captured
         FROM lifecycle_execution_snapshots snapshot WHERE tenant_id=$1 AND operation_id=$4
       )
       INSERT INTO lifecycle_execution_snapshots
         (tenant_id,operation_id,reservation_id,case_id,proposal_id,digest,proposal_digest,approval_digest,
          context_bundle_hash,evidence_packet_hash,evidence_revision,route_quote_hash,route_revision,vehicle_id,
          service_start,service_end,approval_valid_until,approver_subject_id,idempotency_key,payload,captured_at)
       SELECT tenant_id,'op_hostile-snapshot',reservation_id,case_id,proposal_id,$2::text,proposal_digest,approval_digest,
          context_bundle_hash,evidence_packet_hash,evidence_revision,route_quote_hash,route_revision,vehicle_id,
          service_start,service_end,approval_valid_until,approver_subject_id,$3::uuid,
          payload || jsonb_build_object(
            'operationId','op_hostile-snapshot','digest',$2::text,'idempotencyKey',$3::uuid::text,'capturedAt',hostile_captured
          ),hostile_captured
       FROM source`,
      ['ten_harborworks', 'c'.repeat(64), randomUUID(), seeded.operationId],
    )).rejects.toThrow(/unique constraint/)

    await expect(pool.query(
      `INSERT INTO lifecycle_assignments
         (tenant_id,id,operation_id,provider_assignment_id,idempotency_key,snapshot_digest,proposal_digest,
          approval_digest,route_quote_hash,vehicle_id,service_start,service_end,accepted_at)
       SELECT tenant_id,'assignment_hostile',operation_id, 'provider-hostile',idempotency_key,digest,
          proposal_digest,approval_digest,route_quote_hash,'veh_wrong',service_start,service_end,clock_timestamp()
       FROM lifecycle_execution_snapshots WHERE tenant_id=$1 AND operation_id=$2`,
      ['ten_harborworks', seeded.operationId],
    )).rejects.toThrow(/assignment does not echo the immutable snapshot|foreign key constraint/)

    const connector = new InMemoryDispatchConnector()
    const worker = new PostgresOutboxWorker({
      repository: value.repository,
      connector,
      workerToken: value.dispatchWorker,
      leaseOwner: 'hostile-test-worker',
    })
    const accepted = await worker.dispatchNext()
    expect(accepted).toMatchObject({ state: 'accepted' })
    const driverReported = await value.repository.recordEvidence(
      value.dispatchWorker,
      seeded.operationId,
      outcomeEvidence(seeded.operationId, 'driver_report', 'ev_db-driver', { observedAt: accepted!.updatedAt }),
      'driver_reported',
    )
    const reconciled = await value.repository.recordEvidence(
      value.dispatchWorker,
      seeded.operationId,
      outcomeEvidence(seeded.operationId, 'reconciliation', 'ev_db-reconciled', { observedAt: driverReported.updatedAt }),
      'evidence_reconciled',
    )
    await expect(pool.query(
      `UPDATE lifecycle_operations
       SET state='customer_confirmed',revision=revision+1
       WHERE tenant_id=$1 AND id=$2`,
      ['ten_harborworks', seeded.operationId],
    )).rejects.toThrow(/exact typed evidence/)

    await expect(value.repository.recordEvidence(
      value.customer,
      seeded.operationId,
      outcomeEvidence(seeded.operationId, 'customer_confirmation', 'ev_db-confirmed', { observedAt: reconciled.updatedAt }),
      'customer_confirmed',
    )).resolves.toMatchObject({ state: 'customer_confirmed' })
  })

  it('rejects JSON null where table and trigger bindings require typed objects', async () => {
    const value = harness()
    const seeded = await seedReservation(value, 'json-null')
    await expect(pool.query(
      `INSERT INTO lifecycle_evidence_snapshots
         (tenant_id,id,case_id,revision,packet_hash,payload,observed_at,valid_until)
       VALUES ($1,'ev_db-json-null', $2,99,$3,'null'::jsonb,clock_timestamp(),clock_timestamp()+interval '1 hour')`,
      [seeded.input.tenantId, seeded.input.caseId, '9'.repeat(64)],
    )).rejects.toThrow(/check constraint/)
    await expect(pool.query(
      `WITH source AS MATERIALIZED (
         SELECT snapshot.*,clock_timestamp() AS hostile_captured
         FROM lifecycle_execution_snapshots snapshot WHERE tenant_id=$1 AND operation_id=$4
       )
       INSERT INTO lifecycle_execution_snapshots
         (tenant_id,operation_id,reservation_id,case_id,proposal_id,digest,proposal_digest,approval_digest,
          context_bundle_hash,evidence_packet_hash,evidence_revision,route_quote_hash,route_revision,vehicle_id,
          service_start,service_end,approval_valid_until,approver_subject_id,idempotency_key,payload,captured_at)
       SELECT tenant_id,'op_json-null',reservation_id,case_id,proposal_id,$2::text,proposal_digest,approval_digest,
          context_bundle_hash,evidence_packet_hash,evidence_revision,route_quote_hash,route_revision,vehicle_id,
          service_start,service_end,approval_valid_until,approver_subject_id,$3::uuid,'null'::jsonb,hostile_captured
       FROM source`,
      [seeded.input.tenantId, '8'.repeat(64), randomUUID(), seeded.operationId],
    )).rejects.toThrow(/snapshot payload must be an object/)

    const worker = new PostgresOutboxWorker({
      repository: value.repository,
      connector: new InMemoryDispatchConnector(),
      workerToken: value.dispatchWorker,
      leaseOwner: 'json-null-worker',
    })
    const accepted = await worker.dispatchNext()
    expect(accepted).toMatchObject({ state: 'accepted' })
    await expect(pool.query(
      `INSERT INTO lifecycle_outcome_evidence
         (tenant_id,id,operation_id,operation_revision,kind,source_id,content_hash,payload,observed_at,
          recorded_by_subject_id,recorded_by_capability)
       VALUES ($1,'ev_db-json-null-outcome',$2,$3,'driver_report','source-json-null',$4,'null'::jsonb,$5,
          'worker_db_dispatch','record_provider_evidence')`,
      [accepted!.tenantId, accepted!.id, accepted!.revision + 1, '7'.repeat(64), accepted!.updatedAt],
    )).rejects.toThrow(/outcome evidence payload must be an object/)
    const time = await pool.query<{ now: Date | string }>('SELECT clock_timestamp() AS now')
    await expect(pool.query(
      `INSERT INTO lifecycle_outcome_receipts
         (tenant_id,digest,operation_id,operation_revision,state,snapshot_digest,payload,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,'null'::jsonb,$7)`,
      [
        accepted!.tenantId,
        '6'.repeat(64),
        accepted!.id,
        accepted!.revision,
        accepted!.state,
        accepted!.snapshot.digest,
        new Date(time.rows[0]!.now).toISOString(),
      ],
    )).rejects.toThrow(/receipt payload must be an object/)
  })

  it('cancels before send when the actual bound route is revoked after reservation', async () => {
    const value = harness()
    const seeded = await seedReservation(value, 'revalidate')
    await pool.query(
      `UPDATE lifecycle_route_quotes SET revoked_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2`,
      [seeded.input.tenantId, seeded.input.routeQuoteId],
    )
    const connector = new InMemoryDispatchConnector()
    const worker = new PostgresOutboxWorker({
      repository: value.repository,
      connector,
      workerToken: value.dispatchWorker,
      leaseOwner: 'final-revalidation-worker',
    })

    await expect(worker.dispatchNext()).resolves.toBeNull()
    await expect(value.repository.getOperation(value.viewer, seeded.operationId)).resolves.toMatchObject({ state: 'cancelled' })
    expect(connector.sendCount).toBe(0)
    await expect(pool.query(
      `UPDATE lifecycle_reservations SET state='reserved'
       WHERE tenant_id=$1 AND proposal_id=$2`,
      [seeded.input.tenantId, seeded.input.proposalId],
    )).rejects.toThrow(/terminal states cannot transition/)
  })

  it('revokes approvals and capabilities through durable repository APIs', async () => {
    const value = harness()
    const input = inputs('revoked-approval')
    await value.repository.prepareDecisionInputs(value.preparationWorker, input)
    const approval = await value.repository.approve(value.dispatcher, input.proposalId)
    const revoked = await value.repository.revokeApproval(value.dispatcher, approval.digest)
    const replay = await value.repository.revokeApproval(value.dispatcher, approval.digest)

    expect(revoked.revokedAt).toBeDefined()
    expect(replay).toEqual(revoked)
    await expect(value.repository.reserve(value.dispatcher, approval.digest))
      .rejects.toMatchObject({ code: 'approval_stale_or_revoked' })
    await expect(pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM lifecycle_operations WHERE tenant_id=$1 AND snapshot_digest IS NOT NULL',
      [input.tenantId],
    )).resolves.toMatchObject({ rows: [{ count: '0' }] })

    const seeded = await seedReservation(value, 'revoked-capability')
    await value.repository.revokeCapability(value.admin, 'usr_db_dispatcher', 'approve_recovery')
    expect(value.authority.hasCapability('usr_db_dispatcher', seeded.input.tenantId, 'approve_recovery', 'user')).toBe(false)
    await expect(value.repository.getOperation(value.dispatcher, seeded.operationId)).resolves.toMatchObject({ state: 'reserved' })

    const connector = new InMemoryDispatchConnector()
    const worker = new PostgresOutboxWorker({
      repository: value.repository,
      connector,
      workerToken: value.dispatchWorker,
      leaseOwner: 'capability-revocation-worker',
    })
    await expect(worker.dispatchNext()).resolves.toBeNull()
    expect(connector.sendCount).toBe(0)
    await expect(pool.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM lifecycle_capabilities
       WHERE tenant_id=$1 AND subject_id='usr_db_dispatcher' AND capability='approve_recovery'`,
      [seeded.input.tenantId],
    )).resolves.toMatchObject({ rows: [{ revoked: true }] })
    await expect(pool.query(
      `UPDATE lifecycle_capabilities SET revoked_at=NULL
       WHERE tenant_id=$1 AND subject_id='usr_db_dispatcher' AND capability='approve_recovery'`,
      [seeded.input.tenantId],
    )).rejects.toThrow(/one-way revocation/)
  })

  it('revokes an approver principal durably without a direct SQL bypass', async () => {
    const value = harness()
    const seeded = await seedReservation(value, 'revoked-principal')
    await value.repository.revokePrincipal(value.admin, 'usr_db_dispatcher')
    expect(() => value.authority.resolve(value.dispatcher)).toThrow(/invalid, expired, or revoked/)
    const connector = new InMemoryDispatchConnector()
    const worker = new PostgresOutboxWorker({
      repository: value.repository,
      connector,
      workerToken: value.dispatchWorker,
      leaseOwner: 'revocation-revalidation-worker',
    })

    await expect(worker.dispatchNext()).resolves.toBeNull()
    await expect(value.repository.getOperation(value.viewer, seeded.operationId)).resolves.toMatchObject({ state: 'cancelled' })
    expect(connector.sendCount).toBe(0)
    await expect(pool.query<{ enabled: boolean; revoked: boolean }>(
      `SELECT enabled,revoked_at IS NOT NULL AS revoked FROM lifecycle_principals
       WHERE tenant_id=$1 AND subject_id='usr_db_dispatcher'`,
      [seeded.input.tenantId],
    )).resolves.toMatchObject({ rows: [{ enabled: false, revoked: true }] })
    await expect(pool.query(
      `UPDATE lifecycle_principals SET enabled=true,revoked_at=NULL
       WHERE tenant_id=$1 AND subject_id='usr_db_dispatcher'`,
      [seeded.input.tenantId],
    )).rejects.toThrow(/revocation is terminal/)
  })

  it('cancels the exact reservation when a connector rejects before acceptance', async () => {
    const value = harness()
    const seeded = await seedReservation(value, 'connector-rejected')
    const connector = {
      async send() {
        throw new ConnectorRejectedError('provider_capacity')
      },
      async lookup() {
        return undefined
      },
    }
    const worker = new PostgresOutboxWorker({
      repository: value.repository,
      connector,
      workerToken: value.dispatchWorker,
      leaseOwner: 'connector-rejection-worker',
    })

    await expect(worker.dispatchNext()).resolves.toMatchObject({ state: 'failed' })
    await expect(pool.query<{ state: string; cancel_reason: string; timestamped: boolean }>(
      `SELECT state,cancel_reason,cancelled_at IS NOT NULL AS timestamped
       FROM lifecycle_reservations WHERE tenant_id=$1 AND proposal_id=$2`,
      [seeded.input.tenantId, seeded.input.proposalId],
    )).resolves.toMatchObject({
      rows: [{ state: 'cancelled', cancel_reason: 'connector_rejected:provider_capacity', timestamped: true }],
    })
  })

  it('rejects causally backdated evidence in both repository and database paths', async () => {
    const value = harness()
    const seeded = await seedReservation(value, 'causal-evidence')
    const worker = new PostgresOutboxWorker({
      repository: value.repository,
      connector: new InMemoryDispatchConnector(),
      workerToken: value.dispatchWorker,
      leaseOwner: 'causal-evidence-worker',
    })
    const accepted = await worker.dispatchNext()
    expect(accepted).toMatchObject({ state: 'accepted' })
    const backdated = outcomeEvidence(seeded.operationId, 'driver_report', 'ev_db-backdated', {
      observedAt: '2000-01-01T00:00:00.000Z',
    })

    await expect(value.repository.recordEvidence(
      value.dispatchWorker,
      seeded.operationId,
      backdated,
      'driver_reported',
    )).rejects.toMatchObject({ code: 'evidence_time_invalid' })
    await expect(pool.query(
      `INSERT INTO lifecycle_outcome_evidence
         (tenant_id,id,operation_id,operation_revision,kind,source_id,content_hash,payload,observed_at,
          recorded_by_subject_id,recorded_by_capability)
       VALUES ($1,$2,$3,$4,'driver_report',$5,$6,$7::jsonb,$8,'worker_db_dispatch','record_provider_evidence')`,
      [
        backdated.tenantId,
        backdated.id,
        backdated.operationId,
        accepted!.revision + 1,
        backdated.sourceId,
        backdated.contentHash,
        JSON.stringify(backdated),
        backdated.observedAt,
      ],
    )).rejects.toThrow(/active principal, payload, or revision binding/)
  })

  it('rejects forged receipts at insertion and during canonical replay', async () => {
    const value = harness()
    const seeded = await seedReservation(value, 'forged-receipt')
    const worker = new PostgresOutboxWorker({
      repository: value.repository,
      connector: new InMemoryDispatchConnector(),
      workerToken: value.dispatchWorker,
      leaseOwner: 'forged-receipt-worker',
    })
    const accepted = await worker.dispatchNext()
    expect(accepted).toMatchObject({ state: 'accepted' })
    const time = await pool.query<{ now: Date | string }>('SELECT clock_timestamp() AS now')
    const recordedAt = new Date(time.rows[0]!.now).toISOString()
    const unsigned = {
      operationId: 'op_forged-other-operation',
      operationRevision: accepted!.revision,
      tenantId: accepted!.tenantId,
      state: accepted!.state,
      evidenceIds: [],
      contextBundleHash: accepted!.snapshot.contextBundleHash,
      evidencePacketHash: accepted!.snapshot.evidencePacketHash,
      routeQuoteHash: accepted!.snapshot.routeQuoteHash,
      proposalDigest: accepted!.snapshot.proposalDigest,
      approvalDigest: accepted!.snapshot.approvalDigest,
      approverId: accepted!.snapshot.approverId,
      approverCapability: accepted!.snapshot.approverCapability,
      approvalValidUntil: accepted!.snapshot.approvalValidUntil,
      idempotencyKey: accepted!.snapshot.idempotencyKey,
      executionSnapshotDigest: accepted!.snapshot.digest,
      recordedAt,
    }
    const forged = { ...unsigned, digest: digest(unsigned) }
    const values = [
      accepted!.tenantId,
      forged.digest,
      accepted!.id,
      accepted!.revision,
      accepted!.state,
      accepted!.snapshot.digest,
      JSON.stringify(forged),
      recordedAt,
    ]

    await expect(pool.query(
      `INSERT INTO lifecycle_outcome_receipts
         (tenant_id,digest,operation_id,operation_revision,state,snapshot_digest,payload,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      values,
    )).rejects.toThrow(/receipt payload does not bind/)

    await pool.query('ALTER TABLE lifecycle_outcome_receipts DISABLE TRIGGER lifecycle_receipts_bind_operation_revision')
    try {
      await pool.query(
        `INSERT INTO lifecycle_outcome_receipts
           (tenant_id,digest,operation_id,operation_revision,state,snapshot_digest,payload,recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        values,
      )
    } finally {
      await pool.query('ALTER TABLE lifecycle_outcome_receipts ENABLE TRIGGER lifecycle_receipts_bind_operation_revision')
    }
    await expect(value.repository.receipt(value.viewer, seeded.operationId)).rejects.toMatchObject({
      code: 'database_binding_invalid',
    })
  })
})
