import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Deterministic monotonic clock: performance.now stays "sticky" at the
  // last handed-out value until the test arms a fresh one; React's internal
  // polling therefore cannot consume the value meant for the next tap.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __tapQueue: number[];
      __wantFresh: boolean;
    };
    w.__tapQueue = [];
    w.__wantFresh = false;
    let current = 0;
    performance.now = () => {
      if (w.__wantFresh && w.__tapQueue.length > 0) {
        current = w.__tapQueue.shift() as number;
        w.__wantFresh = false;
      }
      return current;
    };
  });
  await page.goto("/");
});

async function importCues(page: import("@playwright/test").Page, text: string) {
  await page.getByTestId("schedule-input").fill(text);
  await page.getByTestId("import-button").click();
  await expect(page.getByTestId("schedule-table")).toBeVisible();
}

// Record a run with exact tap times relative to the first hit (the first tap
// is always 0 ms by design), then stop — submission is left to the test so it
// can review and flag mistaps first.
async function driveTaps(
  page: import("@playwright/test").Page,
  recorded: number[],
) {
  await page.getByTestId("start-button").click();
  for (const value of recorded) {
    await page.evaluate((target) => {
      const w = window as unknown as {
        __tapQueue: number[];
        __wantFresh: boolean;
      };
      w.__tapQueue.push(target);
      w.__wantFresh = true;
    }, value);
    await page.getByTestId("tap-button").dispatchEvent("pointerdown");
  }
  await page.getByTestId("stop-button").click();
}

test("ignoring a mistap lets the real taps pair by the 800 ms rule without reshuffling seq numbers, and restoring re-includes it", async ({
  page,
}) => {
  await importCues(page, "开场|0\n谢幕|1000");
  // One mistap at 700 ms: it steals 谢幕 (300 ms away) from the real hit at
  // 1000 ms, which is then left with nothing.
  await driveTaps(page, [0, 700, 1000]);

  // The run is over: every tap is listed in acquisition order with its
  // original time and sequence number, plus an ignore toggle.
  const items = page.getByTestId("tap-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(1)).toContainText("第 2 击");
  await expect(items.nth(1)).toContainText("700 ms");
  await expect(page.getByTestId("tap-ignore-toggle")).toHaveCount(3);

  // Raw submit: the mistap pairs 谢幕, the real 1000 ms hit is unmatched.
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "-300 ms",
  ]);
  await expect(page.getByTestId("unpaired-taps")).toContainText("第 3 击");
  await expect(page.getByTestId("ignored-taps")).toHaveCount(0);

  // Flag the mistap as ignored and submit again.
  await items.nth(1).getByTestId("tap-ignore-toggle").click();
  await expect(items.nth(1).getByTestId("ignored-badge")).toHaveText("已忽略");
  await expect(
    items.nth(1).getByTestId("tap-ignore-toggle"),
  ).toHaveText("恢复参与");
  // Original time and sequence number stay on screen for cross-checking.
  await expect(items.nth(1)).toContainText("第 2 击");
  await expect(items.nth(1)).toContainText("700 ms");

  await page.getByTestId("submit-button").click();

  // The real taps pair exactly by the rule; sequence numbers are not
  // reshuffled (第 1 击 / 第 3 击, not renumbered).
  const rows = page.getByTestId("pair-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("第 1 击");
  await expect(rows.nth(1)).toContainText("第 3 击");
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "+0 ms",
  ]);
  // The result distinguishes ignored taps from unmatched ones.
  await expect(page.getByTestId("unpaired-taps")).toContainText("无");
  const ignored = page.getByTestId("ignored-taps");
  await expect(ignored).toContainText("第 2 击");
  await expect(ignored).toContainText("700 ms");

  // Restoring the mistap makes it participate again on the next submit.
  await items.nth(1).getByTestId("tap-ignore-toggle").click();
  await expect(page.getByTestId("ignored-badge")).toHaveCount(0);
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "-300 ms",
  ]);
  await expect(page.getByTestId("unpaired-taps")).toContainText("第 3 击");
  await expect(page.getByTestId("ignored-taps")).toHaveCount(0);
});

test("a rejected ignore request keeps the selection and the current result", async ({
  page,
}) => {
  await importCues(page, "开场|0\n谢幕|1000");
  await driveTaps(page, [0, 1000]);
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("pair-row")).toHaveCount(2);

  await page
    .getByTestId("tap-item")
    .nth(0)
    .getByTestId("tap-ignore-toggle")
    .click();

  // Force the server to reject the next ignore-carrying submit, as it would
  // for duplicated or out-of-range indices.
  let armed = true;
  await page.route("**/api/match", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !armed) {
      return route.continue();
    }
    const body = request.postDataJSON() as {
      ignored_tap_indices?: number[];
    };
    if (!body.ignored_tap_indices) {
      return route.continue();
    }
    armed = false;
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        detail: {
          code: "IGNORED_TAP_INDEX_OUT_OF_RANGE",
          message: "忽略下标超出本场敲击范围，未进行配对",
        },
      }),
    });
  });

  await page.getByTestId("submit-button").click();

  // The Chinese reason is shown; the existing result and the operator's
  // selection are both kept exactly as they were.
  const error = page.getByTestId("remote-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("忽略下标超出本场敲击范围");
  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "+0 ms",
  ]);
  await expect(page.getByTestId("ignored-taps")).toHaveCount(0);
  const firstItem = page.getByTestId("tap-item").nth(0);
  await expect(firstItem.getByTestId("ignored-badge")).toHaveText("已忽略");
  await expect(firstItem.getByTestId("tap-ignore-toggle")).toHaveText(
    "恢复参与",
  );

  // The operator can adjust and submit again; the retried request succeeds.
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("remote-error")).toHaveCount(0);
  await expect(page.getByTestId("pair-row")).toHaveCount(1);
  await expect(page.getByTestId("pair-row").first()).toContainText("第 2 击");
  const ignored = page.getByTestId("ignored-taps");
  await expect(ignored).toContainText("第 1 击");
  await expect(page.getByTestId("unpaired-taps")).toContainText("无");
});

test("anchor recalibration carries the same ignored indices", async ({
  page,
}) => {
  await importCues(page, "一|0\n二|1000\n三|2000");
  // Mistap at 700 ms; the real run carries a stable +250 ms offset.
  await driveTaps(page, [0, 700, 1000, 2250]);
  await page
    .getByTestId("tap-item")
    .nth(1)
    .getByTestId("tap-ignore-toggle")
    .click();
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "+0 ms",
    "+250 ms",
  ]);

  const matchBodies: {
    anchors?: { cue_index: number; tap_index: number }[];
    ignored_tap_indices?: number[];
  }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/match") && request.method() === "POST") {
      matchBodies.push(
        request.postDataJSON() as (typeof matchBodies)[number],
      );
    }
  });

  // Anchor on the third row (raw deviation +250).
  await page.getByTestId("set-anchor-button").nth(2).click();
  await expect(page.getByTestId("calibration-note")).toContainText(
    "全场校准量 +250 ms",
  );
  await expect(page.getByTestId("pair-calibrated-deviation")).toHaveText([
    "-250 ms",
    "-250 ms",
    "+0 ms",
  ]);

  // The recalibration request carried the very same ignored indices, and the
  // calibrated result still keeps the mistap out of the pairing.
  const anchorRequest = matchBodies.find((body) => body.anchors);
  expect(anchorRequest).toBeDefined();
  expect(anchorRequest?.anchors).toEqual([{ cue_index: 2, tap_index: 3 }]);
  expect(anchorRequest?.ignored_tap_indices).toEqual([1]);
  await expect(page.getByTestId("ignored-taps")).toContainText("第 2 击");
  await expect(page.getByTestId("unpaired-taps")).toContainText("无");
  await expect(page.getByTestId("pair-row")).toHaveCount(3);
});
