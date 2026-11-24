/**
 * report.ts - the survey report: what it says, as plain data.
 *
 * buildReport() turns a survey, the details typed on the Report tab and
 * the company profile into a ReportModel: a cover and sections of simple
 * blocks (text, lists, tables, facts, images). The preview and PDF
 * (report-html.ts) and the Word file (report-docx.ts) both render that one
 * model, so they always say the same thing. The images are drawn in the
 * browser (report-images.ts) and passed in. No DOM and no Zod here.
 */
import {
  detectRoaming,
  findIssues,
  identifyAp,
  inMeasuredOrder,
  apPalette,
  rssiOf,
  ROAM_FLAG_TITLES,
  ROAM_KIND_TITLES,
  summarizeAps,
  WEAK_SIGNAL_DBM,
  type Findings,
} from "./ap-association";
import { accessPointName } from "./access-points";
import { formatMacAddress } from "./utils";
import type { AccessPoint, ApMapping, SurveyPoint } from "./types";

import { type ReportInfo, type ReportProfile } from "./report-info";

export * from "./report-info";

/* ---------- the model ---------- */

export interface ReportImage {
  title: string;
  caption: string;
  /** a PNG data URL */
  src: string;
  width: number;
  height: number;
}

export type ReportBlock =
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "list"; items: string[] }
  | { kind: "facts"; rows: [string, string][] }
  | {
      kind: "table";
      head: string[];
      rows: string[][];
      /** "right" for number columns */
      align?: ("left" | "right")[];
    }
  | { kind: "image"; image: ReportImage };

export interface ReportSection {
  id: string;
  heading: string;
  /** start on a new page when printed */
  newPage?: boolean;
  blocks: ReportBlock[];
}

export interface ReportModel {
  title: string;
  /** the site, else the floor plan name */
  subtitle: string;
  companyName: string;
  logo: string | null;
  /** client, site, date, surveyor, … on the cover */
  cover: [string, string][];
  sections: ReportSection[];
  /** a short line for the page footer */
  footer: string;
}

/* ---------- numbers ---------- */

export interface SignalStats {
  points: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** at or above -67 dBm (green on the signal map) */
  good: number;
  /** below WEAK_SIGNAL_DBM (red) */
  weak: number;
}

/** The good (green) side of the signal scale, in dBm. */
export const GOOD_SIGNAL_DBM = -67;

export function signalStats(points: readonly SurveyPoint[]): SignalStats {
  const values = points
    .map((p) => rssiOf(p.wifiData))
    .filter((v): v is number => v !== null);
  if (!values.length) {
    return {
      points: points.length,
      avg: null,
      min: null,
      max: null,
      good: 0,
      weak: 0,
    };
  }
  return {
    points: points.length,
    avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    min: Math.min(...values),
    max: Math.max(...values),
    good: values.filter((v) => v >= GOOD_SIGNAL_DBM).length,
    weak: values.filter((v) => v < WEAK_SIGNAL_DBM).length,
  };
}

const pct = (n: number, of: number) =>
  of ? `${Math.round((n / of) * 100)}%` : "–";
const dbm = (v: number | null) => (v === null ? "–" : `${v} dBm`);
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The survey date as YYYY-MM-DD: the one typed, else the last measurement's day. */
export function reportDate(
  info: Pick<ReportInfo, "surveyDate">,
  points: readonly SurveyPoint[],
): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(info.surveyDate)) return info.surveyDate;
  const last = Math.max(0, ...points.map((p) => p.timestamp || 0));
  if (!last) return "";
  const d = new Date(last);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** "24 November 2026" for a YYYY-MM-DD date, in the local language. */
export function formatReportDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/* ---------- findings and recommendations ---------- */

/** What deserves a look, as sentences (also on the access point map). */
export function findingsText(findings: Findings): string[] {
  const items: string[] = [];
  if (findings.lateRoams.length) {
    items.push(
      `${plural(findings.lateRoams.length, "roam", "roams")} only after the signal was weak (${findings.lateRoams.map((e) => `#${e.n}`).join(", ")}): the device may be holding on too long.`,
    );
  }
  if (findings.pingPongs.length) {
    items.push(
      `${plural(findings.pingPongs.length, "roam went", "roams went")} straight back to the access point just left (${findings.pingPongs.map((e) => `#${e.n}`).join(", ")}): the coverage overlaps a lot there.`,
    );
  }
  if (findings.distantAp.length) {
    items.push(
      `${plural(findings.distantAp.length, "measurement was", "measurements were")} connected to a distant access point with a weak signal while another marker is much closer.`,
    );
  }
  if (findings.weakPoints) {
    items.push(
      `${plural(findings.weakPoints, "measurement has", "measurements have")} a weak signal (below ${WEAK_SIGNAL_DBM} dBm).`,
    );
  }
  return items;
}

/**
 * Suggested recommendations from the findings, as a starting point the
 * surveyor edits. Empty when nothing stands out.
 */
export function suggestRecommendations(
  findings: Findings,
  stats: SignalStats,
): string {
  const lines: string[] = [];
  if (stats.weak) {
    lines.push(
      `- Improve coverage where the signal is below ${WEAK_SIGNAL_DBM} dBm (red on the signal map): add an access point or mesh node there, or move one closer.`,
    );
  }
  if (findings.lateRoams.length || findings.distantAp.length) {
    lines.push(
      "- Help devices roam sooner: enable fast roaming (802.11k/v/r) if the equipment supports it, and consider a minimum signal (RSSI) threshold so weak clients move to a nearer access point.",
    );
  }
  if (findings.pingPongs.length) {
    lines.push(
      "- Reduce overlap where devices bounce between access points: lower the transmit power of the access points involved or move them further apart.",
    );
  }
  if (findings.unknownBssid) {
    lines.push(
      "- Some measurements have no BSSID, so the access point serving them is unknown. On macOS, allow Location access for the app before the next survey.",
    );
  }
  return lines.join("\n");
}

/* ---------- building the report ---------- */

export interface ReportInput {
  info: ReportInfo;
  profile: ReportProfile;
  floorplanName: string;
  /** the measurements in use (switched-off ones are left out) */
  points: readonly SurveyPoint[];
  accessPoints: readonly AccessPoint[];
  apMapping: readonly ApMapping[];
  /** the maps, by what they show */
  images: Partial<
    Record<"signal" | "locations" | "association" | "roaming", ReportImage>
  >;
}

const band = (b: number) => (b ? `${b} GHz` : "–");
const mbps = (bps: number | undefined | null) =>
  typeof bps === "number" && Number.isFinite(bps)
    ? (bps / 1_000_000).toFixed(1)
    : "–";

/**
 * Typed text as blocks: blank lines separate paragraphs, and a paragraph
 * whose lines all start with "-", "*" or "•" is a bulleted list.
 */
export function paragraphs(text: string, muted = false): ReportBlock[] {
  return text
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t): ReportBlock => {
      const lines = t.split("\n").map((l) => l.trim());
      if (lines.every((l) => /^[-*•]\s+/.test(l))) {
        return {
          kind: "list",
          items: lines.map((l) => l.replace(/^[-*•]\s+/, "")),
        };
      }
      return { kind: "text", text: t, muted };
    });
}

export function buildReport(input: ReportInput): ReportModel {
  const { info, profile, points, accessPoints, apMapping, images } = input;
  const palette = apPalette(points, accessPoints, apMapping);
  const events = detectRoaming(points, accessPoints, apMapping);
  const aps = summarizeAps(points, accessPoints, apMapping, events, palette);
  const findings = findIssues(points, accessPoints, apMapping, events);
  const stats = signalStats(points);
  const date = reportDate(info, points);
  const markers = new Map(accessPoints.map((ap) => [ap.id, ap]));
  const site = info.site.trim();

  const cover: [string, string][] = [];
  const add = (label: string, value: string) => {
    if (value.trim()) cover.push([label, value.trim()]);
  };
  add("Client", info.client);
  add("Site", site);
  add("Address", info.address);
  add("Survey date", date ? formatReportDate(date) : "");
  add("Surveyor", info.surveyor);
  add("Prepared by", profile.companyName);
  add("Floor plan", input.floorplanName);

  const sections: ReportSection[] = [];

  /* summary */
  const roams = events.filter((e) => e.kind === "roam").length;
  const facts: [string, string][] = [
    ["Measurements", String(stats.points)],
    ["Average signal", dbm(stats.avg)],
    [
      "Weakest / strongest",
      stats.min === null ? "–" : `${stats.min} / ${stats.max} dBm`,
    ],
    [
      `Good signal (${GOOD_SIGNAL_DBM} dBm or better)`,
      `${stats.good} (${pct(stats.good, stats.points)})`,
    ],
    [
      `Weak signal (below ${WEAK_SIGNAL_DBM} dBm)`,
      `${stats.weak} (${pct(stats.weak, stats.points)})`,
    ],
    [
      "Access points serving the device",
      String(aps.aps.filter((a) => a.count > 0).length),
    ],
    ["Roams between access points", String(roams)],
    [
      "Band or radio changes",
      String(events.filter((e) => e.kind !== "roam").length),
    ],
  ];
  if (aps.unknown) {
    facts.push(["Measurements without a BSSID", String(aps.unknown)]);
  }
  const found = findingsText(findings);
  sections.push({
    id: "summary",
    heading: "Summary",
    blocks: [
      ...paragraphs(info.summary),
      { kind: "facts", rows: facts },
      { kind: "text", text: "Findings" },
      found.length
        ? { kind: "list", items: found }
        : {
            kind: "text",
            text: "Nothing stood out: no late or ping-pong roams and no weak spots.",
            muted: true,
          },
    ],
  });

  /* coverage */
  if (images.signal) {
    sections.push({
      id: "coverage",
      heading: "Signal coverage",
      newPage: true,
      blocks: [
        { kind: "image", image: images.signal },
        {
          kind: "text",
          text: `Green is ${GOOD_SIGNAL_DBM} dBm or better, yellow down to ${WEAK_SIGNAL_DBM} dBm, red below. Each colour is spread from the measurements around it; the white discs are the access points.`,
          muted: true,
        },
      ],
    });
  }

  /* access points */
  const apRows = aps.aps.map((a) => {
    const marker = a.markerId ? markers.get(a.markerId) : undefined;
    const bssids = [
      ...new Set([
        ...(marker?.bssids ?? []).map((b) =>
          b.endsWith("*") ? b : formatMacAddress(b),
        ),
        ...a.bssids.map((b) => formatMacAddress(b)),
      ]),
    ];
    const ssids = [...new Set([marker?.ssid ?? "", ...a.ssids])].filter(
      Boolean,
    );
    const bands = [...new Set([...(marker?.bands ?? []), ...a.bands])].sort(
      (x, y) => x - y,
    );
    const channels = [
      ...new Set([...(marker?.channels ?? []), ...a.channels]),
    ].sort((x, y) => x - y);
    return [
      a.name,
      marker?.model ?? "",
      ssids.join(", ") || "–",
      bssids.join("\n") || "–",
      bands.map(band).join(", ") || "–",
      channels.join(", ") || "–",
      `${a.count} (${a.percent}%)`,
      dbm(a.avgRssi),
      a.minRssi === null ? "–" : `${a.minRssi} / ${a.maxRssi}`,
      String(a.roamingEvents),
    ];
  });
  const apBlocks: ReportBlock[] = [];
  if (images.locations)
    apBlocks.push({ kind: "image", image: images.locations });
  if (apRows.length) {
    // the model only when some access point has one
    const withModel = apRows.some((r) => r[1]);
    const drop = (row: string[]) =>
      withModel ? row : row.filter((_, i) => i !== 1);
    apBlocks.push({
      kind: "table",
      head: drop([
        "Access point",
        "Model",
        "Network (SSID)",
        "BSSIDs",
        "Bands",
        "Channels",
        "Measurements",
        "Average",
        "Weakest / strongest (dBm)",
        "Roaming events",
      ]),
      rows: apRows.map(drop),
      align: drop([
        "left",
        "left",
        "left",
        "left",
        "left",
        "left",
        "right",
        "right",
        "right",
        "right",
      ]) as ("left" | "right")[],
    });
    const notes = accessPoints
      .filter((ap) => ap.note)
      .map((ap) => `${accessPointName(ap)}: ${ap.note}`);
    if (notes.length) apBlocks.push({ kind: "list", items: notes });
  } else {
    apBlocks.push({
      kind: "text",
      text: "No access points were marked, and no measurement reported a BSSID.",
      muted: true,
    });
  }
  sections.push({
    id: "access-points",
    heading: "Access points",
    newPage: true,
    blocks: apBlocks,
  });

  /* association and roaming */
  const roamBlocks: ReportBlock[] = [];
  if (images.association) {
    roamBlocks.push({ kind: "image", image: images.association });
    roamBlocks.push({
      kind: "text",
      text: "Each area is shaded in the colour of the access point the device was connected to there (its BSSID, not the strongest one nearby). Lines separate areas served by different access points; dashed lines are estimates between measurements.",
      muted: true,
    });
  }
  if (images.roaming && events.length) {
    roamBlocks.push({ kind: "image", image: images.roaming });
  }
  if (events.length) {
    const pointName = new Map(points.map((p) => [p.id, p.label || p.id]));
    roamBlocks.push({
      kind: "table",
      head: [
        "#",
        "What happened",
        "From → to",
        "Where",
        "Signal before → after",
        "Band, channel",
        "Notes",
      ],
      rows: events.map((e) => [
        String(e.n),
        ROAM_KIND_TITLES[e.kind],
        `${e.from.name} → ${e.to.name}`,
        `${pointName.get(e.fromPointId) ?? e.fromPointId} → ${pointName.get(e.toPointId) ?? e.toPointId}`,
        `${dbm(e.rssiBefore)} → ${dbm(e.rssiAfter)}`,
        `${band(e.bandBefore)} ch ${e.channelBefore || "?"} → ${band(e.bandAfter)} ch ${e.channelAfter || "?"}`,
        e.flags.map((f) => ROAM_FLAG_TITLES[f]).join("; "),
      ]),
    });
  } else if (aps.identified) {
    roamBlocks.push({
      kind: "text",
      text: "The device stayed on one access point and band for the whole survey.",
      muted: true,
    });
  }
  if (roamBlocks.length) {
    sections.push({
      id: "roaming",
      heading: "Access point association and roaming",
      newPage: true,
      blocks: roamBlocks,
    });
  }

  /* measurements */
  const ordered = inMeasuredOrder(points);
  const speed = ordered.some(
    (p) => p.iperfData?.tcpDownload || p.iperfData?.tcpUpload,
  );
  sections.push({
    id: "measurements",
    heading: "Measurements",
    newPage: true,
    blocks: [
      {
        kind: "table",
        head: [
          "Point",
          "Signal",
          "Signal (dBm)",
          "Access point",
          "Network",
          "Band",
          "Channel",
          ...(speed ? ["Download (Mbps)", "Upload (Mbps)"] : []),
        ],
        rows: ordered.map((p) => {
          const w = p.wifiData;
          const ap = identifyAp(w.bssid, accessPoints, apMapping);
          return [
            p.label || p.id,
            w.signalStrength ? `${w.signalStrength}%` : "–",
            dbm(rssiOf(w)),
            ap ? ap.name : "not reported",
            w.ssid || "–",
            band(w.band),
            w.channel ? String(w.channel) : "–",
            ...(speed
              ? [
                  mbps(p.iperfData?.tcpDownload?.bitsPerSecond),
                  mbps(p.iperfData?.tcpUpload?.bitsPerSecond),
                ]
              : []),
          ];
        }),
        align: [
          "left",
          "right",
          "right",
          "left",
          "left",
          "left",
          "right",
          ...(speed ? (["right", "right"] as const) : []),
        ],
      },
    ],
  });

  /* recommendations and notes */
  const recs = paragraphs(info.recommendations);
  if (recs.length) {
    sections.push({
      id: "recommendations",
      heading: "Recommendations",
      newPage: true,
      blocks: recs,
    });
  }
  const notes = paragraphs(info.notes);
  if (notes.length) {
    sections.push({
      id: "notes",
      heading: "Additional notes",
      newPage: !recs.length,
      blocks: notes,
    });
  }

  const footerParts = [
    profile.companyName.trim(),
    info.client.trim(),
    site || input.floorplanName,
  ].filter(Boolean);

  return {
    title: "Wi-Fi survey report",
    subtitle: site || input.floorplanName,
    companyName: profile.companyName.trim(),
    logo: profile.logo,
    cover,
    sections,
    footer: footerParts.join(" · "),
  };
}
