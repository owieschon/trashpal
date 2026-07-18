import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../../drizzle/0000_durable_lifecycle.sql', import.meta.url), 'utf8')
const integrationTest = readFileSync(new URL('./postgres.integration.test.ts', import.meta.url), 'utf8')

describe('durable lifecycle migration', () => {
  it('puts tenant identity into every durable business key', () => {
    for (const table of [
      'lifecycle_cases',
      'lifecycle_evidence_snapshots',
      'lifecycle_route_quotes',
      'lifecycle_proposals',
      'lifecycle_principals',
      'lifecycle_capabilities',
      'lifecycle_approvals',
      'lifecycle_reservations',
      'lifecycle_execution_snapshots',
      'lifecycle_operations',
      'lifecycle_outcome_evidence',
      'lifecycle_operation_events',
      'lifecycle_dispatch_outbox',
      'lifecycle_assignments',
      'lifecycle_outcome_receipts',
    ]) {
      const definition = migration.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`))?.[1]
      expect(definition, table).toContain('"tenant_id" text NOT NULL')
      expect(definition, table).toMatch(/PRIMARY KEY \("tenant_id",/)
    }
  })

  it('enforces immutable snapshots and receipts plus transactional binding checks', () => {
    expect(migration).toContain('lifecycle_execution_snapshots_immutable')
    expect(migration).toContain('lifecycle_outcome_receipts_immutable')
    expect(migration).toContain('lifecycle_approvals_bind_current_inputs')
    expect(migration).toContain('lifecycle_reservations_are_current')
    expect(migration).toContain('lifecycle_reservations_transition_monotonically')
    expect(migration).toContain('lifecycle_capabilities_revocation_only')
    expect(migration).toContain('lifecycle_principals_revoke_monotonically')
    expect(migration).toContain('lifecycle_execution_snapshots_bind_reservation')
    expect(migration).toContain('lifecycle_cases_advance_monotonically')
    expect(migration).toContain('lifecycle_outcome_evidence_is_authorized')
    expect(migration).toContain('lifecycle_operations_follow_state_machine')
    expect(migration).toContain('lifecycle_assignments_bind_snapshot')
    expect(migration).toContain('lifecycle_receipts_bind_operation_revision')
    expect(migration).toContain('"operation_revision" integer NOT NULL')
    expect(migration).toContain('"recorded_by_capability" text NOT NULL')
    expect(migration).toContain('UNIQUE ("idempotency_key")')
    expect(migration).toContain('UNIQUE ("tenant_id", "reservation_id")')
    expect(migration).toContain('UNIQUE ("tenant_id", "proposal_id")')
    expect(migration).toContain('FOREIGN KEY ("tenant_id", "operation_id", "operation_revision", "state")')
  })

  it('rejects nullable JSON comparisons and binds fixed-shape payloads exactly', () => {
    expect(migration).toContain('jsonb_typeof("payload") IS NOT DISTINCT FROM \'object\'')
    expect(migration).toContain('"payload" ?& ARRAY[')
    expect(migration).toContain('execution snapshot payload has missing, null, mistyped, or extra fields')
    expect(migration).toContain('outcome evidence payload has missing, null, mistyped, or extra fields')
    expect(migration).toContain('receipt payload has missing, null, mistyped, or extra fields')
    expect(migration).toContain('expected_evidence')
    expect(migration).toContain('NEW."observed_at" < GREATEST(current_operation."created_at", previous_event_at)')
  })

  it('turns the PostgreSQL integration skip into a fail-closed CI gate', () => {
    expect(integrationTest).toContain("process.env.POSTGRES_REQUIRE_REAL === '1' && !databaseUrl")
    expect(integrationTest).toContain('POSTGRES_REQUIRE_REAL=1 requires TEST_DATABASE_URL')
  })
})
