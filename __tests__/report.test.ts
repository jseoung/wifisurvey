/**
 * The survey report: what it says (report.ts), the HTML the preview and
 * PDF use (report-html.ts), the Word file (report-docx.ts), and how the
 * details and the company profile are stored (schema.ts).
 */
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Packer } from "docx";
import {
  buildReport,
  defaultReportInfo,
  defaultReportProfile,
  paragraphs,
  reportDate,
  signalStats,
  suggestRecommendations,
  type ReportInput,
} from "@/lib/report";
import { escapeHtml, reportHtml } from "@/lib/report-html";
import { reportDocument } from "@/lib/report-docx";
import { findIssues, detectRoaming } from "@/lib/ap-association";
import {
  parseSurveyFile,
  reportProfileFileSchema,
  reportProfileSchema,
  settingsPatchSchema,
} from "@/lib/schema";
import { defaultSurvey } from "@/lib/survey-defaults";
import { getDefaultIperfResults, getDefaultWifiResults } from "@/lib/utils";
import type { AccessPoint, SurveyPoint } from "@/lib/types";

let n = 0;
const point = (
  x: number,
  bssid: string,
  rssi: number,
  band = 5,
): SurveyPoint => {
  n++;
  return {
    id: `Point_${n}`,
    x,
    y: 100,
    timestamp: Date.UTC(2026, 10, 20, 9, 0, n),
    isEnabled: true,
    iperfData: getDefaultIperfResults(),
    wifiData: {
      ...getDefaultWifiResults(),
      ssid: "Office",
      bssid,
      rssi,
      signalStrength: Math.round(((rssi + 100) / 60) * 100),
      band,
      channel: band === 5 ? 36 : 6,
    },
  };
};

// three access points, one SSID; a late roam and a weak spot
const points = [
  point(10, "aa:bb:cc:00:01:10", -50),
  point(60, "aa:bb:cc:00:01:10", -79),
  point(110, "aa:bb:cc:00:02:10", -55),
  point(160, "aa:bb:cc:00:02:10", -60),
  point(210, "aa:bb:cc:00:03:10", -58),
  point(260, "", -62),
];
const markers: AccessPoint[] = [
  {
    id: "ap1",
    x: 20,
    y: 90,
    name: "Lobby",
    model: "UniFi U6 Pro",
    bssids: ["aabbcc000110"],
    note: "Ceiling, above reception",
  },
];

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  info: {
    ...defaultReportInfo(),
    client: "Acme",
    site: "Head office",
    surveyor: "J. Tech",
    summary: "All floors walked.",
    recommendations: "- Add a node in the store room\n- Enable 802.11r",
  },
  profile: { companyName: "Example Networks", logo: null },
  floorplanName: "plan.png",
  points,
  accessPoints: markers,
  apMapping: [{ macAddress: "aa:bb:cc:00:02:10", apName: "Kitchen" }],
  images: {},
  ...over,
});

describe("buildReport", () => {
  const model = buildReport(input());

  it("has a cover and the sections in order", () => {
    expect(model.title).toBe("Wi-Fi survey report");
    expect(model.subtitle).toBe("Head office");
    expect(model.cover.map(([k]) => k)).toEqual([
      "Client",
      "Site",
      "Survey date",
      "Surveyor",
      "Prepared by",
      "Floor plan",
    ]);
    expect(model.sections.map((s) => s.id)).toEqual([
      "summary",
      "access-points",
      "roaming",
      "measurements",
      "recommendations",
    ]);
    expect(model.footer).toBe("Example Networks · Acme · Head office");
  });

  it("summarises the signal and the roaming", () => {
    const facts = model.sections[0].blocks.find((b) => b.kind === "facts");
    expect(
      facts?.kind === "facts" && Object.fromEntries(facts.rows),
    ).toMatchObject({
      Measurements: "6",
      "Weakest / strongest": "-79 / -50 dBm",
      "Access points serving the device": "3",
      "Roams between access points": "2",
      "Measurements without a BSSID": "1",
    });
  });

  it("names access points by marker, then name, then BSSID, with the marker's details", () => {
    const table = model.sections[1].blocks.find((b) => b.kind === "table");
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;
    expect(table.head[1]).toBe("Model");
    const names = table.rows.map((r) => r[0]);
    expect(names).toEqual(
      expect.arrayContaining(["Lobby", "Kitchen", "AA-BB-CC-00-03-10"]),
    );
    expect(table.rows.find((r) => r[0] === "Lobby")?.[1]).toBe("UniFi U6 Pro");
    // the marker's note is listed under the table
    expect(
      model.sections[1].blocks.some(
        (b) => b.kind === "list" && b.items[0].includes("above reception"),
      ),
    ).toBe(true);
  });

  it("leaves the model column out when no access point has one", () => {
    const m = buildReport(
      input({ accessPoints: [{ ...markers[0], model: undefined }] }),
    );
    const table = m.sections[1].blocks.find((b) => b.kind === "table");
    expect(table?.kind === "table" && table.head).not.toContain("Model");
    expect(
      table?.kind === "table" &&
        table.rows.every((r) => r.length === table.head.length),
    ).toBe(true);
  });

  it("turns typed lines starting with - into a list", () => {
    const recs = model.sections.find((s) => s.id === "recommendations");
    expect(recs?.blocks).toEqual([
      {
        kind: "list",
        items: ["Add a node in the store room", "Enable 802.11r"],
      },
    ]);
  });

  it("skips empty recommendations and notes, and maps it has no image for", () => {
    const m = buildReport(
      input({ info: { ...defaultReportInfo() }, images: {} }),
    );
    const ids = m.sections.map((s) => s.id);
    expect(ids).not.toContain("recommendations");
    expect(ids).not.toContain("notes");
    expect(ids).not.toContain("coverage");
    expect(m.subtitle).toBe("plan.png");
  });

  it("lists every measurement, and 'not reported' without a BSSID", () => {
    const table = model.sections
      .find((s) => s.id === "measurements")
      ?.blocks.find((b) => b.kind === "table");
    expect(table?.kind === "table" && table.rows.length).toBe(6);
    expect(table?.kind === "table" && table.rows[5][3]).toBe("not reported");
  });
});

describe("report helpers", () => {
  it("paragraphs: blank lines split, list lines become lists", () => {
    expect(paragraphs("One.\n\nTwo\nlines.\n\n* a\n* b")).toEqual([
      { kind: "text", text: "One.", muted: false },
      { kind: "text", text: "Two\nlines.", muted: false },
      { kind: "list", items: ["a", "b"] },
    ]);
  });

  it("reportDate: the typed date, else the last measurement's day", () => {
    expect(reportDate({ surveyDate: "2026-01-02" }, points)).toBe("2026-01-02");
    expect(reportDate({ surveyDate: "" }, points)).toMatch(/^2026-11-2\d$/);
    expect(reportDate({ surveyDate: "" }, [])).toBe("");
  });

  it("suggests recommendations only for what was found", () => {
    const events = detectRoaming(points, markers, []);
    const text = suggestRecommendations(
      findIssues(points, markers, [], events),
      signalStats(points),
    );
    expect(text).toMatch(/below -76 dBm/);
    expect(text).toMatch(/no BSSID/);
    const good = points.slice(2, 4);
    expect(
      suggestRecommendations(
        findIssues(good, [], [], detectRoaming(good, [], [])),
        signalStats(good),
      ),
    ).toBe("");
  });
});

describe("reportHtml", () => {
  it("escapes everything typed", () => {
    const html = reportHtml(
      buildReport(
        input({
          info: {
            ...defaultReportInfo(),
            client: '<script>alert("x")</script>',
            notes: "<img src=x onerror=alert(1)>",
          },
        }),
      ),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(escapeHtml(`a&b<'"`)).toBe("a&amp;b&lt;&#39;&quot;");
  });

  it("only uses image data URLs for the logo", () => {
    const bad = reportHtml(
      buildReport(
        input({ profile: { companyName: "X", logo: "javascript:alert(1)" } }),
      ),
    );
    expect(bad).not.toContain("javascript:");
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const good = reportHtml(
      buildReport(input({ profile: { companyName: "X", logo: png } })),
    );
    expect(good).toContain(`<img src="${png}"`);
  });
});

/** One file from a zip (the .docx), enough for these tests. */
function unzip(buf: Buffer, name: string): string {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const fileName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (fileName === name) {
      const start =
        local +
        30 +
        buf.readUInt16LE(local + 26) +
        buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error(`${name} not in the zip`);
}

describe("reportDocument", () => {
  it("makes a Word file with the cover, the sections and page numbers", async () => {
    const buf = await Packer.toBuffer(reportDocument(buildReport(input())));
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const doc = unzip(buf, "word/document.xml");
    for (const text of [
      "Wi-Fi survey report",
      "Head office",
      "Summary",
      "Access points",
      "UniFi U6 Pro",
      "Recommendations",
      "Enable 802.11r",
    ]) {
      expect(doc).toContain(text);
    }
    expect(unzip(buf, "word/footer1.xml")).toContain("PAGE");
  });
});

describe("stored report details and profile", () => {
  it("an older survey loads with empty report details", () => {
    const { report: _, ...old } = defaultSurvey("plan.png");
    expect(parseSurveyFile(old, "plan.png")?.report).toEqual(
      defaultReportInfo(),
    );
  });

  it("keeps good fields, cuts long text and drops a bad date", () => {
    const survey = parseSurveyFile(
      {
        ...defaultSurvey("plan.png"),
        report: {
          client: "Acme",
          surveyDate: "24/11/2026",
          notes: "x".repeat(20_000),
          extra: 1,
        },
      },
      "plan.png",
    );
    expect(survey?.report.client).toBe("Acme");
    expect(survey?.report.surveyDate).toBe("");
    expect(survey?.report.notes).toHaveLength(10_000);
  });

  it("the settings patch takes the whole report, strictly", () => {
    const report = {
      ...defaultReportInfo(),
      client: "Acme",
      surveyDate: "2026-11-24",
    };
    expect(settingsPatchSchema.safeParse({ report }).success).toBe(true);
    expect(
      settingsPatchSchema.safeParse({
        report: { ...report, surveyDate: "soon" },
      }).success,
    ).toBe(false);
    expect(
      settingsPatchSchema.safeParse({ report: { client: "Acme" } }).success,
    ).toBe(false);
  });

  it("the profile takes a PNG or JPEG data URL, or no logo", () => {
    const ok = { companyName: " Example ", logo: "data:image/png;base64,AAAA" };
    expect(reportProfileSchema.parse(ok).companyName).toBe("Example");
    expect(reportProfileSchema.safeParse({ ...ok, logo: null }).success).toBe(
      true,
    );
    for (const logo of [
      "data:image/svg+xml;base64,AAAA",
      "https://example.com/logo.png",
      "data:image/png;base64,<script>",
    ]) {
      expect(reportProfileSchema.safeParse({ ...ok, logo }).success).toBe(
        false,
      );
    }
    expect(reportProfileFileSchema.parse({ logo: "nope" })).toEqual(
      defaultReportProfile(),
    );
  });
});
