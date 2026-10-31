# Adapters and Contract Versioning

Tower integrates with external engines and providers through adapters. Each adapter speaks a versioned contract. Tower never imports an adapter's runtime. The only shared surface is the contract.

## Contract ids

A contract id names an integration boundary and its major version:

```
tower.<boundary>.v<major>
```

Examples:

| Contract id       | Boundary                                                            |
| ----------------- | ------------------------------------------------------------------- |
| `tower.office.v1` | Auto-Office execution engine: work packets in, receipts out         |
| `tower.runner.v1` | Runner protocol: registration, heartbeat, claims, fencing, receipts |
| `tower.issues.v1` | Issue provider: fetch, observe, link, permitted write, read-back    |

Only `tower.office.v1` is in scope for Phase 0 documentation. The others are named here so later tasks use the same scheme.

## Versioning rules

1. **Major bump for breaking change.** Removing or renaming a field, changing a field's meaning, tightening validation, or changing a state machine's transitions requires a new id (`v2`). The old id keeps working for at least one release after the new one ships.
2. **Additive change stays on the same id.** A new optional field or a new optional message type is allowed within `v1`. Consumers must ignore unknown fields.
3. **Unknown ids are rejected.** An adapter that declares a contract id Tower does not support is refused at registration, with a clear error. Tower does not guess a compatible version.
4. **Ids are declared, not negotiated.** Each adapter declares exactly one contract id per boundary when it registers. Multi-version support means registering more than one adapter identity.
5. **Adapters carry no Tower secrets.** Adapters authenticate with their own principal and scopes (`provider_adapter`, `runner`, and so on). Their token ceiling is in `src/auth/principals.ts`.
6. **Contract changes are recorded in the repo.** A change to a contract id's shape lands with a doc update here and a test that pins the shape.

## Compatibility policy

- A consumer built against `vN` keeps working against any later release that still serves `vN`.
- Tower supports the previous major for one release after a new major ships.
- Deprecation is announced in this file and in the release notes before the old id stops being served.

## Office engine boundary (`tower.office.v1`)

Tower sends, for each work packet:

- Outcome, constraints, and acceptance criteria
- Target scope, repository, and linked issue references
- Approved authority envelope, as policy references
- Correlation id and execution guards
- Required evidence profile

The engine returns:

- Run and attempt ids, current phase, and next legal action
- Self-verification result and required independent review result
- Revision and commit SHA, tests run, integrated verification result
- Landing status, residual risks, and a final completion receipt

Rules:

- Tower does not reimplement Auto-Office planning, review, model routing, or harness execution.
- Tower cannot mark a high-risk outcome complete from a success message or green tests alone.
- Auto-Office's own phase and review gates stay in force inside each packet.

## Adding an adapter

1. Pick the contract id for the boundary. If none fits, add a new boundary here first.
2. Write the adapter against the contract. Do not import from another adapter or from Tower's domain internals.
3. Register it with a `provider_adapter` or `runner` principal and the narrowest scopes it needs.
4. Test the adapter boundary with a fake on the other side. Tower's tests should not require the real engine or provider.
