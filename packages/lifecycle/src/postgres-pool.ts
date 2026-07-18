import { createRequire } from 'node:module'
import { LifecycleError } from './errors.js'
import type { LifecyclePostgresPool } from './types.js'

export interface LifecyclePostgresPoolOptions {
  connectionString: string
  max?: number
  applicationName?: string
  connectionTimeoutMs?: number
  idleTimeoutMs?: number
  statementTimeoutMs?: number
  searchPath?: string
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string }
}

interface PgPoolConstructor {
  new(config: Readonly<Record<string, unknown>>): LifecyclePostgresPool
}

const require = createRequire(import.meta.url)
const { Pool } = require('pg') as { Pool: PgPoolConstructor }
const searchPathPattern = /^[a-z_][a-z0-9_]*$/

export function createLifecyclePostgresPool(options: LifecyclePostgresPoolOptions): LifecyclePostgresPool {
  if (!options.connectionString) {
    throw new LifecycleError('database_configuration_invalid', 'A PostgreSQL connection string is required.')
  }
  if (options.searchPath !== undefined && !searchPathPattern.test(options.searchPath)) {
    throw new LifecycleError('database_configuration_invalid', 'The PostgreSQL search path must be one unquoted identifier.')
  }
  const boundedIntegers = [
    ['max', options.max],
    ['connectionTimeoutMs', options.connectionTimeoutMs],
    ['idleTimeoutMs', options.idleTimeoutMs],
    ['statementTimeoutMs', options.statementTimeoutMs],
  ] as const
  for (const [label, value] of boundedIntegers) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new LifecycleError('database_configuration_invalid', `${label} must be a non-negative safe integer.`)
    }
  }
  return new Pool({
    connectionString: options.connectionString,
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.applicationName !== undefined ? { application_name: options.applicationName } : {}),
    ...(options.connectionTimeoutMs !== undefined ? { connectionTimeoutMillis: options.connectionTimeoutMs } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMillis: options.idleTimeoutMs } : {}),
    ...(options.statementTimeoutMs !== undefined ? { statement_timeout: options.statementTimeoutMs } : {}),
    ...(options.searchPath !== undefined ? { options: `-c search_path=${options.searchPath},public` } : {}),
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
}
