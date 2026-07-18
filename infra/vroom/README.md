# Local VROOM solver

This profile runs the route-feasibility boundary used by the TrashPal core tests.

The container is pinned to the multi-architecture digest for `vroomvrp/vroom-docker:v1.13.0`. It listens only on loopback. Tests send a complete custom duration matrix, so the solver does not call OSRM or another routing service.

The adapter contract uses:

- explicit integer location indices and a declared matrix size
- whole seconds for travel, service, shifts, breaks, and time windows
- whole kilograms in the single capacity dimension
- integer skills for stream capability and per-vehicle commitment binding

VROOM decides whether the encoded work is feasible. TrashPal filters tenant, availability, and stream compatibility before the request, then verifies that the complete returned service interval remains inside confirmed access. A VROOM response is a quote, never permission to dispatch.

Run the credential-free solver proof against the pinned local image:

```bash
scripts/compose.sh -f infra/compose.core.yml up -d --wait vroom
VROOM_REQUIRE_REAL=1 pnpm exec vitest run tests/adapters/routing.test.ts
```

`VROOM_REQUIRE_REAL=1` turns solver availability into a test requirement. A missing, unhealthy, or incompatible service fails the run; the test is skipped only when the real-solver proof was not requested.
