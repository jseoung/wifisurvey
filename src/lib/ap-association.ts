/**
 * ap-association.ts - which access point served each measurement, where
 * the device roamed, and the regions each access point served.
 *
 * Everything here is worked out from what was measured: the BSSID the
 * device was connected to at each point (never the strongest one nearby).
 * A point without a usable BSSID (macOS without Location access reports
 * none, or "<redacted>") is counted as unknown and is left out; nothing is
 * guessed for it. Roaming events and regions are derived each time, so
 * naming or reassigning a BSSID later updates them.
 *
 * Pure functions, no DOM: the browser draws the results (ap-map-draw.ts).
 */
import { accessPointName } from "./access-points";
import { AP_HUES, apNameFor, isApPrefix } from "./apName";
import {
  formatMacAddress,
  isValidMacAddress,
  normalizeMacAddress,
  percentageToRssi,
} from "./utils";
import type { AccessPoint, ApMapping, SurveyPoint, WifiResults } from "./types";

/* ---------- which access point ---------- */

/**
 * Where an access point's identity comes from: a marker that lists the
 * BSSID, a name in the access point names list, or only the BSSID.
 */
export type ApSource = "marker" | "name" | "bssid";

export interface ApIdentity {
  /** stable key: "ap:<marker id>", "name:<name>" or "bssid:<12 hex digits>" */
  key: string;
  /** what to call it: the marker's or given name, else the BSSID */
  name: string;
  source: ApSource;
  /** the marker, when source is "marker" */
  markerId?: string;
}

/** The connected BSSID of a reading (12 lowercase hex digits), or null if it wasn't reported. */
export function connectedBssid(
  wifi: Pick<WifiResults, "bssid"> | undefined,
): string | null {
  const bssid = wifi?.bssid ?? "";
  return isValidMacAddress(bssid) ? normalizeMacAddress(bssid) : null;
}

/**
 * The marker that lists `bssid`: an exact BSSID wins over a prefix, a
 * longer prefix over a shorter one, and the first marker on a tie.
 */
export function markerForBssid(
  bssid: string,
  accessPoints: readonly AccessPoint[],
): AccessPoint | undefined {
  let best: { ap: AccessPoint; length: number } | undefined;
  for (const ap of accessPoints) {
    for (const pattern of ap.bssids ?? []) {
      const p = normalizeMacAddress(pattern);
      if (p === bssid) return ap;
      if (!isApPrefix(p)) continue;
      const prefix = p.slice(0, -1);
      if (bssid.startsWith(prefix) && (!best || prefix.length > best.length)) {
        best = { ap, length: prefix.length };
      }
    }
  }
  return best?.ap;
}

/**
 * The access point a BSSID belongs to: the marker that lists it, else
 * its name in the names list, else the BSSID itself. null when there is
 * no usable BSSID.
 */
export function identifyAp(
  bssid: string | undefined,
  accessPoints: readonly AccessPoint[],
  apMapping: readonly ApMapping[] | undefined,
): ApIdentity | null {
  const b = connectedBssid({ bssid: bssid ?? "" });
  if (!b) return null;
  const marker = markerForBssid(b, accessPoints);
  if (marker) {
    return {
      key: `ap:${marker.id}`,
      name: accessPointName(marker),
      source: "marker",
      markerId: marker.id,
    };
  }
  const named = apNameFor(b, apMapping as ApMapping[] | undefined)?.trim();
  if (named) return { key: `name:${named}`, name: named, source: "name" };
  return { key: `bssid:${b}`, name: formatMacAddress(b), source: "bssid" };
}

/* ---------- colours ---------- */

/** The hue of the n-th access point: the chip hues first, then spread by the golden angle. */
export function nthApHue(n: number): number {
  if (n < AP_HUES.length) return AP_HUES[n];
  return Math.round((AP_HUES[0] + (n - AP_HUES.length + 1) * 137.508) % 360);
}

/**
 * A hue per access point, so a marker, its region, its measurements and
 * its chip in the table share one colour. Markers come first, in the
 * order they were added; then the other access points seen, sorted, so
 * colours don't change when the table is sorted.
 */
export function apPalette(
  points: readonly SurveyPoint[],
  accessPoints: readonly AccessPoint[],
  apMapping: readonly ApMapping[] | undefined,
): Map<string, number> {
  const keys = accessPoints.map((ap) => `ap:${ap.id}`);
  const others = new Set<string>();
  for (const p of points) {
    const id = identifyAp(p.wifiData.bssid, accessPoints, apMapping);
    if (id && id.source !== "marker") others.add(id.key);
  }
  keys.push(...[...others].sort());
  return new Map(keys.map((key, i) => [key, nthApHue(i)]));
}

/* ---------- readings in the order they were taken ---------- */

/** A reading's signal in dBm, from the RSSI or else the percentage; null if neither. */
export function rssiOf(wifi: WifiResults): number | null {
  if (wifi.rssi < 0) return wifi.rssi;
  if (wifi.signalStrength > 0) return percentageToRssi(wifi.signalStrength);
  return null;
}

const pointNumber = (id: string) => {
  const m = id.match(/(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/**
 * Points in the order they were measured: by time, then by the number in
 * their id (old files may have no time, and sample points share one).
 */
export function inMeasuredOrder<T extends SurveyPoint>(
  points: readonly T[],
): T[] {
  return [...points].sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      pointNumber(a.id) - pointNumber(b.id) ||
      a.id.localeCompare(b.id),
  );
}

/* ---------- roaming ---------- */

/**
 * What changed between two readings in a row:
 * - roam: another access point
 * - band-change: same access point, another band (e.g. 5 GHz to 2.4 GHz)
 * - radio-change: same access point and band, another BSSID
 * - network-change: another network (SSID) altogether
 */
export type RoamKind =
  "roam" | "band-change" | "radio-change" | "network-change";

/**
 * - weak-before: the signal was already weak before the change (a late or
 *   "sticky" roam)
 * - ping-pong: it went back to the access point it just left
 * - long-gap: the readings are far apart in time, so the device may have
 *   reconnected rather than roamed
 * - unknown-between: readings without a BSSID lie between the two
 * - inferred-same-ap: the BSSIDs aren't assigned to an access point, but
 *   they differ only in the last or first byte, which usually means two
 *   radios of one access point
 */
export type RoamFlag =
  | "weak-before"
  | "ping-pong"
  | "long-gap"
  | "unknown-between"
  | "inferred-same-ap";

export interface RoamEvent {
  /** 1, 2, 3, … in measured order: the number on the map */
  n: number;
  fromPointId: string;
  toPointId: string;
  from: ApIdentity;
  to: ApIdentity;
  fromBssid: string;
  toBssid: string;
  kind: RoamKind;
  flags: RoamFlag[];
  rssiBefore: number | null;
  rssiAfter: number | null;
  bandBefore: number;
  bandAfter: number;
  channelBefore: number;
  channelAfter: number;
  ssidBefore: string;
  ssidAfter: string;
  /** when the new connection was first measured */
  timestamp: number;
  /** half way between the two readings: where it happened, roughly */
  x: number;
  y: number;
}

export interface RoamingOptions {
  /** a roam from a signal at or below this (dBm) is flagged weak-before */
  weakDbm?: number;
  /** readings further apart than this (ms) are flagged long-gap */
  longGapMs?: number;
}

/** Red on the signal scale below this (survey-defaults.ts). */
export const WEAK_SIGNAL_DBM = -76;
const DEFAULT_LONG_GAP_MS = 15 * 60 * 1000;

/**
 * Two BSSIDs that are probably radios of one access point: they differ
 * only in the last byte, or only in the first (a locally administered
 * variant of the same address).
 */
export function likelySameDevice(a: string, b: string): boolean {
  if (a === b) return true;
  return a.slice(0, 10) === b.slice(0, 10) || a.slice(2) === b.slice(2);
}

/**
 * Every change of connected BSSID between consecutive readings, in the
 * order they were measured. Readings without a BSSID are skipped (and
 * flag the change that spans them).
 */
export function detectRoaming(
  points: readonly SurveyPoint[],
  accessPoints: readonly AccessPoint[],
  apMapping: readonly ApMapping[] | undefined,
  {
    weakDbm = WEAK_SIGNAL_DBM,
    longGapMs = DEFAULT_LONG_GAP_MS,
  }: RoamingOptions = {},
): RoamEvent[] {
  const events: RoamEvent[] = [];
  let prev: { point: SurveyPoint; bssid: string; ap: ApIdentity } | null = null;
  let unknownSince = 0;
  for (const point of inMeasuredOrder(points)) {
    const bssid = connectedBssid(point.wifiData);
    const ap = bssid && identifyAp(bssid, accessPoints, apMapping);
    if (!bssid || !ap) {
      if (prev) unknownSince++;
      continue;
    }
    if (prev && prev.bssid !== bssid) {
      const a = prev.point.wifiData;
      const b = point.wifiData;
      const flags: RoamFlag[] = [];
      let kind: RoamKind;
      const bandChanged = !!a.band && !!b.band && a.band !== b.band;
      if (a.ssid && b.ssid && a.ssid !== b.ssid) {
        kind = "network-change";
      } else if (prev.ap.key === ap.key) {
        kind = bandChanged ? "band-change" : "radio-change";
      } else if (
        prev.ap.source === "bssid" &&
        ap.source === "bssid" &&
        likelySameDevice(prev.bssid, bssid)
      ) {
        kind = bandChanged ? "band-change" : "radio-change";
        flags.push("inferred-same-ap");
      } else {
        kind = "roam";
      }
      const rssiBefore = rssiOf(a);
      if (kind === "roam" && rssiBefore !== null && rssiBefore <= weakDbm) {
        flags.push("weak-before");
      }
      if (unknownSince > 0) flags.push("unknown-between");
      if (
        prev.point.timestamp > 0 &&
        point.timestamp - prev.point.timestamp > longGapMs
      ) {
        flags.push("long-gap");
      }
      events.push({
        n: events.length + 1,
        fromPointId: prev.point.id,
        toPointId: point.id,
        from: prev.ap,
        to: ap,
        fromBssid: prev.bssid,
        toBssid: bssid,
        kind,
        flags,
        rssiBefore,
        rssiAfter: rssiOf(b),
        bandBefore: a.band,
        bandAfter: b.band,
        channelBefore: a.channel,
        channelAfter: b.channel,
        ssidBefore: a.ssid,
        ssidAfter: b.ssid,
        timestamp: point.timestamp,
        x: Math.round((prev.point.x + point.x) / 2),
        y: Math.round((prev.point.y + point.y) / 2),
      });
    }
    prev = { point, bssid, ap };
    unknownSince = 0;
  }

  // back to the access point it just left, at the next change
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1];
    const b = events[i];
    if (
      a.kind === "roam" &&
      b.kind === "roam" &&
      a.toPointId === b.fromPointId &&
      a.from.key === b.to.key
    ) {
      if (!a.flags.includes("ping-pong")) a.flags.push("ping-pong");
      b.flags.push("ping-pong");
    }
  }
  return events;
}

/** "Roamed", "Changed band", … for a roaming event's kind. */
export const ROAM_KIND_TITLES: Record<RoamKind, string> = {
  roam: "Roamed to another access point",
  "band-change": "Changed band, same access point",
  "radio-change": "Changed radio, same access point",
  "network-change": "Changed network",
};

export const ROAM_FLAG_TITLES: Record<RoamFlag, string> = {
  "weak-before": "Late roam: the signal was already weak",
  "ping-pong": "Went straight back (ping-pong)",
  "long-gap": "Long pause between readings: may have reconnected",
  "unknown-between": "Readings without a BSSID in between",
  "inferred-same-ap":
    "Same access point assumed: the BSSIDs are nearly identical",
};

/* ---------- summary per access point ---------- */

export interface ApSummary extends ApIdentity {
  hue: number;
  /** the BSSIDs seen in measurements */
  bssids: string[];
  ssids: string[];
  bands: number[];
  channels: number[];
  /** measurements connected to it */
  count: number;
  /** share of the measurements that have a BSSID, 0..100 */
  percent: number;
  avgRssi: number | null;
  minRssi: number | null;
  maxRssi: number | null;
  /** roaming events from or to it (any kind) */
  roamingEvents: number;
}

export interface ApSummaryResult {
  aps: ApSummary[];
  /** measurements with a BSSID */
  identified: number;
  /** measurements without one (not reported) */
  unknown: number;
}

/**
 * One row per access point: every marker (even one no measurement
 * connected to) and every other access point seen, most measurements
 * first.
 */
export function summarizeAps(
  points: readonly SurveyPoint[],
  accessPoints: readonly AccessPoint[],
  apMapping: readonly ApMapping[] | undefined,
  events: readonly RoamEvent[],
  palette: Map<string, number>,
): ApSummaryResult {
  type Acc = ApSummary & { rssiSum: number; rssiCount: number };
  const rows = new Map<string, Acc>();
  const row = (id: ApIdentity): Acc => {
    let r = rows.get(id.key);
    if (!r) {
      r = {
        ...id,
        hue: palette.get(id.key) ?? 220,
        bssids: [],
        ssids: [],
        bands: [],
        channels: [],
        count: 0,
        percent: 0,
        avgRssi: null,
        minRssi: null,
        maxRssi: null,
        roamingEvents: 0,
        rssiSum: 0,
        rssiCount: 0,
      };
      rows.set(id.key, r);
    }
    return r;
  };
  for (const ap of accessPoints) {
    row({
      key: `ap:${ap.id}`,
      name: accessPointName(ap),
      source: "marker",
      markerId: ap.id,
    });
  }

  let identified = 0;
  let unknown = 0;
  const addTo = <T>(list: T[], v: T) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const p of points) {
    const w = p.wifiData;
    const bssid = connectedBssid(w);
    const id = bssid && identifyAp(bssid, accessPoints, apMapping);
    if (!bssid || !id) {
      unknown++;
      continue;
    }
    identified++;
    const r = row(id);
    r.count++;
    addTo(r.bssids, bssid);
    if (w.ssid && !w.ssid.includes("redacted")) addTo(r.ssids, w.ssid);
    if (w.band) addTo(r.bands, w.band);
    if (w.channel) addTo(r.channels, w.channel);
    const rssi = rssiOf(w);
    if (rssi !== null) {
      r.rssiSum += rssi;
      r.rssiCount++;
      r.minRssi = r.minRssi === null ? rssi : Math.min(r.minRssi, rssi);
      r.maxRssi = r.maxRssi === null ? rssi : Math.max(r.maxRssi, rssi);
    }
  }
  for (const e of events) {
    rows.get(e.from.key)!.roamingEvents++;
    if (e.to.key !== e.from.key) rows.get(e.to.key)!.roamingEvents++;
  }

  const aps = [...rows.values()].map(({ rssiSum, rssiCount, ...r }) => ({
    ...r,
    bssids: r.bssids.sort(),
    bands: r.bands.sort((a, b) => a - b),
    channels: r.channels.sort((a, b) => a - b),
    percent: identified ? Math.round((r.count / identified) * 1000) / 10 : 0,
    avgRssi: rssiCount ? Math.round(rssiSum / rssiCount) : null,
  }));
  aps.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { aps, identified, unknown };
}

/* ---------- findings ---------- */

export interface DistantApPoint {
  pointId: string;
  /** the access point it was connected to */
  connected: string;
  /** a marked access point at most half as far away */
  nearer: string;
  rssi: number;
}

export interface Findings {
  roams: number;
  bandChanges: number;
  /** roams that happened only after the signal was weak */
  lateRoams: RoamEvent[];
  /** roams straight back to the access point just left */
  pingPongs: RoamEvent[];
  /** connected to a marked access point while another is much closer */
  distantAp: DistantApPoint[];
  /** measurements below WEAK_SIGNAL_DBM */
  weakPoints: number;
  /** measurements without a BSSID */
  unknownBssid: number;
}

/**
 * What a network engineer would look at first. Distances are in floor
 * plan pixels, so "distant" is relative: connected to a marker more than
 * twice as far as the nearest other marker, with the signal at -70 dBm or
 * below.
 */
export function findIssues(
  points: readonly SurveyPoint[],
  accessPoints: readonly AccessPoint[],
  apMapping: readonly ApMapping[] | undefined,
  events: readonly RoamEvent[],
): Findings {
  const markers = new Map(accessPoints.map((ap) => [ap.id, ap]));
  const distantAp: DistantApPoint[] = [];
  let weakPoints = 0;
  let unknownBssid = 0;
  for (const p of points) {
    const id = identifyAp(p.wifiData.bssid, accessPoints, apMapping);
    if (!id) {
      unknownBssid++;
      continue;
    }
    const rssi = rssiOf(p.wifiData);
    if (rssi !== null && rssi < WEAK_SIGNAL_DBM) weakPoints++;
    const own = id.markerId ? markers.get(id.markerId) : undefined;
    if (!own || rssi === null || rssi > -70 || accessPoints.length < 2)
      continue;
    const dOwn = Math.hypot(own.x - p.x, own.y - p.y);
    let nearest: AccessPoint | undefined;
    let dNearest = Infinity;
    for (const ap of accessPoints) {
      if (ap.id === own.id) continue;
      const d = Math.hypot(ap.x - p.x, ap.y - p.y);
      if (d < dNearest) {
        dNearest = d;
        nearest = ap;
      }
    }
    if (nearest && dNearest * 2 < dOwn) {
      distantAp.push({
        pointId: p.id,
        connected: id.name,
        nearer: accessPointName(nearest),
        rssi,
      });
    }
  }
  return {
    roams: events.filter((e) => e.kind === "roam").length,
    bandChanges: events.filter((e) => e.kind === "band-change").length,
    lateRoams: events.filter((e) => e.flags.includes("weak-before")),
    pingPongs: events.filter((e) => e.flags.includes("ping-pong")),
    distantAp,
    weakPoints,
    unknownBssid,
  };
}

/* ---------- association regions ---------- */

export interface RegionSample {
  x: number;
  y: number;
  key: string;
}

/**
 * The floor plan in square cells, each labelled with the access point of
 * the nearest measurement, or -1 where no measurement is within the
 * radius. `conf` is 1 up to half the radius from that measurement and
 * falls to 0 at the radius: how much the label is backed by data.
 */
export interface RegionGrid {
  cols: number;
  rows: number;
  /** cell size in floor plan pixels */
  cell: number;
  /** index into keys, or -1 */
  labels: Int16Array;
  conf: Float32Array;
  keys: string[];
}

/** A cell size that keeps the grid near 400 cells across the longer side. */
export function regionCellSize(width: number, height: number): number {
  return Math.max(2, Math.round(Math.max(width, height) / 400));
}

/**
 * Nearest-measurement regions (a Voronoi diagram cut off at `radius`).
 * Points are bucketed by radius, so each cell only looks at the 3 x 3
 * buckets around it: fast for large surveys.
 */
export function computeRegions(
  samples: readonly RegionSample[],
  width: number,
  height: number,
  radius: number,
  cell = regionCellSize(width, height),
): RegionGrid {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const labels = new Int16Array(cols * rows).fill(-1);
  const conf = new Float32Array(cols * rows);
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  for (const s of samples) {
    if (!keyIndex.has(s.key)) {
      keyIndex.set(s.key, keys.length);
      keys.push(s.key);
    }
  }
  if (!samples.length || radius <= 0) {
    return { cols, rows, cell, labels, conf, keys };
  }

  const bucket = radius;
  const buckets = new Map<string, RegionSample[]>();
  for (const s of samples) {
    const k = `${Math.floor(s.x / bucket)},${Math.floor(s.y / bucket)}`;
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(s);
  }

  const r2 = radius * radius;
  const half = radius / 2;
  for (let row = 0; row < rows; row++) {
    const cy = (row + 0.5) * cell;
    const by = Math.floor(cy / bucket);
    for (let col = 0; col < cols; col++) {
      const cx = (col + 0.5) * cell;
      const bx = Math.floor(cx / bucket);
      let best: RegionSample | undefined;
      let bestD2 = r2;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = buckets.get(`${bx + dx},${by + dy}`);
          if (!list) continue;
          for (const s of list) {
            const d2 = (s.x - cx) ** 2 + (s.y - cy) ** 2;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = s;
            }
          }
        }
      }
      if (!best) continue;
      const i = row * cols + col;
      labels[i] = keyIndex.get(best.key)!;
      const d = Math.sqrt(bestD2);
      conf[i] = d <= half ? 1 : Math.max(0, 1 - (d - half) / half);
    }
  }
  return { cols, rows, cell, labels, conf, keys };
}

/** A line segment x1, y1, x2, y2 in floor plan pixels. */
export type Segment = [number, number, number, number];

/**
 * The edges between neighbouring cells served by different access points.
 * Solid where both sides are backed by data (conf >= 0.5), dashed where
 * the boundary is mostly estimated. Edges next to a hidden key, or next
 * to no data, are left out.
 */
export function regionBoundaries(
  grid: RegionGrid,
  hidden: ReadonlySet<string> = new Set(),
): { solid: Segment[]; dashed: Segment[] } {
  const { cols, rows, cell, labels, conf, keys } = grid;
  const solid: Segment[] = [];
  const dashed: Segment[] = [];
  const visible = keys.map((k) => !hidden.has(k));
  const edge = (a: number, b: number, seg: Segment) => {
    const la = labels[a];
    const lb = labels[b];
    if (la < 0 || lb < 0 || la === lb || !visible[la] || !visible[lb]) return;
    (Math.min(conf[a], conf[b]) >= 0.5 ? solid : dashed).push(seg);
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (col + 1 < cols) {
        const x = (col + 1) * cell;
        edge(i, i + 1, [x, row * cell, x, (row + 1) * cell]);
      }
      if (row + 1 < rows) {
        const y = (row + 1) * cell;
        edge(i, i + cols, [col * cell, y, (col + 1) * cell, y]);
      }
    }
  }
  return { solid, dashed };
}

/**
 * The samples for computeRegions: enabled points with a BSSID, keyed by
 * their access point.
 */
export function regionSamples(
  points: readonly SurveyPoint[],
  accessPoints: readonly AccessPoint[],
  apMapping: readonly ApMapping[] | undefined,
): RegionSample[] {
  return points.flatMap((p) => {
    const id = identifyAp(p.wifiData.bssid, accessPoints, apMapping);
    return id ? [{ x: p.x, y: p.y, key: id.key }] : [];
  });
}
