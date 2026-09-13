import type { Page } from "@playwright/test";

export interface MatchGate {
  // Deliver the frozen response to the page.
  release: () => void;
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
