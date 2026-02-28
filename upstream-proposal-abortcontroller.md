# Upstream Proposal: Accept AbortSignal in prompt() and compact()

---

## A) Proposal summary

Add `signal?: AbortSignal` to `PromptOptions` and `CompactOptions` so callers can pass their own `AbortSignal` to `prompt()` and `compact()`. Wire the external signal to the existing internal `AbortController`. This enables composable cancellation patterns like `Promise.race([session.prompt(text), timeout])` without requiring callers to use the fire-and-forget `abort()` method.

---

## B) Current behavior and limitation

### Current behavior:
- `AgentSession.abort()` exists and works — it triggers an internal `AbortController` that:
  - Cancels the LLM stream (signal passed to provider SDKs)
  - Terminates running tools (bash kills process tree, file ops check `signal.aborted`)
- `prompt()` and `compact()` do NOT accept an external `AbortSignal`

### Limitation:
- Callers cannot compose cancellation with `Promise.race()` patterns
- Must call `abort()` as a side effect (fire-and-forget, not composable)
- No way to associate a cancellation with a specific call

### Current workaround:
```typescript
// What you have to do now:
const timeout = setTimeout(() => session.abort(), 30_000);
await session.prompt("Hello");
clearTimeout(timeout);

// What you WANT to do:
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);
await session.prompt("Hello", { signal: controller.signal });
```

---

## C) Requested change

### Primary change:
1. Add `signal?: AbortSignal` to `PromptOptions`
2. Add `signal?: AbortSignal` to `CompactOptions`
3. Wire external signal to internal `AbortController`:
   - If external signal is already aborted, reject immediately
   - If external signal fires, call internal `abortController.abort()`

### Implementation sketch:
```typescript
// In prompt() implementation:
if (options?.signal?.aborted) {
  throw new Error("Request was aborted");
}
options?.signal?.addEventListener("abort", () => {
  this.abortController?.abort();
});
```

---

## D) Why this matters

### Developer impact:
- Enables idiomatic `Promise.race()` cancellation patterns
- Composes with `AbortController.timeout()`, fetch, and other Web APIs
- No behavioral change — just API ergonomics

### No safety/reliability impact:
- The abort mechanism already works; this just exposes it

---

## E) Proposed API shape

```typescript
export interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  signal?: AbortSignal;  // NEW
}

export interface CompactOptions {
  customInstructions?: string;
  replaceInstructions?: boolean;
  signal?: AbortSignal;  // NEW
}
```

### Usage:
```typescript
// Composable timeout
await session.prompt("Hello", {
  signal: AbortSignal.timeout(30_000)
});

// With AbortController
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
try {
  await session.prompt("Hello", { signal: controller.signal });
} finally {
  clearTimeout(timeout);
}

// Promise.race pattern
await Promise.race([
  session.prompt("Hello", { signal: controller.signal }),
  someOtherPromise,
]);
```

---

## F) Compatibility and migration

### Backwards compatibility:
- **100% compatible** — `signal` is optional
- No changes to existing behavior

### Migration:
- None required — existing code works unchanged

---

## G) Alternatives considered

### Alternative: Keep using `abort()` directly
- Works but not composable
- Can't use with `Promise.race()` or `AbortSignal.timeout()`
- Fire-and-forget pattern is error-prone (forgot to clear timeout?)

### Why proposed approach is preferred:
- Standard web platform pattern
- Composable with existing AbortController ecosystem
- Trivial implementation (just wire signal to internal controller)

---

## H) Acceptance criteria

- [ ] `prompt(text, { signal })` rejects immediately if signal already aborted
- [ ] `prompt(text, { signal })` aborts internal controller when signal fires
- [ ] `compact({ signal })` same behavior
- [ ] Aborted calls reject with appropriate error
- [ ] Existing code without `signal` unchanged

---

## I) Implementation sketch (maintainer-oriented)

```typescript
// agent-session.ts - in prompt() implementation
async prompt(text: string, options?: PromptOptions): Promise<void> {
  // Wire external signal to internal abort controller
  if (options?.signal) {
    if (options.signal.aborted) {
      throw new DOMException("Request was aborted", "AbortError");
    }
    options.signal.addEventListener("abort", () => {
      this.abortController?.abort();
    }, { once: true });
  }

  // ... rest of existing implementation
}

// Same pattern for compact()
```

---

## J) Copy-paste issue body

### What do you want to change?

Add `signal?: AbortSignal` to `PromptOptions` and `CompactOptions` so callers can pass their own abort signal to `prompt()` and `compact()`.

### Why?

The internal abort mechanism already works (cancels LLM stream, kills tools), but callers can't pass their own signal. This prevents composable patterns like `Promise.race([prompt(), timeout])` or using `AbortSignal.timeout()`.

Currently you have to:
```typescript
setTimeout(() => session.abort(), 30_000);
await session.prompt("Hello");
```

What you want:
```typescript
await session.prompt("Hello", { signal: AbortSignal.timeout(30_000) });
```

### How?

Wire external signal to internal `AbortController` — just a few lines:

```typescript
if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
options?.signal?.addEventListener("abort", () => this.abortController?.abort());
```

100% backwards compatible — `signal` is optional.

---

## DISCORD MESSAGE (informal)

Quick API request: can we add `signal?: AbortSignal` to `PromptOptions`?

The abort plumbing is already there and works great — just want to pass my own signal so I can use `AbortSignal.timeout()` and `Promise.race()` patterns instead of calling `abort()` as a side effect.

Trivial change, 100% backwards compatible. Happy to PR if useful!
