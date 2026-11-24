"use client";
import React, { useEffect, useState } from "react";
import * as Slider from "@radix-ui/react-slider";

import { useSettings } from "@/components/GlobalSettings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { PopoverHelper } from "@/components/PopoverHelpText";
import {
  apPalette,
  detectRoaming,
  findIssues,
  inMeasuredOrder,
  ROAM_FLAG_TITLES,
  ROAM_KIND_TITLES,
  summarizeAps,
  type RoamEvent,
} from "@/lib/ap-association";
import {
  AP_LAYER_TITLES,
  AP_LAYERS,
  HIDDEN_APS_MAX,
  type ApLayer,
  type ApView,
} from "@/lib/ap-view";
import {
  renderApMap,
  roamNeedsAttention,
  SIGNAL_SCALE_KEY,
} from "@/lib/ap-map-draw";
import { formatMacAddress } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { SurveyPoint } from "@/lib/types";
import { ApChip } from "./ApChip";
import HeatmapImage from "./HeatmapImage";
import HeatmapModal from "./HeatmapModal";

const LAYER_HELP: Record<ApLayer, string> = {
  signal: "The signal heat map, with the access point markers.",
  association:
    "Shaded by the access point the device was connected to. Lines separate areas served by different access points; dashed where the line is an estimate between measurements.",
  combined:
    "The signal heat map with the association boundaries and measurements drawn on top.",
  roaming:
    "Where the device changed access point, band or radio, numbered in the order measured, with the walking route.",
  locations:
    "Where the access points are, and which one each measurement used.",
};

const dbm = (v: number | null) => (v === null ? "–" : `${v} dBm`);
const bandText = (bands: readonly number[]) =>
  bands.length ? bands.map((b) => `${b} GHz`).join(", ") : "–";

/**
 * The access point map on the Heat maps tab: which access point served
 * the device where, where it roamed, and a summary per access point. It
 * uses only the BSSID each measurement was connected to; measurements
 * without one are counted, never guessed.
 */
export function ApMapPanel({
  points,
  radius,
}: {
  /** the enabled measurements */
  points: SurveyPoint[];
  /** the heat map radius, also how far a measurement's region reaches */
  radius: number;
}) {
  const { settings, updateSettings } = useSettings();
  const view = settings.apView;
  const { accessPoints, apMapping } = settings;

  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  // the access point whose readings are highlighted (not saved)
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const palette = apPalette(points, accessPoints, apMapping);
  const events = detectRoaming(points, accessPoints, apMapping);
  const summary = summarizeAps(
    points,
    accessPoints,
    apMapping,
    events,
    palette,
  );
  const findings = findIssues(points, accessPoints, apMapping, events);
  const hidden = new Set(view.hiddenAps);
  // a highlight ends when its access point is hidden or gone
  const focus =
    focusKey !== null &&
    !hidden.has(focusKey) &&
    summary.aps.some((a) => a.key === focusKey)
      ? focusKey
      : null;
  const focusedAp = summary.aps.find((a) => a.key === focus);

  useEffect(() => {
    let cancelled = false;
    const pts = points;
    const pal = apPalette(pts, accessPoints, apMapping);
    const ev = detectRoaming(pts, accessPoints, apMapping);
    const sum = summarizeAps(pts, accessPoints, apMapping, ev, pal);
    renderApMap({
      layer: view.layer,
      view,
      width: settings.dimensions.width,
      height: settings.dimensions.height,
      floorplanSrc: settings.floorplanImagePath,
      floorplanName: settings.floorplanImageName,
      points: pts,
      ordered: inMeasuredOrder(pts),
      accessPoints,
      apMapping,
      palette: pal,
      events: ev,
      summary: sum.aps,
      unknown: sum.unknown,
      radius,
      gradient: settings.gradient,
      minOpacity: settings.minOpacity,
      maxOpacity: settings.maxOpacity,
      signalScale: settings.heatmapRanges?.[SIGNAL_SCALE_KEY],
      focus,
    }).then((url) => {
      if (cancelled) return;
      setSrc(url);
      setFailed(url === null);
    });
    return () => {
      cancelled = true;
    };
  }, [
    points,
    accessPoints,
    apMapping,
    view,
    radius,
    settings.dimensions,
    settings.floorplanImagePath,
    settings.floorplanImageName,
    settings.gradient,
    settings.minOpacity,
    settings.maxOpacity,
    settings.heatmapRanges,
    focus,
  ]);

  const setView = (change: Partial<ApView>) =>
    updateSettings((prev) => ({ apView: { ...prev.apView, ...change } }));

  const toggleAp = (key: string, visible: boolean) =>
    updateSettings((prev) => {
      const rest = prev.apView.hiddenAps.filter((k) => k !== key);
      return {
        apView: {
          ...prev.apView,
          hiddenAps: visible ? rest : [...rest, key].slice(-HIDDEN_APS_MAX),
        },
      };
    });

  const title = AP_LAYER_TITLES[view.layer];
  const usesRegions = view.layer === "association" || view.layer === "roaming";
  const usesBoundaries = usesRegions || view.layer === "combined";
  const usesPoints = view.layer !== "signal";
  const usesRoaming = view.layer === "association" || view.layer === "combined";
  const pointsById = new Map(points.map((p) => [p.id, p]));
  const pointName = (id: string) => {
    const p = pointsById.get(id);
    return p?.label || id;
  };

  const switchRow = (
    id: string,
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
  ) => (
    <label key={id} className="flex items-center gap-2.5 text-sm">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        data-testid={id}
      />
      {label}
    </label>
  );

  return (
    <section className="space-y-4 border-t pt-6" data-testid="ap-map">
      <div>
        <h2 className="text-lg font-semibold">Access point map</h2>
        <p className="text-sm text-muted-foreground">
          Which access point served the device at each spot, and where it
          roamed. Worked out from the BSSID it was connected to, never from the
          strongest one nearby.
        </p>
      </div>

      {summary.identified === 0 && (
        <p
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
          data-testid="ap-map-no-bssid"
        >
          None of the measurements in use has a BSSID, so the map can&apos;t
          show which access point served the device. Nothing is guessed. On
          macOS, allow Location access for the app (see the Wi-Fi notice on the
          Floor plan tab); other systems report it when Wi-Fi is connected.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="space-y-5 lg:sticky lg:top-30 lg:self-start">
          <div className="grid gap-1.5">
            <div className="flex items-center gap-1.5">
              <label htmlFor="ap-map-layer" className="text-sm font-medium">
                Layer
              </label>
              <PopoverHelper text={LAYER_HELP[view.layer]} />
            </div>
            <select
              id="ap-map-layer"
              value={view.layer}
              onChange={(e) => setView({ layer: e.target.value as ApLayer })}
              data-testid="ap-map-layer"
              className="h-9 w-full rounded-md border border-input bg-surface px-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              {AP_LAYERS.map((layer) => (
                <option key={layer} value={layer}>
                  {AP_LAYER_TITLES[layer]}
                </option>
              ))}
            </select>
          </div>

          {usesRegions && (
            <div className="space-y-2" data-testid="ap-region-opacity">
              <div className="flex items-center">
                <span
                  id="ap-region-opacity-label"
                  className="text-sm font-medium"
                >
                  Shading
                </span>
                <span className="tabular ml-auto text-sm text-muted-foreground">
                  {Math.round(view.regionOpacity * 100)}%
                </span>
              </div>
              <Slider.Root
                className="relative flex h-5 w-full touch-none select-none items-center"
                min={0}
                max={100}
                step={5}
                value={[Math.round(view.regionOpacity * 100)]}
                onValueChange={(v) => setView({ regionOpacity: v[0] / 100 })}
                aria-labelledby="ap-region-opacity-label"
              >
                <Slider.Track className="relative h-1.5 grow rounded-full bg-secondary">
                  <Slider.Range className="absolute h-full rounded-full bg-brand" />
                </Slider.Track>
                <Slider.Thumb
                  className="block h-4 w-4 rounded-full border-2 border-brand bg-white shadow-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-label="How strongly the areas are shaded"
                />
              </Slider.Root>
            </div>
          )}

          <div className="space-y-2">
            {usesBoundaries &&
              switchRow(
                "ap-show-boundaries",
                "Boundaries",
                view.showBoundaries,
                (v) => setView({ showBoundaries: v }),
              )}
            {usesPoints &&
              switchRow(
                "ap-show-points",
                "Measurements",
                view.showPoints,
                (v) => setView({ showPoints: v }),
              )}
            {usesRoaming &&
              switchRow(
                "ap-show-roaming",
                "Roaming events",
                view.showRoaming,
                (v) => setView({ showRoaming: v }),
              )}
            {view.layer !== "locations" &&
              switchRow(
                "ap-show-markers",
                "Access point markers",
                view.showMarkers,
                (v) => setView({ showMarkers: v }),
              )}
          </div>

          <p className="text-xs text-muted-foreground">
            The areas reach as far as the heat map radius above. Beyond that
            there is no data, so nothing is shaded.
          </p>
        </aside>

        <div className="min-w-0">
          {src ? (
            <figure className="space-y-1.5" data-testid="ap-map-image">
              <HeatmapImage
                src={src}
                alt={title}
                onClick={() => setEnlarged(true)}
              />
              {focusedAp && (
                <div
                  className="flex flex-wrap items-center gap-2 text-sm"
                  data-testid="ap-map-highlight"
                >
                  <span className="text-muted-foreground">Highlighting</span>
                  <ApChip
                    hue={focusedAp.hue}
                    mono={focusedAp.source === "bssid"}
                  >
                    {focusedAp.name}
                  </ApChip>
                  <span className="text-muted-foreground">
                    {focusedAp.count} measurement
                    {focusedAp.count === 1 ? "" : "s"}
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setFocusKey(null)}
                    data-testid="ap-map-show-all"
                  >
                    Show all
                  </Button>
                </div>
              )}
              <figcaption className="flex items-baseline justify-between text-sm">
                <span className="font-medium">{title}</span>
                <span className="tabular text-xs text-muted-foreground">
                  {events.length} roaming event{events.length === 1 ? "" : "s"}
                </span>
              </figcaption>
            </figure>
          ) : (
            <div
              className={cn(
                "aspect-4/3 rounded-md border",
                failed
                  ? "flex items-end border-dashed p-4"
                  : "animate-pulse bg-muted",
              )}
            >
              {failed && (
                <p className="text-sm text-muted-foreground">
                  Could not draw this map.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <ApSummaryTable
        rows={summary.aps}
        unknown={summary.unknown}
        hidden={hidden}
        onToggle={toggleAp}
        focus={focus}
        onFocus={(key) => setFocusKey(key === focus ? null : key)}
      />

      <Findings findings={findings} />

      <RoamingList events={events} pointName={pointName} />

      <HeatmapModal
        src={src ?? ""}
        alt={title}
        open={enlarged && src !== null}
        onClose={() => setEnlarged(false)}
      />
    </section>
  );
}

function ApSummaryTable({
  rows,
  unknown,
  hidden,
  onToggle,
  focus,
  onFocus,
}: {
  rows: ReturnType<typeof summarizeAps>["aps"];
  unknown: number;
  hidden: ReadonlySet<string>;
  onToggle: (key: string, visible: boolean) => void;
  /** the highlighted access point, or null */
  focus: string | null;
  /** highlight this access point's readings, or stop if it already is */
  onFocus: (key: string) => void;
}) {
  if (!rows.length) return null;
  const th = "px-2 py-1.5 text-left text-xs font-medium text-muted-foreground";
  const td = "px-2 py-1.5 align-top";
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-medium">Access points</h3>
      <p className="text-xs text-muted-foreground">
        Click an access point to highlight its measurements on the map.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="ap-summary">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className={th}>Show</th>
              <th className={th}>Access point</th>
              <th className={th}>BSSIDs</th>
              <th className={th}>Network</th>
              <th className={th}>Bands</th>
              <th className={th}>Channels</th>
              <th className={cn(th, "text-right")}>Measurements</th>
              <th className={cn(th, "text-right")}>Average</th>
              <th className={cn(th, "text-right")}>Weakest</th>
              <th className={cn(th, "text-right")}>Strongest</th>
              <th className={cn(th, "text-right")}>Roaming events</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((ap) => (
              <tr
                key={ap.key}
                className={cn(
                  "border-b last:border-b-0",
                  !hidden.has(ap.key) && "cursor-pointer hover:bg-muted/40",
                  focus === ap.key && "bg-brand-soft/60 hover:bg-brand-soft/60",
                )}
                onClick={() => {
                  if (!hidden.has(ap.key)) onFocus(ap.key);
                }}
                data-testid="ap-summary-row"
                data-highlighted={focus === ap.key ? "true" : undefined}
              >
                <td className={td} onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={!hidden.has(ap.key)}
                    onCheckedChange={(v) => onToggle(ap.key, v === true)}
                    aria-label={`Show ${ap.name} on the map`}
                  />
                </td>
                <td className={td}>
                  <button
                    type="button"
                    className="max-w-full rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFocus(ap.key);
                    }}
                    disabled={hidden.has(ap.key)}
                    aria-pressed={focus === ap.key}
                    title={
                      focus === ap.key
                        ? "Show all access points"
                        : `Highlight the measurements on ${ap.name}`
                    }
                    data-testid="ap-summary-highlight"
                  >
                    <ApChip hue={ap.hue} mono={ap.source === "bssid"}>
                      {ap.name}
                    </ApChip>
                  </button>
                </td>
                <td className={cn(td, "font-mono text-xs")}>
                  {ap.bssids.length
                    ? ap.bssids.map((b) => (
                        <div key={b}>{formatMacAddress(b)}</div>
                      ))
                    : "–"}
                </td>
                <td className={td}>{ap.ssids.join(", ") || "–"}</td>
                <td className={cn(td, "whitespace-nowrap")}>
                  {bandText(ap.bands)}
                </td>
                <td className={td}>{ap.channels.join(", ") || "–"}</td>
                <td className={cn(td, "tabular text-right whitespace-nowrap")}>
                  {ap.count} ({ap.percent}%)
                </td>
                <td className={cn(td, "tabular text-right whitespace-nowrap")}>
                  {dbm(ap.avgRssi)}
                </td>
                <td className={cn(td, "tabular text-right whitespace-nowrap")}>
                  {dbm(ap.minRssi)}
                </td>
                <td className={cn(td, "tabular text-right whitespace-nowrap")}>
                  {dbm(ap.maxRssi)}
                </td>
                <td className={cn(td, "tabular text-right")}>
                  {ap.roamingEvents}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unknown > 0 && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="ap-summary-unknown"
        >
          {unknown} measurement{unknown === 1 ? "" : "s"} without a BSSID{" "}
          {unknown === 1 ? "is" : "are"} left out. The percentages are of the
          measurements that have one.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        To group several BSSIDs as one access point, list them on its marker
        (Floor plan tab) or give them the same name under Access point names in
        Settings.
      </p>
    </div>
  );
}

function Findings({ findings }: { findings: ReturnType<typeof findIssues> }) {
  const items: string[] = [];
  const n = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  if (findings.lateRoams.length) {
    items.push(
      `${n(findings.lateRoams.length, "roam", "roams")} only after the signal was weak (${findings.lateRoams.map((e) => `#${e.n}`).join(", ")}): the device may be holding on too long.`,
    );
  }
  if (findings.pingPongs.length) {
    items.push(
      `${n(findings.pingPongs.length, "roam went", "roams went")} straight back to the access point just left (${findings.pingPongs.map((e) => `#${e.n}`).join(", ")}): the coverage overlaps a lot there.`,
    );
  }
  if (findings.distantAp.length) {
    items.push(
      `${n(findings.distantAp.length, "measurement was", "measurements were")} connected to a distant access point with a weak signal while another marker is much closer.`,
    );
  }
  if (findings.weakPoints) {
    items.push(
      `${n(findings.weakPoints, "measurement has", "measurements have")} a weak signal (below -76 dBm).`,
    );
  }
  if (!items.length) return null;
  return (
    <div className="space-y-1.5" data-testid="ap-findings">
      <h3 className="text-sm font-medium">Worth a look</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function RoamingList({
  events,
  pointName,
}: {
  events: readonly RoamEvent[];
  pointName: (id: string) => string;
}) {
  if (!events.length) return null;
  const band = (b: number) => (b ? `${b} GHz` : "?");
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-medium">Roaming events</h3>
      <ol
        className="divide-y rounded-md border text-sm"
        data-testid="ap-roaming-list"
      >
        {events.map((e) => (
          <li
            key={e.n}
            className="grid gap-0.5 px-3 py-2"
            data-testid="ap-roaming-event"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={cn(
                  "tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold text-white",
                  roamNeedsAttention(e)
                    ? "bg-warning"
                    : "bg-foreground text-background",
                )}
              >
                {e.n}
              </span>
              <span className="font-medium">{ROAM_KIND_TITLES[e.kind]}</span>
              <span className="text-muted-foreground">
                {e.from.name} → {e.to.name}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {pointName(e.fromPointId)} → {pointName(e.toPointId)} · signal{" "}
              {dbm(e.rssiBefore)} → {dbm(e.rssiAfter)} · {band(e.bandBefore)} ch{" "}
              {e.channelBefore || "?"} → {band(e.bandAfter)} ch{" "}
              {e.channelAfter || "?"}
              {e.timestamp > 0 &&
                ` · ${new Date(e.timestamp).toLocaleString()}`}
            </div>
            {e.flags.length > 0 && (
              <div className="text-xs text-warning">
                {e.flags.map((f) => ROAM_FLAG_TITLES[f]).join(" · ")}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
