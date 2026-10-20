# Documentation index

Start here. Each document states its status. Nothing is marked "done" unless it has been built and tested.

| # | Document | Phase | Status |
|---|---|---|---|
| 01 | [Product requirements](01-product-requirements.md) — vision, scope, FRs with acceptance criteria, NFRs, order lifecycle, roles, policy constraints, assumptions, open decisions | 1 | Draft for approval |
| 02 | [Architecture](02-architecture.md) — stack decisions with trade-offs, system and module diagrams, data flows, API outline, multi-tenancy, security controls, deployment, external accounts | 2 | Proposed |
| 03 | [Data model](03-data-model.md) — entities, invariants, inventory and idempotency rules, retention, SQL-only constraints | 2 | Proposed; schema in `prisma/schema.prisma` |
| 04 | [UI/UX](04-ui-ux.md) — navigation flows, storefront and admin wireframes, assistant and WhatsApp conversation design, states, accessibility | 3 | Wireframes for review |
| 05 | [WhatsApp and AI assistant](05-whatsapp-and-ai.md) — webhooks, 24-hour window, consent, templates, Flows evaluation, mock mode, activation; assistant tools, confirmation, grounding, evaluation | 2, 6 | Design |
| 06 | [Payments](06-payments.md) — provider adapter, Paystack flow, verification rules, late payments, refunds, mock provider, test plan | 2, 4 | Design |
| 07 | [MVP and roadmap](07-mvp-and-roadmap.md) — implementation status, MVP scope, stages with exit criteria, testing strategy, risks, launch checklist, open items | 8 | Current plan |

## Status legend used across the docs

- **Implemented** — code exists and automated tests pass.
- **Mocked** — the interface exists and a simulated implementation is used; the real provider is not connected.
- **Requires configuration** — needs an account, credentials, business verification or a paid plan.
- **Planned** — designed, not started.

## Reading order

1. `01` for what we are building and what we are not.
2. `02` for how the pieces fit together.
3. `07` for what happens next and what is blocked on the business.
