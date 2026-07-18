import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLifecyclePostgresPool, type LifecyclePostgresPool } from '../../packages/lifecycle/src/index.js'
import { assertLocalDemoDatabaseUrl, initializeLifecycleSchema } from '../../apps/server/src/bootstrap.js'

const databaseUrl = process.env.TEST_DATABASE_URL ?? ''
const describePostgres = databaseUrl ? describe : describe.skip

describe('local demo database guard', () => {
  it.each([
    'postgresql://trashpal:local@127.0.0.1:54329/trashpal_core_test',
    'postgresql://trashpal:local@localhost:54329/trashpal_core_test',
    'postgresql://trashpal:local@[::1]:54329/trashpal_core_test',
  ])('allows the loopback URL %s', (url) => {
    expect(() => assertLocalDemoDatabaseUrl(url)).not.toThrow()
  })

  it.each([
    'postgresql://trashpal:local@db.example.com:5432/trashpal',
    'postgresql://trashpal:local@10.0.0.8:5432/trashpal',
    'https://127.0.0.1:5432/trashpal',
  ])('rejects a non-local reset target %s', (url) => {
    expect(() => assertLocalDemoDatabaseUrl(url)).toThrow(/loopback PostgreSQL/)
  })
})

describePostgres('local demo schema bootstrap', () => {
  let bootstrapPool: LifecyclePostgresPool
  let scopedPool: LifecyclePostgresPool
  let schema = ''

  beforeAll(async () => {
    schema = `bootstrap_${randomUUID().replaceAll('-', '')}`
    bootstrapPool = createLifecyclePostgresPool({ connectionString: databaseUrl, max: 2 })
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`)
    scopedPool = createLifecyclePostgresPool({ connectionString: databaseUrl, searchPath: schema, max: 2 })
    await initializeLifecycleSchema(scopedPool)
  })

  afterAll(async () => {
    if (scopedPool) await scopedPool.end()
    if (bootstrapPool && schema) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await bootstrapPool.end()
    }
  })

  it('creates lifecycle tables in the scoped schema even when public has prior tables', async () => {
    const relation = await scopedPool.query<{ relation: string | null }>(
      "SELECT to_regclass(format('%I.lifecycle_cases', current_schema())) AS relation",
    )
    const table = await scopedPool.query<{ table_schema: string }>(
      "SELECT table_schema FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='lifecycle_cases'",
    )

    expect(relation.rows[0]?.relation).toBe('lifecycle_cases')
    expect(table.rows).toEqual([{ table_schema: schema }])
  })
})
