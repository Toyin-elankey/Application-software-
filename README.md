# Application-software- — AI-Powered WhatsApp E-Commerce Platform

A commerce platform for one brand (multi-brand later) that combines a mobile-first storefront, an AI shopping assistant on the web and WhatsApp, verified payments, order tracking, and a role-based admin dashboard. All channels share one server-side backend and one database.

> **Current status: specification and data-model stage.** There is no runnable application yet. Nothing in this repository is connected to WhatsApp, Paystack or an AI provider, and no tests exist yet. The status of each area is tracked in [`docs/07-mvp-and-roadmap.md`](docs/07-mvp-and-roadmap.md) §1.

## What is here now

| Path | Contents |
|---|---|
| [`docs/`](docs/README.md) | Product requirements, architecture, data model, UI/UX wireframes, WhatsApp and AI design, payments design, MVP and roadmap |
| [`prisma/schema.prisma`](prisma/schema.prisma) | Proposed MVP data model (39 models, 29 enums). Validated with Prisma 7.10.1. Not yet migrated. |
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

0. Specification (this stage)
1. Foundations: scaffold, Docker, CI
2. Data layer: migrations, seed, constraint tests
3. Commerce core: catalogue, cart, pricing, checkout with idempotency
4. Payments: Paystack adapter, webhooks, verification, refunds
5. Identity, orders, admin API, RBAC, audit
6. Storefront and admin UI
7. WhatsApp and AI assistant
8. Hardening, deployment and launch readiness

Details, exit criteria and launch gates: [`docs/07-mvp-and-roadmap.md`](docs/07-mvp-and-roadmap.md) §3 and §2.3.

## Setup

Setup instructions will be added in Stage 1, when the application is scaffolded. This section will then list the exact commands for local development, migrations, seeding, tests, and the webhook simulator.

## Documentation

Start with [`docs/README.md`](docs/README.md).
