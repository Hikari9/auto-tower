# Auto Tower

Durable mission control for AI chiefs of staff and distributed Auto-Office execution fleets.

Missions outlive tools, agents, sessions, machines, models and issue trackers. Tower keeps the authoritative record of what should be true, who may do what, which machine is doing it, and the evidence that it is done. It is not another AI model: it stays useful with no model running, and model work happens only on runners you own.

- **Missions** are verified outcomes with acceptance, child work, dependencies, linked issues, decisions and an append-only history.
- **Runners** (your laptops and servers) connect outbound, claim authorized work with leases and fencing tokens, and run it with Auto-Office under their own subscriptions.
- **Authority** is explicit, scoped, versioned and checked at the point of effect. Repeated approvals produce proposals, never grants.
- **Decision Inbox** holds only real executive choices; a held decision stops only its own branch.
- **Issues** stay owned by their trackers. Plain links work with no plugin; GitHub sync is opt-in and closes issues only under grants, with read-back.
- **One backend** serves the dashboard, the MCP endpoint for ChatGPT, and the runner protocol.

## Quick start

```sh
pnpm install
pnpm check        # typecheck + 65 contract tests
pnpm smoke        # real binaries end to end on localhost

node bin/tower.ts init --workspace "My Tower" --owner "Me"   # prints the owner token once
node bin/tower.ts serve                                       # http://127.0.0.1:8787
node bin/tower.ts token --kind runner --name laptop           # runner token
TOWER_RUNNER_TOKEN=... node bin/tower-runner.ts --engine fake # dry-run runner
```

## Docs

| Doc | Contents |
| --- | --- |
| [docs/MANIFESTO.md](docs/MANIFESTO.md) | Principles |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Domain vocabulary |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, source-of-truth matrix, concurrency, lifecycles, authority tiers, hosting |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | Versioned runner, receipt, issue-provider, backup and MCP contracts |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Threats, controls and the tests that prove them |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Install, first run, fleet, monitoring, revocation, halt, backup/restore, Cloudflare steps |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | Spec acceptance criteria mapped to evidence |
| [DEFERRED.md](DEFERRED.md) | External work not performed (accounts, credentials, deploys, live Auto-Office runs) |

## Relationship to Auto-Office

Auto Tower is a separate product. It integrates with [Hikari9/auto-office](https://github.com/Hikari9/auto-office) only through `tower.dispatch/v1` / `tower.receipt/v1` and a runner-side adapter for the Auto-Office 3.x CLI. It copies no Auto-Office runtime and never bypasses its phases, review gates or landing.

## Status

v1 implementation on branch `solo/v1`. Nothing is deployed; no cloud resources, paid services or hosted models are used. Default configuration makes no AI calls.
