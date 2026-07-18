CREATE TABLE "lifecycle_cases" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "source_id" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "evidence_revision" integer NOT NULL DEFAULT 0 CHECK ("evidence_revision" >= 0),
  "route_revision" integer NOT NULL DEFAULT 0 CHECK ("route_revision" >= 0),
  "state" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "id"),
  UNIQUE ("tenant_id", "source_id")
);

CREATE TABLE "lifecycle_evidence_snapshots" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "case_id" text NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 0),
  "packet_hash" text NOT NULL CHECK ("packet_hash" ~ '^[0-9a-f]{64}$'),
  "payload" jsonb NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "id"),
  UNIQUE ("tenant_id", "case_id", "revision"),
  UNIQUE ("tenant_id", "id", "case_id", "revision", "packet_hash"),
  FOREIGN KEY ("tenant_id", "case_id") REFERENCES "lifecycle_cases" ("tenant_id", "id") ON DELETE RESTRICT,
  CHECK ("valid_until" > "observed_at"),
  CHECK (
    jsonb_typeof("payload") IS NOT DISTINCT FROM 'object'
    AND "payload" ?& ARRAY['id', 'tenantId', 'caseId', 'revision', 'validUntil']
    AND jsonb_typeof("payload"->'id') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'tenantId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'caseId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'revision') IS NOT DISTINCT FROM 'number'
    AND jsonb_typeof("payload"->'validUntil') IS NOT DISTINCT FROM 'string'
    AND ("payload"->>'id') IS NOT DISTINCT FROM "id"
    AND ("payload"->>'tenantId') IS NOT DISTINCT FROM "tenant_id"
    AND ("payload"->>'caseId') IS NOT DISTINCT FROM "case_id"
    AND ("payload"->>'revision')::integer IS NOT DISTINCT FROM "revision"
    AND ("payload"->>'validUntil')::timestamptz IS NOT DISTINCT FROM "valid_until"
  )
);

CREATE TABLE "lifecycle_route_quotes" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "case_id" text NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 0),
  "quote_hash" text NOT NULL CHECK ("quote_hash" ~ '^[0-9a-f]{64}$'),
  "vehicle_id" text NOT NULL,
  "service_start" timestamptz NOT NULL,
  "service_end" timestamptz NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "payload" jsonb NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "id"),
  UNIQUE ("tenant_id", "case_id", "revision"),
  UNIQUE ("tenant_id", "id", "case_id", "revision", "quote_hash"),
  FOREIGN KEY ("tenant_id", "case_id") REFERENCES "lifecycle_cases" ("tenant_id", "id") ON DELETE RESTRICT,
  CHECK ("service_end" > "service_start"),
  CHECK ("valid_until" > "created_at"),
  CHECK (
    jsonb_typeof("payload") IS NOT DISTINCT FROM 'object'
    AND "payload" ?& ARRAY['id', 'tenantId', 'caseId', 'revision', 'vehicleId', 'serviceStart', 'serviceEnd', 'validUntil']
    AND jsonb_typeof("payload"->'id') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'tenantId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'caseId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'revision') IS NOT DISTINCT FROM 'number'
    AND jsonb_typeof("payload"->'vehicleId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'serviceStart') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'serviceEnd') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'validUntil') IS NOT DISTINCT FROM 'string'
    AND ("payload"->>'id') IS NOT DISTINCT FROM "id"
    AND ("payload"->>'tenantId') IS NOT DISTINCT FROM "tenant_id"
    AND ("payload"->>'caseId') IS NOT DISTINCT FROM "case_id"
    AND ("payload"->>'revision')::integer IS NOT DISTINCT FROM "revision"
    AND ("payload"->>'vehicleId') IS NOT DISTINCT FROM "vehicle_id"
    AND ("payload"->>'serviceStart')::timestamptz IS NOT DISTINCT FROM "service_start"
    AND ("payload"->>'serviceEnd')::timestamptz IS NOT DISTINCT FROM "service_end"
    AND ("payload"->>'validUntil')::timestamptz IS NOT DISTINCT FROM "valid_until"
  )
);

CREATE TABLE "lifecycle_proposals" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "case_id" text NOT NULL,
  "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  "context_bundle_hash" text NOT NULL CHECK ("context_bundle_hash" ~ '^[0-9a-f]{64}$'),
  "context_bundle_payload" jsonb NOT NULL,
  "evidence_snapshot_id" text NOT NULL,
  "evidence_packet_hash" text NOT NULL CHECK ("evidence_packet_hash" ~ '^[0-9a-f]{64}$'),
  "evidence_revision" integer NOT NULL CHECK ("evidence_revision" >= 0),
  "route_quote_id" text NOT NULL,
  "route_quote_hash" text NOT NULL CHECK ("route_quote_hash" ~ '^[0-9a-f]{64}$'),
  "route_revision" integer NOT NULL CHECK ("route_revision" >= 0),
  "vehicle_id" text NOT NULL,
  "service_start" timestamptz NOT NULL,
  "service_end" timestamptz NOT NULL,
  "payload" jsonb NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "id"),
  UNIQUE ("tenant_id", "digest"),
  UNIQUE ("tenant_id", "id", "digest"),
  FOREIGN KEY ("tenant_id", "case_id") REFERENCES "lifecycle_cases" ("tenant_id", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("tenant_id", "evidence_snapshot_id", "case_id", "evidence_revision", "evidence_packet_hash")
    REFERENCES "lifecycle_evidence_snapshots" ("tenant_id", "id", "case_id", "revision", "packet_hash") ON DELETE RESTRICT,
  FOREIGN KEY ("tenant_id", "route_quote_id", "case_id", "route_revision", "route_quote_hash")
    REFERENCES "lifecycle_route_quotes" ("tenant_id", "id", "case_id", "revision", "quote_hash") ON DELETE RESTRICT,
  CHECK ("service_end" > "service_start"),
  CHECK (
    jsonb_typeof("context_bundle_payload") IS NOT DISTINCT FROM 'object'
    AND "context_bundle_payload" ? 'tenantId'
    AND jsonb_typeof("context_bundle_payload"->'tenantId') IS NOT DISTINCT FROM 'string'
    AND ("context_bundle_payload"->>'tenantId') IS NOT DISTINCT FROM "tenant_id"
    AND jsonb_typeof("payload") IS NOT DISTINCT FROM 'object'
    AND "payload" ?& ARRAY['id', 'tenantId', 'caseId', 'routeQuoteId', 'workOrder', 'validUntil']
    AND jsonb_typeof("payload"->'id') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'tenantId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'caseId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'routeQuoteId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'workOrder') IS NOT DISTINCT FROM 'object'
    AND ("payload"->'workOrder') ?& ARRAY['vehicleId', 'serviceStart', 'serviceEnd']
    AND jsonb_typeof("payload"#>'{workOrder,vehicleId}') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"#>'{workOrder,serviceStart}') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"#>'{workOrder,serviceEnd}') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload"->'validUntil') IS NOT DISTINCT FROM 'string'
    AND ("payload"->>'id') IS NOT DISTINCT FROM "id"
    AND ("payload"->>'tenantId') IS NOT DISTINCT FROM "tenant_id"
    AND ("payload"->>'caseId') IS NOT DISTINCT FROM "case_id"
    AND ("payload"->>'routeQuoteId') IS NOT DISTINCT FROM "route_quote_id"
    AND ("payload"#>>'{workOrder,vehicleId}') IS NOT DISTINCT FROM "vehicle_id"
    AND ("payload"#>>'{workOrder,serviceStart}')::timestamptz IS NOT DISTINCT FROM "service_start"
    AND ("payload"#>>'{workOrder,serviceEnd}')::timestamptz IS NOT DISTINCT FROM "service_end"
    AND ("payload"->>'validUntil')::timestamptz IS NOT DISTINCT FROM "valid_until"
  )
);

CREATE TABLE "lifecycle_principals" (
  "tenant_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('user', 'worker')),
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  PRIMARY KEY ("tenant_id", "subject_id"),
  CHECK ("expires_at" > "created_at")
);

CREATE TABLE "lifecycle_capabilities" (
  "tenant_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "capability" text NOT NULL CHECK ("capability" IN (
    'approve_recovery', 'read_lifecycle', 'confirm_customer_outcome',
    'dispute_customer_outcome', 'reopen_recovery', 'prepare_decision_inputs',
    'dispatch_recovery', 'reconcile_dispatch', 'record_provider_evidence',
    'manage_lifecycle_authority'
  )),
  "granted_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "revoked_at" timestamptz,
  PRIMARY KEY ("tenant_id", "subject_id", "capability"),
  FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "lifecycle_principals" ("tenant_id", "subject_id") ON DELETE CASCADE
);

CREATE TABLE "lifecycle_approvals" (
  "tenant_id" text NOT NULL,
  "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  "proposal_id" text NOT NULL,
  "proposal_digest" text NOT NULL CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  "context_bundle_hash" text NOT NULL CHECK ("context_bundle_hash" ~ '^[0-9a-f]{64}$'),
  "evidence_packet_hash" text NOT NULL CHECK ("evidence_packet_hash" ~ '^[0-9a-f]{64}$'),
  "evidence_revision" integer NOT NULL CHECK ("evidence_revision" >= 0),
  "route_quote_hash" text NOT NULL CHECK ("route_quote_hash" ~ '^[0-9a-f]{64}$'),
  "route_revision" integer NOT NULL CHECK ("route_revision" >= 0),
  "approver_subject_id" text NOT NULL,
  "capability" text NOT NULL CHECK ("capability" = 'approve_recovery'),
  "approved_at" timestamptz NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  PRIMARY KEY ("tenant_id", "digest"),
  UNIQUE ("tenant_id", "proposal_id"),
  UNIQUE ("tenant_id", "digest", "proposal_id"),
  FOREIGN KEY ("tenant_id", "proposal_id", "proposal_digest")
    REFERENCES "lifecycle_proposals" ("tenant_id", "id", "digest") ON DELETE RESTRICT,
  FOREIGN KEY ("tenant_id", "approver_subject_id", "capability")
    REFERENCES "lifecycle_capabilities" ("tenant_id", "subject_id", "capability") ON DELETE RESTRICT,
  CHECK ("valid_until" > "approved_at")
);

CREATE TABLE "lifecycle_reservations" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "proposal_id" text NOT NULL,
  "approval_digest" text NOT NULL,
  "proposal_digest" text NOT NULL CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  "context_bundle_hash" text NOT NULL CHECK ("context_bundle_hash" ~ '^[0-9a-f]{64}$'),
  "evidence_packet_hash" text NOT NULL CHECK ("evidence_packet_hash" ~ '^[0-9a-f]{64}$'),
  "evidence_revision" integer NOT NULL CHECK ("evidence_revision" >= 0),
  "route_quote_hash" text NOT NULL CHECK ("route_quote_hash" ~ '^[0-9a-f]{64}$'),
  "route_revision" integer NOT NULL CHECK ("route_revision" >= 0),
  "state" text NOT NULL CHECK ("state" IN ('reserved', 'cancelled', 'consumed')),
  "reserved_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "cancelled_at" timestamptz,
  "cancel_reason" text,
  "consumed_at" timestamptz,
  PRIMARY KEY ("tenant_id", "id"),
  UNIQUE ("tenant_id", "proposal_id"),
  UNIQUE ("tenant_id", "approval_digest"),
  UNIQUE ("tenant_id", "id", "proposal_id", "approval_digest"),
  FOREIGN KEY ("tenant_id", "approval_digest", "proposal_id")
    REFERENCES "lifecycle_approvals" ("tenant_id", "digest", "proposal_id") ON DELETE RESTRICT,
  CHECK (
    ("state" = 'reserved' AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL AND "consumed_at" IS NULL)
    OR ("state" = 'cancelled' AND "cancelled_at" IS NOT NULL AND btrim("cancel_reason") <> '' AND "consumed_at" IS NULL)
    OR ("state" = 'consumed' AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL AND "consumed_at" IS NOT NULL)
  )
);

CREATE TABLE "lifecycle_execution_snapshots" (
  "tenant_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "reservation_id" text NOT NULL,
  "case_id" text NOT NULL,
  "proposal_id" text NOT NULL,
  "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  "proposal_digest" text NOT NULL CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  "approval_digest" text NOT NULL CHECK ("approval_digest" ~ '^[0-9a-f]{64}$'),
  "context_bundle_hash" text NOT NULL CHECK ("context_bundle_hash" ~ '^[0-9a-f]{64}$'),
  "evidence_packet_hash" text NOT NULL CHECK ("evidence_packet_hash" ~ '^[0-9a-f]{64}$'),
  "evidence_revision" integer NOT NULL CHECK ("evidence_revision" >= 0),
  "route_quote_hash" text NOT NULL CHECK ("route_quote_hash" ~ '^[0-9a-f]{64}$'),
  "route_revision" integer NOT NULL CHECK ("route_revision" >= 0),
  "vehicle_id" text NOT NULL,
  "service_start" timestamptz NOT NULL,
  "service_end" timestamptz NOT NULL,
  "approval_valid_until" timestamptz NOT NULL,
  "approver_subject_id" text NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "captured_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "operation_id"),
  UNIQUE ("tenant_id", "reservation_id"),
  UNIQUE ("tenant_id", "digest"),
  UNIQUE ("idempotency_key"),
  UNIQUE ("tenant_id", "operation_id", "digest"),
  UNIQUE ("tenant_id", "operation_id", "digest", "idempotency_key"),
  FOREIGN KEY ("tenant_id", "reservation_id", "proposal_id", "approval_digest")
    REFERENCES "lifecycle_reservations" ("tenant_id", "id", "proposal_id", "approval_digest") ON DELETE RESTRICT,
  FOREIGN KEY ("tenant_id", "approval_digest", "proposal_id")
    REFERENCES "lifecycle_approvals" ("tenant_id", "digest", "proposal_id") ON DELETE RESTRICT,
  CHECK ("service_end" > "service_start"),
  CHECK ("approval_valid_until" > "captured_at")
);

CREATE TABLE "lifecycle_operations" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "snapshot_digest" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN (
    'reserved', 'sending', 'accepted', 'unknown', 'assignment_reconciled',
    'driver_reported', 'supporting_evidence_received', 'evidence_reconciled',
    'customer_confirmed', 'disputed', 'reopened', 'cancelled', 'failed'
  )),
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "id"),
  UNIQUE ("tenant_id", "id", "snapshot_digest"),
  FOREIGN KEY ("tenant_id", "id", "snapshot_digest")
    REFERENCES "lifecycle_execution_snapshots" ("tenant_id", "operation_id", "digest") ON DELETE RESTRICT
);

CREATE TABLE "lifecycle_outcome_evidence" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "operation_id" text NOT NULL,
  "operation_revision" integer NOT NULL CHECK ("operation_revision" > 0),
  "kind" text NOT NULL CHECK ("kind" IN (
    'driver_report', 'supporting_attachment', 'reconciliation',
    'customer_confirmation', 'customer_dispute', 'reopen'
  )),
  "source_id" text NOT NULL,
  "content_hash" text NOT NULL CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  "payload" jsonb NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "recorded_by_subject_id" text NOT NULL,
  "recorded_by_capability" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "id"),
  UNIQUE ("tenant_id", "operation_id", "source_id"),
  UNIQUE ("tenant_id", "operation_id", "id"),
  UNIQUE ("tenant_id", "operation_id", "operation_revision", "id"),
  FOREIGN KEY ("tenant_id", "operation_id") REFERENCES "lifecycle_operations" ("tenant_id", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("tenant_id", "recorded_by_subject_id", "recorded_by_capability")
    REFERENCES "lifecycle_capabilities" ("tenant_id", "subject_id", "capability") ON DELETE RESTRICT,
  CHECK ("observed_at" <= "created_at" + interval '5 minutes')
);

CREATE TABLE "lifecycle_operation_events" (
  "tenant_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "sequence" integer NOT NULL CHECK ("sequence" >= 0),
  "state" text NOT NULL CHECK ("state" IN (
    'reserved', 'sending', 'accepted', 'unknown', 'assignment_reconciled',
    'driver_reported', 'supporting_evidence_received', 'evidence_reconciled',
    'customer_confirmed', 'disputed', 'reopened', 'cancelled', 'failed'
  )),
  "reason" text,
  "evidence_id" text,
  "occurred_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "operation_id", "sequence"),
  UNIQUE ("tenant_id", "operation_id", "sequence", "state"),
  FOREIGN KEY ("tenant_id", "operation_id") REFERENCES "lifecycle_operations" ("tenant_id", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("tenant_id", "operation_id", "sequence", "evidence_id")
    REFERENCES "lifecycle_outcome_evidence" ("tenant_id", "operation_id", "operation_revision", "id") ON DELETE RESTRICT,
  CHECK ("reason" IS NULL OR btrim("reason") <> '')
);

CREATE TABLE "lifecycle_dispatch_outbox" (
  "tenant_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "snapshot_digest" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('pending', 'leased', 'sent', 'unknown', 'cancelled', 'failed')),
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "last_reconciled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "operation_id"),
  UNIQUE ("idempotency_key"),
  FOREIGN KEY ("tenant_id", "operation_id", "snapshot_digest", "idempotency_key")
    REFERENCES "lifecycle_execution_snapshots" ("tenant_id", "operation_id", "digest", "idempotency_key") ON DELETE RESTRICT,
  CHECK (
    ("state" = 'leased' AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR ("state" <> 'leased' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)
  )
);

CREATE TABLE "lifecycle_assignments" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "operation_id" text NOT NULL,
  "provider_assignment_id" text NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "snapshot_digest" text NOT NULL,
  "proposal_digest" text NOT NULL CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  "approval_digest" text NOT NULL CHECK ("approval_digest" ~ '^[0-9a-f]{64}$'),
  "route_quote_hash" text NOT NULL CHECK ("route_quote_hash" ~ '^[0-9a-f]{64}$'),
  "vehicle_id" text NOT NULL,
  "service_start" timestamptz NOT NULL,
  "service_end" timestamptz NOT NULL,
  "accepted_at" timestamptz NOT NULL,
  "reconciled_at" timestamptz,
  PRIMARY KEY ("tenant_id", "id"),
  UNIQUE ("tenant_id", "operation_id"),
  UNIQUE ("tenant_id", "provider_assignment_id"),
  UNIQUE ("idempotency_key"),
  FOREIGN KEY ("tenant_id", "operation_id", "snapshot_digest", "idempotency_key")
    REFERENCES "lifecycle_execution_snapshots" ("tenant_id", "operation_id", "digest", "idempotency_key") ON DELETE RESTRICT,
  CHECK ("service_end" > "service_start")
);

CREATE TABLE "lifecycle_outcome_receipts" (
  "tenant_id" text NOT NULL,
  "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  "operation_id" text NOT NULL,
  "operation_revision" integer NOT NULL CHECK ("operation_revision" >= 0),
  "state" text NOT NULL CHECK ("state" IN (
    'reserved', 'sending', 'accepted', 'unknown', 'assignment_reconciled',
    'driver_reported', 'supporting_evidence_received', 'evidence_reconciled',
    'customer_confirmed', 'disputed', 'reopened', 'cancelled', 'failed'
  )),
  "snapshot_digest" text NOT NULL,
  "payload" jsonb NOT NULL,
  "recorded_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "digest"),
  UNIQUE ("tenant_id", "operation_id", "operation_revision"),
  FOREIGN KEY ("tenant_id", "operation_id", "snapshot_digest")
    REFERENCES "lifecycle_operations" ("tenant_id", "id", "snapshot_digest") ON DELETE RESTRICT,
  FOREIGN KEY ("tenant_id", "operation_id", "operation_revision", "state")
    REFERENCES "lifecycle_operation_events" ("tenant_id", "operation_id", "sequence", "state") ON DELETE RESTRICT
);

CREATE FUNCTION "lifecycle_reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "lifecycle_evidence_snapshots_immutable"
BEFORE UPDATE OR DELETE ON "lifecycle_evidence_snapshots"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_reject_mutation"();

CREATE TRIGGER "lifecycle_execution_snapshots_immutable"
BEFORE UPDATE OR DELETE ON "lifecycle_execution_snapshots"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_reject_mutation"();

CREATE TRIGGER "lifecycle_operation_events_immutable"
BEFORE UPDATE OR DELETE ON "lifecycle_operation_events"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_reject_mutation"();

CREATE TRIGGER "lifecycle_outcome_evidence_immutable"
BEFORE UPDATE OR DELETE ON "lifecycle_outcome_evidence"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_reject_mutation"();

CREATE TRIGGER "lifecycle_outcome_receipts_immutable"
BEFORE UPDATE OR DELETE ON "lifecycle_outcome_receipts"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_reject_mutation"();

CREATE TRIGGER "lifecycle_assignments_immutable"
BEFORE UPDATE OR DELETE ON "lifecycle_assignments"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_reject_mutation"();

CREATE FUNCTION "lifecycle_guard_revocation_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD."revoked_at" IS NOT NULL
     OR NEW."revoked_at" IS NULL
     OR (to_jsonb(NEW) - 'revoked_at') <> (to_jsonb(OLD) - 'revoked_at')
  THEN
    RAISE EXCEPTION '% permits only a one-way revocation', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_route_quotes_revocation_only"
BEFORE UPDATE OR DELETE ON "lifecycle_route_quotes"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_guard_revocation_update"();

CREATE TRIGGER "lifecycle_proposals_revocation_only"
BEFORE UPDATE OR DELETE ON "lifecycle_proposals"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_guard_revocation_update"();

CREATE TRIGGER "lifecycle_approvals_revocation_only"
BEFORE UPDATE OR DELETE ON "lifecycle_approvals"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_guard_revocation_update"();

CREATE TRIGGER "lifecycle_capabilities_revocation_only"
BEFORE UPDATE OR DELETE ON "lifecycle_capabilities"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_guard_revocation_update"();

CREATE FUNCTION "lifecycle_guard_principal_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'principal revocation is terminal' USING ERRCODE = '55000';
  END IF;
  IF NEW."revoked_at" IS NOT NULL THEN
    IF NEW."enabled" IS DISTINCT FROM false
       OR (to_jsonb(NEW) - ARRAY['enabled', 'revoked_at']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['enabled', 'revoked_at'])
    THEN
      RAISE EXCEPTION 'principal revocation may only disable the principal' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."enabled" IS DISTINCT FROM true
     OR NEW."expires_at" < OLD."expires_at"
     OR (to_jsonb(NEW) - 'expires_at') IS DISTINCT FROM (to_jsonb(OLD) - 'expires_at')
  THEN
    RAISE EXCEPTION 'active principal updates may only extend expiry' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_principals_revoke_monotonically"
BEFORE UPDATE OR DELETE ON "lifecycle_principals"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_guard_principal_update"();

CREATE FUNCTION "lifecycle_validate_case_revision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."id" <> OLD."id"
     OR NEW."source_id" <> OLD."source_id"
     OR NEW."revision" <> OLD."revision" + 1
     OR NEW."evidence_revision" < OLD."evidence_revision"
     OR NEW."route_revision" < OLD."route_revision"
  THEN
    RAISE EXCEPTION 'case truth revisions are monotonic' USING ERRCODE = '23514';
  END IF;
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_cases_advance_monotonically"
BEFORE UPDATE ON "lifecycle_cases"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_validate_case_revision"();

CREATE FUNCTION "lifecycle_validate_approval_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_proposal "lifecycle_proposals"%ROWTYPE;
  current_case "lifecycle_cases"%ROWTYPE;
  database_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO current_proposal FROM "lifecycle_proposals"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."proposal_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval proposal does not exist' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO current_case FROM "lifecycle_cases"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = current_proposal."case_id" FOR UPDATE;

  IF current_proposal."revoked_at" IS NOT NULL
     OR current_proposal."valid_until" <= database_now
     OR abs(extract(epoch FROM (NEW."approved_at" - database_now))) > 5
     OR NEW."valid_until" <> current_proposal."valid_until"
     OR current_case."evidence_revision" <> current_proposal."evidence_revision"
     OR current_case."route_revision" <> current_proposal."route_revision"
     OR NOT EXISTS (
       SELECT 1 FROM "lifecycle_evidence_snapshots" evidence
       WHERE evidence."tenant_id" = current_proposal."tenant_id"
         AND evidence."id" = current_proposal."evidence_snapshot_id"
         AND evidence."case_id" = current_proposal."case_id"
         AND evidence."revision" = current_proposal."evidence_revision"
         AND evidence."packet_hash" = current_proposal."evidence_packet_hash"
         AND evidence."valid_until" > database_now
     )
     OR NOT EXISTS (
       SELECT 1 FROM "lifecycle_route_quotes" quote
       WHERE quote."tenant_id" = current_proposal."tenant_id"
         AND quote."id" = current_proposal."route_quote_id"
         AND quote."case_id" = current_proposal."case_id"
         AND quote."revision" = current_proposal."route_revision"
         AND quote."quote_hash" = current_proposal."route_quote_hash"
         AND quote."vehicle_id" = current_proposal."vehicle_id"
         AND quote."service_start" = current_proposal."service_start"
         AND quote."service_end" = current_proposal."service_end"
         AND quote."valid_until" >= current_proposal."valid_until"
         AND quote."valid_until" > database_now
         AND quote."revoked_at" IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM "lifecycle_principals" principal
       JOIN "lifecycle_capabilities" capability
         ON capability."tenant_id" = principal."tenant_id" AND capability."subject_id" = principal."subject_id"
       WHERE principal."tenant_id" = NEW."tenant_id"
         AND principal."subject_id" = NEW."approver_subject_id"
         AND principal."kind" = 'user' AND principal."enabled" = true
         AND principal."revoked_at" IS NULL AND principal."expires_at" > database_now
         AND capability."capability" = NEW."capability" AND capability."revoked_at" IS NULL
     )
     OR current_proposal."digest" <> NEW."proposal_digest"
     OR current_proposal."context_bundle_hash" <> NEW."context_bundle_hash"
     OR current_proposal."evidence_packet_hash" <> NEW."evidence_packet_hash"
     OR current_proposal."evidence_revision" <> NEW."evidence_revision"
     OR current_proposal."route_quote_hash" <> NEW."route_quote_hash"
     OR current_proposal."route_revision" <> NEW."route_revision"
  THEN
    RAISE EXCEPTION 'approval binding does not match current proposal inputs' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_approvals_bind_current_inputs"
BEFORE INSERT ON "lifecycle_approvals"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_validate_approval_binding"();

CREATE FUNCTION "lifecycle_validate_reservation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_approval "lifecycle_approvals"%ROWTYPE;
  current_proposal "lifecycle_proposals"%ROWTYPE;
  current_case "lifecycle_cases"%ROWTYPE;
  database_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO current_approval FROM "lifecycle_approvals"
  WHERE "tenant_id" = NEW."tenant_id" AND "digest" = NEW."approval_digest" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation approval does not exist' USING ERRCODE = '23514'; END IF;
  SELECT * INTO current_proposal FROM "lifecycle_proposals"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = current_approval."proposal_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation proposal does not exist' USING ERRCODE = '23514'; END IF;
  SELECT * INTO current_case FROM "lifecycle_cases"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = current_proposal."case_id" FOR UPDATE;

  IF NEW."state" IS DISTINCT FROM 'reserved'
     OR NEW."cancelled_at" IS NOT NULL
     OR NEW."cancel_reason" IS NOT NULL
     OR NEW."consumed_at" IS NOT NULL
     OR current_approval."revoked_at" IS NOT NULL
     OR current_approval."valid_until" <= database_now
     OR current_proposal."revoked_at" IS NOT NULL
     OR current_proposal."valid_until" <= database_now
     OR current_approval."valid_until" <> current_proposal."valid_until"
     OR current_case."evidence_revision" <> current_proposal."evidence_revision"
     OR current_case."route_revision" <> current_proposal."route_revision"
     OR current_approval."proposal_id" <> NEW."proposal_id"
     OR current_approval."proposal_digest" <> NEW."proposal_digest"
     OR current_approval."context_bundle_hash" <> NEW."context_bundle_hash"
     OR current_approval."evidence_packet_hash" <> NEW."evidence_packet_hash"
     OR current_approval."evidence_revision" <> NEW."evidence_revision"
     OR current_approval."route_quote_hash" <> NEW."route_quote_hash"
     OR current_approval."route_revision" <> NEW."route_revision"
     OR current_proposal."digest" <> NEW."proposal_digest"
     OR current_proposal."context_bundle_hash" <> NEW."context_bundle_hash"
     OR current_proposal."evidence_packet_hash" <> NEW."evidence_packet_hash"
     OR current_proposal."evidence_revision" <> NEW."evidence_revision"
     OR current_proposal."route_quote_hash" <> NEW."route_quote_hash"
     OR current_proposal."route_revision" <> NEW."route_revision"
     OR NOT EXISTS (
       SELECT 1 FROM "lifecycle_evidence_snapshots" evidence
       WHERE evidence."tenant_id" = current_proposal."tenant_id"
         AND evidence."id" = current_proposal."evidence_snapshot_id"
         AND evidence."case_id" = current_proposal."case_id"
         AND evidence."revision" = current_proposal."evidence_revision"
         AND evidence."packet_hash" = current_proposal."evidence_packet_hash"
         AND evidence."valid_until" > database_now
     )
     OR NOT EXISTS (
       SELECT 1 FROM "lifecycle_route_quotes" quote
       WHERE quote."tenant_id" = current_proposal."tenant_id"
         AND quote."id" = current_proposal."route_quote_id"
         AND quote."case_id" = current_proposal."case_id"
         AND quote."revision" = current_proposal."route_revision"
         AND quote."quote_hash" = current_proposal."route_quote_hash"
         AND quote."vehicle_id" = current_proposal."vehicle_id"
         AND quote."service_start" = current_proposal."service_start"
         AND quote."service_end" = current_proposal."service_end"
         AND quote."valid_until" >= current_proposal."valid_until"
         AND quote."valid_until" > database_now
         AND quote."revoked_at" IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM "lifecycle_principals" principal
       JOIN "lifecycle_capabilities" capability
         ON capability."tenant_id" = principal."tenant_id" AND capability."subject_id" = principal."subject_id"
       WHERE principal."tenant_id" = current_approval."tenant_id"
         AND principal."subject_id" = current_approval."approver_subject_id"
         AND principal."kind" = 'user' AND principal."enabled" = true
         AND principal."revoked_at" IS NULL AND principal."expires_at" > database_now
         AND capability."capability" = current_approval."capability" AND capability."revoked_at" IS NULL
     )
  THEN
    RAISE EXCEPTION 'reservation binding is stale or revoked' USING ERRCODE = '23514';
  END IF;
  NEW."reserved_at" := database_now;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_reservations_are_current"
BEFORE INSERT ON "lifecycle_reservations"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_validate_reservation"();

CREATE FUNCTION "lifecycle_guard_reservation_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE database_now timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservation rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" <> 'reserved'
     OR NEW."state" NOT IN ('cancelled', 'consumed')
     OR ROW(
       NEW."tenant_id", NEW."id", NEW."proposal_id", NEW."approval_digest", NEW."proposal_digest",
       NEW."context_bundle_hash", NEW."evidence_packet_hash", NEW."evidence_revision",
       NEW."route_quote_hash", NEW."route_revision", NEW."reserved_at"
     ) IS DISTINCT FROM ROW(
       OLD."tenant_id", OLD."id", OLD."proposal_id", OLD."approval_digest", OLD."proposal_digest",
       OLD."context_bundle_hash", OLD."evidence_packet_hash", OLD."evidence_revision",
       OLD."route_quote_hash", OLD."route_revision", OLD."reserved_at"
     )
  THEN
    RAISE EXCEPTION 'reservation identity is immutable and terminal states cannot transition' USING ERRCODE = '55000';
  END IF;

  IF NEW."state" = 'cancelled' THEN
    IF NEW."cancelled_at" IS NOT NULL OR NEW."consumed_at" IS NOT NULL
       OR NEW."cancel_reason" IS NULL OR btrim(NEW."cancel_reason") = ''
       OR NOT EXISTS (
         SELECT 1
         FROM "lifecycle_execution_snapshots" snapshot
         JOIN "lifecycle_operations" operation
           ON operation."tenant_id" = snapshot."tenant_id" AND operation."id" = snapshot."operation_id"
         JOIN "lifecycle_operation_events" event
           ON event."tenant_id" = operation."tenant_id" AND event."operation_id" = operation."id"
          AND event."sequence" = operation."revision" AND event."state" = operation."state"
         JOIN "lifecycle_dispatch_outbox" outbox
           ON outbox."tenant_id" = operation."tenant_id" AND outbox."operation_id" = operation."id"
         WHERE snapshot."tenant_id" = NEW."tenant_id" AND snapshot."reservation_id" = NEW."id"
           AND operation."state" IN ('cancelled', 'failed')
           AND outbox."state" = CASE operation."state" WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END
           AND event."reason" IS NOT DISTINCT FROM NEW."cancel_reason"
       )
    THEN
      RAISE EXCEPTION 'reservation cancellation does not bind the exact terminal operation event' USING ERRCODE = '23514';
    END IF;
    NEW."cancelled_at" := database_now;
    RETURN NEW;
  END IF;

  IF NEW."cancelled_at" IS NOT NULL OR NEW."cancel_reason" IS NOT NULL OR NEW."consumed_at" IS NOT NULL
     OR NOT EXISTS (
       SELECT 1
       FROM "lifecycle_execution_snapshots" snapshot
       JOIN "lifecycle_operations" operation
         ON operation."tenant_id" = snapshot."tenant_id" AND operation."id" = snapshot."operation_id"
       JOIN "lifecycle_dispatch_outbox" outbox
         ON outbox."tenant_id" = operation."tenant_id" AND outbox."operation_id" = operation."id"
       JOIN "lifecycle_assignments" assignment
         ON assignment."tenant_id" = operation."tenant_id" AND assignment."operation_id" = operation."id"
       WHERE snapshot."tenant_id" = NEW."tenant_id" AND snapshot."reservation_id" = NEW."id"
         AND operation."state" IN ('accepted', 'assignment_reconciled')
         AND outbox."state" = 'sent'
         AND assignment."snapshot_digest" = snapshot."digest"
     )
  THEN
    RAISE EXCEPTION 'reservation consumption does not bind the accepted assignment' USING ERRCODE = '23514';
  END IF;
  NEW."consumed_at" := database_now;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_reservations_transition_monotonically"
BEFORE UPDATE OR DELETE ON "lifecycle_reservations"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_guard_reservation_transition"();

CREATE FUNCTION "lifecycle_validate_execution_snapshot"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_reservation "lifecycle_reservations"%ROWTYPE;
  current_proposal "lifecycle_proposals"%ROWTYPE;
  current_approval "lifecycle_approvals"%ROWTYPE;
  database_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO current_reservation FROM "lifecycle_reservations"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."reservation_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot reservation does not exist' USING ERRCODE = '23514'; END IF;
  SELECT * INTO current_proposal FROM "lifecycle_proposals"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = current_reservation."proposal_id" FOR UPDATE;
  SELECT * INTO current_approval FROM "lifecycle_approvals"
  WHERE "tenant_id" = NEW."tenant_id" AND "digest" = current_reservation."approval_digest" FOR UPDATE;
  IF jsonb_typeof(NEW."payload") IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'execution snapshot payload must be an object' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW."payload" ?& ARRAY[
       'operationId', 'tenantId', 'caseId', 'proposalId', 'proposalDigest', 'contextBundleHash',
       'evidencePacketHash', 'approvalDigest', 'approverId', 'approverCapability',
       'approvalValidUntil', 'evidenceRevision', 'routeRevision', 'routeQuoteHash', 'vehicleId',
       'serviceStart', 'serviceEnd', 'idempotencyKey', 'capturedAt', 'digest'
     ])
     OR (NEW."payload" - ARRAY[
       'operationId', 'tenantId', 'caseId', 'proposalId', 'proposalDigest', 'contextBundleHash',
       'evidencePacketHash', 'approvalDigest', 'approverId', 'approverCapability',
       'approvalValidUntil', 'evidenceRevision', 'routeRevision', 'routeQuoteHash', 'vehicleId',
       'serviceStart', 'serviceEnd', 'idempotencyKey', 'capturedAt', 'digest'
     ]) IS DISTINCT FROM '{}'::jsonb
     OR jsonb_typeof(NEW."payload"->'operationId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'tenantId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'caseId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'proposalId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'proposalDigest') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'contextBundleHash') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'evidencePacketHash') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'approvalDigest') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'approverId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'approverCapability') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'approvalValidUntil') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'evidenceRevision') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW."payload"->'routeRevision') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW."payload"->'routeQuoteHash') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'vehicleId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'serviceStart') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'serviceEnd') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'idempotencyKey') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'capturedAt') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'digest') IS DISTINCT FROM 'string'
  THEN
    RAISE EXCEPTION 'execution snapshot payload has missing, null, mistyped, or extra fields' USING ERRCODE = '23514';
  END IF;
  IF current_reservation."state" <> 'reserved'
     OR current_proposal."case_id" <> NEW."case_id"
     OR current_reservation."proposal_id" <> NEW."proposal_id"
     OR current_reservation."approval_digest" <> NEW."approval_digest"
     OR current_reservation."proposal_digest" <> NEW."proposal_digest"
     OR current_reservation."context_bundle_hash" <> NEW."context_bundle_hash"
     OR current_reservation."evidence_packet_hash" <> NEW."evidence_packet_hash"
     OR current_reservation."evidence_revision" <> NEW."evidence_revision"
     OR current_reservation."route_quote_hash" <> NEW."route_quote_hash"
     OR current_reservation."route_revision" <> NEW."route_revision"
     OR current_proposal."vehicle_id" <> NEW."vehicle_id"
     OR current_proposal."service_start" <> NEW."service_start"
     OR current_proposal."service_end" <> NEW."service_end"
     OR current_proposal."valid_until" <> NEW."approval_valid_until"
     OR current_approval."approver_subject_id" <> NEW."approver_subject_id"
     OR current_approval."valid_until" <> NEW."approval_valid_until"
     OR (NEW."payload"->>'operationId') IS DISTINCT FROM NEW."operation_id"
     OR (NEW."payload"->>'tenantId') IS DISTINCT FROM NEW."tenant_id"
     OR (NEW."payload"->>'caseId') IS DISTINCT FROM NEW."case_id"
     OR (NEW."payload"->>'proposalId') IS DISTINCT FROM NEW."proposal_id"
     OR (NEW."payload"->>'proposalDigest') IS DISTINCT FROM NEW."proposal_digest"
     OR (NEW."payload"->>'contextBundleHash') IS DISTINCT FROM NEW."context_bundle_hash"
     OR (NEW."payload"->>'evidencePacketHash') IS DISTINCT FROM NEW."evidence_packet_hash"
     OR (NEW."payload"->>'approvalDigest') IS DISTINCT FROM NEW."approval_digest"
     OR (NEW."payload"->>'approverId') IS DISTINCT FROM NEW."approver_subject_id"
     OR (NEW."payload"->>'approverCapability') IS DISTINCT FROM 'approve_recovery'
     OR (NEW."payload"->>'approvalValidUntil')::timestamptz IS DISTINCT FROM NEW."approval_valid_until"
     OR (NEW."payload"->>'evidenceRevision')::integer IS DISTINCT FROM NEW."evidence_revision"
     OR (NEW."payload"->>'routeRevision')::integer IS DISTINCT FROM NEW."route_revision"
     OR (NEW."payload"->>'routeQuoteHash') IS DISTINCT FROM NEW."route_quote_hash"
     OR (NEW."payload"->>'vehicleId') IS DISTINCT FROM NEW."vehicle_id"
     OR (NEW."payload"->>'serviceStart')::timestamptz IS DISTINCT FROM NEW."service_start"
     OR (NEW."payload"->>'serviceEnd')::timestamptz IS DISTINCT FROM NEW."service_end"
     OR (NEW."payload"->>'idempotencyKey') IS DISTINCT FROM NEW."idempotency_key"::text
     OR (NEW."payload"->>'capturedAt')::timestamptz IS DISTINCT FROM NEW."captured_at"
     OR (NEW."payload"->>'digest') IS DISTINCT FROM NEW."digest"
     OR abs(extract(epoch FROM (NEW."captured_at" - database_now))) > 5
     OR NEW."captured_at" >= current_proposal."valid_until"
  THEN
    RAISE EXCEPTION 'execution snapshot does not match its reserved proposal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_execution_snapshots_bind_reservation"
BEFORE INSERT ON "lifecycle_execution_snapshots"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_validate_execution_snapshot"();

CREATE FUNCTION "lifecycle_validate_outcome_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_capability text;
  expected_principal_kind text;
  current_operation "lifecycle_operations"%ROWTYPE;
  previous_event_at timestamptz;
  database_now timestamptz := clock_timestamp();
BEGIN
  expected_capability := CASE NEW."kind"
    WHEN 'driver_report' THEN 'record_provider_evidence'
    WHEN 'supporting_attachment' THEN 'record_provider_evidence'
    WHEN 'reconciliation' THEN 'record_provider_evidence'
    WHEN 'customer_confirmation' THEN 'confirm_customer_outcome'
    WHEN 'customer_dispute' THEN 'dispute_customer_outcome'
    WHEN 'reopen' THEN 'reopen_recovery'
  END;
  expected_principal_kind := CASE
    WHEN NEW."kind" IN ('driver_report', 'supporting_attachment', 'reconciliation') THEN 'worker'
    ELSE 'user'
  END;
  SELECT * INTO current_operation FROM "lifecycle_operations"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."operation_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outcome evidence operation does not exist' USING ERRCODE = '23514';
  END IF;
  SELECT "occurred_at" INTO previous_event_at FROM "lifecycle_operation_events"
  WHERE "tenant_id" = NEW."tenant_id" AND "operation_id" = NEW."operation_id"
    AND "sequence" = current_operation."revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outcome evidence lacks its causal predecessor event' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW."payload") IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'outcome evidence payload must be an object' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW."payload" ?& ARRAY['id', 'tenantId', 'operationId', 'kind', 'sourceId', 'contentHash', 'observedAt'])
     OR (NEW."payload" - ARRAY['id', 'tenantId', 'operationId', 'kind', 'sourceId', 'contentHash', 'observedAt'])
        IS DISTINCT FROM '{}'::jsonb
     OR jsonb_typeof(NEW."payload"->'id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'tenantId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'operationId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'kind') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'sourceId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'contentHash') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'observedAt') IS DISTINCT FROM 'string'
  THEN
    RAISE EXCEPTION 'outcome evidence payload has missing, null, mistyped, or extra fields' USING ERRCODE = '23514';
  END IF;

  IF NEW."operation_revision" IS DISTINCT FROM current_operation."revision" + 1
     OR NEW."recorded_by_capability" IS DISTINCT FROM expected_capability
     OR (NEW."payload"->>'id') IS DISTINCT FROM NEW."id"
     OR (NEW."payload"->>'tenantId') IS DISTINCT FROM NEW."tenant_id"
     OR (NEW."payload"->>'operationId') IS DISTINCT FROM NEW."operation_id"
     OR (NEW."payload"->>'kind') IS DISTINCT FROM NEW."kind"
     OR (NEW."payload"->>'sourceId') IS DISTINCT FROM NEW."source_id"
     OR (NEW."payload"->>'contentHash') IS DISTINCT FROM NEW."content_hash"
     OR (NEW."payload"->>'observedAt')::timestamptz IS DISTINCT FROM NEW."observed_at"
     OR NEW."observed_at" < GREATEST(current_operation."created_at", previous_event_at)
     OR NEW."observed_at" > database_now + interval '5 minutes'
     OR NOT EXISTS (
       SELECT 1 FROM "lifecycle_principals" principal
       JOIN "lifecycle_capabilities" capability
         ON capability."tenant_id" = principal."tenant_id" AND capability."subject_id" = principal."subject_id"
       WHERE principal."tenant_id" = NEW."tenant_id"
         AND principal."subject_id" = NEW."recorded_by_subject_id"
         AND principal."kind" = expected_principal_kind
         AND principal."enabled" = true AND principal."revoked_at" IS NULL
         AND principal."expires_at" > database_now
         AND capability."capability" = NEW."recorded_by_capability"
         AND capability."revoked_at" IS NULL
     )
  THEN
    RAISE EXCEPTION 'outcome evidence lacks an exact active principal, payload, or revision binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_outcome_evidence_is_authorized"
BEFORE INSERT ON "lifecycle_outcome_evidence"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_validate_outcome_evidence"();

CREATE FUNCTION "lifecycle_validate_operation_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'reserved' OR NEW."revision" <> 0 THEN
      RAISE EXCEPTION 'new operation must begin reserved at revision zero' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."id" <> OLD."id" OR NEW."snapshot_digest" <> OLD."snapshot_digest"
     OR NEW."revision" <> OLD."revision" + 1
     OR NOT (CASE OLD."state"
       WHEN 'reserved' THEN NEW."state" IN ('sending', 'cancelled')
       WHEN 'sending' THEN NEW."state" IN ('accepted', 'unknown', 'failed')
       WHEN 'accepted' THEN NEW."state" IN ('driver_reported', 'unknown')
       WHEN 'unknown' THEN NEW."state" IN ('assignment_reconciled', 'failed')
       WHEN 'assignment_reconciled' THEN NEW."state" = 'driver_reported'
       WHEN 'driver_reported' THEN NEW."state" IN ('supporting_evidence_received', 'evidence_reconciled', 'disputed')
       WHEN 'supporting_evidence_received' THEN NEW."state" IN ('evidence_reconciled', 'disputed')
       WHEN 'evidence_reconciled' THEN NEW."state" IN ('customer_confirmed', 'disputed')
       WHEN 'customer_confirmed' THEN NEW."state" = 'disputed'
       WHEN 'disputed' THEN NEW."state" = 'reopened'
       WHEN 'reopened' THEN NEW."state" IN ('reserved', 'cancelled')
       ELSE false
     END)
  THEN
    RAISE EXCEPTION 'invalid lifecycle operation transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" IN ('driver_reported', 'supporting_evidence_received', 'evidence_reconciled', 'customer_confirmed', 'disputed', 'reopened') THEN
    SELECT "kind" INTO evidence_kind FROM "lifecycle_outcome_evidence"
    WHERE "tenant_id" = NEW."tenant_id" AND "operation_id" = NEW."id"
      AND "operation_revision" = NEW."revision";
    IF evidence_kind IS DISTINCT FROM (CASE NEW."state"
      WHEN 'driver_reported' THEN 'driver_report'
      WHEN 'supporting_evidence_received' THEN 'supporting_attachment'
      WHEN 'evidence_reconciled' THEN 'reconciliation'
      WHEN 'customer_confirmed' THEN 'customer_confirmation'
      WHEN 'disputed' THEN 'customer_dispute'
      WHEN 'reopened' THEN 'reopen'
    END) THEN
      RAISE EXCEPTION 'operation transition lacks exact typed evidence' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_operations_follow_state_machine"
BEFORE INSERT OR UPDATE ON "lifecycle_operations"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_validate_operation_transition"();

CREATE FUNCTION "lifecycle_validate_assignment_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_snapshot "lifecycle_execution_snapshots"%ROWTYPE;
BEGIN
  SELECT * INTO current_snapshot FROM "lifecycle_execution_snapshots"
  WHERE "tenant_id" = NEW."tenant_id" AND "operation_id" = NEW."operation_id" FOR KEY SHARE;
  IF NOT FOUND
     OR current_snapshot."digest" <> NEW."snapshot_digest"
     OR current_snapshot."idempotency_key" <> NEW."idempotency_key"
     OR current_snapshot."proposal_digest" <> NEW."proposal_digest"
     OR current_snapshot."approval_digest" <> NEW."approval_digest"
     OR current_snapshot."route_quote_hash" <> NEW."route_quote_hash"
     OR current_snapshot."vehicle_id" <> NEW."vehicle_id"
     OR current_snapshot."service_start" <> NEW."service_start"
     OR current_snapshot."service_end" <> NEW."service_end"
  THEN
    RAISE EXCEPTION 'assignment does not echo the immutable snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_assignments_bind_snapshot"
BEFORE INSERT ON "lifecycle_assignments"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_validate_assignment_binding"();

CREATE FUNCTION "lifecycle_validate_receipt_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_operation "lifecycle_operations"%ROWTYPE;
  current_snapshot "lifecycle_execution_snapshots"%ROWTYPE;
  current_event "lifecycle_operation_events"%ROWTYPE;
  expected_evidence jsonb;
  database_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO current_operation FROM "lifecycle_operations"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."operation_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt operation does not exist' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO current_snapshot FROM "lifecycle_execution_snapshots"
  WHERE "tenant_id" = NEW."tenant_id" AND "operation_id" = NEW."operation_id"
    AND "digest" = NEW."snapshot_digest" FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt snapshot does not exist' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO current_event FROM "lifecycle_operation_events"
  WHERE "tenant_id" = NEW."tenant_id" AND "operation_id" = NEW."operation_id"
    AND "sequence" = NEW."operation_revision" AND "state" = NEW."state";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt lacks its exact operation event' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(jsonb_agg(evidence."id" ORDER BY evidence."id"), '[]'::jsonb)
  INTO expected_evidence
  FROM "lifecycle_outcome_evidence" evidence
  JOIN "lifecycle_operation_events" applied_event
    ON applied_event."tenant_id" = evidence."tenant_id"
   AND applied_event."operation_id" = evidence."operation_id"
   AND applied_event."sequence" = evidence."operation_revision"
   AND applied_event."evidence_id" = evidence."id"
  WHERE evidence."tenant_id" = NEW."tenant_id" AND evidence."operation_id" = NEW."operation_id"
    AND evidence."operation_revision" <= NEW."operation_revision";

  IF jsonb_typeof(NEW."payload") IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'receipt payload must be an object' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW."payload" ?& ARRAY[
       'operationId', 'operationRevision', 'tenantId', 'state', 'evidenceIds', 'contextBundleHash',
       'evidencePacketHash', 'routeQuoteHash', 'proposalDigest', 'approvalDigest', 'approverId',
       'approverCapability', 'approvalValidUntil', 'idempotencyKey', 'executionSnapshotDigest',
       'recordedAt', 'digest'
     ])
     OR (NEW."payload" - ARRAY[
       'operationId', 'operationRevision', 'tenantId', 'state', 'evidenceIds', 'contextBundleHash',
       'evidencePacketHash', 'routeQuoteHash', 'proposalDigest', 'approvalDigest', 'approverId',
       'approverCapability', 'approvalValidUntil', 'idempotencyKey', 'executionSnapshotDigest',
       'invalidation', 'recordedAt', 'digest'
     ]) IS DISTINCT FROM '{}'::jsonb
     OR jsonb_typeof(NEW."payload"->'operationId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'operationRevision') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW."payload"->'tenantId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'state') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'evidenceIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW."payload"->'contextBundleHash') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'evidencePacketHash') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'routeQuoteHash') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'proposalDigest') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'approvalDigest') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'approverId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'approverCapability') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'approvalValidUntil') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'idempotencyKey') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'executionSnapshotDigest') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'recordedAt') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW."payload"->'digest') IS DISTINCT FROM 'string'
  THEN
    RAISE EXCEPTION 'receipt payload has missing, null, mistyped, or extra fields' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW."payload"->'evidenceIds') item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'receipt evidence identifiers must be strings' USING ERRCODE = '23514';
  END IF;
  IF current_operation."revision" IS DISTINCT FROM NEW."operation_revision"
     OR current_operation."state" IS DISTINCT FROM NEW."state"
     OR current_operation."snapshot_digest" IS DISTINCT FROM NEW."snapshot_digest"
     OR (NEW."payload"->>'operationId') IS DISTINCT FROM NEW."operation_id"
     OR (NEW."payload"->>'operationRevision')::integer IS DISTINCT FROM NEW."operation_revision"
     OR (NEW."payload"->>'tenantId') IS DISTINCT FROM NEW."tenant_id"
     OR (NEW."payload"->>'state') IS DISTINCT FROM NEW."state"
     OR (NEW."payload"->'evidenceIds') IS DISTINCT FROM expected_evidence
     OR (NEW."payload"->>'contextBundleHash') IS DISTINCT FROM current_snapshot."context_bundle_hash"
     OR (NEW."payload"->>'evidencePacketHash') IS DISTINCT FROM current_snapshot."evidence_packet_hash"
     OR (NEW."payload"->>'routeQuoteHash') IS DISTINCT FROM current_snapshot."route_quote_hash"
     OR (NEW."payload"->>'proposalDigest') IS DISTINCT FROM current_snapshot."proposal_digest"
     OR (NEW."payload"->>'approvalDigest') IS DISTINCT FROM current_snapshot."approval_digest"
     OR (NEW."payload"->>'approverId') IS DISTINCT FROM current_snapshot."approver_subject_id"
     OR (NEW."payload"->>'approverCapability') IS DISTINCT FROM 'approve_recovery'
     OR (NEW."payload"->>'approvalValidUntil')::timestamptz IS DISTINCT FROM current_snapshot."approval_valid_until"
     OR (NEW."payload"->>'idempotencyKey') IS DISTINCT FROM current_snapshot."idempotency_key"::text
     OR (NEW."payload"->>'executionSnapshotDigest') IS DISTINCT FROM current_snapshot."digest"
     OR (NEW."payload"->>'recordedAt')::timestamptz IS DISTINCT FROM NEW."recorded_at"
     OR (NEW."payload"->>'digest') IS DISTINCT FROM NEW."digest"
     OR NEW."recorded_at" < current_event."occurred_at"
     OR abs(extract(epoch FROM (NEW."recorded_at" - database_now))) > 5
  THEN
    RAISE EXCEPTION 'receipt payload does not bind its row, snapshot, event, evidence, or database time' USING ERRCODE = '23514';
  END IF;
  IF current_event."reason" IS NULL THEN
    IF NEW."payload" ? 'invalidation' THEN
      RAISE EXCEPTION 'receipt invalidation lacks an exact event reason' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF jsonb_typeof(NEW."payload"->'invalidation') IS DISTINCT FROM 'object'
       OR NOT ((NEW."payload"->'invalidation') ?& ARRAY['reason', 'approvedEvidenceRevision', 'approvedRouteRevision'])
       OR ((NEW."payload"->'invalidation') - ARRAY['reason', 'approvedEvidenceRevision', 'approvedRouteRevision'])
          IS DISTINCT FROM '{}'::jsonb
       OR jsonb_typeof(NEW."payload"#>'{invalidation,reason}') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW."payload"#>'{invalidation,approvedEvidenceRevision}') IS DISTINCT FROM 'number'
       OR jsonb_typeof(NEW."payload"#>'{invalidation,approvedRouteRevision}') IS DISTINCT FROM 'number'
       OR (NEW."payload"#>>'{invalidation,reason}') IS DISTINCT FROM current_event."reason"
       OR (NEW."payload"#>>'{invalidation,approvedEvidenceRevision}')::integer IS DISTINCT FROM current_snapshot."evidence_revision"
       OR (NEW."payload"#>>'{invalidation,approvedRouteRevision}')::integer IS DISTINCT FROM current_snapshot."route_revision"
    THEN
      RAISE EXCEPTION 'receipt invalidation does not bind its exact operation event' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lifecycle_receipts_bind_operation_revision"
BEFORE INSERT ON "lifecycle_outcome_receipts"
FOR EACH ROW EXECUTE FUNCTION "lifecycle_validate_receipt_binding"();
