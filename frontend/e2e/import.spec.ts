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
});
