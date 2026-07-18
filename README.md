# TrashPal

TrashPal is a local operator workspace for reviewing one service exception, approving an exact recovery, and reconciling an uncertain dispatch before retrying it.

TrashPal is an independent fictional project, not an official PostHog product. It was distilled from [self-driving-trash-palace](https://github.com/owieschon/self-driving-trash-palace), the full build, including how it was built and what it does not prove.

## Run the local demo

Use Node 22 or later, Corepack, and Docker. Install the pinned dependencies once with `corepack enable && pnpm install --frozen-lockfile`.

Run these commands in three terminals from the repository root:

```sh
pnpm demo:services
```

```sh
pnpm demo:api
```

```sh
pnpm demo:web
```

Open [http://127.0.0.1:3212](http://127.0.0.1:3212). The browser flow is source records, prepare, approve and reserve, dispatch, reconcile, then receipt.

## Local-demo boundary

The web client calls the loopback API through same-origin `/v1` requests. The API issues an HttpOnly local-demo cookie. PostgreSQL, VROOM, case records, and the lost-ack dispatch profile run locally. This demo does not contact a CRM, fleet provider, model provider, analytics service, or cloud account.
