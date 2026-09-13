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

// Drive a run with exact tap times relative to the first hit (the first tap
// is always 0 ms by design). Each pointerdown is dispatched synchronously
// right after arming the next clock value, so no unrelated caller can read
// it first.
async function driveRun(
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
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("pairs-table")).toBeVisible();
}

test("setting an anchor calibrates the whole run and shows offset + recalibrated times", async ({
  page,
}) => {
  await importCues(page, "开场|0\n主角登场|1200\n第一段唱|2400\n谢幕|4000");
  // The first tap is pinned to 0; a stable +250 ms start offset then shows
  // up on every later cue, with a little jitter: raw deviations
  // [0, +250, +280, +240].
  await driveRun(page, [0, 1450, 2680, 4240]);

  const rows = page.getByTestId("pair-row");
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "+250 ms",
    "+280 ms",
    "+240 ms",
  ]);

  // Anchor on the second raw pair (主角登场), whose raw deviation is +250.
  const buttons = page.getByTestId("set-anchor-button");
  await expect(buttons).toHaveCount(4);
  await buttons.nth(1).click();

  // Calibration quantity is displayed.
  await expect(page.getByTestId("calibration-note")).toContainText(
    "全场校准量 +250 ms",
  );

  // Anchor row has zero calibrated deviation; other rows are re-paired by
  // the existing rule (the first row now shows the absorbed -250 ms).
  await expect(page.getByTestId("pair-calibrated-deviation")).toHaveText([
    "-250 ms",
    "+0 ms",
    "+30 ms",
    "-10 ms",
  ]);
  await expect(page.getByTestId("pair-calibrated-time")).toHaveText([
    "-250 ms",
    "1200 ms",
    "2430 ms",
    "3990 ms",
  ]);

  // Raw columns are preserved verbatim.
  await expect(page.getByTestId("pair-deviation")).toHaveText([
    "+0 ms",
    "+250 ms",
    "+280 ms",
    "+240 ms",
  ]);

  // The anchor row is locked and can no longer be chosen again.
  await expect(page.getByTestId("anchor-badge")).toHaveText(
    "校准锚点（锁定）",
  );
  await expect(page.getByTestId("set-anchor-button")).toHaveCount(0);
});

test("calibration can pair a tap that was out of the 800 ms window originally", async ({
  page,
}) => {
  await importCues(page, "开场|0\n主角登场|1200\n谢幕|2000");
  // Taps relative to first hit: 0 (cue 1), 1300 (cue 2, +100), 2900 (900 ms
  // from cue 3, unmatched in the raw pairing).
  await driveRun(page, [0, 1300, 2900]);

  await expect(page.getByTestId("pair-row")).toHaveCount(2);
  await expect(page.getByTestId("unpaired-taps")).toContainText("第 3 击");

  // Anchor on cue 2: offset +100 pulls the third tap to 2800, exactly 800 ms
  // from cue 3, so it is paired by the ordinary rule.
  await page.getByTestId("set-anchor-button").nth(1).click();

  await expect(page.getByTestId("calibration-note")).toContainText(
    "全场校准量 +100 ms",
  );
  await expect(page.getByTestId("pair-row")).toHaveCount(3);
  await expect(page.getByTestId("pair-calibrated-deviation")).toHaveText([
    "-100 ms",
    "+0 ms",
    "+800 ms",
  ]);
  await expect(page.getByTestId("unpaired-taps")).toContainText("无");
});

test("a rejected anchor keeps the current result and explains the reason", async ({
  page,
}) => {
  await importCues(page, "开场|0\n谢幕|9000");
  await driveRun(page, [0, 100]);

  // Only cue 1 is paired (the second tap is 100 ms late and cue 2 is far
  // away). Force the server to reject the anchor request, as it would for an
  // out-of-range, duplicated or non-paired anchor.
  await page.route("**/api/match", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      return route.continue();
    }
    const body = request.postDataJSON() as {
      anchors?: { cue_index: number; tap_index: number }[];
    };
    if (body.anchors) {
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: {
            code: "ANCHOR_NOT_PAIRED",
            message: "锚点不属于原始配对结果，未重新对点",
          },
        }),
      });
    }
    return route.continue();
  });

  await page.getByTestId("set-anchor-button").first().click();

  // The reason is shown at the operation; the existing raw result stays.
  const error = page.getByTestId("anchor-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("锚点不属于原始配对结果");
  await expect(page.getByTestId("pair-row")).toHaveCount(1);
  await expect(page.getByTestId("pair-deviation")).toHaveText("+0 ms");
  await expect(page.getByTestId("calibration-note")).toHaveCount(0);
  await expect(page.getByTestId("pair-calibrated-deviation")).toHaveCount(0);
  // The operation stays available so the operator can pick another row.
  await expect(page.getByTestId("set-anchor-button")).toHaveCount(1);
});
