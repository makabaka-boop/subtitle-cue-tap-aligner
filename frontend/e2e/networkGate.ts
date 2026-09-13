import type { Page } from "@playwright/test";

export interface MatchGate {
  // Deliver the frozen response to the page.
  release: () => void;
}

export interface ParseGate {
  // Deliver the frozen (real) server response to the page.
  release: () => void;
  // Abort the request instead, so the page sees a network-level failure.
  fail: () => void;
}

/**
 * Freeze the browser-side delivery of the next POST /api/match whose body
 * matches `predicate`. The request still reaches the real server immediately
 * (via `route.fetch`); only its response is held back until `release()`, so the
 * page races a genuinely in-flight server answer rather than a fabricated mock.
 *
 * Every other /api/match call passes through untouched, and after the held call
 * has been taken the route becomes a pass-through for the rest of the test.
 */
export async function holdNextMatchResponse(
  page: Page,
  predicate: (body: { anchors?: unknown }) => boolean,
): Promise<MatchGate> {
  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  let armed = true;
  await page.route("**/api/match", async (route) => {
    const request = route.request();
    let body: { anchors?: unknown } = {};
    try {
      body = (request.postDataJSON() as { anchors?: unknown }) ?? {};
    } catch {
      body = {};
    }
    if (request.method() !== "POST" || !armed || !predicate(body)) {
      return route.continue();
    }
    armed = false;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  return {
    release: () => resolveGate(),
  };
}

/**
 * Freeze the browser-side delivery of every POST /api/parse response from now
 * on. Each request still reaches the real server immediately (via
 * `route.fetch`); only its response is held back. `next()` hands out the gate
 * for the next held response in request order, so the test can release or fail
 * overlapping imports in any order — including an order opposite to how they
 * were submitted.
 */
export async function holdParseResponses(
  page: Page,
): Promise<{ next: () => Promise<ParseGate> }> {
  const ready: ParseGate[] = [];
  const waiters: ((gate: ParseGate) => void)[] = [];
  await page.route("**/api/parse", async (route) => {
    if (route.request().method() !== "POST") {
      return route.continue();
    }
    let decide: (action: "release" | "fail") => void = () => {};
    const decision = new Promise<"release" | "fail">((resolve) => {
      decide = resolve;
    });
    const gate: ParseGate = {
      release: () => decide("release"),
      fail: () => decide("fail"),
    };
    const waiter = waiters.shift();
    if (waiter) {
      waiter(gate);
    } else {
      ready.push(gate);
    }
    const response = await route.fetch();
    if ((await decision) === "fail") {
      return route.abort();
    }
    await route.fulfill({ response });
  });
  return {
    next: () =>
      new Promise<ParseGate>((resolve) => {
        const gate = ready.shift();
        if (gate) {
          resolve(gate);
        } else {
          waiters.push(resolve);
        }
      }),
  };
}
