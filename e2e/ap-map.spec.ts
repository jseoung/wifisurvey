/**
 * The access point map on the Heat maps tab: drawn from the connected
 * BSSID of each measurement, with a summary per access point, and its
 * view (layer, switches, hidden access points) saved with the survey.
 * The mock always reports one BSSID, so there is one access point and no
 * roaming; the roaming logic itself is unit tested (ap-association.test.ts).
 */
import { test, expect } from "./fixtures";
import { uploadFloorplan, gotoTab, readSurvey } from "./helpers";

test("the access point map shows the access point and saves its view", async ({
  page,
}) => {
  const name = await uploadFloorplan(page);
  await gotoTab(page, "floorplan");
  await page.getByTestId("add-sample-points").click();
  await readSurvey(page, name, (s) => s.surveyPoints.length === 24);

  await gotoTab(page, "heatmaps");
  const map = page.getByTestId("ap-map");
  await expect(map.getByTestId("ap-map-image").locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png/,
    { timeout: 30_000 },
  );

  // one access point, named by its BSSID until someone names it
  const rows = map.getByTestId("ap-summary-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("9E-05-D6-96-E8-30");
  await expect(rows.first()).toContainText("24 (100%)");
  await expect(map.getByTestId("ap-roaming-event")).toHaveCount(0);

  // clicking an access point highlights its readings; clicking again stops
  await rows.first().getByTestId("ap-summary-highlight").click();
  await expect(map.getByTestId("ap-map-highlight")).toContainText(
    "24 measurements",
  );
  await expect(rows.first()).toHaveAttribute("data-highlighted", "true");
  await map.getByTestId("ap-map-show-all").click();
  await expect(map.getByTestId("ap-map-highlight")).toHaveCount(0);

  // the view is saved with the survey
  await map.getByTestId("ap-map-layer").selectOption("roaming");
  await map.getByTestId("ap-show-points").click();
  await rows.first().getByRole("checkbox").click();
  const survey = await readSurvey(
    page,
    name,
    (s) => s.apView?.layer === "roaming" && s.apView?.hiddenAps?.length === 1,
  );
  expect(survey.apView).toMatchObject({
    layer: "roaming",
    showPoints: false,
    hiddenAps: ["bssid:9e05d696e830"],
  });

  await page.reload();
  // the app opens the default floor plan; switch back to ours
  await page.getByTestId("floorplan-picker").click();
  await page.getByRole("menuitem", { name }).click();
  await expect(page.getByTestId("ap-map-layer")).toHaveValue("roaming");
  await expect(page.getByTestId("ap-show-points")).toHaveAttribute(
    "data-state",
    "unchecked",
  );
});

test("a measured point can be marked as an access point, and a later one moves it", async ({
  page,
}) => {
  const name = await uploadFloorplan(page);
  await gotoTab(page, "floorplan");
  await page.getByTestId("add-sample-points").click();
  const survey = await readSurvey(
    page,
    name,
    (s) => s.surveyPoints.length === 24,
  );
  const [first, second] = survey.surveyPoints;
  const canvas = page.getByTestId("floorplan-canvas");

  /** Click a point by its floor plan coordinates. */
  const clickPoint = async (p: { x: number; y: number }) => {
    const box = (await canvas.boundingBox())!;
    await canvas.click({
      position: {
        x: (box.width * p.x) / survey.dimensions.width,
        y: (box.height * p.y) / survey.dimensions.height,
      },
    });
  };

  // no marker has this BSSID yet: mark the point as an access point
  await clickPoint(first);
  await page.getByTestId("point-mark-access-point").click();
  await expect(page.getByTestId("access-point-details")).toBeVisible();
  let saved = await readSurvey(page, name, (s) => s.accessPoints?.length === 1);
  expect(saved.accessPoints[0]).toMatchObject({
    x: first.x,
    y: first.y,
    bssids: ["9e05d696e830"],
  });
  await page
    .getByTestId("access-point-details")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.getByTestId("access-point-details")).toHaveCount(0);
  // the next point's BSSID belongs to that marker: it can be moved there
  await clickPoint(second);
  await expect(page.getByTestId("point-show-access-point")).toBeVisible();
  await page.getByTestId("point-move-access-point").click();
  saved = await readSurvey(
    page,
    name,
    (s) =>
      s.accessPoints?.[0]?.x === second.x &&
      s.accessPoints?.[0]?.y === second.y,
  );
  expect(saved.accessPoints).toHaveLength(1);
});
