import { expect, test } from "@playwright/test";

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
});
