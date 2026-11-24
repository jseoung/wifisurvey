/**
 * The access point map: what each layer draws, the region colours, and
 * the CSV naming the access point the same way the map does.
 */
import { describe, expect, it } from "vitest";
import {
  apMapParts,
  apRgb,
  isDimmed,
  roamNeedsAttention,
} from "@/lib/ap-map-draw";
import { AP_LAYERS, defaultApView } from "@/lib/ap-view";
import { surveyPointsToCsv } from "@/lib/exportCsv";
import { getDefaultIperfResults, getDefaultWifiResults } from "@/lib/utils";
import type { RoamEvent } from "@/lib/ap-association";
import type { AccessPoint, SurveyPoint } from "@/lib/types";

describe("apMapParts", () => {
  const view = defaultApView();

  it("only the association and roaming layers shade regions", () => {
    const shaded = AP_LAYERS.filter((l) => apMapParts(l, view).regions > 0);
    expect(shaded).toEqual(["association", "roaming"]);
    // roaming shades half as strongly, so the events stand out
    expect(apMapParts("roaming", view).regions).toBeCloseTo(
      apMapParts("association", view).regions / 2,
    );
  });

  it("the signal layers draw the heat map and its scale", () => {
    for (const layer of AP_LAYERS) {
      const p = apMapParts(layer, view);
      expect(p.signal).toBe(layer === "signal" || layer === "combined");
      expect(p.signalLegend).toBe(p.signal);
    }
  });

  it("follows the view's switches", () => {
    const off = {
      ...view,
      showBoundaries: false,
      showPoints: false,
      showRoaming: false,
      showMarkers: false,
    };
    const a = apMapParts("association", off);
    expect([a.boundaries, a.points, a.roaming, a.markers]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // the roaming layer always shows its events; the locations layer its markers
    expect(apMapParts("roaming", off).roaming).toBe(true);
    expect(apMapParts("locations", off).markers).toBe(true);
  });

  it("clamps the shading to 0..1", () => {
    expect(
      apMapParts("association", { ...view, regionOpacity: 3 }).regions,
    ).toBe(1);
    expect(
      apMapParts("association", { ...view, regionOpacity: -1 }).regions,
    ).toBe(0);
  });
});

describe("apRgb", () => {
  it("turns hues into the expected colours", () => {
    expect(apRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(apRgb(120, 1, 0.5)).toEqual([0, 255, 0]);
    expect(apRgb(240, 1, 0.5)).toEqual([0, 0, 255]);
  });
});

describe("roamNeedsAttention", () => {
  const event = (flags: RoamEvent["flags"]) => ({ flags }) as RoamEvent;
  it("flags late roams and ping-pongs only", () => {
    expect(roamNeedsAttention(event(["weak-before"]))).toBe(true);
    expect(roamNeedsAttention(event(["ping-pong"]))).toBe(true);
    expect(roamNeedsAttention(event(["long-gap"]))).toBe(false);
    expect(roamNeedsAttention(event([]))).toBe(false);
  });
});

describe("CSV access_point column", () => {
  const point = (id: string, bssid: string): SurveyPoint => ({
    id,
    x: 10,
    y: 10,
    timestamp: 1,
    isEnabled: true,
    iperfData: getDefaultIperfResults(),
    wifiData: { ...getDefaultWifiResults(), ssid: "Office", bssid },
  });
  const marker: AccessPoint = {
    id: "ap1",
    x: 0,
    y: 0,
    name: "Lobby",
    bssids: ["aabbcc000110"],
  };

  it("uses the marker's name, then the given name, else nothing", () => {
    const [header, ...rows] = surveyPointsToCsv(
      [
        point("a", "aa:bb:cc:00:01:10"),
        point("b", "aa:bb:cc:00:02:10"),
        point("c", "aa:bb:cc:00:03:10"),
        point("d", ""),
      ],
      [{ macAddress: "aa:bb:cc:00:02:10", apName: "Kitchen" }],
      [marker],
    )
      .trim()
      .split("\n")
      .map((line) => line.split(","));
    const col = header.indexOf("access_point");
    expect(rows.map((r) => r[col])).toEqual(["Lobby", "Kitchen", "", ""]);
  });
});

describe("isDimmed", () => {
  it("fades nothing until an access point is highlighted", () => {
    expect(isDimmed("ap:1", null)).toBe(false);
    expect(isDimmed(null, null)).toBe(false);
  });
  it("then fades every other access point and readings without a BSSID", () => {
    expect(isDimmed("ap:1", "ap:1")).toBe(false);
    expect(isDimmed("ap:2", "ap:1")).toBe(true);
    expect(isDimmed(null, "ap:1")).toBe(true);
  });
});
