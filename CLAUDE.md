# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An API-monitoring SaaS backend: customers add URLs, a worker checks them on a schedule, the app records results, opens incidents and emails the team. Staff manage customers and plans from an admin area. The website lives in `../Frontend` (separate repo).

## Commands (run from `Backend/`)

```bash
npm run dev          # API with nodemon          npm start     # API
npm run worker       # runs the monitor checks (BullMQ worker, needs Redis); worker:dev = nodemon
npm run seed:admin -- --email you@company.com --name "Your Name" --phone 9876543210
npm test             # node --test over tests/*.test.js (needs MongoDB and Redis running)
node --test tests/team.test.js     # one suite
```

`seed:admin` creates the first `SUPER_ADMIN` on an empty database: random password emailed (same as `createEmployee`), `--print-password` shows it instead when SMTP isn't set up. It refuses if any super admin exists and removes the account if the email can't be sent.

## Environment (`.env`)

| Var | Notes |
|---|---|
| `PORT` | default 3004 |
| `MONGODB_URI` | standalone MongoDB is fine (no transactions are used) |
| `FRONTEND_URL` | used for CORS (reduced to its origin, so a trailing slash is harmless) and for links in emails (`/reset-password`, `/admin/reset-password`, `/billing`, `/admin/plan-requests`) |
| `NODE_ENV` | `production` hides error messages. **`test` switches rate limiting off**; never set it in production |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | required / default `1d` |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `APP_NAME` | needed to create any account (port 465 = SSL, else STARTTLS) |
| `SALES_EMAIL` | optional; who hears about plan requests. Unset = every active super admin and staff with `plan-requests.manage` |
| `REDIS_URL`, `QUEUE_PREFIX` (default `apimon`), `WORKER_CONCURRENCY` (20), `RECONCILE_INTERVAL_MINUTES` (10) | monitor scheduling |
| `RESULT_RETENTION_DAYS` (30), `INCIDENT_FAILURE_THRESHOLD` (3) | first retention given to the starting plans (after that each plan sets its own, see Plans) / failures in a row before an incident |
| `ALLOW_PRIVATE_MONITOR_URLS` | `true` only in local dev, lets monitors target localhost/private IPs |
| `TRUST_PROXY` | number of reverse proxies in production, or rate limiting sees the proxy IP |
| `BILLING_PROVIDER` (default `none`), `PLAN_PRICE_STARTER/ENTERPRISE`, `BILLING_CURRENCY`, `PLAN_PRICES_CONFIRMED` | `PLAN_PRICE_*` only set the *first* prices when the starting plans are created; afterwards prices are edited in the admin area. The currency is global. The website shows a "sample pricing" notice while `PLAN_PRICES_CONFIRMED` isn't `true` |

## Architecture

- **ESM** (`"type": "module"`): every relative import needs the `.js` extension. **Express 5**: `server.js` runs helmet, CORS, JSON body, then defaults `req.body` to `{}` (Express 5 leaves it undefined for bodiless requests), `/health-check`, `/api` routes, `notFound`, `errorHandler`.
- **Layering**: `src/Routes` -> `src/Controllers` -> `src/Models`; shared logic in `src/Services`, `src/utils`, `config/`. Controllers use `try/catch` + `next(error)`. Every JSON response is `{ success, message, ...payload }`; validation failures are 400 (monitor validation also returns `errors[]`).
- **Two auth realms**, one JWT secret, distinguished by the token's `type` claim: staff `Employees` (`type: "admin"`, roles `SUPER_ADMIN`/`STAFF` + `permissions[]`) and customers `Client` + `ClientUser` (`type: "client"`, roles `OWNER`/`MEMBER`). `protect(...types)` re-loads the account from the database on every request (disabled/suspended/deleted accounts are refused at once, and a token issued before `passwordChangedAt` is refused). Guards: `requireRole`, `requirePermission(...)` (SUPER_ADMIN always passes; permissions listed in `config/permissions.js`), `requireClientRole("OWNER")`.
- **Emailed random passwords**: no create flow accepts a password (`clientRegister`, `createEmployee`, `addTeamMember`, `seed:admin`). A password is generated (`utils/generatePassword.js`), its hash stored, the plain one emailed; accounts get `mustChangePassword: true`, and until it's cleared `protect` answers `403 { code: "PASSWORD_CHANGE_REQUIRED" }` except on `protectAllowPasswordChange` routes (`/me`, `/change-password`). If the email fails the record is deleted again (502).
- **Password change / forgot / reset** (`Controllers/passwordController.js`, one implementation for both realms, driven by the small `ADMIN` / `CLIENT` settings objects): change returns a new token; forgot always answers the same 200 and stores only a SHA-256 hash of a 30-minute token; reset is a single `findOneAndUpdate`, so a link works once. `MIN_PASSWORD_LENGTH` is served to the website via `/api/meta`.
- **Email must be unique across all customers** (`ClientUser.email` unique; login looks users up by email alone). Sign-up creates `Client` then `ClientUser` and deletes the client if the second insert fails.
- **Rate limiting** (`Middlewares/rateLimit.middleware.js`, `express-rate-limit`, in-memory): login 5 failures/15 min per IP+email and 30/15 min per IP, forgot-password 5/h per IP and 3/h per IP+email, reset 10/15 min, register 5/h, change-password 10 failures/15 min, team invites 20/h and plan requests 5/h per signed-in user. In-memory means per process; use a Redis store if you run several API instances.

### Plans (dynamic) and the config endpoint

Plans are **documents in the `Plan` collection** (`Models/Plan.js`: key, name, description, features[], priceMonthly, `limits` {maxMonitors, minIntervalSeconds, maxTimeoutSeconds, maxTeamMembers, retentionDays}, sortOrder, isRecommended, isDefault, isActive). `Client.plan` and `PlanRequest.fromPlan/toPlan` store the plan *key* (no enum; keys are checked against the plans).

- **`Services/planCatalog.js`** is the only way to read plans: `getPlans/getPlan/getPlanLimits/planName/getPlanRanks/getDefaultPlan/isActivePlan/toPlanResponse`. All are **async** and use a 5-second in-memory cache (`clearPlanCache()` after a write). The worker is a separate process, so it picks changes up when its cache expires. `ensureDefaultPlans()` runs at API and worker start: with no plans it inserts Free/Starter/Enterprise from `config/plans.js` (`seedPlans`). `config/plans.js` also holds `PLAN_LIMIT_RANGES` (allowed range per limit, served to the website in `meta.limits.planLimits`).
- **Admin API** (`Controllers/adminPlanController.js`, permission `plans.manage`): `GET/POST /api/admin/plans`, `PATCH /api/admin/plans/:key`. A key is `[A-Z][A-Z0-9_]{1,23}` and never changes. Exactly one default plan (setting a new default unsets the old; the default can't be archived or un-defaulted directly); one recommended plan. Plans are archived (`isActive:false`), never deleted: archived plans can't be requested or assigned (`isActivePlan`), a request for a plan archived since can't be approved, and customers already on it keep it. Edits write `plan.create`/`plan.update` audit entries (limits flattened into the changes).
- **Edits apply immediately:** a changed `minIntervalSeconds` triggers `resyncPlanSchedules`; a shorter `retentionDays` triggers `purgeExpiredResults(planKey)` in the background; the PATCH reply includes `impact` (`planImpact` in `planService.js`: customers over their monitor/seat limit, monitors faster than allowed). Nothing is removed or switched off when a plan shrinks.
- **Retention is per plan.** The old global TTL index on check results is gone (`dropGlobalResultExpiry()` removes it at start); the worker's `purgeExpiredResults()` runs hourly and deletes results older than each plan's `retentionDays`, per customer.
- **Rank decides upgrade vs downgrade:** a plan's position in `sortOrder` order (`getPlanRanks()`); `toPlanRequestResponse(request, ranks)` needs the ranks.
- `GET /api/meta` (public) serves all plans (archived ones carry `isActive:false` so names still resolve), currency, allowed enum values, validation limits and the staff permission list, so **the website hard-codes none of it**. Anything that schedules a monitor goes through `effectiveIntervalSeconds(monitor, limits)` (limits object from `getPlanLimits`). Downgrades never delete anything; `planChangeWarnings` lists what no longer fits.

### Monitors, checker, incidents (customer data, always filtered by `clientId` from the token)

- **Monitors** `/api/client/monitors` (CRUD, `?page ?limit ?status ?search`; list also returns `usage`). Validation in `utils/validateMonitorInput.js` mirrors plan limits; URLs go through `utils/validateMonitorUrl.js` (http(s) only, no credentials, no localhost/private/link-local/metadata addresses incl. IPv6 and encoded forms). Another tenant's monitor is a 404.
- **Checker = BullMQ + Redis, MongoDB is the source of truth.** One repeating *job scheduler* per ACTIVE monitor (`Services/monitorQueue.js`, id = monitor id, first run immediate); a job carries only `{ monitorId }` and the worker re-reads the monitor, so edits apply on the next check. Create/resume/interval change/pause/delete and staff plan or suspension changes update schedules (`syncMonitorSchedule`, `removeMonitorSchedule`, `resyncClientSchedules`). Redis down never fails an API call (`callRedis` fails fast when not connected and caps each call); `reconcileSchedules()` (worker start + every `RECONCILE_INTERVAL_MINUTES`) rebuilds Redis from MongoDB and leaves correct schedulers untouched.
- **Worker** (`worker.js`, `Services/monitorWorker.js`): a deleted/paused monitor removes its own scheduler, a suspended client is skipped, otherwise `runCheck` -> `CheckResult` -> `Monitor.health` (only the worker writes `health`). `runCheck` (`Services/monitorCheckService.js`) never throws, doesn't follow redirects, times the whole request with one timer, reads at most 1 MB, treats certificate errors as failures, and re-validates the URL and checks the *dialled IP* (`createGuardedLookup`) against private ranges (DNS rebinding). Error types are listed in `CHECK_ERROR_TYPES`.
- **Incidents** (`Services/incidentService.js`): open after `INCIDENT_FAILURE_THRESHOLD` consecutive failures (`startedAt` = first failed check), resolve on the first success; a partial unique index allows one OPEN incident per monitor. Down/recovered emails go to every ACTIVE user of the client, claim-based (2-minute lock + attempt counter, max 5, retried by the worker every 2 minutes within 24 h; a "recovered" mail is skipped if the "down" mail never went out). Pausing closes the incident quietly (`resolution: PAUSED`), resuming resets the failure streak, deleting a monitor deletes its results and incidents.
- **Stats** (`Controllers/statsController.js`, needs MongoDB 7+ for `$percentile`): `/monitors/:id/stats|chart`, `/stats/overview` with `?range=24h|7d|30d`. Uptime is check-based and capped at 99.99 if anything failed; `null` = no data; response times use successful checks only; chart buckets are epoch-aligned and empty ones are `null`.

### Team, admin, billing

- **Team** `/api/client/team` (any user lists; OWNER adds/edits/removes/resends). Seats = ACTIVE users vs `maxTeamMembers`; you can't change yourself or remove the last owner; a disabled member is locked out immediately.
- **Admin** (`Routes/adminRoutes.js`, `protect("admin")` + `requirePermission`): `/admin/plans` (see Plans above), `/admin/clients` (list, detail, PATCH plan/status/companyName; plan or status changes resync schedules and email owners), `/admin/plan-requests` (+ `/:id/approve|reject`, one atomic decision), `/admin/stats`, `/admin/audit-logs`, `/admin/meta`; `/admin/employees` (list/create/patch) is SUPER_ADMIN only. Every staff change is written to `AuditLog` (append-only, `Services/auditService.js`).
- **Billing** `/api/client/billing` (OWNER only): `GET` plan + usage + recent requests, `POST /plan-requests` (one PENDING per client, enforced by a partial unique index; staff are emailed), `DELETE /plan-requests/:id`, `POST /checkout` (501 `PAYMENTS_NOT_ENABLED` until a provider exists). There is **no payment provider yet**: plan changes happen by staff approving a request. To add one, implement the shape documented in `Services/billing/index.js` and register it there.

## Tests (`tests/`, `node:test`)

Suites start the real API as a child process (`tests/helpers/app.js`) with a fake SMTP server (`helpers/smtpSink.js`), real MongoDB and (admin suite) real Redis under a private key prefix; they run with `NODE_ENV=test` so rate limits are off, except `ratelimit.test.js`. Test data is only ever `zz-<tag>-...@example.com`, removed before and after. Suites: register, team, admin, billing, plans, ratelimit.

**Tests use their own database** (`tests/helpers/testEnv.js` switches `MONGODB_URI` to `<database>_test` before anything connects), where the API creates its own starting plans, so plans edited in the real database can't break a test and tests can't change real plans. Test plans use the key prefix `ZTP_` and are removed afterwards. Older monitor/queue/incident/stats suites were written outside the repo and are not here yet.

## Known gaps

- No payment provider; `Employees.phone` is a `Number`; monitor header values are stored as plain text and visible to the whole team; incidents are never deleted; email times are UTC; stats for clients with hundreds of monitors would want pre-aggregated rollups.
- Mixed-case model filenames (`employees.js`, `clients.js`, `ClientUser.js`): imports must match exactly on case-sensitive systems.
