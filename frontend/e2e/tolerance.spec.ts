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

test("a 900 ms deviation pairs only after widening the tolerance to 1000 ms, the ignored mistap stays out, and the anchor recalculation reuses the tolerance", async ({
  page,
}) => {
  await importCues(page, "开场|0\n谢幕|2000");
  // One mistap at 2600 ms (600 ms from 谢幕, would steal the cue once the
  // window reaches it) and the real hit at 2900 ms (900 ms from 谢幕).
  await driveTaps(page, [0, 2600, 2900]);

  // The tolerance defaults to 800 ms.
  const toleranceInput = page.getByTestId("tolerance-input");
  await expect(toleranceInput).toHaveValue("800");

  // Flag the mistap before submitting.
  await page
    .getByTestId("tap-item")
    .nth(1)
    .getByTestId("tap-ignore-toggle")
    .click();

  const matchBodies: {
    anchors?: { cue_index: number; tap_index: number }[];
    ignored_tap_indices?: number[];
    tolerance_ms?: number;
  }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/match") && request.method() === "POST") {
      matchBodies.push(
        request.postDataJSON() as (typeof matchBodies)[number],
      );
    }
  });

  // Default window: the 900 ms deviation does not pair.
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("tolerance-note")).toContainText(
    "本次配对容差：800 ms",
  );
  await expect(page.getByTestId("pair-row")).toHaveCount(1);
  await expect(page.getByTestId("pair-deviation")).toHaveText(["+0 ms"]);
  await expect(page.getByTestId("unpaired-cues")).toContainText("谢幕");
  await expect(page.getByTestId("unpaired-taps")).toContainText("第 3 击");
  await expect(page.getByTestId("ignored-taps")).toContainText("第 2 击");
  expect(matchBodies.at(-1)?.tolerance_ms).toBe(800);
  expect(matchBodies.at(-1)?.ignored_tap_indices).toEqual([1]);

  // Widen the window to 1000 ms: the real hit pairs 谢幕 at +900 ms, and the
  // ignored mistap still does not participate (it sits only 600 ms away).
  await toleranceInput.fill("1000");
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("tolerance-note")).toContainText(
    "本次配对容差：1000 ms",
  );
  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "+900 ms",
  ]);
  const rows = page.getByTestId("pair-row");
  await expect(rows.nth(1)).toContainText("谢幕");
  await expect(rows.nth(1)).toContainText("第 3 击");
  await expect(page.getByTestId("unpaired-taps")).toContainText("无");
  await expect(page.getByTestId("unpaired-cues")).toContainText("无");
  await expect(page.getByTestId("ignored-taps")).toContainText("第 2 击");
  expect(matchBodies.at(-1)?.tolerance_ms).toBe(1000);

  // Anchor on the 谢幕 row (raw deviation +900): the recalibration carries
  // the same tolerance, so the first hit — calibrated to -900 ms — stays
  // paired instead of falling out of an 800 ms window.
  await page.getByTestId("set-anchor-button").nth(1).click();
  await expect(page.getByTestId("calibration-note")).toContainText(
    "全场校准量 +900 ms",
  );
  await expect(page.getByTestId("tolerance-note")).toContainText(
    "本次配对容差：1000 ms",
  );
  await expect(page.getByTestId("pair-calibrated-deviation")).toHaveText([
    "-900 ms",
    "+0 ms",
  ]);
  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  const anchorRequest = matchBodies.find((body) => body.anchors);
  expect(anchorRequest).toBeDefined();
  expect(anchorRequest?.anchors).toEqual([{ cue_index: 1, tap_index: 2 }]);
  expect(anchorRequest?.tolerance_ms).toBe(1000);
  expect(anchorRequest?.ignored_tap_indices).toEqual([1]);
});

test("a rejected tolerance keeps the input, the ignore selection and the current result", async ({
  page,
}) => {
  await importCues(page, "开场|0\n谢幕|2000");
  await driveTaps(page, [0, 2600, 2900]);
  await page
    .getByTestId("tap-item")
    .nth(1)
    .getByTestId("tap-ignore-toggle")
    .click();
  const toleranceInput = page.getByTestId("tolerance-input");
  await toleranceInput.fill("1000");
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  await expect(page.getByTestId("tolerance-note")).toContainText(
    "本次配对容差：1000 ms",
  );

  // Out of range: the server rejects with a Chinese reason; nothing changes.
  await toleranceInput.fill("3000");
  await page.getByTestId("submit-button").click();
  const error = page.getByTestId("remote-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("配对容差必须在 100 至 2000 毫秒之间");
  await expect(toleranceInput).toHaveValue("3000");
  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "+900 ms",
  ]);
  await expect(page.getByTestId("tolerance-note")).toContainText(
    "本次配对容差：1000 ms",
  );
  await expect(
    page.getByTestId("tap-item").nth(1).getByTestId("ignored-badge"),
  ).toHaveText("已忽略");
  await expect(page.getByTestId("ignored-taps")).toContainText("第 2 击");

  // Not an integer: same contract, same preservation.
  await toleranceInput.fill("abc");
  await page.getByTestId("submit-button").click();
  await expect(error).toContainText("配对容差必须为整数毫秒");
  await expect(toleranceInput).toHaveValue("abc");
  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  await expect(
    page.getByTestId("tap-item").nth(1).getByTestId("ignored-badge"),
  ).toHaveText("已忽略");

  // Corrected value: the submit succeeds again and the error clears.
  await toleranceInput.fill("1200");
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("remote-error")).toHaveCount(0);
  await expect(page.getByTestId("tolerance-note")).toContainText(
    "本次配对容差：1200 ms",
  );
  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  await expect(page.getByTestId("ignored-taps")).toContainText("第 2 击");
});
