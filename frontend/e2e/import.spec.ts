import { expect, test } from "@playwright/test";
import { holdParseResponses } from "./networkGate";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test.describe("schedule import", () => {
  test("valid schedule is imported and rendered", async ({ page }) => {
    await page.getByTestId("schedule-input").fill("开场|0\n主角|3200");
    await page.getByTestId("import-button").click();

    await expect(page.getByTestId("import-note")).toHaveText(/已导入 2 行计划/);
    const rows = page.getByTestId("schedule-table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("开场");
    await expect(rows.first()).toContainText("0");
  });

  test("invalid import is located to lines and does not replace valid data", async ({
    page,
  }) => {
    await page.getByTestId("schedule-input").fill("开场|0\n主角|3200");
    await page.getByTestId("import-button").click();
    await expect(page.getByTestId("import-note")).toBeVisible();

    // Second import attempt: empty subtitle, negative time, non-increasing.
    await page
      .getByTestId("schedule-input")
      .fill("|-5\n没有分隔符\nA|100\nB|90");
    await page.getByTestId("import-button").click();

    const errors = page.getByTestId("import-errors");
    await expect(errors).toContainText("第 1 行");
    await expect(errors).toContainText("字幕文本不得为空");
    await expect(errors).toContainText("时间不得为负");
    await expect(errors).toContainText("第 2 行");
    await expect(errors).toContainText("第 4 行");

    // The previous valid result must still be on screen.
    const rows = page.getByTestId("schedule-table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("主角");
    await expect(page.getByTestId("import-note")).toBeVisible();
  });

  test("start button stays disabled until a valid import exists", async ({
    page,
  }) => {
    await expect(page.getByTestId("start-button")).toBeDisabled();
    await page.getByTestId("schedule-input").fill("开场|abc");
    await page.getByTestId("import-button").click();
    await expect(page.getByTestId("start-button")).toBeDisabled();
  });

  test("re-importing during a running rehearsal is refused, not silently reset", async ({
    page,
  }) => {
    await page.getByTestId("schedule-input").fill("开场|0\n主角|1200");
    await page.getByTestId("import-button").click();
    await expect(page.getByTestId("schedule-table")).toBeVisible();

    await page.getByTestId("start-button").click();
    await page.getByTestId("tap-button").click();
    await page.getByTestId("tap-button").click();
    await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(2);
    await expect(page.getByTestId("stop-button")).toBeVisible();

    // Try to replace the plan with a valid new schedule mid-rehearsal.
    await page.getByTestId("schedule-input").fill("新计划|5\n再一行|90");
    await page.getByTestId("import-button").click();

    // The rejection explains why; the run is still active with both taps and
    // the original schedule untouched.
    const errors = page.getByTestId("import-errors");
    await expect(errors).toBeVisible();
    await expect(errors).toContainText("联排进行中");
    await expect(errors).toContainText("请先结束联排");
    await expect(page.getByTestId("stop-button")).toBeVisible();
    await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(2);
    const rows = page.getByTestId("schedule-table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("开场");
  });

  test("import is refused while the run is active even before the first tap", async ({
    page,
  }) => {
    await page.getByTestId("schedule-input").fill("开场|0\n主角|1200");
    await page.getByTestId("import-button").click();
    await expect(page.getByTestId("schedule-table")).toBeVisible();

    // Start a rehearsal but do not tap anything.
    await page.getByTestId("start-button").click();
    await expect(page.getByTestId("stop-button")).toBeVisible();
    await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(0);

    // A valid new plan must not replace the active session's plan while the
    // page still shows "联排中".
    await page.getByTestId("schedule-input").fill("新计划|5\n再一行|90");
    await page.getByTestId("import-button").click();

    const errors = page.getByTestId("import-errors");
    await expect(errors).toBeVisible();
    await expect(errors).toContainText("联排进行中");
    await expect(errors).toContainText("请先结束联排");
    // The run is still the active session and the original schedule stands.
    await expect(page.getByTestId("stop-button")).toBeVisible();
    const rows = page.getByTestId("schedule-table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("开场");
    await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(0);
  });

  test("adjacent large integers are accepted and rendered exactly", async ({
    page,
  }) => {    // These two adjacent values are indistinguishable to a float; the
    // import must not falsely flag them as duplicate times.
    const first = "9007199254740993";
    const second = "9007199254740994";
    await page
      .getByTestId("schedule-input")
      .fill(`甲|${first}\n乙|${second}`);
    await page.getByTestId("import-button").click();

    await expect(page.getByTestId("import-note")).toHaveText(/已导入 2 行计划/);
    await expect(page.getByTestId("import-errors")).toHaveCount(0);

    const rows = page.getByTestId("schedule-table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(first);
    await expect(rows.nth(1)).toContainText(second);
  });

  test("a late import response does not replace the plan or clear the active run", async ({
    page,
  }) => {
    await page.getByTestId("schedule-input").fill("开场|0\n主角|1200");
    await page.getByTestId("import-button").click();
    await expect(page.getByTestId("schedule-table")).toBeVisible();

    // Submit a new valid plan, then start the rehearsal and tap before the
    // server answer comes back.
    const held = await holdParseResponses(page);
    await page.getByTestId("schedule-input").fill("新计划|5\n再一行|90");
    await page.getByTestId("import-button").click();
    const lateImport = await held.next();

    await page.getByTestId("start-button").click();
    await page.getByTestId("tap-button").click();
    await page.getByTestId("tap-button").click();
    await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(2);

    // The late response lands: the active session must stay exactly as it is.
    lateImport.release();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("stop-button")).toBeVisible();
    await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(2);
    const rows = page.getByTestId("schedule-table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("开场");
    await expect(page.getByTestId("import-note")).toHaveText(/已导入 2 行计划/);
    await expect(page.getByTestId("import-errors")).toHaveCount(0);

    // The first-hit clock was never reset: the next tap extends the same run.
    await page.getByTestId("tap-button").click();
    await expect(page.getByTestId("tap-list").locator("li")).toHaveCount(3);
  });

  test("out-of-order import responses settle on the last submission", async ({
    page,
  }) => {
    const held = await holdParseResponses(page);

    await page
      .getByTestId("schedule-input")
      .fill("旧计划一|0\n旧计划二|100");
    await page.getByTestId("import-button").click();
    const firstSubmission = await held.next();

    await page
      .getByTestId("schedule-input")
      .fill("新计划一|0\n新计划二|100\n新计划三|200");
    await page.getByTestId("import-button").click();
    const secondSubmission = await held.next();

    // The later submission answers first and is applied.
    secondSubmission.release();
    const rows = page.getByTestId("schedule-table").locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("新计划一");
    await expect(page.getByTestId("import-note")).toHaveText(/已导入 3 行计划/);

    // The earlier submission's late answer must not reverse-overwrite it.
    firstSubmission.release();
    await page.waitForTimeout(300);
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("新计划一");
    await expect(rows.nth(2)).toContainText("新计划三");
    await expect(page.getByTestId("import-note")).toHaveText(/已导入 3 行计划/);
  });

  test("a stale import failure is ignored after a newer import succeeded", async ({
    page,
  }) => {
    const held = await holdParseResponses(page);

    await page.getByTestId("schedule-input").fill("旧计划|0");
    await page.getByTestId("import-button").click();
    const failingSubmission = await held.next();

    await page
      .getByTestId("schedule-input")
      .fill("新计划一|0\n新计划二|100");
    await page.getByTestId("import-button").click();
    const successfulSubmission = await held.next();

    // The newer plan imports successfully.
    successfulSubmission.release();
    await expect(page.getByTestId("import-note")).toHaveText(/已导入 2 行计划/);
    const rows = page.getByTestId("schedule-table").locator("tbody tr");
    await expect(rows).toHaveCount(2);

    // The older request then fails late: no error may appear next to the
    // successfully imported plan.
    failingSubmission.fail();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("import-errors")).toHaveCount(0);
    await expect(page.getByTestId("import-note")).toHaveText(/已导入 2 行计划/);
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("新计划一");
  });

  test("a stale import success does not clear the current input's errors", async ({
    page,
  }) => {
    const held = await holdParseResponses(page);

    await page.getByTestId("schedule-input").fill("有效一|0\n有效二|100");
    await page.getByTestId("import-button").click();
    const pendingSubmission = await held.next();

    // While the valid plan is still being checked, replace the draft with an
    // illegal one and submit again: the local rejection is the current state.
    await page.getByTestId("schedule-input").fill("没有分隔符");
    await page.getByTestId("import-button").click();
    const errors = page.getByTestId("import-errors");
    await expect(errors).toBeVisible();
    await expect(errors).toContainText("缺少分隔符");

    // The earlier request's late success must not clear this attempt's
    // validation errors (nor import the superseded plan).
    pendingSubmission.release();
    await page.waitForTimeout(300);
    await expect(errors).toBeVisible();
    await expect(errors).toContainText("缺少分隔符");
    await expect(page.getByTestId("schedule-table")).toHaveCount(0);
    await expect(page.getByTestId("import-note")).toHaveCount(0);
  });
});
