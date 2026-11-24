/**
 * schema.ts - the shape of a survey file and of the API request bodies that
 * change one, as Zod schemas. The TypeScript types in types.ts are derived
 * from these, so the two cannot drift apart.
 *
 * Two kinds of schema live here:
 *
 * - Lenient ones read what is on disk (surveyFileSchema). Survey files come
 *   from every version since 0.4, and some were edited by hand. A field that
 *   is missing or has the wrong type falls back to its default (`.catch()`),
 *   a list entry that is unusable is dropped, and the rest still loads.
 *   The migrations that used to live in GlobalSettings.tsx and fileHandler.ts
 *   (defaults for missing fields, iperfResults -> iperfData, the fixed
 *   colour scales) happen here, on the server.
 *
 * - Strict ones check request bodies (settingsPatchSchema, addPointSchema,
 *   ...). Unknown keys and invalid values are refused with a 400, and
 *   nothing is written.
 *
 * The measurement payload of a point (wifiData, iperfData) is read leniently
 * in both cases: it comes from this server's own scanners, which leave a
 * field out on some systems, and losing a measurement over a missing
 * txRate would be worse than storing 0. A speed test that did not run is
 * null (files before schema version 2 stored zeros; parseSurveyFile()
 * reads those as null).
 *
 * The sudo password is not part of any schema here: it is never stored, and
 * parsing drops it like any other unknown key.
 */
import { z } from "zod";
import { HEATMAP_KEYS, parseHeatmapKey } from "./heatmap-grid";
import { isValidHeatmapRange } from "./heatmap-scale";
import {
  defaultIperfCommands,
  iperfArgsProblem,
  migrateIperfTemplate,
} from "./iperfUtils";
import { getLogger } from "./logger";
import {
  defaultGradient,
  defaultPointValueColor,
  defaultPointValueOpacity,
  defaultPointValueScale,
  emptyWifiResults,
  isPreviousDefaultGradient,
} from "./survey-defaults";
import { mediaUrlFor } from "./media-url";
import { migrateMeasurementMode } from "./measurement-mode";
import { cleanPointLabel, POINT_LABEL_MAX } from "./point-label";
import {
  ACCESS_POINT_BSSIDS_MAX,
  ACCESS_POINT_CHANNELS_MAX,
  ACCESS_POINT_MODEL_MAX,
  ACCESS_POINT_NAME_MAX,
  ACCESS_POINT_NOTE_MAX,
  ACCESS_POINT_SSID_MAX,
  ACCESS_POINTS_MAX,
  AP_BANDS,
  CHANNEL_MAX,
  cleanAccessPointNote,
  cleanBandList,
  cleanBssidList,
  cleanChannelList,
  cleanOptionalText,
  compactAccessPoint,
} from "./access-points";
import { isValidApPattern } from "./apName";
import { AP_LAYERS, defaultApView, HIDDEN_APS_MAX } from "./ap-view";
import {
  COMPANY_NAME_MAX,
  defaultReportInfo,
  defaultReportProfile,
  LOGO_DATA_URL,
  LOGO_MAX_BYTES,
  REPORT_LONG_FIELDS,
  REPORT_LONG_MAX,
  REPORT_SHORT_FIELDS,
  REPORT_SHORT_MAX,
  type ReportInfo,
} from "./report-info";
import { COPY_PART_NAMES, type CopyPart } from "./survey-ops";
import type { Gradient, HeatmapKey, HeatmapRanges } from "./types";

const logger = getLogger("schema");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list whose unusable entries are dropped instead of failing the list. */
function lenientArray<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data as z.output<T>] : [];
      }),
    );
}

const finite = z.number(); // Zod 4 refuses NaN and Infinity

/* ---------- measurements ---------- */

/**
 * One speed test that ran. Without a usable bitsPerSecond it isn't one
 * (the test becomes null); the other values fall back one by one.
 */
export const iperfTestPropertySchema = z.object({
  bitsPerSecond: finite, // 0 is a real result: nothing got through
  retransmits: finite.optional().catch(undefined),
  // null: the test does not report it (TCP has no jitter) or it is unknown
  jitterMs: finite.nullable().catch(null),
  lostPackets: finite.nullable().catch(null),
  packetsReceived: finite.nullable().catch(null),
  signalStrength: finite.catch(0),
});

/** A test, or null when it did not run (or is unusable). */
const iperfTestOrNull = iperfTestPropertySchema.nullable().catch(null);

/** The four speed tests of a point; null for each one that did not run. */
export const iperfResultsSchema = z.object({
  tcpDownload: iperfTestOrNull,
  tcpUpload: iperfTestOrNull,
  udpDownload: iperfTestOrNull,
  udpUpload: iperfTestOrNull,
});

const IPERF_TESTS = [
  "tcpDownload",
  "tcpUpload",
  "udpDownload",
  "udpUpload",
] as const;

/**
 * Did this stored test not run? Before schema version 2 a test that did
 * not run was saved as zeros: bitsPerSecond 0 and nothing else measured.
 * signalStrength is not looked at: it is the Wi-Fi reading copied in
 * (0.3 stored the signal there even for tests that did not run). A test
 * with any other value is kept, and so is any test in a newer file, where
 * 0 Mbps is a real result.
 */
function savedAsZeros(test: z.output<typeof iperfTestPropertySchema>) {
  const nothing = (v: number | null | undefined) =>
    v === 0 || v === null || v === undefined;
  return (
    test.bitsPerSecond === 0 &&
    nothing(test.retransmits) &&
    nothing(test.jitterMs) &&
    nothing(test.lostPackets) &&
    nothing(test.packetsReceived)
  );
}

/** The results of a Wi-Fi reading. */
export interface WifiResults {
  ssid: string;
  bssid: string;
  rssi: number; // dBm
  // noise floor in dBm; only some platforms report it (macOS, some Linux
  // drivers). Missing or null means unknown.
  noise?: number | null;
  signalStrength: number; // percent
  channel: number;
  security: string;
  txRate: number;
  phyMode: string;
  channelWidth: number;
  band: number; // frequency band in GHz: 2.4, 5 or 6; 0 if unknown
  currentSSID: boolean; // true if this is the SSID currently in use
  strongestSSID: WifiResults | null;
}

export const wifiResultsSchema: z.ZodType<WifiResults> = z.lazy(() =>
  z.object({
    ssid: z.string().catch(""),
    bssid: z.string().catch(""),
    rssi: finite.catch(0),
    noise: finite.nullable().optional().catch(undefined),
    signalStrength: finite.catch(0),
    channel: finite.catch(0),
    security: z.string().catch(""),
    txRate: finite.catch(0),
    phyMode: z.string().catch(""),
    channelWidth: finite.catch(0),
    band: finite.catch(0),
    currentSSID: z.boolean().catch(false),
    strongestSSID: wifiResultsSchema.nullable().catch(null),
  }),
);

/* ---------- survey points ---------- */

/**
 * A point's name in a request: trimmed, at most POINT_LABEL_MAX
 * characters; "" removes it.
 */
const pointLabelStrict = z
  .string()
  .trim()
  .max(POINT_LABEL_MAX, `a label is at most ${POINT_LABEL_MAX} characters`);

/** A stored name: trimmed and cut to POINT_LABEL_MAX; empty or bad: none. */
const pointLabelLenient = z
  .string()
  .transform(cleanPointLabel)
  .optional()
  .catch(undefined);

const pointFields = {
  x: finite,
  y: finite,
  wifiData: wifiResultsSchema,
  iperfData: iperfResultsSchema,
  timestamp: finite,
  isEnabled: z.boolean(),
  /** optional name shown instead of the id ("Kitchen"); display only */
  label: pointLabelStrict.optional(),
};

/**
 * A stored point. Without a usable position and id it is dropped; everything
 * else falls back. Versions before 0.4 called iperfData "iperfResults".
 */
export const surveyPointSchema = z.preprocess(
  (value) => {
    if (!isRecord(value) || value.iperfResults === undefined) return value;
    const { iperfResults, ...rest } = value;
    return { ...rest, iperfData: iperfResults };
  },
  z.object({
    x: pointFields.x,
    y: pointFields.y,
    id: z.string().min(1),
    wifiData: pointFields.wifiData.catch(emptyWifiResults),
    iperfData: pointFields.iperfData.catch(() => iperfResultsSchema.parse({})), // all null
    timestamp: pointFields.timestamp.catch(0),
    isEnabled: pointFields.isEnabled.catch(true),
    label: pointLabelLenient,
  }),
);

/* ---------- access points on the plan ---------- */

/**
 * Where an access point (router, mesh node) is on the floor plan, drawn
 * as a marker for reference (issue #154). Not a measurement: it never
 * feeds a heat map. Saved with the survey; PATCH /api/settings replaces
 * the whole list.
 */
const accessPointFields = {
  id: z.string().trim().min(1).max(40),
  x: finite,
  y: finite,
  name: z
    .string()
    .trim()
    .max(
      ACCESS_POINT_NAME_MAX,
      `a name is at most ${ACCESS_POINT_NAME_MAX} characters`,
    ),
  /** optional free text: model, height, which way the antennas point */
  note: z
    .string()
    .trim()
    .max(
      ACCESS_POINT_NOTE_MAX,
      `a note is at most ${ACCESS_POINT_NOTE_MAX} characters`,
    )
    .optional(),
  /** optional manufacturer and model ("Ubiquiti U6 Pro") */
  model: z
    .string()
    .trim()
    .max(
      ACCESS_POINT_MODEL_MAX,
      `a model is at most ${ACCESS_POINT_MODEL_MAX} characters`,
    )
    .optional(),
  /** optional network name it broadcasts */
  ssid: z
    .string()
    .trim()
    .max(
      ACCESS_POINT_SSID_MAX,
      `an SSID is at most ${ACCESS_POINT_SSID_MAX} characters`,
    )
    .optional(),
  /**
   * The BSSIDs (one per radio or network) that belong to this access
   * point, or prefixes ending in "*". Measurements connected to one of
   * them are counted as this access point (ap-association.ts).
   */
  bssids: z
    .array(
      z.string().refine(isValidApPattern, {
        error:
          "must be a MAC address such as 9e:05:d6:96:e8:30, or a prefix ending in * such as 9e:05:d6:96:e8:*",
      }),
    )
    .max(ACCESS_POINT_BSSIDS_MAX)
    .transform(cleanBssidList)
    .optional(),
  /** bands it uses, in GHz */
  bands: z
    .array(
      z.number().refine((b) => (AP_BANDS as readonly number[]).includes(b), {
        error: "a band is 2.4, 5 or 6",
      }),
    )
    .max(AP_BANDS.length)
    .transform(cleanBandList)
    .optional(),
  /** channels it uses */
  channels: z
    .array(z.int().min(1).max(CHANNEL_MAX))
    .max(ACCESS_POINT_CHANNELS_MAX)
    .transform(cleanChannelList)
    .optional(),
};

/** Optional text in a stored marker: cleaned, or none if unusable. */
const optionalTextLenient = (max: number) =>
  z
    .string()
    .transform((v) => cleanOptionalText(v, max))
    .optional()
    .catch(undefined);

/** An optional list in a stored marker: cleaned, or none if unusable. */
const optionalListLenient = <T>(
  item: z.ZodType<T>,
  clean: (values: T[]) => T[],
) =>
  z
    .array(z.unknown())
    .transform((values) => {
      const list = clean(
        values.flatMap((v) => {
          const parsed = item.safeParse(v);
          return parsed.success ? [parsed.data] : [];
        }),
      );
      return list.length ? list : undefined;
    })
    .optional()
    .catch(undefined);

/**
 * A stored marker. Without an id and a position it is dropped; a bad
 * optional field is left out and the rest of the marker kept. Files from
 * before the optional fields existed load unchanged.
 */
export const accessPointSchema = z.object({
  id: z.string().min(1),
  x: finite,
  y: finite,
  name: z
    .string()
    .transform((v) => v.trim().slice(0, ACCESS_POINT_NAME_MAX))
    .catch(""),
  note: z
    .string()
    .transform((v) => cleanAccessPointNote(v))
    .optional()
    .catch(undefined),
  model: optionalTextLenient(ACCESS_POINT_MODEL_MAX),
  ssid: optionalTextLenient(ACCESS_POINT_SSID_MAX),
  bssids: optionalListLenient(z.string(), cleanBssidList),
  bands: optionalListLenient(z.number(), cleanBandList),
  channels: optionalListLenient(z.number(), cleanChannelList),
});

/** The list in a request: ids must be unique. */
const accessPointsStrict = z
  .array(z.strictObject(accessPointFields))
  .max(ACCESS_POINTS_MAX)
  .superRefine((aps, ctx) => {
    const seen = new Set<string>();
    aps.forEach((ap, i) => {
      if (seen.has(ap.id)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: `"${ap.id}" is used twice`,
        });
      }
      seen.add(ap.id);
    });
  })
  .transform((aps) => aps.map(compactAccessPoint));

/* ---------- how the access point map is shown ---------- */

const apViewFields = {
  layer: z.enum(AP_LAYERS),
  regionOpacity: finite.min(0).max(1),
  showBoundaries: z.boolean(),
  showMarkers: z.boolean(),
  showPoints: z.boolean(),
  showRoaming: z.boolean(),
  hiddenAps: z.array(z.string().max(200)).max(HIDDEN_APS_MAX),
};

/** A stored view: each bad or missing field falls back to its default. */
const apViewLenient = z
  .unknown()
  .optional()
  .transform((value) => {
    const view = defaultApView();
    if (!isRecord(value)) return view;
    const out: Record<string, unknown> = { ...view };
    for (const [key, schema] of Object.entries(apViewFields)) {
      const parsed = schema.safeParse(value[key]);
      if (parsed.success) out[key] = parsed.data;
    }
    return out as unknown as typeof view;
  });

/* ---------- the report's details ---------- */

const ymdDate = z.union([
  z.literal(""),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date is YYYY-MM-DD"),
]);

const shortText = z.string().max(REPORT_SHORT_MAX);
const longText = z.string().max(REPORT_LONG_MAX);
const reportInfoFields = {
  client: shortText,
  site: shortText,
  address: shortText,
  surveyor: shortText,
  surveyDate: ymdDate,
  summary: longText,
  recommendations: longText,
  notes: longText,
} satisfies Record<keyof ReportInfo, z.ZodType<string>>;

/** A stored report: each bad or missing field is empty; long text is cut. */
const reportInfoLenient = z
  .unknown()
  .optional()
  .transform((value): ReportInfo => {
    const info = defaultReportInfo();
    if (!isRecord(value)) return info;
    for (const k of REPORT_SHORT_FIELDS) {
      if (typeof value[k] === "string") {
        info[k] = value[k].slice(0, REPORT_SHORT_MAX);
      }
    }
    for (const k of REPORT_LONG_FIELDS) {
      if (typeof value[k] === "string") {
        info[k] = value[k].slice(0, REPORT_LONG_MAX);
      }
    }
    if (ymdDate.safeParse(value.surveyDate).success) {
      info.surveyDate = value.surveyDate as string;
    }
    return info;
  });

/* ---------- settings ---------- */

export const apMappingSchema = z.object({
  apName: z.string(),
  macAddress: z.string(),
});

/** The extra iperf3 options of one test (see iperfUtils.ts). */
const iperfExtraArgs = z.array(z.string()).superRefine((args, ctx) => {
  const problem = iperfArgsProblem(args);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/**
 * The extra iperf3 options per test, as argument arrays. (Before 0.8 these
 * were whole command templates run through a shell; the file key stayed.)
 */
export const iperfCommandsSchema = z.object({
  tcpDownload: iperfExtraArgs,
  tcpUpload: iperfExtraArgs,
  udpDownload: iperfExtraArgs,
  udpUpload: iperfExtraArgs,
});

const iperfCommandKeys = Object.keys(
  iperfCommandsSchema.shape,
) as (keyof typeof iperfCommandsSchema.shape)[];

/**
 * Missing or damaged options fall back to the default one by one. An old
 * command template (a string) is read into its extra options; one that
 * can't be (shell syntax, another program) falls back to the defaults,
 * with a warning in the log.
 */
const iperfCommandsLenient = z
  .unknown()
  .optional()
  .transform(
    (value) =>
      Object.fromEntries(
        iperfCommandKeys.map((key) => {
          const v = isRecord(value) ? value[key] : undefined;
          if (typeof v === "string") {
            const migrated = migrateIperfTemplate(v);
            if (migrated.args) return [key, migrated.args];
            logger.warn(
              `The ${key} iperf3 command "${v}" can't be used any more because ${migrated.reason}; using the default options instead. Set extra options under Settings > Advanced.`,
            );
            return [key, [...defaultIperfCommands[key]]];
          }
          const parsed = iperfExtraArgs.safeParse(v);
          return [
            key,
            parsed.success ? parsed.data : [...defaultIperfCommands[key]],
          ];
        }),
      ) as z.output<typeof iperfCommandsSchema>,
  );

export const heatmapScaleSchema = z.object({
  min: finite,
  max: finite,
  enabled: z.boolean(),
});

function isHeatmapKey(key: string): key is (typeof HEATMAP_KEYS)[number] {
  return (HEATMAP_KEYS as readonly string[]).includes(key);
}

/** Why a saved scale isn't valid for its map (0 <= min < max, <= 100 for signal), or null. */
function scaleProblem(
  key: (typeof HEATMAP_KEYS)[number],
  scale: unknown,
): string | null {
  const { property } = parseHeatmapKey(key);
  if (
    heatmapScaleSchema.safeParse(scale).success &&
    isValidHeatmapRange(scale, property)
  ) {
    return null;
  }
  return (
    "must be { min, max, enabled } with 0 <= min < max" +
    (property === "signalStrength"
      ? " <= 100 (percent)"
      : ", in display units (Mbps, ms, counts or dB)")
  );
}

/** Keep only known maps with a valid saved scale (lenient). */
export function normalizeHeatmapRanges(input: unknown): HeatmapRanges {
  if (!isRecord(input)) return {};
  const ranges: HeatmapRanges = {};
  for (const key of HEATMAP_KEYS) {
    const value = input[key];
    if (scaleProblem(key, value) === null) {
      ranges[key] = heatmapScaleSchema.parse(value);
    }
  }
  return ranges;
}

const heatmapRangesLenient = z
  .unknown()
  .optional()
  .transform(normalizeHeatmapRanges);

/** A reading label's text colour, as a hex colour the browser's picker gives. */
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

function isGradientStop(key: string, color: unknown): color is string {
  const stop = Number(key);
  return (
    key.trim() !== "" &&
    Number.isFinite(stop) &&
    stop >= 0 &&
    stop <= 1 &&
    typeof color === "string" &&
    color !== ""
  );
}

/** Colour stops 0..1 -> CSS colour. */
const gradientSchema = z
  .record(z.string(), z.string())
  .superRefine((gradient, ctx) => {
    const entries = Object.entries(gradient);
    if (entries.length === 0) {
      ctx.addIssue({ code: "custom", message: "needs at least one stop" });
    }
    for (const [key, color] of entries) {
      if (!isGradientStop(key, color)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "a stop is a number from 0 to 1 and a colour",
        });
      }
    }
  })
  .transform((g) => g as Gradient);

/**
 * Bad stops are dropped; with none left, the default gradient. A survey
 * still on an earlier version's default gets the current one.
 */
const gradientLenient = z
  .unknown()
  .optional()
  .transform((value): Gradient => {
    if (!isRecord(value)) return defaultGradient();
    const stops = Object.entries(value).filter(([k, c]) =>
      isGradientStop(k, c),
    );
    if (!stops.length) return defaultGradient();
    const gradient = Object.fromEntries(stops) as Gradient;
    return isPreviousDefaultGradient(gradient) ? defaultGradient() : gradient;
  });

export const surveyFileMetaSchema = z.object({
  schemaVersion: finite,
  appVersion: z.string(),
  platform: z.string(),
  osName: z.string(),
  savedAt: z.string(), // ISO timestamp
  // Only on the save that created the survey: the survey whose speed
  // settings it started from (survey-store.ts)
  speedSettingsFrom: z.string().optional().catch(undefined),
});

/* ---------- the survey file ---------- */

/**
 * One data/surveys/<floor plan>.json, read leniently. Unknown keys
 * (including a sudo password in a very old file) are dropped.
 */
export const surveyFileSchema = z.object({
  surveyPoints: lenientArray(surveyPointSchema),
  floorplanImageName: z.string().catch(""),
  // URL the browser loads the image from; always derived from the name
  floorplanImagePath: z.string().catch(""),
  // "Signal and speed" (true) or "Signal only" (false). Files before 0.8
  // don't have it; parseSurveyFile() derives it from the server address.
  measureSpeed: z.boolean().optional().catch(undefined),
  iperfServerAdrs: z.string().catch(""), // the speed test (iperf3) server, host[:port]
  testDuration: finite.catch(5),
  // The fixed-rate (UDP) tests. Older files ran them on every point,
  // so a missing value is true; new surveys start without them.
  udpTests: z.boolean().catch(true),
  apMapping: lenientArray(apMappingSchema),
  accessPoints: lenientArray(accessPointSchema).transform((aps) =>
    aps.map(compactAccessPoint),
  ),
  // how the access point map is shown; older files get the defaults
  apView: apViewLenient,
  // the Report tab's details; older files get empty ones
  report: reportInfoLenient,
  nextPointNum: z.int().catch(1),
  dimensions: z
    .object({ width: finite, height: finite })
    .catch(() => ({ width: 100, height: 100 })),
  radiusDivider: finite.nullable().catch(null), // null: calculated
  maxOpacity: finite.catch(0.7),
  minOpacity: finite.catch(0.2),
  blur: finite.catch(0.99),
  // label every measurement with the value its map shows
  showPointValues: z.boolean().catch(false),
  pointValueScale: z.int().min(40).max(160).catch(defaultPointValueScale),
  pointValueOpacity: finite.min(0).max(1).catch(defaultPointValueOpacity),
  pointValueColor: hexColour.catch(defaultPointValueColor),
  gradient: gradientLenient,
  heatmapRanges: heatmapRangesLenient,
  iperfCommands: iperfCommandsLenient,
  meta: surveyFileMetaSchema.optional().catch(undefined), // set on every save
});

/** A survey as the API returns it: the file, never with a password. */
export type SurveyDocument = Omit<
  z.output<typeof surveyFileSchema>,
  "measureSpeed"
> & { measureSpeed: boolean };

/**
 * The version of the survey file format, stamped into `meta` on each save
 * (survey-store.ts). 2 (after 0.8): a speed test that did not run is null, not
 * zeros.
 */
export const SURVEY_SCHEMA_VERSION = 2;

/**
 * Files before schema version 2 stored a speed test that did not run as
 * zeros; read those as null (savedAsZeros()). Tests with real values are
 * kept. Newer files are left alone, so a real 0 Mbps stays 0, and running
 * it twice changes nothing.
 */
export function migrateUnmeasuredTests<
  T extends Pick<z.output<typeof surveyFileSchema>, "surveyPoints" | "meta">,
>(survey: T): T {
  if ((survey.meta?.schemaVersion ?? 0) >= 2) return survey;
  return {
    ...survey,
    surveyPoints: survey.surveyPoints.map((point) => {
      const iperfData = { ...point.iperfData };
      for (const key of IPERF_TESTS) {
        const test = iperfData[key];
        if (test && savedAsZeros(test)) iperfData[key] = null;
      }
      return { ...point, iperfData };
    }),
  };
}

/**
 * parseSurveyFile() - whatever is in a survey file, as a complete survey for
 * that floor plan. The floor plan name and image URL come from the name the
 * survey was asked for (older files stored a /media/... path that is no
 * longer served), keeping the stored spelling when it is the same file.
 */
export function parseSurveyFile(
  raw: Record<string, unknown>,
  floorPlan: string,
  sameFile: (a: string, b: string) => boolean = (a, b) => a === b,
): SurveyDocument {
  const survey = migrateMeasurementMode(
    migrateUnmeasuredTests(surveyFileSchema.parse(raw)),
  );
  const name =
    survey.floorplanImageName && sameFile(survey.floorplanImageName, floorPlan)
      ? survey.floorplanImageName
      : floorPlan;
  return {
    ...survey,
    floorplanImageName: name,
    floorplanImagePath: mediaUrlFor(name),
  };
}

/* ---------- request bodies (strict) ---------- */

/** What PATCH /api/settings accepts. Every field is optional. */
export const settingsPatchSchema = z
  .strictObject({
    measureSpeed: z.boolean(),
    iperfServerAdrs: z.string().trim(),
    testDuration: z.int().min(1).max(60),
    udpTests: z.boolean(),
    /** Replaces the whole list. */
    apMapping: z.array(z.strictObject(apMappingSchema.shape)),
    /** Replaces the whole list. */
    accessPoints: accessPointsStrict,
    /** Replaces the whole view. */
    apView: z.strictObject(apViewFields),
    /** Replaces the whole report details. */
    report: z.strictObject(reportInfoFields),
    dimensions: z.strictObject({
      width: finite.positive(),
      height: finite.positive(),
    }),
    radiusDivider: finite.positive().nullable(),
    maxOpacity: finite.min(0).max(1),
    minOpacity: finite.min(0).max(1),
    blur: finite.min(0),
    showPointValues: z.boolean(),
    pointValueScale: z.int().min(40).max(160),
    pointValueOpacity: finite.min(0).max(1),
    pointValueColor: hexColour,
    gradient: gradientSchema,
    /** Per map; null removes that map's scale, maps not given are kept. */
    heatmapRanges: z
      .record(z.string(), z.unknown())
      .superRefine((ranges, ctx) => {
        for (const [key, scale] of Object.entries(ranges)) {
          if (!isHeatmapKey(key)) {
            ctx.addIssue({
              code: "custom",
              path: [key],
              message: "is not a heat map",
            });
          } else if (scale !== null) {
            const problem = scaleProblem(key, scale);
            if (problem) {
              ctx.addIssue({ code: "custom", path: [key], message: problem });
            }
          }
        }
      })
      .transform(
        (ranges) =>
          ranges as Partial<
            Record<HeatmapKey, z.output<typeof heatmapScaleSchema> | null>
          >,
      ),
    /** Only the commands given change. */
    iperfCommands: z.strictObject(iperfCommandsSchema.shape).partial(),
  })
  .partial();

export type SettingsPatch = z.output<typeof settingsPatchSchema>;

/**
 * POST /api/surveys/[name]/points. The server assigns the id unless a
 * free one is given; the browser sends "".
 */
export const addPointSchema = z.strictObject({
  ...pointFields,
  id: z.string().optional(),
});

export type NewSurveyPoint = z.output<typeof addPointSchema>;

/**
 * PATCH /api/surveys/[name]/points/[id]. The id cannot change; a label
 * of "" removes the point's name.
 */
export const pointPatchSchema = z.strictObject(pointFields).partial();

export type SurveyPointPatch = z.output<typeof pointPatchSchema>;

/** DELETE /api/surveys/[name]/points. Unknown ids are ignored. */
export const deletePointsSchema = z.strictObject({
  ids: z.array(z.string()),
});

/**
 * POST /api/settings (whole document, kept for older clients). Read like a
 * file, so an export from any version imports; it must name its floor plan.
 */
export const surveyImportSchema = z.looseObject({
  floorplanImageName: z.string().min(1),
});

/**
 * POST /api/settings/copy?from=&to=&parts= (the query string, as an object).
 * parts is a comma-separated list of COPY_PARTS names.
 */
export const copySettingsQuerySchema = z.strictObject({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  parts: z
    .string()
    .transform((s) => [
      ...new Set(
        s
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(
      z
        .array(
          z.enum(COPY_PART_NAMES as [CopyPart, ...CopyPart[]], {
            error: (issue) =>
              `"${String(issue.input)}" is not one of ${COPY_PART_NAMES.join(", ")}`,
          }),
        )
        .min(1, `name at least one of ${COPY_PART_NAMES.join(", ")}`),
    ),
});

/** POST /api/start-task?action=start */
export const startTaskSchema = z.strictObject({
  // the floor plan (survey) the point is saved to, and where
  survey: z.string().trim().min(1),
  x: finite.min(0),
  y: finite.min(0),
  settings: z.object({
    // missing: derived from the server (localhost or empty = signal only)
    measureSpeed: z.boolean().optional(),
    iperfServerAdrs: z.string(),
    testDuration: finite,
    // missing: run them (older clients always did)
    udpTests: z.boolean().optional(),
    // left out or "": the server uses the password it holds, if any
    // (sudo-session.ts; how MCP-started measurements get one)
    sudoerPassword: z.string().default(""),
    iperfCommands: iperfCommandsSchema,
  }),
});

/* ---------- usage counts (telemetry.ts) ---------- */

/**
 * data/usage-counts.json, read leniently: a broken field is dropped, so a
 * hand-edited file never stops the app. Not part of any survey.
 */
export const usageCountsFileSchema = z.object({
  /** false: turned off in Settings */
  enabled: z.boolean().optional().catch(undefined),
  /** random, made when usage counts are first on; removed when turned off */
  installId: z.uuid().optional().catch(undefined),
  /** the Install event was sent (never again, even with a new id) */
  installReported: z.boolean().optional().catch(undefined),
  /** UTC day (YYYY-MM-DD) of the last App start event */
  lastAppStartDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  lastSent: z
    .object({ event: z.string(), at: z.string() })
    .optional()
    .catch(undefined),
});

export type UsageCountsFile = z.output<typeof usageCountsFileSchema>;

/** PATCH /api/telemetry */
export const usageCountsPatchSchema = z.strictObject({
  enabled: z.boolean(),
});

/* ---------- e2e test scenarios (mock-scenario.ts) ---------- */

/** How the mock reports reading Wi-Fi, as the real scanners name it. */
export const MOCK_WIFI_METHODS = [
  "mock",
  "macos-helper",
  "wdutil",
  "wlan-api",
  "netsh-fallback",
  "iw",
  "iw-sudo",
] as const;

/**
 * PUT /api/e2e/scenario - how the mock backend behaves (e2e tests only).
 * Every field is optional; a missing one has its normal mock behaviour.
 */
export const mockScenarioSchema = z.strictObject({
  /**
   * ok; needs-sudo: refused without a sudo password (and with one other
   * than `sudoPassword`, if set); wrong-sudo: every password is refused;
   * not-connected: Wi-Fi is off; error: reading Wi-Fi fails (`wifiError`)
   */
  wifi: z
    .enum(["ok", "needs-sudo", "wrong-sudo", "not-connected", "error"])
    .optional(),
  /** the password needs-sudo accepts (any non-empty one if unset) */
  sudoPassword: z.string().max(200).optional(),
  /** the message of wifi: "error" */
  wifiError: z.string().min(1).max(500).optional(),
  /** what the Wi-Fi reading is recorded as, for diagnostics */
  wifiMethod: z.enum(MOCK_WIFI_METHODS).optional(),
  /** noise floor in dBm, or null for none (default: -90 to -95 dBm) */
  noise: z.number().int().min(-120).max(0).nullable().optional(),
  /** a fixed signal strength in percent (default: a random walk) */
  signal: z.number().int().min(1).max(100).optional(),
  /**
   * ok; missing: iperf3 is not installed; unreachable: the server doesn't
   * answer; fails-midway: the first test runs, the second one fails
   * (`iperfError`)
   */
  iperf: z.enum(["ok", "missing", "unreachable", "fails-midway"]).optional(),
  /** iperf3's "error" for fails-midway */
  iperfError: z.string().min(1).max(500).optional(),
  /** how long each step takes, in ms (default 150) */
  delayMs: z.number().int().min(0).max(30_000).optional(),
});

export type MockScenario = z.output<typeof mockScenarioSchema>;

/** One line per problem, for a 400 answer. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join(".");
      if (issue.code === "unrecognized_keys") {
        const keys = issue.keys.join(", ");
        return where ? `${where}: unknown ${keys}` : `unknown field ${keys}`;
      }
      return where ? `${where}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/* ---------- the company on reports (data/report-profile.json) ---------- */

const logoField = z
  .string()
  .max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 64, "the logo is too large")
  .regex(LOGO_DATA_URL, "the logo must be a PNG or JPEG image")
  .nullable();

/** PUT /api/report-profile: the whole profile. */
export const reportProfileSchema = z.strictObject({
  companyName: z.string().trim().max(COMPANY_NAME_MAX),
  logo: logoField,
});

/** The stored file: anything unusable falls back to empty. */
export const reportProfileFileSchema = z.object({
  companyName: z
    .string()
    .transform((v) => v.trim().slice(0, COMPANY_NAME_MAX))
    .catch(""),
  logo: logoField.catch(defaultReportProfile().logo),
});
