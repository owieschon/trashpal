# Core build local evidence receipt

This receipt records local verification of the bounded TrashPal core implementation in the curated public revision that contains this file. Resolve that revision with `git log -1 --format=%H -- artifacts/evidence/core-build-local-receipt.md`. It attests to the commands and controlled inputs below; it is not a release, provider, or model-quality receipt.

## Evidence classification

| Item | Value |
| --- | --- |
| Evidence class | `deterministic_fixture` with local PostgreSQL and VROOM integration |
| Comparative-evaluation label | Deterministic comparative evaluation |
| Promotion eligibility | Ineligible; credentialed live statistical evaluation is required |
| External providers used | None |
| Operational data used | None; every case world is synthetic and recorded |

The comparative contract is [comparative-evaluation-contract.json](comparative-evaluation-contract.json). Its five variants compare bounded and deterministic paths over fixed fixtures. They do not measure a live model.

## Pinned inputs

| Input | Pinned identity |
| --- | --- |
| Program | `resolve-commercial-service-exception@1.0.0` |
| Policy | `commercial-recovery-policy@1.0.0` |
| Source mapping | `salesforce-service-context@1.0.0` |
| Synthetic corpus | Fixed Tuesday, 2026-07-21, 13:20 America/Chicago snapshot; scenarios `C01` through `C11` |
| PostgreSQL | `postgres:17.10-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193` |
| VROOM solver | `vroomvrp/vroom-docker:v1.13.0@sha256:2e417553320bf68a25f6614ba8bdc31b0b2fc1172f8c25518c4656f488031c2a` |

The local VROOM request supplies a complete synthetic duration matrix. The solver does not query a routing, map, CRM, or dispatch provider.

## Executed verification

Recorded 2026-07-17T03:52:31Z against the implementation archived with this receipt. The database connection value is intentionally redacted; it addressed the local Compose PostgreSQL service only.

| Command | Result |
| --- | --- |
| `pnpm check` | Passed: TypeScript check and 4 risk-contract tests |
| `pnpm test:context` | Passed: 14 tests |
| `pnpm test:agent` | Passed: 25 tests |
| `TEST_DATABASE_URL=<local-test-dsn> POSTGRES_REQUIRE_REAL=1 VROOM_REQUIRE_REAL=1 pnpm test:routing` | Passed: 41 tests, including the real local VROOM solver checks |
| `TEST_DATABASE_URL=<local-test-dsn> POSTGRES_REQUIRE_REAL=1 VROOM_REQUIRE_REAL=1 pnpm test:lifecycle` | Passed: 33 tests, including 10 PostgreSQL integration tests |
| `TEST_DATABASE_URL=<local-test-dsn> POSTGRES_REQUIRE_REAL=1 VROOM_REQUIRE_REAL=1 pnpm test:composed` | Passed: 11 composed HTTP/API tests |
| `pnpm test:evals` | Passed: 5 deterministic comparative-evaluation tests |

## What this proves locally

- The source mapping, policy, program, and bounded skill contract compile into versioned context for the synthetic corpus.
- The route adapter filters ineligible vehicles, validates complete access windows, and obtains a feasibility quote from the pinned local VROOM service.
- PostgreSQL guards the durable lifecycle: exact-payload approval, authorization, reservation, replay, revocation, unknown-outcome reconciliation, and receipt integrity.
- The composed API proves the C01 explicit-confirmation boundary, C07 lost-acknowledgement reconciliation with one assignment, and C08 cancellation before send after revocation.
- The composed API rejects caller-supplied identity and execution overrides, limits evidence recording to its worker capability, exposes a redacted case-scoped trace, and returns an inspectable safe-stop result rather than treating it as a server failure.

## Not established by this receipt

- Live model behavior, recommendation quality, prompt-injection resilience against a live provider, latency, token use, cost, or corpus-scale evaluation.
- Live Salesforce, routing, dispatch, OAuth, webhooks, customer data, or cross-system transaction behavior.
- Production security operations, reliability, deployment, backups, observability, analytics ingestion, or user-interface behavior.
- Real fleet outcomes, service quality, customer confirmation rates, or business impact.

The core contract and corpus boundaries remain canonical in [CORE_BUILD_CONTRACT.md](../../docs/architecture/CORE_BUILD_CONTRACT.md) and [SYNTHETIC_SEED_CORPUS.md](../../docs/architecture/SYNTHETIC_SEED_CORPUS.md).

## P6 verification addendum: test hardening

This later addendum records fresh-directory verification of core test hardening. It supplements the P5 bounded-core evidence above without changing its revision, evidence classification, or claims.

### Controlled execution

Recorded 2026-07-17T04:13:04Z from a fresh source copy. The copy excluded Git metadata, installed dependencies, environment files, and untracked local state before installation.

| Step | Result |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | Passed: 107 packages resolved from the local package store; 0 downloaded |
| `pnpm check` | Passed: TypeScript plus 17 guarded deterministic test files; 121 passed and 2 explicitly skipped real-VROOM cases |
| `pnpm test:offline` | Passed: 17 guarded deterministic test files; 121 passed and 2 explicitly skipped real-VROOM cases |
| `pnpm test:composed` | Passed: 2 real local-service test files; 21 passed, comprising 10 PostgreSQL lifecycle and 11 composed API cases |

The composed runner started only the digest-pinned local PostgreSQL and VROOM fixtures with image pulling disabled. Its test workers allow only `127.0.0.1:54329` and `127.0.0.1:3000`; the deterministic runner permits no application network access. Focused checks reject remote and non-exact loopback overrides, remote Docker transports, outbound HTTP/DNS/TCP paths, and named-import bypasses.

### CI surface

[core-tests.yml](../../.github/workflows/core-tests.yml) runs the same guarded verification on Ubuntu 24.04 with Node 22.23.1 and SHA-pinned actions. It contains no release, deployment, or publishing step. The Endor job skips unless a repository namespace is configured and uses OIDC only when it runs.

### Scope boundary

This is local deterministic and local-service evidence. It does not establish a production deployment, external provider behavior, live model quality, live analytics ingestion, load behavior, or business outcomes.
