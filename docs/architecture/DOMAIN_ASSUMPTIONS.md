# TrashPal domain assumptions

This page separates the local test world's operating assumptions from claims that require a real waste-service provider or integration.

## Evidence and source assumptions

| Assumption | Local status | Production requirement |
| --- | --- | --- |
| A mapped service agreement can identify the site, stream, and recovery deadline. | Synthetic and contract-tested. | Validate the provider's actual CRM objects, ownership, and update latency. |
| Customer access messages are useful evidence but cannot override policy or field evidence. | Enforced. | Define which customer channels and identities can confirm access. |
| A field attempt can report an incomplete collection and reason. | Synthetic and contract-tested. | Map the driver's actual event vocabulary and correction process. |
| Conflicting site identities block recovery instead of being merged heuristically. | Enforced. | Establish the system of record and an operator resolution workflow. |

## Routing assumptions

| Assumption | Local status | Production requirement |
| --- | --- | --- |
| Stream capability, usable capacity, shift, committed work, and service windows are required constraints. | Enforced with a fixed matrix. | Validate the provider's equipment, facility, labor, disposal, and downstream-stop constraints. |
| VROOM returns a feasibility quote, not authority to dispatch. | Enforced. | Integrate the provider's route platform and transactional authorization boundary. |
| The full service interval must fit inside confirmed access. | Enforced after solver output. | Confirm access semantics and timezone handling with the provider. |

## Outcome assumptions

| Assumption | Local status | Production requirement |
| --- | --- | --- |
| Connector acceptance means only that a work request was accepted. | Enforced. | Reconcile against the provider's assignment identifier. |
| A driver completion report and optional attachment are supporting evidence. | Enforced. | Define evidence retention, correction, and dispute policy. |
| Supporting evidence cannot become customer confirmation automatically. | Enforced. | Choose whether explicit confirmation, elapsed dispute windows, or another provider rule closes the case. |
| Lost acknowledgements remain `unknown` until lookup resolves them. | Enforced locally. | Require idempotency and lookup guarantees from the external dispatch system. |

## Authority assumptions

| Assumption | Local status | Production requirement |
| --- | --- | --- |
| A dispatcher may approve an exact quoted recovery. | Synthetic role and capability. | Map real roles, limits, delegation, and audit retention. |
| Credits are never authorized by Pal. | Enforced. | Define a separate commercial approval path if credits are supported. |

These assumptions bound the executable evidence. They do not establish that a specific provider uses this workflow or would adopt the product.
