# AI Architecture

Status: design only. **No AI feature is in the pilot MVP.** An optional request assistant may be built after Phase 6 if time permits. The product must work fully with AI disabled.

## Principles
1. Deterministic baseline first (matching is rules-based and explainable); AI augments, never replaces.
2. AI drafts, suggests and summarizes. A human confirms any action that changes bookings, money, access, vendor status or sends external messages.
3. All user and vendor text is untrusted input.
4. Children's data is excluded from prompts by default and data sent is minimized and redacted.
5. Every capability has a success metric, an evaluation set, a fallback and a cost ceiling.

## Layered design
```
Feature module (e.g. request assistant)
   -> AI service (policy, budget, redaction, logging)
      -> Provider adapter interface (complete, structured output, embeddings)
         -> Provider implementation (selected in a later decision)
```
- **Adapter interface:** swapping provider or model is a config change.
- **Prompts:** versioned records (`ai_prompts`), reviewed like code, with variables allow-listed.
- **Config:** model per feature, temperature, max tokens, feature flag per tenant, per-tenant monthly budget, rate limits.
- **Observability:** log prompt version, model, tokens, cost, latency, outcome; payloads stored only with redaction and retention limits.
- **Guardrails:** structured-output validation against schemas, refusal handling, content filters, allow-listed tool set (read-only tools only at launch).
- **Prompt-injection defence:** user text is delimited and never concatenated into system instructions; tool outputs are data; outputs that would trigger actions go through confirmation UI.

## Capabilities (priority order)
| # | Capability | Value | Evaluation | Fallback |
|---|---|---|---|---|
| 1 | Request assistant: natural language to structured request fields, asks for missing details | Cuts ops clarification time | Field extraction accuracy on 100 labelled examples; clarification rate | Standard form |
| 2 | Operations copilot: summarize request, compare quotes, flag risks | Ops speed | Reviewer usefulness rating | Manual |
| 3 | Vendor assistant: descriptions, packages, profile gaps | Profile quality | Completeness uplift | Manual |
| 4 | Resident assistant grounded in catalog | Discovery | Grounded-answer rate (no invented offerings) | Search |
| 5 | Event planner | Event ideas and checklists | Reviewer rating | Templates |
| 6 | BI insights over metrics dictionary | Decisions | Accuracy against queries | Dashboards |

## Provider decision
**[DECISION, later phase]** Provider and models are chosen when the first capability is approved, based on quality on the evaluation set, cost, data-handling terms and region options. Check current model IDs and pricing at that time.

## Data tables (later)
`ai_prompts`, `ai_runs` (feature, model, tokens, cost, status), `ai_conversations`, `ai_recommendations` (with accept/reject), `ai_evaluations`.
