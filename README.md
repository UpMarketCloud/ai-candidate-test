# Candidate Test: Smart Escalation Management

## Context

You're working on **webchat-ai**, an AI-powered virtual concierge for the hospitality industry. The concierge assists guests via instant messaging — answering questions about properties, check-in procedures, amenities, and more. When the AI cannot resolve a guest's issue on its own, it escalates to human staff by calling the `contact_staff` tool.

### The Problem

The `contact_staff` tool currently operates in a **fire-and-forget** manner: every time the AI agent decides to escalate, it creates a brand-new escalation with no awareness of whether the same guest already has an open escalation about the same (or a related) issue. The tool has **zero context** about the escalation lifecycle.

This leads to poor guest interactions in real-world conversations:

- **A guest follows up** on an issue they already reported ("Any update on the hot water?"), and the tool creates a second, duplicate escalation instead of recognizing that staff is already working on it.
- **A guest adds details** to an existing issue ("Also, the bathroom light is flickering — related to the electrical problem I mentioned"), and the tool creates a separate escalation instead of updating the existing one with the new information.
- **A guest re-reports a resolved issue** ("The hot water is gone again"), and the tool has no way to know it was previously resolved, missing the opportunity to flag this as a recurring problem and escalate with higher urgency.
- **The AI agent gives poor responses** because the tool only ever returns a generic "escalated" status. It can't tell the agent "staff is already looking into this" or "this was resolved before but has resurfaced," so the agent can't communicate meaningfully with the guest about the state of their issue.

The root cause is simple: **the tool is stateless**. It doesn't query existing escalations, doesn't understand the lifecycle of an issue, and therefore can't make intelligent decisions about how to handle each escalation request.

### What the Backend Already Supports

The admin backend already provides a full CRUD API for escalations. It can:

- **List** existing escalations for a chat (`GET /api/ai/escalations?chatId=xxx`)
- **Create** new escalations (`POST /api/ai/report-escalation`) — this is the only endpoint the tool currently uses
- **Update** existing escalations (`PUT /api/ai/escalations/:id`) — for appending context, changing priority, etc.
- **Close** escalations (`PATCH /api/ai/escalations/:id/close`) — to mark as resolved

The tool only uses the create endpoint today. The list, update, and close endpoints exist and are ready to be consumed — the tool just doesn't use them yet.

**Your task:** Enhance the `ContactStaffTool` so it becomes escalation-aware. It should query existing escalations before acting, and make intelligent decisions about whether to create, update, or skip — giving the AI agent enough information to communicate meaningfully with the guest.

---

## What You Receive

A standalone repo with these files:

```
├── README.md                            # Candidate instructions
├── package.json
├── tsconfig.json
├── src/
│   ├── Service/
│   │   ├── Tools/
│   │   │   ├── ContactStaffTool.ts      # THE FILE TO MODIFY
│   │   │   └── ContactStaffTool.spec.ts # EXISTING TESTS + YOUR NEW TESTS
│   │   └── Utils/
│   │       └── admin-request-options.ts # HTTP request helper (read-only)
│   ├── Dto/
│   │   ├── askQuestion.dto.ts           # Request DTO (read-only)
│   │   ├── escalation-request.dto.ts    # Escalation DTO (can extend)
│   │   └── conversation.dto.ts          # Chat history DTO (read-only)
│   └── test-utils/
│       └── unit-test.helpers.ts         # Shared test utilities (read-only)
```

### What You Don't Have

- The full NestJS application (you only have the tool + its dependencies)
- The backend API (the contract is provided below — you mock it in tests)
- The AI agent (you only see the tool interface the agent calls)
- Access to a running environment (everything runs via unit tests)

---

## Setup

```bash
# Prerequisites: Node.js 20+
corepack enable
yarn install
yarn test    # All existing tests must pass
```

No API keys, databases, or external services are required. All dependencies are mocked in tests.

---

## The Current Tool

`ContactStaffTool.ts` is a LangChain `DynamicStructuredTool` that:

1. Receives `query` (guest issue summary), `context` (action steps for staff), and `priority` (1/2/3)
2. Sends a Slack notification (non-blocking)
3. POSTs to the admin backend at `/api/ai/report-escalation`
4. Returns `{ status: 'escalated' }` or `{ status: 'failed' }` to the AI agent

**Current behavior:** Every call creates a new escalation. The tool has no awareness of existing escalations, their status, or their relationship to the current request.

### Key Interfaces

```typescript
// What the AI agent sends to the tool
interface ToolInput {
  query: string;      // "Guest reports no hot water in room 302"
  context: string;    // "1. Check boiler. 2. Offer room change."
  priority: '1' | '2' | '3';  // 1=HIGH, 2=NORMAL, 3=LOW
}

// What the tool sends to the backend to create an escalation
interface EscalationRequestDto {
  guestRequest: string;
  conciergeSummary: string;
  bookingId?: string;
  chatId?: string;
  hostId?: string;
  locationId?: string;
  priority: '1' | '2' | '3';
  chatMessageId?: string;
}

// What the backend returns on creation
interface IncidentResponse {
  incident?: {
    id?: string;
    note?: string;
    status?: string;
  };
}
```

---

## Backend API Contract

The backend already supports the following endpoints. All use the same `ADMIN_INSTANCE_URL` and `ADMIN_INSTANCE_X_API_KEY` as the existing POST endpoint. Use `buildAdminRequestOptions()` for headers.

### List Escalations

**`GET {ADMIN_INSTANCE_URL}/api/ai/escalations`**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chatId` | string | Yes | The chat ID to fetch escalations for |
| `bookingId` | string | No | Narrow results to a specific booking |

**Response:**

```typescript
interface ExistingEscalation {
  id: string;                    // "esc-001"
  guestRequest: string;          // "No hot water in room 302"
  conciergeSummary: string;      // "1. Check boiler. 2. Offer room change."
  status: 'open' | 'resolved';  // Current escalation status
  priority: '1' | '2' | '3';
  createdAt: string;             // ISO 8601 timestamp
}

// Response shape
{
  escalations: ExistingEscalation[];
}
```

### Update Escalation

**`PUT {ADMIN_INSTANCE_URL}/api/ai/escalations/:id`**

```typescript
// Request body
{
  conciergeSummary?: string;  // Append or replace context
  priority?: '1' | '2' | '3';  // Update priority if needed
  guestRequest?: string;  // Updated summary
}

// Response: updated ExistingEscalation
```

### Close Escalation

**`PATCH {ADMIN_INSTANCE_URL}/api/ai/escalations/:id/close`**

```typescript
// No request body required
// Response: updated ExistingEscalation with status: 'resolved'
```

---

## The Challenge

The core of this test is **decision-making**. Given the current request and the list of existing escalations, the tool needs to decide the right course of action. Here are some scenarios to consider (this is not exhaustive — you may identify more):

| Scenario | What should happen? |
|----------|---------------------|
| No existing escalations | ? *(you decide)* |
| Existing **open** escalation about the **same issue** | ? *(you decide)* |
| Existing **resolved** escalation about the **same issue** | ? *(you decide)* |
| Existing escalation about a **different issue** | ? *(you decide)* |
| Guest adds new details to an already-escalated issue | ? *(you decide)* |
| Priority of the new request is higher than the existing escalation | ? *(you decide)* |
| Fetch-existing-escalations API call **fails** | ? *(you decide)* |

Fill in the `?` cells above with your reasoning in your README deliverable.

### Similarity Detection

You need to determine if a new guest complaint is about the same issue as an existing escalation. This requires **AI-powered comparison** since complaints can be expressed very differently:

- "There's no hot water" vs "The shower is ice cold" → **Same issue**
- "There's no hot water" vs "The Wi-Fi doesn't work" → **Different issue**
- "The AC stopped working" vs "It's extremely hot in the room, the air conditioning isn't cooling" → **Same issue**

Design a prompt that compares the new `query` with existing escalation summaries and returns a structured decision. The LLM call should be mocked in tests, but the prompt template must be part of your code.

### Tool Response Design

The tool's return value tells the AI agent what happened. The current tool only returns `{ status: 'escalated' }` or `{ status: 'failed' }`, which gives the agent no context about the escalation state. Design richer responses so the agent can communicate meaningfully with the guest. Think about what the agent needs to know to say things like:

- "Our team is already looking into this for you"
- "I've updated our team with the new details you've provided"
- "This issue came up before — I've flagged it as recurring with higher priority"

---

## Evaluation Criteria

### What We're Looking For

| Criteria | Weight | What We Assess |
|----------|--------|----------------|
| **Decision-making** | High | How you handle each scenario, edge cases you identify, trade-offs you consider |
| **Test quality** | High | Tests that verify behavior (not mocks), cover edge cases, follow existing patterns |
| **Prompt engineering** | High | Clear, structured prompts that produce reliable similarity decisions |
| **Code quality** | Medium | Follows existing patterns, clean TypeScript, good error handling |
| **Documentation** | Medium | Clear README explaining your approach and decisions |

### What We're NOT Looking For

- Over-engineering (keep it pragmatic)
- A running backend (everything is mocked in tests)
- Perfect prompts (we want to see your thinking process)
- Changes to files marked "read-only" above

---

## Constraints

- **Language:** TypeScript (follow existing code style)
- **Testing framework:** Jest (follow patterns in existing spec file)
- **Tool pattern:** LangChain `DynamicStructuredTool` (don't change the tool's external interface)
- **Error handling:** Tools return structured errors, never throw (see existing pattern)
- **HTTP client:** Use the injected `HttpService` (NestJS/Axios wrapper with RxJS observables)
- **Mocking pattern:** Use `of()` from RxJS for successful responses, `throwError()` for failures

---

## Deliverables

We expect the following from you:

1. **Enhanced `ContactStaffTool.ts`** — the tool must become escalation-aware, querying existing escalations and making intelligent decisions about how to handle each request.
2. **Unit tests** in `ContactStaffTool.spec.ts` — comprehensive tests covering all scenarios you've identified. All existing tests must continue to pass. `yarn test` must be green.
3. **A `README.md` file** explaining:
   - Your approach and reasoning
   - The scenarios you identified and how you handle each (fill in the decision table)
   - Any trade-offs or assumptions you made
   - How to run the tests
4. **Any new DTOs or interfaces** you need (place them in `src/Dto/`)
5. Share the work as a **GitHub repository** (private, share access with the team)

---

## Time Expectation

This is designed to take approximately **3-4 hours**. Focus on making good decisions and writing clean tests rather than building a perfect solution. We value your reasoning process over completeness.

---

## Mocking Reference

The existing tests only mock `httpService.post`. Your solution will need **additional HTTP calls** (e.g., fetching existing escalations, updating) and potentially **LLM calls**. Here are patterns to help you set those up correctly.

### Mocking multiple HTTP methods

The current setup only registers `post`. If you need `get`, `put`, `patch` (or other methods), add them to the mock:

```typescript
beforeEach(() => {
  httpService = {
    post: jest.fn(),
    get: jest.fn(),     // add methods you need
    put: jest.fn(),
    patch: jest.fn(),
  } as unknown as HttpService;
});
```

### Mocking the GET escalations endpoint

The `HttpService` wraps Axios with RxJS. Responses are always wrapped in `of()`:

```typescript
// Backend returns existing escalations for a chat
(httpService.get as jest.Mock).mockReturnValue(
  of({
    data: {
      escalations: [
        {
          id: 'esc-001',
          guestRequest: 'No hot water in room 302',
          conciergeSummary: '1. Check boiler. 2. Offer room change.',
          status: 'open',
          priority: '2',
          createdAt: '2026-02-28T10:00:00Z',
        },
      ],
    },
  }),
);
```

### Mocking an empty response (no existing escalations)

```typescript
(httpService.get as jest.Mock).mockReturnValue(
  of({ data: { escalations: [] } }),
);
```

### Mocking failures

```typescript
import { throwError } from 'rxjs';

(httpService.get as jest.Mock).mockReturnValue(
  throwError(() => new Error('Network error')),
);
```

### Coordinating multiple calls in one test

When the tool makes a GET (check existing) then conditionally a POST (create new), you mock both:

```typescript
it('creates a new escalation when no existing ones match', async () => {
  // 1. GET: no existing escalations
  (httpService.get as jest.Mock).mockReturnValue(
    of({ data: { escalations: [] } }),
  );

  // 2. POST: create escalation succeeds
  (httpService.post as jest.Mock).mockReturnValue(
    of({ data: { incident: { id: 'inc-123' } } }),
  );

  const request = buildRequest();
  const dynamicTool = tool.build(request);

  const result = await dynamicTool.func({
    query: 'The pool is closed unexpectedly',
    context: '1. Check pool maintenance schedule.',
    priority: '3',
  });

  // Verify the GET was called with correct params
  expect(httpService.get).toHaveBeenCalledWith(
    expect.stringContaining('/api/ai/'),
    expect.any(Object),
  );

  // Verify the POST was still called (new escalation created)
  expect(httpService.post).toHaveBeenCalled();

  expect(JSON.parse(result)).toEqual(
    expect.objectContaining({ status: 'escalated' }),
  );
});
```

---

## Tips

- Read the existing test file carefully — it shows exactly how to mock HTTP calls, build requests, and assert results
- The `unit-test.helpers.ts` file has useful factories (`buildAskQuestionDto`, `createMockHttpService`, `setupTestEnv`)
- Study `admin-request-options.ts` to understand how backend requests are configured
- Tools must return `JSON.stringify(...)` — they communicate with the AI agent via JSON strings
- Look at how `ConversationDto` includes an `escalation` field — this exists in the chat history

---

## Questions?

If anything is unclear, document your assumptions in the README and proceed. We want to see how you handle ambiguity.

---

## Candidate Solution Notes

## Change Log

### 2026-03-02

- Implemented escalation-aware decision flow in `ContactStaffTool`:
  - fetch existing escalations before acting
  - similarity-based match routing
  - open match: `skipped` vs `updated`
  - resolved match: recurring `reopened` escalation with priority elevation
- Added one-shot similarity retry when checker returns a `matchedEscalationId` not present in fetched escalations.
- Expanded tool response semantics (`escalated`, `updated`, `skipped`, `reopened`, `failed`) for clearer agent messaging.
- Added and updated unit tests to cover decision branches and failure paths.
- Added prompt/data formatting alignment so similarity comparison includes escalation summary context.
- Documented scenario decisions, trade-offs, and similarity behavior in the README.

### Decision Table (Implemented)

| Scenario | Behavior |
|----------|----------|
| No existing escalations | Create a new escalation (`status: "escalated"`). |
| Existing **open** escalation about the **same issue** | If no meaningful new details and no priority increase, skip duplicate update (`status: "skipped"`). Otherwise update the existing escalation (`status: "updated"`). |
| Existing **resolved** escalation about the **same issue** | Treat as recurring issue, create a new escalation, and elevate priority by one level when possible (`status: "reopened"`). |
| Existing escalation about a **different issue** | Create a new escalation (`status: "escalated"`). |
| Guest adds new details to an already-escalated issue | Update the existing open escalation and append new context (`status: "updated"`). |
| Priority of the new request is higher than existing escalation | Update matched open escalation priority and return `priorityUpgraded: true`. |
| Fetch-existing-escalations API call fails | Graceful degradation: log error and create a new escalation. |
| Similarity returns an ID not present in fetched escalations | Retry similarity once with an invalid-ID hint; if still invalid, fall back to creating a new escalation. |

### Similarity Detection

- A similarity prompt template is defined in code (`SIMILARITY_PROMPT_TEMPLATE`).
- The prompt compares the new guest query against existing escalation issue + summary context.
- Similarity evaluation is invoked through the `SimilarityChecker` interface.
- If similarity returns a non-existent escalation ID, the tool performs one retry with `invalidMatchedEscalationId` to reduce bad-ID matches.
- In unit tests, similarity is mocked to keep tests deterministic and avoid real LLM calls.

### Tool Response Design

The tool now returns richer outcomes for the agent:

- `escalated`: a new escalation was created
- `updated`: an existing escalation was updated
- `skipped`: duplicate follow-up with no new actionable info
- `reopened`: recurring issue after a resolved escalation
- `failed`: escalation service unavailable after retries

### Assumptions / Trade-offs

- Duplicate follow-ups should not spam staff; skip is preferred when no new detail is provided.
- Recurring issues should be surfaced with higher urgency to reduce repeat guest impact.
- If fetch/update fails, favor continuity for guest support over strict deduplication.
- Similarity retry is intentionally capped at one attempt to avoid loops and keep latency predictable.
