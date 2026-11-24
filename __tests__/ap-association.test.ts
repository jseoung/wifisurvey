import { describe, expect, it } from "vitest";
import {
  apPalette,
  computeRegions,
  connectedBssid,
  detectRoaming,
  findIssues,
  identifyAp,
  inMeasuredOrder,
  likelySameDevice,
  nthApHue,
  regionBoundaries,
  regionSamples,
  summarizeAps,
} from "@/lib/ap-association";
import { AP_HUES } from "@/lib/apName";
import { getDefaultIperfResults, getDefaultWifiResults } from "@/lib/utils";
import type { AccessPoint, ApMapping, SurveyPoint } from "@/lib/types";

/**
 * A simulated survey: three access points broadcasting the same SSID
 * ("Office") along a corridor, each with a 2.4 and a 5 GHz radio whose
 * BSSIDs differ only in the last byte.
 */
const RADIOS = {
  west5: "aa:bb:cc:00:01:10",
  west24: "aa:bb:cc:00:01:11",
  mid5: "aa:bb:cc:00:02:10",
  mid24: "aa:bb:cc:00:02:11",
  east5: "aa:bb:cc:00:03:10",
  east24: "aa:bb:cc:00:03:11",
};

let clock = 1_700_000_000_000;
let num = 0;

function point(
  x: number,
  bssid: string,
  rssi: number,
  {
    band = 5,
    ssid = "Office",
    channel,
    y = 100,
  }: { band?: number; ssid?: string; channel?: number; y?: number } = {},
): SurveyPoint {
  channel ??= band === 5 ? 36 : 6;
  num++;
  clock += 30_000;
  return {
    id: `Point_${num}`,
    x,
    y,
    timestamp: clock,
    isEnabled: true,
    iperfData: getDefaultIperfResults(),
    wifiData: {
      ...getDefaultWifiResults(),
      ssid,
      bssid,
      rssi,
      signalStrength: Math.round(((rssi + 100) / 60) * 100),
      band,
      channel,
    },
  };
}

const markers: AccessPoint[] = [
  {
    id: "AP_1",
    x: 100,
    y: 100,
    name: "West",
    bssids: ["aabbcc000110", "aabbcc000111"],
  },
  { id: "AP_2", x: 500, y: 100, name: "Middle", bssids: ["aabbcc0002*"] },
  // East is placed but its BSSIDs are not assigned yet
  { id: "AP_3", x: 900, y: 100, name: "East" },
];

/** West -> Middle -> East, with a late roam, a band change and a ping-pong. */
function walk(): SurveyPoint[] {
  num = 0;
  return [
    point(100, RADIOS.west5, -45),
    point(200, RADIOS.west5, -58),
    point(300, RADIOS.west5, -70),
    point(400, RADIOS.west5, -79), // sticky: still on West
    point(450, RADIOS.mid5, -52), // late roam West -> Middle
    point(500, RADIOS.mid5, -44),
    point(560, RADIOS.mid24, -50, { band: 2.4 }), // band change on Middle
    point(620, RADIOS.mid5, -55),
    point(700, RADIOS.east5, -60), // roam Middle -> East (unassigned)
    point(720, RADIOS.mid5, -62), // straight back: ping-pong
    point(760, RADIOS.east5, -57), // and again
    point(800, "", -50), // macOS without Location access: no BSSID
    point(850, RADIOS.east5, -48),
  ];
}

describe("which access point served a reading", () => {
  it("never makes up a BSSID", () => {
    expect(connectedBssid({ bssid: "" })).toBeNull();
    expect(connectedBssid({ bssid: "<redacted>" })).toBeNull();
    expect(connectedBssid({ bssid: "00:00:00:00:00:00" })).toBeNull();
    expect(connectedBssid({ bssid: "AA-BB-CC-00-01-10" })).toBe("aabbcc000110");
    expect(identifyAp("", markers, [])).toBeNull();
  });

  it("a marker's BSSID wins, then a name, then the bare BSSID", () => {
    const mapping: ApMapping[] = [
      { apName: "Named", macAddress: "aabbcc000110" },
      { apName: "East names", macAddress: "aabbcc0003*" },
    ];
    expect(identifyAp(RADIOS.west5, markers, mapping)).toEqual({
      key: "ap:AP_1",
      name: "West",
      source: "marker",
      markerId: "AP_1",
    });
    // a prefix on a marker covers both radios
    expect(identifyAp(RADIOS.mid24, markers, mapping)?.key).toBe("ap:AP_2");
    expect(identifyAp(RADIOS.east5, markers, mapping)).toEqual({
      key: "name:East names",
      name: "East names",
      source: "name",
    });
    expect(identifyAp(RADIOS.east5, markers, [])).toEqual({
      key: "bssid:aabbcc000310",
      name: "AA-BB-CC-00-03-10",
      source: "bssid",
    });
  });

  it("an exact BSSID beats a prefix on another marker", () => {
    const aps: AccessPoint[] = [
      { id: "A", x: 0, y: 0, name: "Prefix", bssids: ["aabbcc0001*"] },
      { id: "B", x: 0, y: 0, name: "Exact", bssids: ["aabbcc000111"] },
    ];
    expect(identifyAp(RADIOS.west24, aps, [])?.name).toBe("Exact");
    expect(identifyAp(RADIOS.west5, aps, [])?.name).toBe("Prefix");
  });

  it("gives markers their colours first, then the others, sorted", () => {
    const palette = apPalette(walk(), markers, []);
    expect([...palette.keys()]).toEqual([
      "ap:AP_1",
      "ap:AP_2",
      "ap:AP_3",
      "bssid:aabbcc000310",
    ]);
    expect(palette.get("ap:AP_1")).toBe(AP_HUES[0]);
    // never runs out of colours
    const hues = Array.from({ length: 20 }, (_, i) => nthApHue(i));
    expect(new Set(hues).size).toBe(20);
  });
});

describe("roaming", () => {
  it("finds every change of BSSID, in measured order", () => {
    const events = detectRoaming(walk(), markers, []);
    expect(
      events.map((e) => [e.kind, e.from.name, e.to.name, e.flags]),
    ).toEqual([
      ["roam", "West", "Middle", ["weak-before"]],
      ["band-change", "Middle", "Middle", []],
      ["band-change", "Middle", "Middle", []],
      ["roam", "Middle", "AA-BB-CC-00-03-10", ["ping-pong"]],
      ["roam", "AA-BB-CC-00-03-10", "Middle", ["ping-pong"]],
      ["roam", "Middle", "AA-BB-CC-00-03-10", ["ping-pong"]],
    ]);
    const late = events[0];
    expect(late).toMatchObject({
      n: 1,
      fromPointId: "Point_4",
      toPointId: "Point_5",
      rssiBefore: -79,
      rssiAfter: -52,
      bandBefore: 5,
      bandAfter: 5,
      x: 425,
      y: 100,
    });
    expect(events[1]).toMatchObject({ bandBefore: 5, bandAfter: 2.4 });
  });

  it("orders by time, not by the order points are stored in", () => {
    const pts = walk();
    const shuffled = [pts[4], pts[0], pts[3], pts[2], pts[1]];
    expect(inMeasuredOrder(shuffled).map((p) => p.id)).toEqual([
      "Point_1",
      "Point_2",
      "Point_3",
      "Point_4",
      "Point_5",
    ]);
    expect(detectRoaming(shuffled, markers, [])).toHaveLength(1);
  });

  it("skips readings without a BSSID and says so", () => {
    num = 0;
    const pts = [
      point(0, RADIOS.west5, -50),
      point(10, "", -60),
      point(20, RADIOS.mid5, -55),
    ];
    const [e] = detectRoaming(pts, markers, []);
    expect(e.flags).toContain("unknown-between");
    expect(e.fromPointId).toBe("Point_1");
  });

  it("tells radios of one unassigned access point from a roam", () => {
    expect(likelySameDevice("aabbcc000310", "aabbcc000311")).toBe(true);
    expect(likelySameDevice("aabbcc000310", "a2bbcc000310")).toBe(true);
    expect(likelySameDevice("aabbcc000310", "aabbcc000210")).toBe(false);
    num = 0;
    const pts = [
      point(0, RADIOS.east5, -50),
      point(10, RADIOS.east24, -52, { band: 2.4 }),
    ];
    const [e] = detectRoaming(pts, [], []);
    expect(e.kind).toBe("band-change");
    expect(e.flags).toContain("inferred-same-ap");
  });

  it("a different SSID is a network change, and a long pause is flagged", () => {
    num = 0;
    const a = point(0, RADIOS.west5, -50);
    const b = point(10, RADIOS.mid5, -50, { ssid: "Guest" });
    b.timestamp = a.timestamp + 60 * 60 * 1000;
    const [e] = detectRoaming([a, b], markers, []);
    expect(e.kind).toBe("network-change");
    expect(e.flags).toContain("long-gap");
  });

  it("finds nothing on one access point", () => {
    num = 0;
    const pts = [point(0, RADIOS.west5, -50), point(10, RADIOS.west5, -60)];
    expect(detectRoaming(pts, markers, [])).toEqual([]);
  });
});

describe("summary per access point", () => {
  it("counts measurements, signal and roaming per access point", () => {
    const pts = walk();
    const events = detectRoaming(pts, markers, []);
    const palette = apPalette(pts, markers, []);
    const { aps, identified, unknown } = summarizeAps(
      pts,
      markers,
      [],
      events,
      palette,
    );
    expect(identified).toBe(12);
    expect(unknown).toBe(1);
    const by = Object.fromEntries(aps.map((a) => [a.name, a]));
    expect(by.West).toMatchObject({
      count: 4,
      percent: 33.3,
      minRssi: -79,
      maxRssi: -45,
      avgRssi: -63,
      bssids: ["aabbcc000110"],
      ssids: ["Office"],
      bands: [5],
      roamingEvents: 1,
      hue: palette.get("ap:AP_1"),
    });
    expect(by.Middle).toMatchObject({
      count: 5,
      bssids: ["aabbcc000210", "aabbcc000211"],
      bands: [2.4, 5],
      channels: [6, 36],
      // 1 roam in, 2 band changes (counted once each), 3 in the ping-pong
      roamingEvents: 6,
    });
    // a marker nothing connected to is still listed
    expect(by.East).toMatchObject({ count: 0, percent: 0, avgRssi: null });
    expect(by["AA-BB-CC-00-03-10"]).toMatchObject({
      count: 3,
      source: "bssid",
    });
    expect(aps.reduce((n, a) => n + a.percent, 0)).toBeCloseTo(100, 0);
  });

  it("points out late roams, ping-pong, distant access points and gaps", () => {
    const pts = walk();
    // assign East's BSSIDs: now distant-AP checks can use its position
    const all = markers.map((m) =>
      m.id === "AP_3" ? { ...m, bssids: ["aabbcc0003*"] } : m,
    );
    const events = detectRoaming(pts, all, []);
    const f = findIssues(pts, all, [], events);
    expect(f.roams).toBe(4);
    expect(f.bandChanges).toBe(2);
    expect(f.lateRoams.map((e) => e.n)).toEqual([1]);
    expect(f.pingPongs).toHaveLength(3);
    expect(f.weakPoints).toBe(1);
    expect(f.unknownBssid).toBe(1);
    // Point_4 (x 400) is on West (x 100) while Middle (x 500) is near
    expect(f.distantAp).toEqual([
      { pointId: "Point_4", connected: "West", nearer: "Middle", rssi: -79 },
    ]);
  });
});

describe("association regions", () => {
  const samples = [
    { x: 10, y: 10, key: "a" },
    { x: 90, y: 10, key: "b" },
  ];

  it("labels each cell with the nearest measurement's access point", () => {
    const g = computeRegions(samples, 100, 20, 60, 10);
    expect(g.cols).toBe(10);
    expect(g.rows).toBe(2);
    const row0 = Array.from(g.labels.slice(0, 10)).map((l) => g.keys[l]);
    expect(row0).toEqual(["a", "a", "a", "a", "a", "b", "b", "b", "b", "b"]);
  });

  it("leaves cells without a measurement in reach empty", () => {
    // cell centres at x 5, 15, 25, 35, …: 0, 10, 20, 30 px from the point
    const g = computeRegions([{ x: 5, y: 5, key: "a" }], 100, 10, 30, 10);
    expect(Array.from(g.labels)).toEqual([0, 0, 0, -1, -1, -1, -1, -1, -1, -1]);
    expect(g.conf[0]).toBe(1);
    expect(g.conf[1]).toBe(1); // within half the radius
    expect(g.conf[2]).toBeCloseTo(2 / 3); // fading towards the radius
  });

  it("draws a boundary only between two access points with data", () => {
    const far = [
      { x: 0, y: 10, key: "a" },
      { x: 100, y: 10, key: "b" },
    ];
    const g = computeRegions(far, 100, 20, 50, 10);
    const { solid, dashed } = regionBoundaries(g);
    // one vertical edge per row at x = 50
    expect([...solid, ...dashed]).toEqual([
      [50, 0, 50, 10],
      [50, 10, 50, 20],
    ]);
    // ~45 px from both measurements with a 50 px radius: estimated (dashed)
    expect(dashed).toHaveLength(2);
    // with a larger radius the data backs it: solid
    const near = computeRegions(far, 100, 20, 200, 10);
    expect(regionBoundaries(near).solid).toHaveLength(2);
    // nothing next to a hidden access point
    const hidden = regionBoundaries(g, new Set(["b"]));
    expect([...hidden.solid, ...hidden.dashed]).toEqual([]);
  });

  it("only uses points with a BSSID", () => {
    expect(regionSamples(walk(), markers, [])).toHaveLength(12);
  });

  it("stays fast on a large survey", () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({
      x: (i * 37) % 2000,
      y: (i * 53) % 1500,
      key: `k${i % 6}`,
    }));
    const t = performance.now();
    const g = computeRegions(many, 2000, 1500, 120);
    regionBoundaries(g);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
