/**
 * The Report tab: the details are saved (the survey's with the survey, the
 * company once for the app), the preview shows them, and the Word file
 * downloads. Printing to PDF opens the system dialog, which a test can't
 * drive; it prints the same page as the preview.
 */
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import { uploadFloorplan, gotoTab, readSurvey } from "./helpers";

test("a report is filled in, previewed and downloaded for Word", async ({
  page,
}) => {
  const name = await uploadFloorplan(page);
  await gotoTab(page, "floorplan");
  await page.getByTestId("add-sample-points").click();
  await readSurvey(page, name, (s) => s.surveyPoints.length === 24);

  await gotoTab(page, "report");
  await expect(page.getByTestId("report-tab")).toBeVisible();

  await page.getByTestId("report-company").fill("Example Networks");
  await page.getByTestId("report-company").blur();
  await page.getByTestId("report-client").fill("Acme <Dental>");
  await page.getByTestId("report-site").fill("Head office");
  await page.getByTestId("report-surveyor").fill("J. Tech");
  await page.getByTestId("report-suggest").click();

  // the survey's details are saved with it, the company once for the app
  const survey = await readSurvey(
    page,
    name,
    (s) => s.report?.surveyor === "J. Tech" && s.report?.site === "Head office",
  );
  expect(survey.report.client).toBe("Acme <Dental>");
  await expect
    .poll(async () => (await page.request.get("/api/report-profile")).json())
    .toMatchObject({ companyName: "Example Networks", logo: null });

  // the preview shows what was typed, escaped
  const preview = page.frameLocator('[data-testid="report-preview"]');
  await expect(preview.locator(".cover")).toContainText("Acme <Dental>", {
    timeout: 30_000,
  });
  await expect(preview.locator(".cover")).toContainText("Example Networks");
  await expect(preview.locator("#measurements tbody tr")).toHaveCount(24);
  await expect(preview.locator("#coverage img")).toHaveCount(1);

  // the Word file
  const download = page.waitForEvent("download");
  await page.getByTestId("report-download-docx").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Head_office-wifi-survey-report.docx");
  const bytes = readFileSync((await file.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.length).toBeGreaterThan(10_000);

  // after a reload the details are still there
  await page.reload();
  await page.getByTestId("floorplan-picker").click();
  await page.getByRole("menuitem", { name }).click();
  await gotoTab(page, "report");
  await expect(page.getByTestId("report-client")).toHaveValue("Acme <Dental>");
  await expect(page.getByTestId("report-company")).toHaveValue(
    "Example Networks",
  );
});

test("the report profile refuses a logo that isn't a PNG or JPEG", async ({
  page,
}) => {
  const res = await page.request.put("/api/report-profile", {
    data: { companyName: "X", logo: "data:image/svg+xml;base64,AAAA" },
  });
  expect(res.status()).toBe(400);
});
