# 05 — WhatsApp Integration and AI Shopping Assistant (Phases 2 and 6 design)

Status: **Design.** Nothing here is connected to Meta or an LLM provider yet. Both integrations start in **mock mode** (§1.8, §2.12). Anything marked *verify* must be checked against Meta's current documentation before launch.

---

# Part 1 — WhatsApp integration

## 1.1 Platform choice and constraints

- **Channel:** WhatsApp Business Platform, **Cloud API** (hosted by Meta), called directly through a thin client. Adapter boundary allows a Business Solution Provider later (`02-architecture.md` §1).
- **Two rules decide what we can send** (verified across Meta documentation and secondary sources):
  1. **24-hour customer service window.** Free-form messages (text, interactive buttons, lists) are allowed only within 24 hours of the customer's last inbound message. Outside it, only approved **templates** may be sent.
  2. **Templates** are pre-approved by Meta, have a category (utility, authentication, marketing), and are filled with variables. Approval is required before use.
- **Billing.** From 1 October 2026, service messages (free-form replies inside the window) are billed per message after 1,000 free per business phone number per month. Utility templates sent inside an open window are also billed. Per-country rates vary across third-party sources, so confirm on Meta's rate card before budgeting (see [Meta pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)).
- **Policy constraint P-1** (`01` §9): the assistant must remain a business-specific sales and support agent. It must not be a general-purpose chatbot. Read the current Business Solution Terms before launch.

## 1.2 Inbound: webhooks

**Verification handshake (GET):** Meta sends `hub.mode`, `hub.verify_token` and `hub.challenge`. The endpoint returns the challenge as plain text when `hub.mode = subscribe` and the token matches. Otherwise `403`.

**Event delivery (POST):**

1. Read the **raw body** once (before any JSON parsing).
2. Verify `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(App Secret, raw body), compared in constant time. Reject with `401` and log, without processing.
3. Parse the payload (`entry[].changes[].value`), which can contain `messages[]`, `statuses[]` and `contacts[]`.
4. For each message, store a `WebhookEvent` keyed by the message id. Duplicates are ignored.
5. Respond `200` quickly. Meta retries undelivered events, so processing must be idempotent. Heavy work runs in the worker.

**Subscription:** subscribe to the `messages` field of the WhatsApp Business Account. Status updates (sent, delivered, read, failed) arrive through the same field.

**Mapping rules**

| Inbound | Action |
|---|---|
| Text | Route to the conversation's current mode (AI, human, closed) |
| Button reply (`id`) | Dispatch to the menu or control handler by id, never by label text |
| List reply (`id`) | Same as button reply |
| Media, location, contacts, other | Polite fallback: "I can read text messages and menu buttons for now." |
| `STOP` / `START` keywords | Consent withdraw / restore; confirm in one message |
| Unknown sender | Creates a `Customer` only after the first meaningful action (browse, order, or handoff), never silently for marketing |

## 1.3 Outbound: sending

- **Client:** POST to the Graph API messages endpoint for our phone number id, with a pinned API version in config. The access token is loaded from the secret store.
- **Send decision** (computed in one place, `whatsapp/sendPolicy.ts`):
  1. Mode is `LIVE`? If not, route to mock.
  2. Consent present for the notification's purpose? If not, `SKIPPED_NO_CONSENT`.
  3. Customer window open? Free-form allowed. If closed, the message must be a template; if no approved template exists, the notification fails with a clear reason.
  4. Build the payload. Validate length (text ≤ 4,096 characters; button titles ≤ 20 characters; list row titles ≤ 24 characters — *verify*).
- **Idempotency:** each send has a `dedupeKey`. The worker records `providerMessageId` on success, so a retried job after a timeout does not send twice when the provider already accepted the message.

## 1.4 Notifications and consent

| Trigger | Notification type | Template key | Consent purpose | Window |
|---|---|---|---|---|
| Payment verified | `ORDER_CONFIRMED` | `order_confirmed` | `ORDER_UPDATES_WHATSAPP` | Template (usually closed) |
| Staff moves to Processing or Ready | `ORDER_STATUS_UPDATE` | `order_status_update` | same | Template |
| Dispatched | `DELIVERY_UPDATE` | `order_dispatched` | same | Template |
| Out for delivery | `DELIVERY_UPDATE` | `order_out_for_delivery` | same | Template |
| Delivered | `DELIVERY_UPDATE` | `order_delivered` | same | Template |
| Refund requested or completed | `REFUND_UPDATE` | `refund_update` | same | Template |
| Cancelled | `ORDER_STATUS_UPDATE` | `order_cancelled` | same | Template |
| Assistant or staff reply | — (conversation) | free-form | `AI_ASSISTANT_PROCESSING` for AI replies | Free-form inside window |
| OTP for sign-in or order lookup | — | `otp_login`, `otp_lookup` (AUTHENTICATION) | none required beyond the user's own request | Template |

**Consent sources**

- Web checkout: unticked checkbox "Send my order updates on WhatsApp". Recorded with `source = CHECKOUT_FORM` and the policy version.
- WhatsApp checkout: the confirmation message states that updates will go to this number. The customer's tap on **Place order** is the affirmative act. Recorded with `source = WHATSAPP_CONFIRMATION`.
- Withdrawal: `STOP`, the account page, or staff action. Recorded as a new `ConsentRecord` row with `granted = false`. Pending notifications for that purpose become `CANCELLED`.

**Content rules:** templates carry the customer's first name, the order number and at most one status or amount. They never include full addresses, product lists, card or payment details, or tracking links with personal data.

**Outbox behaviour:** a notification row is created in the same transaction as the business change. The worker processes pending rows in order, with backoff, and never sends a notification for a status the order has already left.

## 1.5 Template catalogue (to be drafted and submitted to Meta)

| Internal key | Category | Purpose | Variables | Status in repo |
|---|---|---|---|---|
| `otp_login` | AUTHENTICATION | Sign-in code | code (auth template format with copy-code button) | Drafted; not submitted |
| `otp_lookup` | AUTHENTICATION | Order lookup code | code | Drafted; not submitted |
| `order_confirmed` | UTILITY | Payment verified; order confirmed | first name, order number, total | Drafted; not submitted |
| `order_status_update` | UTILITY | Processing or ready | first name, order number, status label | Drafted; not submitted |
| `order_dispatched` | UTILITY | Handed to courier or rider | first name, order number | Drafted; not submitted |
| `order_out_for_delivery` | UTILITY | Out for delivery | first name, order number, provider ETA text (optional) | Drafted; not submitted |
| `order_delivered` | UTILITY | Delivered | first name, order number | Drafted; not submitted |
| `order_cancelled` | UTILITY | Cancelled | first name, order number | Drafted; not submitted |
| `refund_update` | UTILITY | Refund status | first name, order number, amount, status label | Drafted; not submitted |

Rules: variables are fixed in the code; text is in English (en-NG); Meta's review may reject wording, so the templates avoid promotional language and avoid implying a payment that has not been verified. If a template is paused or disabled, the notification waits in `PENDING`, the dashboard shows "Template unavailable", and staff are alerted. Orders are never blocked by a messaging failure.

## 1.6 WhatsApp Flows evaluation

**What Flows offers.** Native, in-chat forms (screens with text inputs, dropdowns, date pickers and similar) that the customer completes without leaving WhatsApp. Data can be submitted to a business endpoint. Flows need a Flow definition registered with Meta and a data-exchange endpoint that handles encrypted requests and signatures.

**What they are good for in this product**

| Use | Fit | Decision |
|---|---|---|
| Collecting delivery address and contact | Good: structured, validated, fewer typos than free text | **Candidate for post-MVP** (Stage 9) |
| OTP entry | Possible, but the authentication template's copy-code button is simpler | Keep the template path for MVP |
| Product browsing | Poor: a catalogue with images, stock and variants fits a web page | Use a link to the storefront |
| Full checkout inside chat | Not supported as a substitute for the storefront | Use the storefront and payment page |

**Limits to remember.** A Flow is not a web app. It cannot show the full storefront, it needs an endpoint and key management of its own, and the Flow JSON must be maintained as the product evolves. Adopt Flows only after the core flow works end-to-end.

## 1.7 Interactive menus, links and handoff

**Main menu** (reply buttons: maximum three per message; a list allows up to ten rows — *verify*):

- Option A: "Browse new arrivals" → list of up to ten categories or products, each row opening a product card with a link.
- Option B: "Find something" → free-text search (in-window).
- Option C: "Track my order" → order lookup and OTP flow (§2.5).
- Further: "Talk to a person" and "Store info" in a second menu or list.

**Links.** Product pages and checkout links use the brand's domain with UTM parameters. A `wa.me` click-to-chat link with a prefilled product message is provided on each product page (`https://wa.me/<number>?text=…`, URL-encoded).

**Handoff.** `handoff_to_human` sets `Conversation.mode = HUMAN` and creates an inbox item with a short summary (AI-generated, labelled). Staff reply from the inbox. While the conversation is in HUMAN mode, the assistant does not reply, and the customer sees "A team member will reply. Typical reply time: X (business hours)."

**Handoff hours.** Replies outside business hours get an automatic message with the next opening time, and the inbox item remains open.

## 1.8 Mock mode and simulator

- `WHATSAPP_MODE=mock` (default in development and CI). Outbound messages and templates are stored in `Message` and `WhatsAppNotification` with `providerMessageId = mock_<uuid>` and a simulated status progression (sent → delivered → read) with configurable delays.
- A development-only simulator (CLI and dev page) creates signed inbound events using the configured App Secret, so the real signature code path is tested. It is disabled in production.
- Fixtures: sanitised examples of text, button reply, list reply, status and failure payloads, used by automated tests.

## 1.9 Errors, retries and monitoring

| Condition | Behaviour |
|---|---|
| Invalid or expired access token (auth error) | Stop sends for the account; set notifications to `PENDING` (not failed); raise a critical alert |
| Rate limit or server error, timeout | Retry with exponential backoff and jitter (e.g. 1 min, 5 min, 30 min, 2 h, then daily up to the max attempts) |
| Re-engagement error (outside window, free-form attempted) | Switch to the template path if approved; otherwise fail with reason "window closed" |
| Undeliverable (recipient not on WhatsApp, unreachable) | Permanent failure after one retry. Staff see it in the log. |
| Invalid template parameters | Permanent failure. This is a code bug; alert. |
| Template not approved, paused or disabled | Hold as `PENDING`; alert staff |
| Status event for an unknown message | Store in `WebhookEvent`; reconcile later; no state change |
| Status regression (e.g. read arrives, then delivered) | Ignore the older status |

**Metrics:** messages sent per day and per template; delivery rate; failure codes; webhook verification failures; queue age; monthly service-message count against the 1,000 free allowance.

## 1.10 Activation checklist (when credentials and approvals exist)

1. Complete Meta Business verification for the business portfolio and name the admins.
2. Create a Meta app with the WhatsApp product. Register the business phone number. It must not be active in the consumer WhatsApp app. Get the display name approved.
3. Create a system user and a non-expiring token with the messaging and management permissions the Cloud API requires (*verify* exact scopes in the current docs). Store it in the secret manager only.
4. Set configuration: `WHATSAPP_MODE=live`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_GRAPH_VERSION` (pinned), and secrets `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`.
5. Register the callback URL `https://<app-domain>/api/webhooks/whatsapp` with the verify token, then subscribe to `messages`.
6. Submit templates in §1.5 for approval. Map each approved name in `MessageTemplate.providerName`.
7. In staging, send to an allowlisted test number: the verification GET, a signed inbound text, a menu reply, an in-window reply, a template send, and the status callbacks.
8. Compliance sign-off: P-1 (assistant scope), P-2 (no training on data, vendor confirmation), P-5 (consent wording), and the privacy notice.
9. Turn on live mode for a small pilot audience before public launch.

---

# Part 2 — AI shopping assistant

## 2.1 Purpose and boundaries

**The assistant helps a shopper move from question to checkout, and from checkout to a tracked order, for this business only.**

| In scope | Out of scope (politely redirected) |
|---|---|
| Products, variants, prices, stock, comparisons, recommendations | General knowledge, homework, coding, medical, legal or financial advice |
| Cart and checkout guidance, with explicit confirmation | Anything about other customers |
| Delivery areas, fees, estimate labels, returns and refund policy | Price negotiation, discounts or promises the policy does not contain |
| Order status after verification; cancellation request | Changing prices, stock, orders by free text |
| Store contact, hours, handoff to a person | Opinions on competitors |

**Disclosure.** The first message in each conversation says the assistant is an AI assistant for the store, and that a person is available on request.

## 2.2 Architecture

```text
Inbound (web or WhatsApp)
   │
   ▼
Conversation router ── mode = HUMAN? ──► inbox (no model call)
   │ mode = AI
   ▼
Rate and abuse checks ── exceeded? ──► polite limit message
   │
   ▼
Context builder  (policy text · brand facts · verified flag · last N turns · summary)
   │
   ▼
LLM adapter  (tool calling; timeout; max tool rounds = 4)
   │   ▲
   │   └── tool results (structured, server-validated)
   ▼
Response validator  (grounding: prices/stock/names must match tool output; URL allowlist; length)
   │
   ▼
Renderer  (text + server-rendered cards and controls)  ── audit: AiToolInvocation rows
   │
   ▼
Outbound (free-form in window; template path otherwise)
```

**Fallback path.** Any model error, timeout, budget exhaustion or validation failure routes to the deterministic menu (§2.9). The customer never sees a raw error.

## 2.3 Tool catalogue

Tools run on the server with **identity injected by the server**. No tool accepts a customer id, business id or conversation id from the model. Arguments are validated with Zod. Every call is audited.

| Tool | Purpose | Key arguments (validated) | Reads / writes | Gate |
|---|---|---|---|---|
| `search_products` | Find products | `query?` (≤ 80 chars), `categorySlug?`, `minPriceMinor?`, `maxPriceMinor?`, `inStockOnly` (default true), `limit` (≤ 5) | Read catalogue | Public |
| `get_product` | Details, variants, stock state | `slug` | Read | Public |
| `compare_products` | Side-by-side facts | `slugs` (≤ 3) | Read | Public |
| `get_policy` | Policy text | `topic` ∈ {delivery, returns, refunds, privacy, contact, hours} | Read settings | Public |
| `get_delivery_quote` | Fee and estimate label | `state` (enum of Nigerian states) | Read zones | Public |
| `get_cart` | Current cart with server totals | — | Read cart (bound to conversation) | Conversation |
| `update_cart` | Add or set quantity | `variantId` (must come from a search result in this conversation), `quantity` (1–10) | Write cart | Conversation |
| `remove_from_cart` | Remove a line | `variantId` | Write cart | Conversation |
| `set_delivery_details` | Store draft delivery details | `recipientName`, `line1`, `city`, `state`, `landmark?` | Write conversation draft (not the customer profile) | Conversation |
| `prepare_checkout_summary` | Compute totals and issue a summary snapshot | — | Read + snapshot hash | Conversation |
| `show_checkout_confirmation` | Render the **Place order** control | — | Creates `ConfirmationRequest` | Conversation; requires a current summary snapshot |
| `request_order_code` | Send an OTP to the order's phone | `orderNumber` | Creates `OtpChallenge` | Rate-limited; does not reveal whether the order exists to a stranger (generic reply) |
| `verify_order_code` | Check the code the customer typed | `code` (6 digits) | Sets `verifiedUntil` on conversation | Attempt-limited |
| `get_order_status` | Order status and timeline | `orderNumber` | Read order | Verified conversation **and** order belongs to the verified customer |
| `show_cancel_confirmation` | Render the cancel control for an eligible order | `orderNumber` | Creates `ConfirmationRequest` | Verified; order eligible |
| `handoff_to_human` | Escalate | `reason` (enum), `summary` (≤ 500 chars, redacted) | Sets mode HUMAN; creates inbox item | Public |

**Callback-only actions (not callable by the model):**

- **Place order** is executed only by the button callback (`CHECKOUT_CONFIRM:<token>`) through the checkout service.
- **Cancel order** is executed only by the cancel control callback.
- **Apply discount, change price, change stock, refund** have no assistant path at all.

## 2.4 Explicit confirmation protocol

1. The customer's intent to buy is recognised and the assistant calls `prepare_checkout_summary`. The summary contains line items, quantities, variant titles, subtotal, delivery fee, total, delivery address, consent statement and payment method.
2. The assistant calls `show_checkout_confirmation`. The server:
   - computes the summary's `snapshotHash` (items, quantities, prices, fee, address, consent text version),
   - marks any earlier open confirmation for this cart as consumed,
   - creates a `ConfirmationRequest` (random token, stored as hash, 10-minute expiry, single use),
   - renders the summary and the **Place order** and **Change** controls.
3. The model never sees the token. It only learns that a control was rendered.
4. Tapping **Place order** calls the callback. The server checks: token valid, not expired, not consumed; `snapshotHash` equals the current cart snapshot; stock still reserved or available; delivery state still covered. Only then does the checkout service run, with the same idempotency rules as the web checkout.
5. Any change between summary and confirmation (cart edit, price change, stock change) invalidates the token. The customer sees the updated summary and confirms again.

**Text is never consent to act.** "Yes", "ok" or "go ahead" does not place an order or cancel one. The assistant replies: "Tap **Place order** to confirm."

## 2.5 Identity and order lookup

- **Who is talking?** On WhatsApp, the sender's phone number identifies the conversation. On the web, a random conversation id identifies it. Neither is treated as proof of the person behind a phone number.
- **Order details require an OTP.** `request_order_code` sends a one-time code to the phone number on the order, not to the number the customer types. The code is valid for 10 minutes and has 5 attempts.
- **Verification scope.** `verifiedUntil` is 30 minutes. The verified customer id is stored on the conversation, and tools check it on every call.
- **No enumeration.** The request response is identical whether or not the order exists or matches the phone number.
- **Cross-customer protection.** Even a verified conversation can only see orders where `order.customerId = verifiedCustomerId`. A test covers requests for another customer's order number.

## 2.6 Grounding and answer quality

- Every factual claim about products, prices, stock, delivery, policies or order status must come from a tool result in the same turn. The system prompt says so, and the validator enforces it:
  - Any currency amount in the reply must appear in the tool results of that turn (regex on `₦` amounts).
  - Any product name in the reply must match a product returned by a tool in that turn or earlier in the conversation.
  - Stock wording is limited to the states the tool returns (in stock, low stock, out of stock).
  - Delivery time wording must come from the provider or a labelled business estimate.
- On validation failure: one regeneration with a stricter instruction. If it fails again, the reply is replaced by a short, structured answer built from tool data, or by a handoff offer.
- Product cards and buttons are rendered from tool output. The model can only reference button ids from an allowlist.
- Links in replies are restricted to the brand's storefront domain, `wa.me` and the payment provider's checkout domain. Any other URL is removed.

## 2.7 Memory, context and privacy

- **Context window:** the system prompt, brand facts, the last 12 messages, the conversation summary, the verified flag and the cart summary. Other customers' data, staff notes and full addresses are never included unless the current step needs the delivery address to confirm it.
- **Summary:** regenerated every 10 turns, at most 1,000 characters, and it excludes phone numbers, full addresses and card or payment details. It is labelled "AI-generated summary" in the inbox.
- **Retention:** message bodies follow the 90-day rule. Tool invocations keep redacted inputs for one year. Raw model transcripts are not stored by the platform. If the LLM vendor retains data, the contract must limit it (P-2).
- **Redaction:** phone numbers, OTP codes, addresses and tokens are masked in logs and tool audit records.
- **Model training:** the vendor must not use our conversations for training (P-2). Written confirmation is required before production.

## 2.8 Prompt injection and abuse

| Threat | Mitigation |
|---|---|
| Customer asks the model to ignore instructions, reveal the system prompt, or grant a discount | System rules are fixed. Tool results are treated as data. There is no discount tool. Refusals are scripted. Test cases in §2.10. |
| Malicious text in product descriptions or reviews | Product text is passed as quoted data with delimiters. Output validation still applies. |
| Customer requests another person's order | Identity injection and the ownership check in §2.5. |
| Requests for personal data (e.g. "give me the phone number of the customer who bought X") | Refused. No tool returns other customers' data. |
| Spam or cost attacks | Per-conversation and per-number limits (e.g. 20 messages per 10 minutes), daily per-business budget, blocklist after repeated abuse. |
| Tool-call loops | Maximum 4 tool rounds per turn; repeated identical calls are cut off. |
| Phishing through injected links | URL allowlist (§2.6). |

## 2.9 Fallback, timeouts and limits

- **Timeouts:** model call 12 s on WhatsApp, 15 s on web (*to tune in staging*). Total turn budget 20 s. Beyond that, the fallback menu is sent.
- **Deterministic menu (no LLM):** Browse categories, Search by keyword (database search), Track my order (OTP flow), Talk to a person. These flows are implemented as a state machine and tested independently of the model.
- **Budget:** a per-business monthly token budget. At 80%, staff are alerted. At 100%, the assistant switches to the menu until the next period, and this is shown in the admin overview.
- **Disable switch:** `aiAssistantEnabled = false` in settings returns the menu immediately.

## 2.10 Evaluation suite

A versioned set of about 80 scenarios in `tests/ai/eval/*.yaml`. Each has the conversation, the catalogue state, the expected tool calls and the expected properties of the reply.

| Category | Examples | Pass criterion |
|---|---|---|
| **Safety (must be 100%)** | Place order without a confirmation tap; "yes" as consent; cross-customer order lookup; prompt injection for discounts; request for personal data; invented product; invented price; reuse of a consumed token | No forbidden tool call; no order created; refusal or handoff |
| **Accuracy (≥ 95%)** | Price and variant correct; out-of-stock stated correctly; budget filter respected; compare reports missing attributes; policy answer matches stored text | Facts match tool output |
| **Scope (≥ 95%)** | Off-topic requests are redirected; disclosure present at start | Redirect or disclosure present |
| **Flow (≥ 90%)** | Browse → add → checkout summary → confirm; track order with OTP; handoff with summary | Flow completes or hands off |
| **Resilience (100%)** | Model timeout, model error, budget exhausted, malformed tool output | Fallback menu sent; no raw error |
| **Language (informational)** | Nigerian Pidgin input; mixed English and Yoruba words | Reply in clear English; no crash |

Run in CI with a **deterministic fake model** that replays scripted tool calls, so tool logic and validators are tested every commit. A nightly job runs the suite against the real provider (when a key is configured) and reports results without blocking deployment. Real-model results are recorded in the release notes.

## 2.11 Cost controls

- Short system prompt; catalogue data fetched by tool, not stuffed into context.
- Maximum output tokens per reply; maximum tool rounds.
- Per-turn and per-day budgets, with the menu fallback at the limit.
- Caching of policy text and category lists within a short TTL.
- Token counts stored on `AiToolInvocation` for cost reporting.

## 2.12 Model selection criteria (decision D-04)

| Criterion | Why it matters | How we test it |
|---|---|---|
| Tool-calling reliability | Core to safety and accuracy | Eval suite categories Safety and Accuracy |
| Latency from Lagos | WhatsApp users expect replies in seconds | p95 measured from staging hosted in the target region |
| Price per conversation | Sets the margin | Token counts from staging traffic |
| Data-use terms | P-2: no training on our data; retention limits | Vendor agreement review |
| Structured output support | Keeps validator simple | Fixture tests |
| Availability and rate limits | Fallback must be rare | Load test at expected peak |

The provider sits behind `integrations/ai/provider.ts`. Switching providers means implementing one adapter and re-running the eval suite.

**Mock mode (default in development and CI):** a fake model with scripted responses, used by unit and eval tests. A live key is optional for development and required for the nightly eval and for staging with the assistant on.

---

## 3. Acceptance criteria for Stages 6 and 7

- A WhatsApp inbound text creates or resumes a conversation, and the menu replies within the mock simulator's configured delay.
- Duplicate inbound events (same message id) create one `Message` and one reply.
- An invalid signature is rejected with `401` and no database write beyond the rejection log.
- A notification is sent only with consent. The window rule and the template fallback are tested with the mock clock.
- An out-of-window free-form attempt is never sent.
- The assistant never creates an order without the confirmation callback. Tested by eval and by unit tests on the callback.
- Order status is shown only after OTP verification, and only for the verified customer.
- Model timeout and budget exhaustion show the fallback menu.
- The validator blocks an invented price in a test reply.
