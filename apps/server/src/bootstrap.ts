import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  FileProviderAssignmentStore,
  SimulatedDispatchConnector,
} from '@trashpal/adapters'
import {
  ProcessSessionAuthority,
  createLifecyclePostgresPool,
  type DispatchConnector,
  type LifecyclePostgresPool,
} from '@trashpal/lifecycle'
import { createComposedRuntime, type ComposedRuntime } from './composition.js'
import { createTrashPalOperatorApi, LocalDemoSessionStore } from './operator.js'

const localDatabaseUrl = 'postgresql://trashpal:trashpal_local_only@127.0.0.1:54329/trashpal_core_test'
const migrationUrl = new URL('../../../drizzle/0000_durable_lifecycle.sql', import.meta.url)
const localDemoSchema = 'trashpal_local_demo'

export interface LocalDemoServer {
  readonly app: ReturnType<typeof createTrashPalOperatorApi>
  readonly runtime: ComposedRuntime
  readonly sessions: LocalDemoSessionStore
  close(): Promise<void>
}

export interface CreateLocalDemoServerOptions {
  readonly databaseUrl?: string
  readonly connector?: DispatchConnector
  readonly providerStatePath?: string
}

/**
 * Builds the loopback-only local demo. It initializes the existing pinned
 * PostgreSQL Compose service and uses the simulated lost-ack profile by
 * default, so the operator journey exercises durable reconciliation.
 */
export async function createLocalDemoServer(options: CreateLocalDemoServerOptions = {}): Promise<LocalDemoServer> {
  const connectionString = options.databaseUrl ?? process.env.TRASHPAL_DATABASE_URL ?? localDatabaseUrl
  assertLocalDemoDatabaseUrl(connectionString)
  const bootstrapPool = createLifecyclePostgresPool({
    connectionString,
    applicationName: 'trashpal-local-demo-bootstrap',
    max: 2,
  })
  try {
    await resetLocalDemoSchema(bootstrapPool)
  } finally {
    await bootstrapPool.end()
  }
  const pool = createLifecyclePostgresPool({
    connectionString,
    applicationName: 'trashpal-local-demo',
    max: 12,
    searchPath: localDemoSchema,
  })
  try {
    await initializeLifecycleSchema(pool)
  } catch (error) {
    await pool.end()
    throw error
  }

  const authority = new ProcessSessionAuthority(randomBytes(32), { defaultTtlMs: 60 * 60 * 1_000 })
  const dispatcherSession = authority.issue({
    subjectId: 'usr_local_dispatcher',
    tenantId: 'ten_harborworks',
    capabilities: ['read_lifecycle', 'approve_recovery'],
  })
  const preparationWorker = authority.issueWorker({
    workerId: 'worker_local_preparation',
    tenantId: 'ten_harborworks',
    capabilities: ['prepare_decision_inputs'],
  })
  const dispatchWorker = authority.issueWorker({
    workerId: 'worker_local_dispatch',
    tenantId: 'ten_harborworks',
    capabilities: ['dispatch_recovery', 'reconcile_dispatch', 'record_provider_evidence'],
  })
  const connector = options.connector ?? new SimulatedDispatchConnector({
    store: new FileProviderAssignmentStore(options.providerStatePath
      ?? resolve(process.cwd(), '.trashpal-local-demo', 'provider-assignments.json')),
    mode: 'accept_then_lose_ack',
  })
  const runtime = createComposedRuntime({
    pool,
    authority,
    connector,
    workers: { preparation: preparationWorker, dispatch: dispatchWorker },
  })
  const sessions = new LocalDemoSessionStore({ authority, dispatcherSession })
  const app = createTrashPalOperatorApi({ runtime, sessions })
  let closed = false

  return {
    app,
    runtime,
    sessions,
    async close() {
      if (closed) return
      closed = true
      await app.close()
      await pool.end()
    },
  }
}

/** The reset-on-start local demo is intentionally limited to loopback PostgreSQL. */
export function assertLocalDemoDatabaseUrl(connectionString: string): void {
  let parsed: URL
  try {
    parsed = new URL(connectionString)
  } catch {
    throw new Error('TRASHPAL_DATABASE_URL must be a valid loopback PostgreSQL URL for the local demo.')
  }
  const host = parsed.hostname.toLowerCase()
  const isPostgres = parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:'
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (!isPostgres || !isLoopback) {
    throw new Error('The local demo may reset only a loopback PostgreSQL database.')
  }
}

/** Initialize lifecycle tables in the pool's first active search-path schema. */
export async function initializeLifecycleSchema(pool: LifecyclePostgresPool): Promise<void> {
  await pool.query("SELECT pg_advisory_lock(hashtext('trashpal_durable_lifecycle_schema_v1'))")
  try {
    const present = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass(format('%I.lifecycle_cases', current_schema())) AS relation",
    )
    if (!present.rows[0]?.relation) {
      await pool.query(await readFile(migrationUrl, 'utf8'))
    }
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext('trashpal_durable_lifecycle_schema_v1'))")
  }
}

/** A local demo always starts from one isolated schema, never public rows. */
async function resetLocalDemoSchema(pool: LifecyclePostgresPool): Promise<void> {
  await pool.query("SELECT pg_advisory_lock(hashtext('trashpal_local_demo_schema_reset_v1'))")
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${localDemoSchema} CASCADE`)
    await pool.query(`CREATE SCHEMA ${localDemoSchema}`)
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext('trashpal_local_demo_schema_reset_v1'))")
  }
}

async function main(): Promise<void> {
  const port = localPort(process.env.TRASHPAL_LOCAL_DEMO_PORT)
  const server = await createLocalDemoServer()
  try {
    await server.app.listen({ host: '127.0.0.1', port })
    process.stdout.write(`TrashPal local demo listening on http://127.0.0.1:${port}\n`)
  } catch (error) {
    await server.close()
    throw error
  }
}

function localPort(value: string | undefined): number {
  if (value === undefined) return 3211
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('TRASHPAL_LOCAL_DEMO_PORT must be a valid TCP port.')
  }
  return port
}

const entrypoint = process.argv[1]
if (entrypoint && pathToFileURL(resolve(process.cwd(), entrypoint)).href === import.meta.url) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown local demo startup failure.'
    process.stderr.write(`TrashPal local demo failed: ${message}\n`)
    process.exitCode = 1
  })
}
