import { expect, test } from "@playwright/test";
import { holdNextMatchResponse } from "./networkGate";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

async function importCues(page: import("@playwright/test").Page, text: string) {
  await page.getByTestId("schedule-input").fill(text);
  await page.getByTestId("import-button").click();
  await expect(page.getByTestId("schedule-table")).toBeVisible();
}

test("first tap is 0 ms, pairs show raw times and signed deviation", async ({
  page,
}) => {
  await importCues(page, "开场|0\n主角|400");

  await page.getByTestId("start-button").click();
  await page.getByTestId("tap-button").click(); // first tap -> 0 ms, pairs cue 1

  const taps = page.getByTestId("tap-list").locator("li");
  await expect(taps).toHaveCount(1);
  await expect(taps.first()).toContainText("0 ms");

  await page.getByTestId("stop-button").click();
  await page.getByTestId("submit-button").click();

  const pairRows = page.getByTestId("pairs-table").locator("tbody tr");
  await expect(pairRows).toHaveCount(1);
  await expect(pairRows.first()).toContainText("开场");
  await expect(pairRows.first()).toContainText("0 ms");
  await expect(page.getByTestId("pair-deviation")).toHaveText("+0 ms");

  await expect(page.getByTestId("unpaired-cues")).toContainText("主角");
  await expect(page.getByTestId("unpaired-cues")).toContainText("400 ms");
  await expect(page.getByTestId("unpaired-taps")).toContainText("无");
});

test("a negative signed deviation is displayed for an early tap", async ({
  page,
}) => {
  await importCues(page, "开场|400");

  await page.getByTestId("start-button").click();
  await page.getByTestId("tap-button").click(); // 0 ms vs cue at 400 -> -400
  await page.getByTestId("stop-button").click();
  await page.getByTestId("submit-button").click();

  await expect(page.getByTestId("pair-deviation")).toHaveText("-400 ms");
  await expect(page.getByTestId("unpaired-cues")).toContainText("无");
});

test("leftover taps beyond 800 ms are listed as unpaired", async ({ page }) => {
  await importCues(page, "开场|0\n谢幕|5000");

  await page.getByTestId("start-button").click();
  await page.getByTestId("tap-button").click(); // 0 ms -> cue 1
  await page.getByTestId("tap-button").click(); // ~0 ms, cue 1 used; far from cue 2
  await page.getByTestId("stop-button").click();
  await page.getByTestId("submit-button").click();

  const pairRows = page.getByTestId("pairs-table").locator(
    "tr[data-testid='pair-row']",
  );
  await expect(pairRows).toHaveCount(1);
  await expect(page.getByTestId("unpaired-cues")).toContainText("谢幕");
  const unpairedTaps = page.getByTestId("unpaired-taps");
  await expect(unpairedTaps).toContainText("第 2 击");
});

test("space key records taps during the run", async ({ page }) => {
  await importCues(page, "开场|0");
  await page.getByTestId("start-button").click();

  await page.keyboard.press("Space");
  await page.keyboard.press("Space");

  await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("tap-list").locator("li").first()).toContainText(
    "0 ms",
  );
});

test("space in the schedule input edits text and never records a tap", async ({
  page,
}) => {
  await importCues(page, "开场|0");
  await page.getByTestId("start-button").click();

  // Focus the plan textarea (focus is on the stop button after clicking
  // start), clear the imported draft and type a subtitle containing spaces
  // with the space bar.
  const input = page.getByTestId("schedule-input");
  await input.fill("");
  await input.click();
  await page.keyboard.type("字 幕 A|100");

  await expect(input).toHaveValue("字 幕 A|100");
  await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(0);

  // Global capture still works once focus leaves the text field.
  await page.getByTestId("tap-button").click();
  await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(1);
});

test("a pairing response that arrives after a new run starts is ignored", async ({
  page,
}) => {
  await importCues(page, "旧场字幕|0\n另一条|400");

  // Session 1: record a tap and submit, then hold the server response.
  const firstSubmission = holdNextMatchResponse(page, (body) =>
    Array.isArray(body.anchors) ? body.anchors.length === 0 : true,
  );
  await page.getByTestId("start-button").click();
  await page.getByTestId("tap-button").click(); // 0 ms -> pairs cue 1
  await page.getByTestId("stop-button").click();
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("submit-button")).toContainText("提交中");
  const gate = await firstSubmission;

  // Before the answer returns, start a fresh, empty rehearsal session.
  await page.getByTestId("start-button").click();
  await expect(page.getByTestId("pairs-table")).toHaveCount(0);
  await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(0);

  // Now the previous session's answer lands: it must not repopulate the page.
  gate.release();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("pairs-table")).toHaveCount(0);
  await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(0);
  await expect(page.getByTestId("stop-button")).toBeVisible();

  // The new session still works end to end: tap, stop, submit -> its own
  // result, with no stale rows from session 1.
  await page.getByTestId("tap-button").click();
  await page.getByTestId("stop-button").click();
  await page.getByTestId("submit-button").click();
  const pairRows = page.getByTestId("pairs-table").locator(
    "tr[data-testid='pair-row']",
  );
  await expect(pairRows).toHaveCount(1);
  await expect(pairRows.first()).toContainText("旧场字幕");
});
