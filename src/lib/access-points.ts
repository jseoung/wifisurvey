/**
 * access-points.ts - access point markers on the floor plan (issue #154):
 * where a router or mesh node is, with a name, an optional note and,
 * optionally, what it broadcasts (SSID, BSSIDs, bands, channels). The
 * BSSIDs tie measurements to the marker (ap-association.ts); the marker's
 * position never feeds a signal heat map. No Zod here, so the browser can
 * use it (the schemas are in schema.ts).
 */
import { isValidApPattern } from "./apName";
import { normalizeMacAddress } from "./utils";
import type { AccessPoint } from "./types";

/** Longest name, in characters, after trimming. */
export const ACCESS_POINT_NAME_MAX = 60;
/** Longest note, in characters, after trimming. */
export const ACCESS_POINT_NOTE_MAX = 500;
/** Longest "manufacturer and model", in characters, after trimming. */
export const ACCESS_POINT_MODEL_MAX = 80;
/** Longest SSID, in characters (802.11 allows 32 bytes; leave room for UTF-8). */
export const ACCESS_POINT_SSID_MAX = 64;
/** Most BSSIDs (or BSSID prefixes) one marker can list. */
export const ACCESS_POINT_BSSIDS_MAX = 32;
/** Most channels one marker can list. */
export const ACCESS_POINT_CHANNELS_MAX = 16;
/** Most markers one survey can have. */
export const ACCESS_POINTS_MAX = 100;
/** The Wi-Fi bands a marker can list, in GHz. */
export const AP_BANDS = [2.4, 5, 6] as const;
/** Highest Wi-Fi channel number (6 GHz goes to 233). */
export const CHANNEL_MAX = 233;

/** A note as it is stored: trimmed, at most ACCESS_POINT_NOTE_MAX, or none. */
export function cleanAccessPointNote(value: string): string | undefined {
  const note = value.trim().slice(0, ACCESS_POINT_NOTE_MAX).trim();
  return note === "" ? undefined : note;
}

/** Optional short text as it is stored: trimmed and cut to `max`, or none. */
export function cleanOptionalText(
  value: string,
  max: number,
): string | undefined {
  const text = value.trim().slice(0, max).trim();
  return text === "" ? undefined : text;
}

/**
 * BSSIDs as stored: normalized (lowercase, no separators), valid ones only
 * (a full MAC address or a prefix ending in "*"), no duplicates.
 */
export function cleanBssidList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!isValidApPattern(value)) continue;
    const bssid = normalizeMacAddress(value.trim());
    if (!out.includes(bssid)) out.push(bssid);
  }
  return out.slice(0, ACCESS_POINT_BSSIDS_MAX);
}

/** Bands as stored: known ones only, in order, no duplicates. */
export function cleanBandList(values: readonly number[]): number[] {
  return AP_BANDS.filter((band) => values.includes(band));
}

/** Channels as stored: whole numbers 1..CHANNEL_MAX, sorted, no duplicates. */
export function cleanChannelList(values: readonly number[]): number[] {
  return [
    ...new Set(
      values.filter((c) => Number.isInteger(c) && c >= 1 && c <= CHANNEL_MAX),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, ACCESS_POINT_CHANNELS_MAX);
}

/**
 * Split what someone typed in a list field ("6, 44 149" or one BSSID per
 * line) into its entries.
 */
export function splitListInput(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Leave the optional fields out when they are empty, so a marker without
 * them is stored exactly as before they existed.
 */
export function compactAccessPoint(ap: AccessPoint): AccessPoint {
  const out: AccessPoint = { id: ap.id, x: ap.x, y: ap.y, name: ap.name };
  if (ap.note) out.note = ap.note;
  if (ap.model) out.model = ap.model;
  if (ap.ssid) out.ssid = ap.ssid;
  if (ap.bssids?.length) out.bssids = ap.bssids;
  if (ap.bands?.length) out.bands = ap.bands;
  if (ap.channels?.length) out.channels = ap.channels;
  return out;
}

/** What to call a marker: its name, or "Access point" if it has none. */
export function accessPointName(ap: Pick<AccessPoint, "name">): string {
  return ap.name.trim() || "Access point";
}

/**
 * A new marker at (x, y): the first free "AP_N" id, named "Access point"
 * with a number when there are others already.
 */
export function newAccessPoint(
  existing: readonly AccessPoint[],
  x: number,
  y: number,
): AccessPoint {
  const used = new Set(existing.map((ap) => ap.id));
  let n = 1;
  while (used.has(`AP_${n}`)) n++;
  return {
    id: `AP_${n}`,
    x: Math.round(x),
    y: Math.round(y),
    name: existing.length === 0 ? "Access point" : `Access point ${n}`,
  };
}

/* ---------- drawing ---------- */

/**
 * Lucide's "router" icon (ISC licence, as in lucide-react), on its 24 x 24
 * grid, so canvas markers match the icon the app shows in buttons.
 */
/** An access point's colour as its light ring: bright, like a status LED. */
export const apLedColor = (hue: number | undefined) =>
  hue === undefined ? "hsl(205 90% 52%)" : `hsl(${hue} 85% 45%)`;

/**
 * Draw one access point marker centred on (x, y), `size` across: a white
 * ceiling-mount disc with a soft grey edge and a light ring, the way a
 * ceiling access point such as a UniFi U6 Pro looks from below. The ring
 * takes the access point's colour (the same one as its association
 * region); without a `hue` it is status blue. Its name goes below when
 * `label` is given. Larger than a measurement dot and white with a grey
 * edge, so it never reads as one.
 */
export function drawAccessPointMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  {
    label,
    font,
    selected = false,
    hue,
  }: { label?: string; font?: number; selected?: boolean; hue?: number } = {},
) {
  const half = size / 2;
  ctx.save();

  if (selected) {
    ctx.beginPath();
    ctx.arc(x, y, half * 1.35, 0, Math.PI * 2);
    ctx.lineWidth = size * 0.12;
    ctx.strokeStyle = "hsl(252 56% 57%)";
    ctx.stroke();
  }

  // the disc, lifted off the plan by a soft shadow
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = size * 0.18;
  ctx.shadowOffsetY = size * 0.05;
  const body = ctx.createRadialGradient(
    x - half * 0.25,
    y - half * 0.3,
    half * 0.1,
    x,
    y,
    half,
  );
  body.addColorStop(0, "#ffffff");
  body.addColorStop(0.75, "#f4f5f7");
  body.addColorStop(1, "#dfe2e6");
  ctx.beginPath();
  ctx.arc(x, y, half, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, half, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, size * 0.045);
  ctx.strokeStyle = "#9aa1ab";
  ctx.stroke();

  // the slightly raised centre
  ctx.beginPath();
  ctx.arc(x, y, half * 0.68, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(0.75, size * 0.025);
  ctx.strokeStyle = "rgba(20, 24, 31, 0.12)";
  ctx.stroke();

  // the light ring, glowing in the access point's colour
  const led = apLedColor(hue);
  ctx.save();
  ctx.shadowColor = led;
  ctx.shadowBlur = size * 0.12;
  ctx.beginPath();
  ctx.arc(x, y, half * 0.34, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, size * 0.085);
  ctx.strokeStyle = led;
  ctx.stroke();
  ctx.restore();

  // the logo spot in the middle
  ctx.beginPath();
  ctx.arc(x, y, half * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = "#c9cdd3";
  ctx.fill();

  // name
  if (label && font) {
    const pad = font * 0.3;
    ctx.font = `600 ${font}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const w = ctx.measureText(label).width + pad * 2;
    const h = font * 1.25 + pad * 2;
    const top = y + half + size * 0.25;
    ctx.fillStyle = "rgba(20, 24, 31, 0.85)";
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, h, pad);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, x, top + pad);
  }

  ctx.restore();
}
