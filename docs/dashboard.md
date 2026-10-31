# Dashboard

The dashboard is the owner's view of Tower. It is a static browser client in `public/` that calls the same HTTP API, with the same bearer tokens and scopes, as any other client. It has no chat interface and no privileged route.

## Mounting

`src/api/routes/dashboard.ts` exports `dashboardRoutes`: a public `GET /dashboard` shell and a `GET /dashboard/*` handler. The handler reads only the files named in its `ASSETS` table, so no request path reaches anything else on disk.

Mount them next to the API routes:

```ts
createApp({ db }, [...ROUTES, ...dashboardRoutes]);
```

`ROUTES` in `src/api/app.ts` does not include the dashboard yet. Add `dashboardRoutes` there when the host should always serve it.

## Views

| Route (hash)     | View                      | Reads                                                        |
| ---------------- | ------------------------- | ------------------------------------------------------------ |
| `#/missions`     | Mission Overview          | `GET /missions`                                              |
| `#/missions/:id` | Mission Detail            | mission, issue links, activity, open decisions               |
| `#/runners`      | Runner Fleet              | `GET /runners`, `GET /runners/leases`                        |
| `#/decisions`    | Decision Inbox            | `GET /decisions?status=open`; answers via `POST .../answers` |
| `#/policy`       | Permissions & Preferences | `GET /policy`; revoke and proposal actions                   |
| `#/integrations` | Integrations              | `GET /issues/sync-config`                                    |
| `#/activity`     | Activity/Audit            | `GET /runners/audit`, `GET /policy/history`                  |
| `#/health`       | Health                    | `GET /health` and list counts                                |

Mission Detail shows the outcome, definition of done, constraints, work packets with their dependencies, runner attempts, issue links, evidence references, and the event timeline. A "Why this is blocked" panel explains waits: unverified dependencies, open decisions, a mission waiting for a runner, and issue discrepancies.

## Status vocabulary

Every state has a text label. Color is never the only signal.

- Mission states: `waiting-runner`, `waiting-decision`, `waiting-external`, `verifying`, `completed`, `needs-attention`, and the rest, as labelled in `public/js/status.js`.
- Lease states: `held` shows as Running. `recovering` shows as Interrupted, recovering. `fenced` shows as a rejected stale attempt.
- Runner states: Active, Paused, Quarantined. Paused applies to runners only. Missions have no paused state.
- Evidence: "Verified by Tower" comes only from Tower's own verification. A runner's report shows as "Self-reported by runner (not verified)" with a dashed border. Tower-verified evidence has a solid border.

## Security

- The token lives in `sessionStorage` under `tower.dashboard.token`. It is sent only as an `Authorization: Bearer` header, never in a URL.
- A 401 clears the stored token and returns to the sign-in form.
- Untrusted text (mission titles, issue titles, provider notes, runner summaries) is set with `textContent`. The client never uses `innerHTML`.
- Issue links become anchors only when they are `http:` or `https:`. Any other URL renders as text.
- Destructive or authority-changing actions (revoke a rule, accept or decline a proposal, answer a decision) open a confirmation group first. Nothing is sent until Confirm.
- Served responses carry `Content-Security-Policy: default-src 'self'` with no inline script or style, plus `nosniff` and `no-referrer`.

## Persona

`public/persona.json` holds the display name and tagline:

```json
{
  "name": "Control Tower",
  "tagline": "Missions, runners and decisions in one place. Edit this file to rename the dashboard."
}
```

The code has no personal name. Missing or malformed values fall back to the defaults in `public/js/app.js`.

## Layout and responsiveness

The layout is single-column below 720px and widens above it. Wide tables scroll inside their own region, which is keyboard-focusable. Controls are native buttons, links, and form fields.

## Tests

- `test/dashboard/shell.test.ts` covers serving, the whitelist, CSP, traversal refusal, and that the API stays closed.
- `test/dashboard/views.test.ts` runs in happy-dom. It mounts the client against an in-process Tower and checks rendered content, labels, confirmation gates, the 409 and 401 paths, and accessibility attributes.
- Browser screenshots are unavailable on the build host, so these DOM tests are the gate.

The DOM tests use `import.meta.dirname` and `node:path` rather than `new URL(..., import.meta.url)`, because happy-dom replaces the global `URL`.

## Limits

- `src/api/routes/dashboard.ts` reads files with `node:fs`. The Workers host (`src/hosting/worker.ts`) cannot serve the dashboard until its assets are bundled into the Worker.
- The dashboard only renders what the API returns. Write actions are limited to the routes listed above.
