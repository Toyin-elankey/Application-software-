# Application-software- — AI-Powered WhatsApp E-Commerce Platform

A commerce platform for one brand (multi-brand later) that combines a mobile-first storefront, an AI shopping assistant on the web and WhatsApp, verified payments, order tracking, and a role-based admin dashboard. All channels share one server-side backend and one database.

> **Current status: Stage 1 (foundations).** The repository has a Next.js app with a placeholder storefront and a health check, plus Docker, CI and test setup. It has no commerce features, no database migrations, and no connection to WhatsApp, Paystack or an AI provider. The status of each area is tracked in [`docs/07-mvp-and-roadmap.md`](docs/07-mvp-and-roadmap.md) §1.

## What is here now

| Path | Contents |
|---|---|
| [`docs/`](docs/README.md) | Product requirements, architecture, data model, UI/UX wireframes, WhatsApp and AI design, payments design, MVP and roadmap |
| [`prisma/schema.prisma`](prisma/schema.prisma) | Proposed MVP data model (39 models, 29 enums). Validated with Prisma 7.10.1. Not yet migrated. |
| [`prisma.config.ts`](prisma.config.ts) | Prisma 7 configuration; the database URL is read from `DATABASE_URL` |
| [`src/`](src) | Next.js app: placeholder storefront, `/api/health`, validated configuration (`src/lib/env.ts`), structured logger |
| [`e2e/`](e2e), [`tests/spec/`](tests/spec) | End-to-end tests (Playwright) and specification tests (node:test) |
| [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) | Container image for the web app and a local PostgreSQL 16 service |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | CI: lint, types, tests, Prisma validation, build, end-to-end tests, Docker build, secret scan |
| [`.env.example`](.env.example) | Planned configuration surface, with placeholders only |

## Proposed stack

- **Web and API:** Next.js (App Router), TypeScript, one deployable with a separate worker process
- **UI:** Tailwind CSS and shadcn/ui (accessible Radix primitives)
- **Data:** PostgreSQL with Prisma 7; hand-written SQL for constraints and full-text search
- **Staff auth:** Auth.js (Credentials, Argon2id, revocable sessions). **Customer auth:** phone-number OTP.
- **Messaging:** WhatsApp Business Platform Cloud API, called directly (mock mode until approved)
- **Payments:** Paystack first, Flutterwave later, behind one provider interface (mock provider for development)
- **AI:** LLM provider behind a server-side adapter with controlled tools (fake model for tests until a provider is chosen)
- **Testing:** Vitest, real-Postgres integration tests, Playwright end-to-end tests

Trade-offs and alternatives are in [`docs/02-architecture.md`](docs/02-architecture.md) §1.

## Decisions that need the business

Eleven open decisions are listed in [`docs/07-mvp-and-roadmap.md`](docs/07-mvp-and-roadmap.md) §8. The most urgent is **D-07, WhatsApp business verification**, because it has the longest lead time. Defaults are stated for each decision, so work can continue if they are not answered.

Two constraints from Meta's current WhatsApp terms shape the design: the assistant must be a business-specific commerce and support agent, not a general-purpose chatbot, and business conversations may not be used to train AI models. See PRD §9 (P-1, P-2).

## Roadmap at a glance

0. Specification ✅
1. Foundations: scaffold, Docker, CI (current)
2. Data layer: migrations, seed, constraint tests
3. Commerce core: catalogue, cart, pricing, checkout with idempotency
4. Payments: Paystack adapter, webhooks, verification, refunds
5. Identity, orders, admin API, RBAC, audit
6. Storefront and admin UI
7. WhatsApp and AI assistant
8. Hardening, deployment and launch readiness

Details, exit criteria and launch gates: [`docs/07-mvp-and-roadmap.md`](docs/07-mvp-and-roadmap.md) §3 and §2.3.

## Setup

Requirements: Node.js 22 (20.9 or newer works), npm, and Python 3 only for the test video. Docker is optional, for the container stack.

```bash
npm ci                 # install dependencies
npm run dev            # dev server at http://localhost:3000 (placeholder storefront)
npm run build          # production build
npm start              # run the production build at http://localhost:3000
```

Quality checks:

```bash
npm run lint           # ESLint
npm run typecheck      # TypeScript, no emit
npm test               # specification tests (node:test) and unit tests (Vitest)
npm run test:e2e       # Playwright; run `npx playwright install chromium` once first
npm run prisma:validate
npm run check          # all of the above, in order
npm run test:report    # re-run the spec tests and write test-reports/ (needs pip install pillow imageio-ffmpeg)
```

Container (needs Docker):

```bash
cp .env.example .env   # optional; compose has local-only defaults
docker compose up --build
# web: http://localhost:3000  database: 127.0.0.1:5432 (user app_user, database commerce_dev)
```

Configuration is validated at boot in `src/lib/env.ts`. A missing or invalid variable stops the server with a message that names the variable and never prints its value. Variables read today: `NODE_ENV`, `APP_BASE_URL`, `LOG_LEVEL`. `DATABASE_URL` is accepted but not used until Stage 2.

Not set up yet: database migrations and seed data (Stage 2), the worker process (Stage 4), authentication (Stage 5), and any WhatsApp, payment or AI provider configuration (Stages 4 and 7).

## Documentation

Start with [`docs/README.md`](docs/README.md).
