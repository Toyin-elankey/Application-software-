# 01 — Product Requirements (Phase 1)

Status: **Draft for approval.** Items marked *Assumption* (A-xx) or *Open decision* (D-xx) are not confirmed. See §10.

---

## 1. Summary

An AI-assisted commerce platform for a single brand at launch, designed to become multi-brand later. A customer can discover the brand on the web, Instagram or WhatsApp, talk to a business-specific shopping assistant, browse and buy products, pay online, and then follow the order through WhatsApp messages and a tracking page. Staff manage catalogue, orders, fulfilment, customer messages and settings in a protected admin dashboard that reads from the same backend and database as the storefront.

**Principles**

1. **The server is the source of truth.** Prices, stock, totals, payment status and order status are computed and validated on the server. Neither the browser, the chat, nor the AI decides them.
2. **Money moves only on verified facts.** An order becomes paid only after the payment provider is verified server-side. A screenshot, a customer message, or an AI statement is never proof of payment.
3. **Retries never duplicate effects.** Checkout, payment initialisation, webhooks and WhatsApp sends are idempotent.
4. **The AI is a tool-using interface, not an authority.** It can read catalogue data and call controlled actions. It cannot invent facts or act on consequential choices without an explicit, server-rendered customer confirmation.
5. **Least data, least privilege.** Collect only what each purpose needs. Each role sees only what it needs. Every sensitive read or write is audited.

---

## 2. Users and personas

| Persona | Context | Primary goal |
|---|---|---|
| **Customer — Lagos mobile shopper** | Mostly phone, WhatsApp-first, intermittent data | Find an item, pay, know when it arrives |
| **Customer — web browser** | Clicked a link from Instagram or Google | Browse visually, compare sizes, check out quickly |
| **Store owner** | Runs the business, reviews sales | Overview of sales, trust that orders are paid and fulfilled |
| **Store manager** | Maintains catalogue and prices | Add products, variants, stock, promotions (later) |
| **Fulfilment staff** | Packs and dispatches | See what to pack, move orders through dispatch, add tracking |
| **Support agent** | Answers WhatsApp and web chat | Take over conversations, look up orders after verification |
| **Finance** | Reconciles payments | See payment references, initiate and approve refunds |
| **Viewer / auditor** | Read-only | Review reports and logs |

---

## 3. Goals and success measures

Targets are placeholders to be set by the business. The platform must measure these from day one.

| Measure | Definition | Launch target |
|---|---|---|
| Checkout completion | Checkouts that reach `PAYMENT_CONFIRMED` ÷ checkouts started | Business to set; baseline after 4 weeks |
| Duplicate orders | Orders sharing a checkout key or payment reference | **0** (hard requirement) |
| Oversell | Confirmed orders exceeding available stock | **0** (hard requirement) |
| Payment confirmation latency | Time from provider success to order `PAYMENT_CONFIRMED` | p95 under 60 s when the webhook arrives |
| Confirmation delivery | Order-confirmed messages delivered ÷ sent | Business to set; monitored |
| AI containment | Assistant conversations resolved without human handoff | Monitored; no target until baseline |
| AI handoff latency | Time to a human after a handoff request during staffed hours | Business to set |

---

## 4. Scope

### 4.1 In MVP (v0.1, launch scope)

- Storefront: home, categories, search, product detail with variants and stock state, cart, checkout with delivery zone fees, order confirmation, order tracking and history (after verification).
- Customer identity by phone number, verified by a one-time code (OTP). Guest checkout is allowed; the account is created from the verified phone number.
- Payments: Paystack (test and live) behind a provider interface; a mock provider for development and automated tests. Prepaid orders only.
- Refund **workflow**: request, approve, provider call, status tracking. Partial refunds are supported in the data model.
- Admin dashboard with role-based access: overview, products, categories, variants, inventory, orders, customers (masked), payments, deliveries, WhatsApp logs, conversation handoff, settings, delivery zones, staff, audit log.
- WhatsApp Cloud API integration: verified webhook, signed-payload check, inbound message handling, interactive menus, outbound in-window replies, approved templates for notifications, delivery-status tracking, human handoff. Runs in **mock mode** until credentials and approvals exist.
- AI shopping assistant on the storefront and on WhatsApp, using server-side tools, with a deterministic fallback menu when the model is unavailable.
- Admin MFA (TOTP) for Owner, Admin and Finance roles. **Required before production launch**; it may be delivered after the first internal demo, but it is not optional.
- Automated tests across unit, integration, webhook fixtures and end-to-end flows.

### 4.2 Later (post-MVP, prioritised)

1. WhatsApp Flows for structured address capture and OTP entry inside the chat (evaluated in `05-whatsapp-and-ai.md` §1.6).
2. Flutterwave adapter (second provider) and pay-on-delivery, if approved (D-02).
3. Courier API integrations for automatic delivery events (provider to be chosen).
4. Coupons and promotions; loyalty points.
5. Marketing broadcasts using approved marketing templates, with opt-in management.
6. Self-serve multi-brand onboarding and per-tenant domains.
7. Native mobile app; reviews; multi-currency; multi-warehouse inventory.

### 4.3 Out of scope (explicitly)

- A general-purpose AI chat on WhatsApp (see §9, policy constraint P-1).
- Storing or processing card numbers, CVV or bank passwords on our systems.
- Automatic tax invoices with sequential legal numbering (assumed to be handled outside the platform until the accountant confirms requirements).
- Cryptocurrency, instalment plans, buy-now-pay-later.

---

## 5. Functional requirements

Priority: **M** = must have for MVP, **S** = should have for MVP if time allows, **C** = later.

### 5.1 Storefront and catalogue

| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-CAT-01 | Browse published products by category. | Only `PUBLISHED`, non-deleted products with an active variant appear. Pagination is cursor-based. | M |
| FR-CAT-02 | Search products by name, tag and attribute text. | Typo-tolerant to a reasonable degree (trigram); empty query returns a helpful empty state with suggested categories. | M |
| FR-CAT-03 | Product detail page with images, description, options and variants. | Selecting an option combination resolves to one variant. An unavailable combination shows "Not available in this combination" and disables add-to-cart. | M |
| FR-CAT-04 | Stock state per variant. | Shows *In stock*, *Only N left* (threshold configurable), or *Out of stock*. Quantity requested above available is rejected at add-to-cart and again at checkout. | M |
| FR-CAT-05 | Price display in Naira. | Format `₦12,500`. Compare-at price shown only when greater than the price. Prices come from the server, never the client. | M |
| FR-CAT-06 | Brand configuration. | Logo, colours, tagline, contact details and policy pages are editable in admin settings and applied without a code change. | M |
| FR-CAT-07 | Product images with alt text. | Alt text is required before publishing. Images are served from object storage with size and type validation on upload. | M |
| FR-CAT-08 | Deep links for discovery. | Every product and category has a stable URL. A WhatsApp click-to-chat link with a prefilled product message is available. | S |

### 5.2 Cart, delivery and checkout

| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-CART-01 | Anonymous cart. | Cart is tied to a random cookie token (only its hash is stored). Cart survives a page reload and a return visit within the expiry window (14 days). | M |
| FR-CART-02 | Add, change quantity and remove items. | Quantity is an integer from 1 to the per-line maximum (default 10, configurable). Operations are idempotent per request. | M |
| FR-CART-03 | Cart totals computed by the server. | Response includes line totals, subtotal, shipping (when a delivery state is known), VAT information, and total. | M |
| FR-CART-04 | Delivery fee calculation. | Fee comes from the delivery zone that covers the selected state. Free-shipping threshold applies when configured. If no zone covers the state, the customer sees "We do not deliver to this state yet" and can contact support. | M |
| FR-CHK-01 | Checkout collects recipient name, phone, address and optional note, plus an email address. | Phone is E.164 (Nigerian default +234). Address fields are validated. Email is required because the payment provider requires it for the payment receipt (D-11); it is used for no other purpose unless the customer opts in. No other fields are requested. | M |
| FR-CHK-02 | Consent at checkout. | Separate, unticked choice: "Send my order updates on WhatsApp". Stored as a `ConsentRecord` with policy version. Order confirmation by WhatsApp is only sent when this consent exists or the customer has started a WhatsApp conversation for this order. | M |
| FR-CHK-03 | Checkout re-validates everything. | Server re-checks stock, prices, zones and cart snapshot in one transaction. Any change returns a `409` with the changed lines so the UI can show what changed. | M |
| FR-CHK-04 | Stock reservation. | Successful checkout reserves stock for `stockReservationMinutes` (default 30). Reservation release happens on cancel or expiry. | M |
| FR-CHK-05 | Checkout is idempotent. | `Idempotency-Key` header required. Same key and same body returns the original response. Same key and different body returns `422`. A concurrent duplicate returns `409 in_progress`. | M |
| FR-CHK-06 | Order created as `PENDING_PAYMENT`. | Order has an immutable price snapshot and a human-friendly order number (e.g. `ORD-260001`). | M |
| FR-CHK-07 | Order confirmation page. | Shows order number, items, totals, delivery address and the current status. It does **not** claim payment is complete until the server says so. | M |

### 5.3 Payments

| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-PAY-01 | Payment initialisation. | Server creates a provider transaction for the order total in minor units with our unique reference. Repeated initialisation returns the existing pending authorisation URL. | M |
| FR-PAY-02 | Payment verification. | Order is marked paid only after a server-side verification call confirms status, amount, currency and reference. | M |
| FR-PAY-03 | Webhook handling. | Signature verified over the raw body. Event stored once (unique key). Processing is idempotent. Unknown events are stored and ignored. | M |
| FR-PAY-04 | Mismatched payments are flagged, not confirmed. | Amount or currency mismatch sets payment to `FAILED` with a reason and creates a staff task. The order is not confirmed. | M |
| FR-PAY-05 | Failed, abandoned and pending states. | Failed attempts can be retried while the reservation is valid. Abandoned attempts stay visible in admin. Pending older than 10 minutes triggers an automatic verification call. | M |
| FR-PAY-06 | Expiry. | Unpaid orders are cancelled and stock released when the reservation expires, **after** one final verification call (to catch late success). | M |
| FR-PAY-07 | Refund workflow. | Finance requests, Owner or Finance approves, server calls the provider, webhook or verification confirms, order moves to `REFUNDED`. Sum of refunds never exceeds the paid amount. | M |
| FR-PAY-08 | No card data. | The platform never receives or stores card numbers or CVV. Only provider references, channel label and safe metadata are stored. | M |

### 5.4 Orders, fulfilment and tracking

| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-ORD-01 | Order lifecycle state machine. | Transitions in §7 are enforced on the server. Invalid transitions return `409` and are logged. | M |
| FR-ORD-02 | Timestamped status history. | Every change records from, to, actor type, actor id, reason and time. History is append-only. | M |
| FR-ORD-03 | Customer tracking timeline. | Shows status steps with timestamps and delivery events. Internal notes are never shown. | M |
| FR-ORD-04 | Delivery information. | Staff can add carrier, tracking number and status events. Estimated delivery is shown only as a provider estimate or a labelled business estimate ("Usually 1–2 working days in Lagos"). | M |
| FR-ORD-05 | Staff order management. | List with search (order number, phone, name) and filters (status, date range, channel, payment status, zone). Bulk status change is **not** in MVP. | M |
| FR-ORD-06 | Cancellation. | Customer may cancel while the order is `PENDING_PAYMENT` or `PAYMENT_CONFIRMED`, via the storefront or the assistant (after a confirmation step). Staff may cancel until `DISPATCHED`. Paid cancellations move to `REFUND_PENDING`. | M |
| FR-ORD-07 | Notifications on status change. | Each customer-visible status change enqueues the matching WhatsApp notification (§5.6) if consent exists. | M |

### 5.5 Customer accounts and privacy

| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-CUS-01 | Sign in with phone and OTP. | 6-digit code, expires in 10 minutes, 5 attempts maximum, resend cooldown 60 seconds, at most 5 sends per phone per hour. Codes are stored hashed. | M |
| FR-CUS-02 | Order history. | Lists the customer's orders after sign-in. Shows nothing for other customers. | M |
| FR-CUS-03 | Order lookup without sign-in. | Requires order number **and** an OTP to the phone on the order. Lookup responses never reveal other orders. | M |
| FR-CUS-04 | Data export and deletion request. | Customer can request a copy or deletion via support. Deletion anonymises PII and keeps financial records (see §8.4). | S |
| FR-CUS-05 | Consent withdrawal. | Customer can say "STOP" on WhatsApp or untick in account settings. Withdrawal takes effect immediately and is recorded. | M |

### 5.6 WhatsApp

| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-WA-01 | Webhook verification. | `GET` checks `hub.mode`, `hub.verify_token` and returns `hub.challenge` as plain text. Otherwise `403`. | M |
| FR-WA-02 | Signed payload check. | `POST` checks `X-Hub-Signature-256` over the raw body with the App Secret, using constant-time comparison. Invalid signatures are rejected and logged. | M |
| FR-WA-03 | Inbound handling. | Each inbound message is processed once (keyed by message id). Supported: text, button reply, list reply. Other types get a polite fallback. | M |
| FR-WA-04 | Interactive menus. | Main menu uses reply buttons (max 3) or a list (max 10 rows). Menus are generated from configuration. | M |
| FR-WA-05 | 24-hour service window. | Free-form messages only inside the window opened by the customer's last inbound message. Outside it, only approved templates are sent. | M |
| FR-WA-06 | Notification templates. | Order confirmed, payment received, status update, out for delivery, delivered, refund update, OTP. Each template is approved by Meta before use. | M |
| FR-WA-07 | Delivery-status tracking. | Status updates (sent, delivered, read, failed) update the message and notification record. Out-of-order updates never move a status backwards. | M |
| FR-WA-08 | Retries with backoff. | Failed sends retry with exponential backoff up to a limit. Permanent errors stop retries and are visible to staff. | M |
| FR-WA-09 | Human handoff. | Customer chooses "Talk to a person" or the assistant escalates. Conversation mode becomes `HUMAN`. Staff reply from the dashboard within the window or with a template. | M |
| FR-WA-10 | Opt-out handling. | "STOP" marks marketing and order-update consent as withdrawn and confirms in one message. | M |

### 5.7 AI shopping assistant

| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-AI-01 | Product Q&A from catalogue data. | Every product fact (price, stock, variant, material, care) comes from a tool result. Responses that quote a price or stock level are checked against tool output. | M |
| FR-AI-02 | Recommendations by preference and budget. | Uses search and filter tools with price bounds. Returns only in-stock published products, or says none match. | M |
| FR-AI-03 | Comparison. | Compares up to three products on attributes present in data. Missing attributes are reported as "not listed", not guessed. | S |
| FR-AI-04 | Policy answers. | Answers delivery, return and refund questions from the stored policy text only. Otherwise offers a human. | M |
| FR-AI-05 | Cart actions. | Can add, change and remove cart items through server tools with validation. | M |
| FR-AI-06 | Checkout guidance with explicit confirmation. | Assistant summarises items, totals and delivery. A **server-rendered confirmation control** (button or link) must be used to place the order. The model cannot confirm on the customer's behalf. | M |
| FR-AI-07 | Order status after verification. | Requires OTP verification in the same conversation before order details are shown. Scope limited to that customer's orders. | M |
| FR-AI-08 | Handoff. | Triggers on request, repeated misunderstanding, complaints, refund disputes, or payment problems. Creates a conversation handoff with a short summary. | M |
| FR-AI-09 | Graceful degradation. | If the model is unavailable or times out, the assistant shows the deterministic menu (browse, search by keyword, track order, talk to a person). | M |
| FR-AI-10 | Audit. | Every tool call is recorded with redacted inputs, status, latency and the acting customer. | M |
| FR-AI-11 | Scope restriction. | Declines unrelated requests (general knowledge, coding, personal advice) and redirects to shopping and support topics. | M |

### 5.8 Admin dashboard

| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-ADM-01 | Overview. | Sales today and this week (paid orders only), order counts by status, pending fulfilment, open handoffs, failed notifications, failed payments. | M |
| FR-ADM-02 | Product create and edit. | Draft and publish. Publishing requires name, description, at least one active variant, a price and alt text on at least one image. | M |
| FR-ADM-03 | Categories and variants. | Create categories (one level of nesting in MVP). Define options (e.g. Size, Colour) and generate variants with SKU and price. | M |
| FR-ADM-04 | Inventory. | View on-hand and reserved stock. Adjust with a reason. Every change is written to the movement ledger. | M |
| FR-ADM-05 | Customers. | List and search. Phone and email are **masked by default**. Revealing a value requires a role permission and writes an audit entry. | M |
| FR-ADM-06 | Payments view. | Payment status, provider reference, amount, channel and timestamps. No card data. | M |
| FR-ADM-07 | Conversations inbox. | List of conversations by mode (AI, human, closed), with unread and window status. Staff can reply, assign, and close. | M |
| FR-ADM-08 | WhatsApp notification log. | Each notification with type, order link, status, attempts, last error. Filter by failed. | M |
| FR-ADM-09 | Settings. | Brand, contact details, policies, delivery zones, VAT display, reservation minutes, AI on/off, notification preferences. Every change audited. | M |
| FR-ADM-10 | Staff accounts and roles. | Create, deactivate, change role. Owner cannot be deactivated by others. Deactivation revokes sessions immediately. | M |
| FR-ADM-11 | Audit log viewer. | Filter by actor, action, entity and date. Read-only. | M |

---

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| **Security** | OWASP ASVS Level 2 as the target for MVP. Server-side authorisation on every route. No secrets in client bundles. Rate limits on OTP, checkout, webhook and AI endpoints. Details in `02-architecture.md` §8. |
| **Privacy** | Aligned with the Nigeria Data Protection Act 2023 (NDPA): lawful basis and notice at collection, provable consent, right to withdraw, retention limits, breach handling. Legal review required before launch (see §9). |
| **Performance** | Storefront pages render server-side with cached catalogue reads. Target p95 under 800 ms for product list and detail on a mid-range phone over 4G in Lagos (to be measured). Checkout p95 under 1.5 s excluding payment redirect. |
| **Availability** | Target 99.5% monthly for storefront and checkout at MVP. Webhooks must be acknowledged within seconds even when processing is delayed (processing is asynchronous). |
| **Accessibility** | WCAG 2.2 AA. Keyboard navigable. Visible focus. Touch targets at least 44×44 px. Colour contrast 4.5:1 for body text. Form errors linked to fields. Reduced-motion respected. |
| **Localisation** | English (en-NG) for MVP. Currency NGN. Time zone Africa/Lagos. Phone numbers in E.164. Plan for Pidgin or Yoruba copy later (D-08). |
| **Observability** | Structured JSON logs with request ids. No PII in logs (phones, addresses, tokens). Error tracking, uptime checks, queue depth and webhook failure alerts. |
| **Maintainability** | TypeScript strict mode. Domain logic separated from HTTP and UI. Migrations are versioned and reviewed. |
| **Data integrity** | Money in minor units. Stock never negative. Order totals equal the sum of their parts (DB check). Immutable order snapshots. |
| **Portability** | No vendor-specific feature that blocks moving to another host or database provider. |

---

## 7. Order lifecycle and business rules

Single customer-visible status with transitions enforced on the server. "Actor" shows who may trigger the transition.

| From | To | Actor | Condition / side effects |
|---|---|---|---|
| — | `PENDING_PAYMENT` | Customer (checkout) | Stock reserved; reservation expiry set; payment record created. |
| `PENDING_PAYMENT` | `PAYMENT_CONFIRMED` | System (verified payment) | Provider verification passed; stock committed; `paidAt` set; payment-received notification queued. |
| `PENDING_PAYMENT` | `CANCELLED` | System (expiry) or customer | Reservation released; no refund needed. |
| `PAYMENT_CONFIRMED` | `CONFIRMED` | Staff or system (auto after verification, D-05) | Order confirmed notification queued. |
| `PAYMENT_CONFIRMED` / `CONFIRMED` | `REFUND_PENDING` | Staff | Cancelled after payment. Refund requested. |
| `CONFIRMED` | `PROCESSING` | Staff (fulfilment) | — |
| `PROCESSING` | `READY_FOR_DISPATCH` | Staff (fulfilment) | Packed and labelled. |
| `READY_FOR_DISPATCH` | `DISPATCHED` | Staff (fulfilment) | Shipment created; dispatch notification queued; `dispatchedAt` set. |
| `DISPATCHED` | `OUT_FOR_DELIVERY` | Staff or provider event | Out-for-delivery notification queued. |
| `OUT_FOR_DELIVERY` | `DELIVERED` | Staff or provider event | Delivered notification queued; `deliveredAt` set. |
| `OUT_FOR_DELIVERY` | `DISPATCHED` | Staff | Delivery attempt failed; returns to dispatched for re-attempt. Event recorded. |
| `DELIVERED` | `REFUND_PENDING` | Staff (Finance or Owner) | Return or refund approved. |
| `CONFIRMED` / `PROCESSING` / `READY_FOR_DISPATCH` | `CANCELLED` | Staff | Only if unpaid. For paid orders use `REFUND_PENDING`. |
| `REFUND_PENDING` | `REFUNDED` | System | Only after provider confirms full refund; partial refunds keep the order in `REFUND_PENDING` until fully refunded. |

**Business rules**

- BR-01: A cancelled order cannot be reactivated. Customers reorder instead.
- BR-02: An order cannot leave `PENDING_PAYMENT` without verified payment or cancellation.
- BR-03: Price, product name and variant title are snapshotted at checkout.
- BR-04: Stock is never negative. Reservations are included in availability.
- BR-05: Each customer-visible change produces one notification at most (deduplicated).
- BR-06: Staff notes are internal and are never sent to the customer or the assistant.
- BR-07: VAT is applied as configured. Default assumption: prices include VAT at 7.5% and the displayed breakdown is informational (A-06).

---

## 8. Roles and permissions

Permissions are enforced by a central policy module on the server. The UI only hides controls.

| Capability | Owner | Admin | Manager | Fulfilment | Support | Finance | Viewer |
|---|---|---|---|---|---|---|---|
| View overview and reports | ✔ | ✔ | ✔ | — | — | ✔ | ✔ |
| Create and edit products, categories, variants | ✔ | ✔ | ✔ | — | — | — | — |
| Publish or archive products | ✔ | ✔ | ✔ | — | — | — | — |
| Adjust inventory | ✔ | ✔ | ✔ | ✔ | — | — | — |
| View orders | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Move fulfilment statuses (`CONFIRMED`→`DISPATCHED`, delivery events) | ✔ | ✔ | ✔ | ✔ | — | — | — |
| Cancel an unpaid order | ✔ | ✔ | ✔ | — | ✔ | — | — |
| Request a refund | ✔ | ✔ | — | — | — | ✔ | — |
| Approve and execute a refund | ✔ | — | — | — | — | ✔ | — |
| View customers (masked) | ✔ | ✔ | ✔ | — | ✔ | — | ✔ |
| Reveal full phone or email (audited) | ✔ | ✔ | — | — | ✔ | — | — |
| View payments | ✔ | ✔ | ✔ | — | — | ✔ | ✔ |
| Use WhatsApp inbox and handoff | ✔ | ✔ | ✔ | — | ✔ | — | — |
| Manage settings and delivery zones | ✔ | ✔ | — | — | — | — | — |
| Manage staff and roles | ✔ | — | — | — | — | — | — |
| View audit log | ✔ | ✔ | — | — | — | — | ✔ |

Rules: only Owner can grant the Owner role. Admin cannot grant Owner. Every role change is audited.

---

## 9. Policy and compliance constraints

| ID | Constraint | Impact on design | Source / status |
|---|---|---|---|
| **P-1** | Meta's WhatsApp Business Solution Terms prohibit AI providers from distributing general-purpose AI assistants on the platform when the AI is the primary functionality. Use that is ancillary or supports the business's own customer service is permitted. | The assistant is scoped to **this business's catalogue, cart, checkout, order and support tasks**. It declines open-ended topics. It is not offered as a standalone chatbot product. Compliance review is required before launch. | Terms effective 15 Jan 2026 [1](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/); EC summary permits ancillary customer-support use [15](https://chatmitra.com/blog/whatsapp-ai-agent/). Read the current official terms before launch. |
| **P-2** | Business Solution Data (conversations) may not be used to train or improve AI models, except for a model fine-tuned for the business's exclusive use. | LLM provider must be configured with no training on our data (zero-retention or equivalent). Written confirmation from the vendor is required. | [8](https://monochat.ai/blog/whatsapp-ai-chatbot-policy-2026) — verify in vendor contract. |
| **P-3** | Free-form messages only inside the 24-hour window opened by the customer. Otherwise approved templates only. | Outbox must check window state before sending. Notifications use templates. | Meta Cloud API behaviour; error on closed window is a documented re-engagement error. |
| **P-4** | Service and utility messages are billed per message from 1 Oct 2026. Each phone number has 1,000 free service messages per month. | Cost model needed: a few hundred orders a month mostly fall in the free allowance, but marketing messages are priced separately. Track message counts per month in admin. | Meta pricing page [1](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing). Per-country rates differ between third-party sources; confirm on Meta's rate card before budgeting. |
| **P-5** | Opt-in for business messages must be obtained and recorded. | Consent records with purpose, source, time and policy version. Checkout consent is unticked by default. | Company policy aligned with NDPA 2023 consent rules (§6). |
| **P-6** | NDPA 2023: consent is burdened on the controller to prove; withdrawal must be as easy as giving consent; retention must be limited to need. | Consent ledger, STOP handling, retention jobs (see `03-data-model.md` §8). | NDPA s.26 burden of proof [2](https://cert.gov.ng/ngcert/resources/Nigeria_Data_Protection_Act_2023.pdf); s.35 withdrawal; retention s.24(1)(d) [7](https://iclg.com/practice-areas/data-protection-laws-and-regulations/nigeria/). |
| **P-7** | NDPC "major importance" thresholds (e.g. processing data of more than 200 data subjects in six months) can trigger additional obligations. | Counsel to assess; the business may need to register with the NDPC. | [3](https://cookie-script.com/privacy-laws/nigeria-data-protection-act-2023). |
| **P-8** | Breach notification duties, data protection impact assessment, and processor contracts with WhatsApp, Paystack and the LLM provider. | Legal checklist in the launch plan. Not yet verified; confirm with counsel. | To confirm. |

---

## 10. Assumptions and open decisions

### 10.1 Assumptions (used until corrected)

| ID | Assumption |
|---|---|
| A-01 | One Nigerian brand at launch, selling in NGN. Delivery initially within Lagos and named states. |
| A-02 | The business will create a Meta Business Portfolio, complete business verification, and register a dedicated WhatsApp Business phone number. The number is not used in the consumer WhatsApp app. |
| A-03 | The business has a Paystack merchant account and can obtain test and live keys. |
| A-04 | Fulfilment is handled by business staff: in-house riders or a courier updated manually. No courier API in MVP. |
| A-05 | Products are prepaid. Pay-on-delivery is not in MVP (see D-02). |
| A-06 | Prices include VAT at 7.5%. The VAT breakdown is shown for information. The accountant confirms the treatment. |
| A-07 | Customers are identified by phone number (E.164). Email is optional. |
| A-08 | Guest checkout is allowed. Order lookup always needs an OTP. |
| A-09 | Stock is tracked per variant. Reservations last 30 minutes. |
| A-10 | Refunds are approved manually by Owner or Finance. Partial refunds are supported. |
| A-11 | The LLM provider is accessed through a server-side adapter. The first choice is made in Stage 6, based on tool-calling quality, data-use terms and cost. |
| A-12 | Delivery estimates are business-configured and labelled as estimates. The platform never invents a date. |
| A-13 | Time zone is Africa/Lagos (UTC+1, no daylight saving). |
| A-14 | Order numbers may have gaps. Legal sequential invoice numbering is out of MVP scope. |
| A-15 | Staff use email and password with Argon2id. MFA is required before production (§4.1). |

### 10.2 Open decisions (need the business's answer)

| ID | Decision | Options | Default if not decided |
|---|---|---|---|
| **D-01** | Brand identity: name, logo, colours, categories, first product set. | Provided by owner | Neutral sample brand, clearly marked as sample data |
| **D-02** | Payment methods at launch. | (a) Paystack online only · (b) Paystack + pay-on-delivery · (c) Paystack + bank transfer with manual confirmation | **Decided: (a) Paystack online only.** Bank transfer was considered and rejected because a manual confirmation would break the verified-payment rule (principle 2). Pay-on-delivery would change the state machine. |
| **D-03** | Delivery model and areas. | In-house riders · courier partner · pickup only | **Decided: in-house riders, Lagos only, two zones with sample fees** (fees and ETAs are labelled as estimates). |
| **D-04** | LLM provider and monthly budget. | Provider choice and a spending cap | Provider adapter with a monthly budget cap; no model chosen yet |
| **D-05** | Auto-confirm orders after verified payment, or manual confirmation by staff? | Auto · manual | **Decided: manual confirmation by staff.** A verified payment moves the order to `PAYMENT_CONFIRMED`. Staff then move it to `CONFIRMED`; the state machine is unchanged, only the actor for that transition differs. |
| **D-06** | Hosting preference. | Vercel + managed Postgres + worker · container host (e.g. Render, Railway, Fly) + managed Postgres | Container host with a separate worker (see `02-architecture.md` §9) |
| **D-07** | WhatsApp readiness: Meta Business verification status, number, and who holds admin access. | Ready · in progress · not started | Mock mode until ready |
| **D-08** | Languages. | English only · English plus Pidgin or Yoruba copy | English only |
| **D-09** | Minimum order value and per-item limit. | Values | **Decided: no minimum order value; per-item limit 10.** |
| **D-10** | Customer accounts: OTP only, or optional password later? | OTP only · OTP plus password | OTP only |
| **D-11** | Email at checkout. Paystack requires an email address to initialise a transaction, so WhatsApp-initiated orders must also collect one. | Collect email (required) · use a system placeholder for WhatsApp orders (not recommended: payment receipts would go nowhere and the data would be misleading) | Collect email, required for payment, used for the receipt only. Confirm the privacy wording with counsel. |

---

## 11. Traceability to the brief

| Brief item | Where addressed |
|---|---|
| Customer journey steps 1–12 | §5.1–5.6; `04-ui-ux.md` §2 |
| AI assistant capabilities | §5.7; `05-whatsapp-and-ai.md` Part 2 (§2.x) |
| Storefront requirements | §5.1–5.2; `04-ui-ux.md` |
| WhatsApp integration | §5.6; `05-whatsapp-and-ai.md` Part 1 (§1.x) |
| Admin dashboard | §5.8; §8; `04-ui-ux.md` §4 |
| Order lifecycle | §7; `03-data-model.md` §3 |
| Payments | §5.3; `06-payments.md` |
| Data model and security | `03-data-model.md`; `02-architecture.md` §8 |
| Phases 1–8 | Phase 1: this file. Phase 2: `02-architecture.md`. Phase 3: `04-ui-ux.md`. Phases 4–8: `07-mvp-and-roadmap.md` |
