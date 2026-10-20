# 07 — MVP Scope, Delivery Plan and Launch Path

This document is the answer to "what do we build first, and in what order?" It turns the specification (`01`–`06`) into staged work, with exit criteria that are testable, and it states plainly what is and is not built today.

---

## 1. Current implementation status

Recorded as of this commit. Update it at the end of every stage.

| Area | Status | Evidence |
|---|---|---|
| Product requirements (Phase 1) | ✅ Written, awaiting approval | `docs/01-product-requirements.md` |
| Architecture (Phase 2) | ✅ Written, awaiting approval | `docs/02-architecture.md`, `docs/03`, `docs/05`, `docs/06` |
| Data model | ✅ Draft, validated with Prisma 7.10.1 | `prisma/schema.prisma` (40 models, 29 enums). Migrated and tested against PostgreSQL 16 (Stage 2). |
| UI/UX wireframes (Phase 3) | ✅ Written, awaiting review | `docs/04-ui-ux.md` |
| Application code | 🟡 Stage 1 scaffold, then Stages 2–4 core | `src/`: Next.js 16 app. Catalogue, cart, delivery quote, checkout, order state machine, mock payments, Paystack adapter with signed webhooks, verify jobs and late-payment rules. See the stage sections below for what is not built. |
| Database migrations | 🟡 Stage 2 | `prisma/migrations/`: generated baseline (40 tables, 29 enums) and hand-written §9 constraints. Applied to a real PostgreSQL 16 in tests. Prisma `migrate deploy` and the drift check run in CI. |
| Automated tests | 🟡 Stages 1–4 | Spec suite (`npm run test:spec`, 16 tests), unit tests (`npm run test:unit`, 170 across 17 files, including the staff management rules and the refund policy), database tests (`npm run test:db`, 218 across 14 files: constraints, tenant isolation, seed, cart, checkout, concurrency, payments, expiry, reconciliation, return page, mock-pay HTTP, staff sign-in and MFA, admin orders, staff management, refunds), end-to-end tests (`npm run test:e2e`, Playwright, run in CI). |
| Storefront, admin dashboard | 🟡 Storefront API only | Catalogue, cart, delivery quote and checkout APIs exist. No storefront pages beyond the placeholder, and no admin (Stages 5–6). |
| WhatsApp integration | ⬜ Design only | Not connected to Meta. Mock adapter planned (Stage 7). |
| Payments | 🟡 Stage 4 core | Mock provider (dev, CI, demos only) and a Paystack adapter written and tested with fixtures and a fake provider. **Not run against Paystack's sandbox**: this sandbox cannot reach `api.paystack.co`. The refund workflow is built (Stage 5): request, two-person approval, execution, `refund.reconcile`. It is tested against a scripted provider, not Paystack's sandbox. |
| AI assistant | ⬜ Design only | No model provider configured. Fallback menu is the first thing built in Stage 7. |
| Deployment | 🟡 Stage 1 container | `Dockerfile` and `docker-compose.yml` for the web app and PostgreSQL. No hosting yet (Stage 8). |

**What this means.** Stage 1 adds a runnable placeholder app, but it has no business features. The specification is complete enough to build from, and the data model has passed schema validation. Next is Stage 2, the data layer. The rows marked 🟡 are verified only as far as the commands listed in the evidence column have been run; see the Stage 1 section for what CI has and has not confirmed.

---

## 2. MVP (v0.1) definition

The MVP is the smallest version that delivers the full customer journey (brief §2) for one brand, safely. Everything not listed is deferred (`01` §4.2).

### 2.1 Must have for v0.1

- [ ] Storefront: home, categories, search, product detail with variants and stock state, cart, checkout with zone-based delivery fee, confirmation, order tracking, order history after OTP sign-in.
- [ ] Payments: Paystack adapter (test keys) and mock provider; webhook with signature check; server-side verify; idempotent confirmation; expiry and late-payment handling; refund workflow with approval.
- [ ] Orders: the lifecycle in `01` §7, enforced on the server, with timestamped history and customer-safe timeline.
- [ ] Inventory: reservation, commit, release and ledger; oversell test passing.
- [ ] Admin: staff sign-in, roles (Owner, Admin, Manager, Fulfilment, Support, Finance, Viewer), overview, products, categories, variants, inventory, orders, customers (masked), payments, deliveries, notification log, conversation inbox with handoff, settings, delivery zones, staff management, audit log.
- [ ] WhatsApp: verified webhook, signed payload check, inbound text and button/list replies, interactive menu, in-window replies, template notifications with consent, status tracking, retries, handoff. Mock mode by default.
- [ ] AI assistant: product Q&A, recommendations, cart actions, checkout summary with server-rendered confirmation, OTP-verified order status, policies, handoff, deterministic fallback menu. Model provider behind an adapter, with a fake model for tests.
- [ ] Security: staff password hashing and lockout, customer OTP limits, RBAC tests, rate limits, CSRF protection, secret validation at boot, log redaction.
- [ ] Testing: unit, integration (real Postgres), webhook fixtures, E2E for the main journeys.
- [ ] Docs: README with setup, environment variables, webhook setup, deployment and launch checklist; runbooks for stuck payments and webhook replays.

### 2.2 Must NOT be in v0.1

Flutterwave; WhatsApp Flows; courier integration; coupons; marketing broadcasts; multi-brand onboarding; native apps; multi-currency; reviews; pay-on-delivery (unless D-02 changes); legal invoice numbering.

### 2.3 Launch gates (v0.1 cannot go live until these pass)

| Gate | Owner | Evidence |
|---|---|---|
| Admin MFA enabled for Owner, Admin and Finance | Engineering | Test and screenshot |
| Paystack live keys and live webhook verified with a small real payment, then refunded | Business + Engineering | Log of the transaction and refund |
| WhatsApp templates approved; live send tested to a staff number | Business | Meta approval; message log |
| P-1 and P-2 compliance review done (assistant scope; vendor no-training terms) | Business + counsel | Signed memo |
| Privacy notice, consent wording, retention schedule approved (NDPA) | Business + counsel | Approved documents |
| Penetration-style review of auth, RBAC and webhooks (internal checklist at minimum) | Engineering | Checklist with results |
| Backups restored to a scratch database once | Engineering | Restore log |
| Accessibility check on the key journeys with a screen reader | Engineering | Test notes |

---

## 3. Stage plan

Each stage ends with a merge to the working branch and passing CI. Sizes are relative (S, M, L), not calendar estimates.

### Stage 0 — Specification ✅ (this turn)

- **Delivered:** `docs/01`–`07`, `prisma/schema.prisma` (validated), updated README index.
- **Exit:** owner approves the PRD and resolves open decisions D-01 to D-11 (or accepts defaults).

### Stage 1 — Foundations (S)

- Scaffold Next.js (App Router, TypeScript strict, Tailwind, ESLint, `src/` layout). Pin exact versions.
- Add Prisma 7 with `prisma.config.ts`, Zod, Vitest, Playwright, pino logger.
- `docker-compose.yml` with PostgreSQL. `.env.example`. Zod-validated `env.ts` that fails fast.
- `Dockerfile` for the web app and the worker (multi-stage, non-root user).
- CI workflow: install, lint, typecheck, unit tests, `prisma validate`, build.
- Secret scanning in CI.
- **Exit:** `npm run dev` shows a placeholder storefront from the container; CI is green on a clean checkout.

**Status (Stage 1):** built on `arena/ca7870ef-application-software` (PR #3). CI passed on commit `ab08636` for every job: lint, typecheck, spec and unit tests, Prisma validation, build, Playwright end-to-end tests on Chromium, Docker image build, and gitleaks secret scan.
- Checked locally: `npm run check` passes; the production server returns 200 from `/api/health` with `no-store`; an invalid `APP_BASE_URL` in production stops the process with exit code 1.
- Not checked: `docker compose up` (Docker is not available in the sandbox); the Dockerfile is only proven by the CI image build.
- Deviation: the Dockerfile builds the web app only. The worker image comes with the job queue (Stage 4/5).

### Stage 2 — Data layer (M)

- Baseline migration from the schema; hand-written SQL from `03` §9 added as a second migration; tests that assert each CHECK, unique index and FTS column exists and rejects bad data.
- Seed script (sample business, categories, products, variants, zones, staff) that refuses production.
- Repository layer requiring `businessId`; BigInt JSON serialiser with tests.
- **Exit:** migrations apply to an empty database and to the seed; constraint tests pass; repository tests show tenant isolation (a second business cannot see the first's products).

**Status (Stage 2):** built on `arena/959e970e-application-software`, not yet merged. Verified locally against PostgreSQL 16.14 (the sandbox has no Docker): both migrations apply to an empty database; the seed loads and a second run changes nothing; `npm run test:db` passes 41 of 41; and dropping one CHECK constraint makes its presence test fail. Not verified locally: `prisma migrate deploy` and the `prisma migrate diff` drift check, because Prisma's schema engine cannot be downloaded in this sandbox. CI runs both against a PostgreSQL 16 service container and passes on the Stage 2 head. CI found one real drift (`DeliveryZone.states` default, now declared in the schema) and a Docker build failure on the Alpine base, which is now Debian slim with OpenSSL.
- The baseline is generated by `scripts/db/gen-baseline.mjs`, not by Prisma's schema engine. The script fails on any schema feature it does not support, and `npm run db:baseline:check` fails if the committed SQL is out of date.
- Repository layer: only the catalogue read functions exist so far (`src/server/catalogue/products.ts`). Every function takes a `TenantScope`, and public reads never select stock counts.
- Seed: one sample business, 2 categories, 6 products, 12 variants, 2 delivery zones, 3 staff memberships. Staff have no login until Stage 5, because their password hashes cannot be created without Argon2.
- Deferred to later stages: the seed's WhatsApp account and draft templates (Stage 7), and product options beyond the single "Size" option.

### Stage 3 — Commerce core (L)

- Catalogue read APIs and admin write APIs for products, variants, categories (write APIs may wait for Stage 5; read APIs first).
- Pricing engine as pure functions (line totals, subtotal, VAT display, zone fee, free-shipping threshold) with table-driven unit tests.
- Cart with hashed cookie token; add, update, remove; validation of stock and quantity limits.
- Delivery quote.
- Checkout with `Idempotency-Key`, price and stock re-check, reservation, snapshot, order `PENDING_PAYMENT`, and the mock payment provider.
- Tests: idempotent replay, conflicting replay (422), concurrent duplicate (409), 50 parallel checkouts against 10 units (exactly 10 succeed), price changed mid-checkout (409 with diff).
- **Exit:** a scripted journey from product list to `PENDING_PAYMENT` and a mock-paid `PAYMENT_CONFIRMED` passes in integration tests.

**Status (Stage 3):** merged in PR #5 (merge commit `cfeadee`, feature commit `c29a432`). Verified against PostgreSQL 16.14: `npm run test:db` 96 of 96 at that commit, including 50 parallel checkouts for 10 units (exactly 10 succeed, no negative stock). Live check on `next dev`: a FAILED attempt then a SUCCESS attempt on the mock page; the order reached `PAYMENT_CONFIRMED`, and repeated presses changed nothing. CI run 39460396726 passed all five jobs. Not built: admin write APIs and the order status endpoint `GET /orders/{orderNumber}` (both wait for Stage 5 auth).

### Stage 4 — Payments and reconciliation (M)

- `PaymentProvider` interface; Paystack adapter (initialise, verify, refund, webhook parse); mock provider with a signed-webhook simulator.
- Webhook endpoint: raw body, signature check, `WebhookEvent` dedupe, job enqueue.
- Worker: job runner (SKIP LOCKED), `payment.verify`, `payment.expire`, `payment.reconcile`, `refund.reconcile`.
- Late-success handling (`06` §5). Refund workflow with two-person threshold.
- Fixture tests for Paystack signature (valid, invalid, re-serialised body), duplicate and delayed events, amount mismatch.
- **Exit:** every row in `06` §10 has a passing test. Sandbox run completed if test keys are available; otherwise marked "sandbox not run" in the release notes.

**Status (Stage 4):** core merged in PR #5 (`9db6e5a`, merged as `cfeadee`). Follow-up on `arena/7cd59cb0-application-software`:
- Late success is applied on FAILED and ABANDONED payments, not refused (06 §5). The verify job checks every payment that is not yet SUCCEEDED, so a success after a failed attempt is never dropped.
- Reservation expiry (`src/server/payments/expire.ts`) is a sweep run from `runPaymentMaintenance`, not a separate `payment.expire` job type. An expired order gets one final verify where a payment could still succeed. A provider error defers the cancellation; it never cancels. A verified success confirms the order. Otherwise the order is cancelled with reason `payment_timeout`, its stock is released with `RESERVATION_RELEASED` movements, and its awaiting payments are ABANDONED.
- The mock page sends a signed `charge.success` or `charge.failed` through the real webhook intake, then runs the due jobs. ABANDONED is verified directly, because Paystack sends no abandon event.
- Reconciliation (`src/server/payments/reconcile.ts`, 06 §4.5): payments still awaiting a result 10 minutes after creation are verified; provider errors defer.
- Customer return page `GET /orders/{orderNumber}/payment-return` (06 §4.2): verifies with the provider and applies the result with the same rules. It never marks an order paid from the browser request alone. Reloads do not call the provider once the payment is settled.

Verified locally: `npm run test:db` 126 of 126 on a fresh reset; `npm run check` exit 0 (106 unit tests, lint, types, build). Mutation: removing the provider-error deferral fails the expiry tests; disabling the webhook signature check fails 4 payment tests. Live: the internal runner route returns 404 without the secret and a summary with it; a bad signature returns 400.

**Exit criterion not met yet.** Not every `06` §10 row has a passing test. Still open:
- Refund workflow, refund execution, refund webhooks and the two-person threshold (3 rows). Deferred to Stage 5, because approval needs staff authentication. The user accepted this deferral. Built in Stage 5 (see below). The late-success path already flags such money for staff.
- `refund.reconcile` job (built in Stage 5).
- `POST /orders/{id}/payments` to retry a FAILED payment (06 §3). Needs an authenticated customer, so it comes with Stage 5 customer sessions.
- Paystack sandbox run: not done, because the sandbox cannot reach `api.paystack.co`. Needs test keys and a run in an environment with access.

### Stage 5 — Identity, orders, admin API (L)

- Staff auth (Auth.js Credentials, Argon2id, lockout, `tokenVersion`, idle and absolute timeouts). Customer OTP (WhatsApp template or mock, limits, hashed codes, sessions).
- Central permission map; table-driven RBAC tests covering every row in PRD §8.
- Order state machine with exhaustive transition tests; transition endpoint with `If-Match`; `OrderStatusEvent`; `AuditLog`.
- Admin APIs from `02` §6.5, including masked customer data and audited reveal.
- Notification outbox rows created with each change.
- **Exit:** RBAC matrix tests pass; a deactivated staff member loses access on the next request; a stale transition returns 409; every mutation writes an audit row.

**Status (Stage 5, first part: staff auth, RBAC, MFA, order changes):** built in PR #8 (`arena/336b5f77-application-software`, head `4d6a4d6`). Staff management is built on `arena/377c8c0e-application-software`, on top of that commit. Verified locally against PostgreSQL 16.14: `npm run test:db` 175 of 175 on a fresh reset (new: `staff-auth.test.ts`, `admin-orders.test.ts`); `npm run test:unit` covers the permission matrix (every PRD §8 row for every role) and TOTP against the RFC 6238 vectors. Live on `next dev`: sign-in, the MFA gate, enrolment with a real authenticator code, replayed-code refusal, order change with `If-Match` (stale value → 409), illegal move → 422, sign-out.
- Staff sign-in: Argon2id; generic error for every failure; lockout after 5 failures for 15 minutes (failed MFA codes count too); server-side sessions with 30-minute idle and 12-hour absolute timeouts; revocation by `tokenVersion`, deactivation, or sign-out; a deactivated member loses access on the next request.
- TOTP MFA required for Owner, Admin and Finance before any permission is granted. Secrets encrypted with AES-256-GCM; a code is accepted once.
- Order changes: `PATCH /api/v1/admin/orders/{id}/status` needs `If-Match` (428 without, 409 when stale). Fulfilment moves need `orders.fulfil`; cancelling an unpaid order needs `orders.cancel_unpaid` and releases stock. Every change writes an `OrderStatusEvent` and an `AuditLog` row in one transaction.
- Masked customer reads; the full phone and email are revealed only by `POST …/customer/reveal` with a reason, for Owner, Admin and Support, and every reveal is audited.
- `StaffSession` is a new table (migration `0001_baseline` regenerated from the schema, as the baseline check requires). Any database created before this change must be reset.
- Development staff: `scripts/db/create-staff.mjs` (refuses production).
- Staff management (FR-ADM-10): `GET /api/v1/admin/staff` lists members, including deactivated ones; `POST /api/v1/admin/staff` creates a member with `{email, fullName, role}` and returns a generated temporary password once (201; never stored in plain text; no password-change endpoint yet, so the member must change it when that endpoint exists); `PATCH /api/v1/admin/staff/{staffId}` changes `role` and/or `isActive`. Only Owner has `staff.manage`. Rules, in `src/server/staff/rules.ts`: only an Owner can grant the Owner role (403 `owner_role_required`); nobody can change their own account (422 `self_change_refused`); an Owner account cannot be deactivated or demoted through this API (422 `owner_protected`); a duplicate email is 409 `email_in_use`. A role change or deactivation ends the member's sessions at once; reactivation does not restore them. Every change writes an `AuditLog` row. Two concurrent edits to one member run one after the other (the row is locked before it is read).
- Decision to confirm: the spec says "Owner cannot be deactivated by others" (FR-ADM-10). The implementation takes the strictest reading: no Owner can be deactivated or demoted through the API. Relax this if another Owner should be able to deactivate an Owner (never the last one, never oneself).
- `StaffUser.isActive` is account-wide. When the platform has more than one brand, deactivation should move to the membership instead.
- Live check on `next dev` (commerce_test, MFA on for the Owner): 32 checks pass, covering the 415 for a non-JSON body, 201 and 409 on create, the Manager session refused on `GET /staff` with 403, a role change ending the old session, deactivation refused at sign-in, reactivation, and the Owner protections.

**Status (Stage 5, refund workflow):** written on `arena/4efcddd2-application-software`, not yet merged. `npm run check` passes (170 unit tests across 17 files); `npm run test:db` passes (218 across 14 files, 27 of them in `tests/db/refunds.test.ts`); the Paystack adapter's refund calls are covered by fixtures in `paystack.test.ts`. Live on `next dev` (commerce_live, the threshold set to ₦10 for the run): 29 of 29 HTTP checks pass, covering MFA sign-in for three roles, checkout and mock payment to `PAYMENT_CONFIRMED`, the `REFUND_PENDING` move with a required reason, the Idempotency-Key rules, replay and key reuse, the over-refund 422, the second-person rule, the role gates, execute once, a signed `refund.processed` webhook, and the job runner. The order stays `REFUND_PENDING` and the refund stays `PROCESSING` after the job, as expected: the mock has no final state unless it is simulated.
- Rules (`06` §4.6): the sum of PENDING, PROCESSING and SUCCEEDED refunds may not exceed the paid amount, checked under the payment lock. Request needs `refunds.request` (Owner, Admin, Finance) and an `Idempotency-Key`; the order must be `REFUND_PENDING`. Approve and execute need `refunds.approve` (Owner, Finance). Above `REFUND_APPROVAL_THRESHOLD_MINOR` (default ₦50,000) the approver must differ from the requester.
- Execution claims PENDING → PROCESSING before the provider call. A second execute is refused (409) without calling the provider. A definitive provider refusal (4xx) marks the refund FAILED. An unknown outcome (timeout, 5xx) leaves it PROCESSING, returns 502 `refund_uncertain` and is never sent again automatically.
- The order moves to `REFUNDED` only when successful refunds cover the paid amount. A partial refund keeps `REFUND_PENDING`. A final refund state is never changed again. The UI should show "requested" or "processing" until the provider confirms.
- `refund.processed` and `refund.failed` webhooks enqueue `refund.reconcile`, which asks the provider for the refund's state. A sweep checks PROCESSING refunds not updated for 10 minutes. Refund webhook event names are still unverified against Paystack (`06` §9).
- Decisions to confirm: the ₦50,000 threshold; that the requester may approve a refund below the threshold (the spec's text allows it); that a paid order moves from `DELIVERED` to `REFUND_PENDING` through staff before a refund can be requested (the spec's "or DELIVERED" wording is not followed for requests). Known gap: after an unknown outcome, staff must check the Paystack dashboard, because no automatic lookup is possible without a refund id.
- Permission names are `refunds.request` and `refunds.approve`, as in `02`. The rest of the code uses other names (`orders.view`, `customers.reveal_pii`), and `02` uses different ones again (`orders.read`, `pii.reveal`). That mismatch predates this work and is not resolved here.

**Still open for Stage 5:** a password-change endpoint for staff (needed before the temporary password is safe to hand over); customer OTP sessions and `GET /orders/{orderNumber}` for customers; the retry endpoint `POST /orders/{id}/payments`; notification outbox rows (depend on WhatsApp templates, Stage 7); the broader admin APIs in `02` §6.5 (catalogue and inventory writes, customer list, payments view, audit log view). Exit criterion not met yet.

### Stage 6 — Storefront and admin UI (L)

- Storefront pages per `04` §3, built on the real APIs with loading, empty and error states. Brand theming from settings.
- Checkout, payment return and polling, confirmation, tracking timeline, OTP sign-in, order history.
- Admin pages per `04` §4 with role-aware navigation.
- Accessibility pass on all key pages (axe in CI).
- Visual review: a clickable prototype is shared with the owner before this stage is complete.
- **Exit:** Playwright E2E for: browse → cart → checkout → mock payment → confirmation → track; admin: role-restricted access and an order status change.

### Stage 7 — WhatsApp and AI assistant (L)

- WhatsApp client, signed webhook, inbound processing, interactive menu, send policy (window, consent, template), status tracking, retry matrix (`05` §1.9), mock simulator.
- Assistant orchestrator, tool catalogue (`05` §2.3), confirmation protocol (§2.4), grounding validator (§2.6), redaction, rate limits, fallback menu (§2.9). Fake model for tests.
- Handoff, inbox and reply from the dashboard.
- Eval suite (§2.10) running in CI with the fake model.
- **Exit:** acceptance criteria in `05` §3 pass. The fallback menu works with the model switched off.

### Stage 8 — Hardening, deployment and launch readiness (M)

- E2E suite complete with the failure cases from the brief's Phase 7 list (§4.1 below) and `06` §10. Load test of checkout and webhooks at expected peak (to be set by the business).
- Security review against `02` §8; dependency audit; header and CSP checks.
- Deployment: container images, release procedure, migration step, health checks, backup and restore test, monitoring and alerts, runbooks.
- Launch checklist (§6 below) completed, with evidence attached.
- **Exit:** launch gates in §2.3 are green, or each open gate has a named owner and date.

### Stage 9 — Post-MVP (prioritised in `01` §4.2)

WhatsApp Flows for address capture; Flutterwave adapter; courier integration; coupons; marketing templates; multi-brand onboarding and row-level security.

---

## 4. Testing strategy

| Level | Tool | What it covers | Where it runs |
|---|---|---|---|
| Unit | Vitest | Pricing, state machine, validators, phone and money formatting, redaction, permission map, OTP rules, signature checks | Every commit |
| Integration | Vitest + Postgres container | Repositories, transactions, stock concurrency, idempotency, webhook dedupe, job runner, RBAC on routes | Every commit (CI service container) |
| Contract and fixture | Vitest + recorded payloads | Meta and Paystack webhook shapes, error responses, signature edge cases | Every commit |
| AI evaluation | Vitest with fake model; nightly with real model | Tool safety, grounding, scope, fallback | Every commit (fake); nightly (real) |
| End-to-end | Playwright | Customer and admin journeys, failure journeys | Every merge to main; nightly |
| Accessibility | axe-core in Playwright; manual screen reader pass | Key pages | Every merge; manual before launch |
| Load | k6 (or equivalent) | Checkout and webhook throughput | Before launch and after major changes |
| Security | Dependency audit, secret scan, RBAC and IDOR tests, header checks | As in `02` §8 | Every commit (automated parts) |

### 4.1 Mapping to the brief's Phase 7 list

| Brief test area | Where covered |
|---|---|
| Customer registration (OTP) | Stage 5 integration + E2E; failure cases: wrong code, expired, locked |
| Product browsing and search | Stage 3 integration; E2E browse; empty search state |
| Cart operations | Stage 3 unit + integration; stock changes mid-cart |
| Checkout | Stage 3 integration; E2E; idempotent retry; price change |
| Payment verification | Stage 4 fixtures and integration; verify-before-webhook; amount mismatch |
| Order creation | Stage 3; no duplicate orders under retries |
| Duplicate webhooks | Stage 4 (same event twice; concurrent duplicates) |
| WhatsApp notifications | Stage 7 send policy tests; consent; window; template fallback; failure codes |
| Role permissions | Stage 5 RBAC matrix; E2E for forbidden routes |
| Inventory consistency | Stage 2 CHECKs; Stage 3 concurrency; Stage 4 release on expiry |
| Delivery updates | Stage 5 transitions and events; customer timeline E2E |
| Failure cases | Each stage lists its failure cases; `06` §10 and `05` §2.10 are the detailed lists |

**Quality bar.** No merged feature without its tests. A bug fixed in production gets a regression test first. Flaky tests are fixed or quarantined within a day, not ignored.

---

## 5. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WhatsApp business verification or template approval is slow | High | High | Mock mode first; start verification now (D-07); the storefront works without WhatsApp; templates drafted early |
| Meta's policy on AI assistants is interpreted more strictly than planned | Medium | High | Scope the assistant narrowly (P-1); compliance memo before launch; the menu-only mode is an approved fallback |
| Per-message charges erode margin | Medium | Medium | Prefer in-window replies; track monthly service messages; templates only for notifications; alert at 80% of the free allowance |
| Paystack sandbox differs from live behaviour | Medium | High | Recorded fixtures; live test payment and refund before launch; reconciliation report for the first week |
| Oversell during a flash sale | Medium | High | Conditional-update reservations; concurrency tests; late-payment policy; low-stock threshold alerts |
| Duplicate orders from client retries | High | High | Idempotency keys end to end; unique constraints; tests |
| Data-protection complaint or breach | Low | High | Minimal data; masking; audit; retention jobs; counsel review; breach runbook |
| LLM cost or latency spikes | Medium | Medium | Budgets, timeouts, tool-based context, menu fallback |
| Prompt injection leads to unsafe action | Low | High | No consequential tool for the model; server confirmation tokens; validators; eval suite in CI |
| Small team bus factor | High | Medium | Documentation, runbooks, decisions log (`docs/decisions.md`, to be started at Stage 1), code ownership notes |
| Scope creep (multi-brand, Flows, couriers) | High | Medium | `01` §4.2 ordering; change requests recorded and scheduled after v0.1 |

---

## 6. Launch checklist (draft, completed in Stage 8)

**Product and content**
- [ ] Brand, logo, colours, categories and real products loaded (D-01); sample data removed
- [ ] Policies published: delivery, returns, refunds, privacy, terms, contact
- [ ] Delivery zones and fees confirmed (D-03); estimate labels approved
- [ ] VAT treatment confirmed by the accountant (A-06)

**Security and privacy**
- [ ] Admin MFA enforced for Owner, Admin and Finance
- [ ] Secrets in the host secret store; none in the repository (secret scan clean)
- [ ] Production refuses test keys and mock adapters at boot (tested)
- [ ] Privacy notice, consent wording, retention schedule and erasure procedure approved
- [ ] Counsel review of NDPA obligations, including whether NDPC registration applies (PRD P-7)

**Payments**
- [ ] Paystack live keys; live webhook URL; events enabled
- [ ] Live test payment verified and refunded; reconciliation report scheduled
- [ ] Refund approval thresholds set

**WhatsApp and AI**
- [ ] Business verification complete; number and display name approved
- [ ] Templates approved; mapping verified
- [ ] Opt-in and STOP handling tested live
- [ ] Assistant scope reviewed against Meta's current terms (P-1); vendor no-training terms signed (P-2)
- [ ] Monthly AI budget cap set; fallback tested with the switch off

**Operations**
- [ ] Production database with point-in-time recovery; restore tested
- [ ] Uptime checks on storefront, webhooks and worker heartbeat
- [ ] Alerts routed to a named person: webhook signature failures, payment mismatch, queue age, WhatsApp error rate, 5xx rate
- [ ] Runbooks published: replay webhook, reconcile payment, resend notification, rotate secret, disable assistant, restore from backup
- [ ] Support team trained on handoff, order lookup verification and refund process
- [ ] Rollback procedure rehearsed (previous image + backward-compatible migration)

**Commercial**
- [ ] Meta and Paystack costs understood and budgeted (PRD P-4; Paystack fees)
- [ ] Support hours published; handoff promise matches staffed hours (UX-04)

---

## 7. Plan for the first implementation steps (what happens next, once approved)

1. **Approve** the PRD and resolve or accept defaults for D-01 to D-11. Blocking items for Stage 3 are D-02, D-03, D-05 and D-09. Blocking items for Stage 7 are D-04 and D-07.
2. **Stage 1 scaffold**, with commands recorded in the README and CI green.
3. **Stage 2 migrations and seed**, with constraint tests.
4. **Stage 3 catalogue and checkout** on the mock provider, with the concurrency tests that protect against oversell and duplicate orders.
5. Then Stage 4 (Paystack), Stage 5 (identity and admin APIs), Stage 6 (UI), Stage 7 (WhatsApp and AI), Stage 8 (hardening and launch).

**Decisions log.** Each choice made during implementation that differs from these documents is recorded in `docs/decisions.md` (to be created in Stage 1) with the reason, date and affected files.

---

## 8. Open items that need the business

These are repeated from `01` §10.2 so that the owner sees them in one place.

| ID | Question | Needed by |
|---|---|---|
| D-01 | Brand identity, categories, first products | Stage 6 (sample data until then) |
| D-02 | Payment methods at launch | Stage 3 — **decided: Paystack online only** |
| D-03 | Delivery model and areas; zone fees | Stage 3 — **decided: in-house, Lagos only, two zones (sample fees)** |
| D-04 | LLM provider and monthly budget | Stage 7 (fake model until then) |
| D-05 | Auto-confirm after payment, or manual? | Stage 4 — **decided: manual staff confirmation** |
| D-06 | Hosting preference (container host recommended) | Stage 8 (Stage 1 is host-neutral) |
| D-07 | WhatsApp readiness: Meta verification, number, admins | Stage 7 live use (mock until then) — **start now; it has the longest lead time** |
| D-08 | Languages (English only recommended for MVP) | Stage 6 |
| D-09 | Minimum order value; per-item limit (10) | Stage 3 — **decided: no minimum; limit 10** |
| D-10 | Customer accounts: OTP only (recommended) | Stage 5 |
| D-11 | Email at checkout (required by Paystack) | Stage 3 |
