// Generated from content/programs/resolve-commercial-service-exception.yaml. Do not edit.
export const recoveryProgramDefinition = {
  "id": "resolve-commercial-service-exception",
  "version": "1.0.0",
  "allowedSkills": [
    "inspect_service_exception",
    "get_customer_commitments",
    "get_access_evidence",
    "get_field_attempt",
    "quote_recovery_options",
    "submit_typed_proposal"
  ],
  "outcomes": [
    "prepare_recovery",
    "hold_for_confirmation",
    "escalate"
  ]
} as const

export const recoverySkillDefinitions = [
  {
    "id": "inspect_service_exception",
    "version": "1.0.0",
    "description": "Read the scoped case summary and candidate evidence inventory.",
    "access": "case_scoped_read_only",
    "inputSchemaId": "case-scope@1",
    "outputSchemaId": "service-exception@1"
  },
  {
    "id": "get_customer_commitments",
    "version": "1.0.0",
    "description": "Read the mapped service agreement and recovery commitment for the active case.",
    "access": "case_scoped_read_only",
    "inputSchemaId": "case-scope@1",
    "outputSchemaId": "customer-commitments@1"
  },
  {
    "id": "get_access_evidence",
    "version": "1.0.0",
    "description": "Read current access evidence and its source authority and freshness.",
    "access": "case_scoped_read_only",
    "inputSchemaId": "case-scope@1",
    "outputSchemaId": "access-evidence@1"
  },
  {
    "id": "get_field_attempt",
    "version": "1.0.0",
    "description": "Read the latest field-service attempt for the active case.",
    "access": "case_scoped_read_only",
    "inputSchemaId": "case-scope@1",
    "outputSchemaId": "field-attempt@1"
  },
  {
    "id": "quote_recovery_options",
    "version": "1.0.0",
    "description": "Request a deterministic route-feasibility quote after required evidence is present.",
    "access": "case_scoped_read_only",
    "inputSchemaId": "recovery-quote-request@1",
    "outputSchemaId": "recovery-route-quote@1"
  },
  {
    "id": "submit_typed_proposal",
    "version": "1.0.0",
    "description": "Submit a cited proposal for host validation without executing it.",
    "access": "case_scoped_read_only",
    "inputSchemaId": "recovery-proposal@1",
    "outputSchemaId": "proposal-validation@1"
  }
] as const
