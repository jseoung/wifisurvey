/**
 * report-images.ts - the maps in the report, drawn in the browser with the
 * access point map's renderer (ap-map-draw.ts): the signal heat map with
 * the access points, where the access points are, which one served the
 * device where, and the roaming events. Every access point is shown,
 * whatever is hidden on the Heat maps tab.
 */
import {
  apPalette,
  detectRoaming,
  inMeasuredOrder,
  summarizeAps,
} from "./ap-association";
import { renderApMap, SIGNAL_SCALE_KEY } from "./ap-map-draw";
import { AP_LAYER_TITLES, defaultApView, type ApLayer } from "./ap-view";
import type { ReportImage, ReportInput } from "./report";
import type { HeatmapSettings, SurveyPoint } from "./types";

const CAPTIONS: Record<ReportImageKey, string> = {
  signal:
    "Signal strength over the floor plan, spread from the measurements, with the access points.",
  locations:
    "The access points, and the measurements coloured by the access point the device was connected to.",
  association:
    "Areas served by each access point, from the BSSID the device was connected to at each measurement.",
  roaming:
    "Where the device changed access point, band or radio, numbered in the order measured, with the route walked.",
};

type ReportImageKey = keyof ReportInput["images"];
const LAYERS: Record<ReportImageKey, ApLayer> = {
  signal: "signal",
  locations: "locations",
  association: "association",
  roaming: "roaming",
};

function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("could not read the image"));
    img.src = src;
  });
}

/** Draw the report's maps; a map that can't be drawn is left out. */
export async function renderReportImages(
  settings: HeatmapSettings,
  points: readonly SurveyPoint[],
  radius: number,
): Promise<ReportInput["images"]> {
  const { accessPoints, apMapping } = settings;
  const palette = apPalette(points, accessPoints, apMapping);
  const events = detectRoaming(points, accessPoints, apMapping);
  const summary = summarizeAps(
    points,
    accessPoints,
    apMapping,
    events,
    palette,
  );
  const view = defaultApView();
  const out: ReportInput["images"] = {};
  for (const key of Object.keys(LAYERS) as ReportImageKey[]) {
    const layer = LAYERS[key];
    const src = await renderApMap({
      layer,
      view: { ...view, layer },
      width: settings.dimensions.width,
      height: settings.dimensions.height,
      floorplanSrc: settings.floorplanImagePath,
      floorplanName: settings.floorplanImageName,
      points,
      ordered: inMeasuredOrder(points),
      accessPoints,
      apMapping,
      palette,
      events,
      summary: summary.aps,
      unknown: summary.unknown,
      radius,
      gradient: settings.gradient,
      minOpacity: settings.minOpacity,
      maxOpacity: settings.maxOpacity,
      signalScale: settings.heatmapRanges?.[SIGNAL_SCALE_KEY],
      focus: null,
    });
    if (!src) continue;
    const size = await imageSize(src).catch(() => null);
    if (!size) continue;
    const image: ReportImage = {
      title: AP_LAYER_TITLES[layer],
      caption: CAPTIONS[key],
      src,
      ...size,
    };
    out[key] = image;
  }
  return out;
}
