/**
 * ap-map-draw.ts - draws the access point map: which access point served
 * the device where, the boundaries between them, roaming events and the
 * markers, over the floor plan or the signal heat map.
 *
 * The geometry (regions, boundaries, roaming) comes from ap-association.ts;
 * this file only paints it. `apMapParts` says what each layer shows and is
 * pure, so it is unit tested; the rest needs a browser canvas.
 */
import createHeatmapWebGLRenderer from "@/app/webGL/renderers/mainRenderer";
import {
  computeRegions,
  identifyAp,
  regionBoundaries,
  regionSamples,
  ROAM_KIND_TITLES,
  type ApSummary,
  type RegionGrid,
  type RoamEvent,
  type Segment,
} from "./ap-association";
import { accessPointName, drawAccessPointMarker } from "./access-points";
import { AP_LAYER_TITLES, type ApLayer, type ApView } from "./ap-view";
import { heatmapKey, resolveHeatmapRange } from "./heatmap-scale";
import { getColorAt, objectToRGBAString } from "./utils-gradient";
import type {
  AccessPoint,
  ApMapping,
  Gradient,
  HeatmapScale,
  SurveyPoint,
} from "./types";

/* ---------- what each layer shows ---------- */

export interface ApMapParts {
  /** the signal heat map under everything, instead of the bare floor plan */
  signal: boolean;
  /** shaded association regions; the number is how strong, 0..1 */
  regions: number;
  boundaries: boolean;
  points: boolean;
  /** the walk from one reading to the next, as a faint line */
  path: boolean;
  roaming: boolean;
  markers: boolean;
  /** the signal colour scale in the legend */
  signalLegend: boolean;
  /** the access points (colours) in the legend */
  apLegend: boolean;
}

/** What a layer draws, after the view's switches. */
export function apMapParts(layer: ApLayer, view: ApView): ApMapParts {
  const opacity = Math.min(1, Math.max(0, view.regionOpacity));
  switch (layer) {
    case "signal":
      return {
        signal: true,
        regions: 0,
        boundaries: false,
        points: false,
        path: false,
        roaming: false,
        markers: view.showMarkers,
        signalLegend: true,
        apLegend: false,
      };
    case "association":
      return {
        signal: false,
        regions: opacity,
        boundaries: view.showBoundaries,
        points: view.showPoints,
        path: false,
        roaming: view.showRoaming,
        markers: view.showMarkers,
        signalLegend: false,
        apLegend: true,
      };
    case "combined":
      return {
        signal: true,
        regions: 0,
        boundaries: view.showBoundaries,
        points: view.showPoints,
        path: false,
        roaming: view.showRoaming,
        markers: view.showMarkers,
        signalLegend: true,
        apLegend: true,
      };
    case "roaming":
      return {
        signal: false,
        // faint, so the events stand out
        regions: opacity / 2,
        boundaries: view.showBoundaries,
        points: view.showPoints,
        path: true,
        roaming: true,
        markers: view.showMarkers,
        signalLegend: false,
        apLegend: true,
      };
    case "locations":
      return {
        signal: false,
        regions: 0,
        boundaries: false,
        points: view.showPoints,
        path: false,
        roaming: false,
        markers: true,
        signalLegend: false,
        apLegend: true,
      };
  }
}

/* ---------- colours ---------- */

/** An access point's hue as [r, g, b], 0..255 (the region fill). */
export function apRgb(hue: number, s = 0.7, l = 0.5): [number, number, number] {
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [
    number,
    number,
    number,
  ];
}

/** A measurement dot or boundary in the access point's colour. */
const apDot = (hue: number) => `hsl(${hue} 70% 46%)`;

/** Roaming event markers: amber when something looks wrong, else dark. */
const ROAM_OK = "#14181f";
const ROAM_WARN = "#b45309";

/* ---------- highlighting one access point ---------- */

/** How much of everything else shows while one access point is highlighted. */
export const DIMMED_ALPHA = 0.25;

/**
 * Is `key` faded out because another access point is highlighted? Readings
 * without a BSSID (key null) fade too.
 */
export const isDimmed = (key: string | null, focus: string | null) =>
  focus !== null && key !== focus;

/* ---------- painting ---------- */

const FONT = "ui-sans-serif, system-ui, sans-serif";

/** Shade each cell with its access point's colour; less where it is estimated. */
function drawRegions(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  grid: RegionGrid,
  palette: Map<string, number>,
  hidden: ReadonlySet<string>,
  opacity: number,
  focus: string | null,
) {
  const { cols, rows, cell, labels, conf, keys } = grid;
  const img = new ImageData(cols, rows);
  const rgb = keys.map((k) =>
    hidden.has(k) ? null : apRgb(palette.get(k) ?? 220),
  );
  const strength = keys.map((k) =>
    isDimmed(k, focus) ? opacity * DIMMED_ALPHA : opacity,
  );
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label < 0) continue;
    const c = rgb[label];
    if (!c) continue;
    const j = i * 4;
    img.data[j] = c[0];
    img.data[j + 1] = c[1];
    img.data[j + 2] = c[2];
    // estimated areas fade out: at most 40% as strong as confirmed ones
    img.data[j + 3] = Math.round(255 * strength[label] * (0.4 + 0.6 * conf[i]));
  }
  const tile = document.createElement("canvas");
  tile.width = cols;
  tile.height = rows;
  tile.getContext("2d")?.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tile, ox, oy, cols * cell, rows * cell);
  ctx.restore();
}

function strokeSegments(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  segments: readonly Segment[],
) {
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    ctx.moveTo(ox + x1, oy + y1);
    ctx.lineTo(ox + x2, oy + y2);
  }
  ctx.stroke();
}

/**
 * Boundary lines: solid where both sides were measured, dashed where the
 * line is an estimate. A white halo keeps them readable over any plan.
 */
function drawBoundaries(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  grid: RegionGrid,
  hidden: ReadonlySet<string>,
  width: number,
) {
  const { solid, dashed } = regionBoundaries(grid, hidden);
  ctx.save();
  ctx.lineCap = "square";
  const styles: [Segment[], number[]][] = [
    [solid, []],
    [dashed, [width * 2.5, width * 2]],
  ];
  for (const [segs, dash] of styles) {
    if (!segs.length) continue;
    ctx.setLineDash(dash);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = width * 2.2;
    strokeSegments(ctx, ox, oy, segs);
    ctx.strokeStyle = "rgba(20,24,31,0.85)";
    ctx.lineWidth = width;
    strokeSegments(ctx, ox, oy, segs);
  }
  ctx.restore();
}

/** Measurements as dots in their access point's colour; hollow grey when no BSSID was reported. */
function drawPoints(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  points: readonly SurveyPoint[],
  keyOf: (p: SurveyPoint) => string | null,
  palette: Map<string, number>,
  hidden: ReadonlySet<string>,
  r: number,
  focus: string | null,
) {
  ctx.save();
  // the highlighted access point's readings last, so they sit on top
  const ordered = [...points].sort(
    (a, b) =>
      Number(!isDimmed(keyOf(a), focus)) - Number(!isDimmed(keyOf(b), focus)),
  );
  for (const p of ordered) {
    const key = keyOf(p);
    if (key && hidden.has(key)) continue;
    const dim = isDimmed(key, focus);
    const lit = focus !== null && !dim;
    ctx.globalAlpha = dim ? DIMMED_ALPHA : 1;
    if (lit) {
      // a dark ring around each reading of the highlighted access point
      ctx.beginPath();
      ctx.arc(ox + p.x, oy + p.y, r * 1.9, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, r * 0.4);
      ctx.strokeStyle = "rgba(20,24,31,0.85)";
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(ox + p.x, oy + p.y, lit ? r * 1.35 : r, 0, Math.PI * 2);
    if (key) {
      const hue = palette.get(key) ?? 220;
      ctx.fillStyle = apDot(hue);
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.35);
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.35);
      ctx.strokeStyle = "#6b7280";
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The order the readings were taken in, as a faint line. */
function drawPath(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  ordered: readonly SurveyPoint[],
  width: number,
) {
  if (ordered.length < 2) return;
  ctx.save();
  ctx.strokeStyle = "rgba(20,24,31,0.35)";
  ctx.lineWidth = width;
  ctx.setLineDash([width * 3, width * 2]);
  ctx.beginPath();
  ctx.moveTo(ox + ordered[0].x, oy + ordered[0].y);
  for (const p of ordered.slice(1)) ctx.lineTo(ox + p.x, oy + p.y);
  ctx.stroke();
  ctx.restore();
}

/** Does this roaming event deserve a second look? */
export const roamNeedsAttention = (e: RoamEvent) =>
  e.flags.includes("weak-before") || e.flags.includes("ping-pong");

/**
 * A roaming event: an arrow from the last reading on the old access point
 * to the first on the new one, and a numbered badge half way. Band and
 * radio changes on one access point get a square badge, roams a circle.
 */
function drawRoamEvents(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  events: readonly RoamEvent[],
  pointsById: Map<string, SurveyPoint>,
  size: number,
  focus: string | null,
) {
  ctx.save();
  for (const e of events) {
    ctx.globalAlpha =
      isDimmed(e.from.key, focus) && isDimmed(e.to.key, focus)
        ? DIMMED_ALPHA
        : 1;
    const a = pointsById.get(e.fromPointId);
    const b = pointsById.get(e.toPointId);
    const colour = roamNeedsAttention(e) ? ROAM_WARN : ROAM_OK;
    if (a && b) {
      const ax = ox + a.x;
      const ay = oy + a.y;
      const bx = ox + b.x;
      const by = oy + b.y;
      const len = Math.hypot(bx - ax, by - ay);
      if (len > size) {
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        // stop short of the dots at both ends
        const sx = ax + ux * size * 0.45;
        const sy = ay + uy * size * 0.45;
        const ex = bx - ux * size * 0.45;
        const ey = by - uy * size * 0.45;
        ctx.strokeStyle = colour;
        ctx.fillStyle = colour;
        ctx.lineWidth = Math.max(1.5, size * 0.12);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        const head = size * 0.45;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(
          ex - ux * head - uy * head * 0.55,
          ey - uy * head + ux * head * 0.55,
        );
        ctx.lineTo(
          ex - ux * head + uy * head * 0.55,
          ey - uy * head - ux * head * 0.55,
        );
        ctx.closePath();
        ctx.fill();
      }
    }
    // the numbered badge
    const cx = ox + e.x;
    const cy = oy + e.y;
    const half = size / 2;
    ctx.beginPath();
    if (e.kind === "roam" || e.kind === "network-change") {
      ctx.arc(cx, cy, half, 0, Math.PI * 2);
    } else {
      ctx.roundRect(cx - half, cy - half, size, size, size * 0.2);
    }
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, size * 0.1);
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(size * 0.55)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(e.n), cx, cy + size * 0.03);
  }
  ctx.restore();
}

/** Cut a name to fit the legend. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > width)
    t = t.slice(0, -1);
  return `${t}…`;
}

interface LegendInput {
  parts: ApMapParts;
  gradient: Gradient;
  summary: readonly ApSummary[];
  hidden: ReadonlySet<string>;
  unknown: number;
  hasEstimated: boolean;
}

/** The legend column right of the plan: signal scale, access points, symbols. */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fontPx: number,
  { parts, gradient, summary, hidden, unknown, hasEstimated }: LegendInput,
) {
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const line = Math.round(fontPx * 1.5);
  let cy = y;
  const heading = (text: string) => {
    ctx.fillStyle = "#14181f";
    ctx.font = `600 ${fontPx}px ${FONT}`;
    ctx.fillText(text, x, cy + line / 2);
    cy += line;
  };
  const row = (
    swatch: (sx: number, sy: number, s: number) => void,
    text: string,
  ) => {
    const s = Math.round(fontPx * 0.95);
    swatch(x, cy + (line - s) / 2, s);
    ctx.fillStyle = "#14181f";
    ctx.font = `${Math.round(fontPx * 0.9)}px ${FONT}`;
    ctx.fillText(
      fit(ctx, text, width - s - fontPx * 0.6),
      x + s + fontPx * 0.5,
      cy + line / 2,
    );
    cy += line;
  };

  if (parts.signalLegend) {
    heading("Signal");
    const barH = Math.round(Math.min(height * 0.3, fontPx * 8));
    const barW = Math.round(fontPx * 1.2);
    for (let i = 0; i < barH; i++) {
      ctx.fillStyle = objectToRGBAString({
        ...getColorAt((barH - i) / barH, gradient),
        a: 1,
      });
      ctx.fillRect(x, cy + i, barW, 1);
    }
    ctx.strokeStyle = "rgba(20,24,33,0.25)";
    ctx.strokeRect(x + 0.5, cy + 0.5, barW - 1, barH - 1);
    ctx.fillStyle = "#14181f";
    ctx.font = `${Math.round(fontPx * 0.85)}px ${FONT}`;
    ctx.fillText("strong", x + barW + fontPx * 0.4, cy + fontPx * 0.5);
    ctx.fillText("weak", x + barW + fontPx * 0.4, cy + barH - fontPx * 0.5);
    cy += barH + line / 2;
  }

  if (parts.apLegend) {
    heading("Access points");
    const shown = summary.filter(
      (s) => !hidden.has(s.key) && (s.count > 0 || s.source === "marker"),
    );
    const room = Math.max(1, Math.floor((y + height - cy) / line) - 5);
    for (const ap of shown.slice(0, room)) {
      row(
        (sx, sy, s) => {
          ctx.fillStyle = apDot(ap.hue);
          ctx.beginPath();
          ctx.roundRect(sx, sy, s, s, s * 0.25);
          ctx.fill();
        },
        ap.count ? `${ap.name} (${ap.count})` : ap.name,
      );
    }
    if (shown.length > room) {
      ctx.fillStyle = "#6b7280";
      ctx.font = `${Math.round(fontPx * 0.85)}px ${FONT}`;
      ctx.fillText(`+${shown.length - room} more`, x, cy + line / 2);
      cy += line;
    }
    if (unknown && parts.points) {
      row((sx, sy, s) => {
        ctx.beginPath();
        ctx.arc(sx + s / 2, sy + s / 2, s * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = Math.max(1, s * 0.15);
        ctx.strokeStyle = "#6b7280";
        ctx.stroke();
      }, `No BSSID reported (${unknown})`);
    }
    if (parts.boundaries && hasEstimated) {
      row((sx, sy, s) => {
        ctx.strokeStyle = "#14181f";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(sx, sy + s / 2);
        ctx.lineTo(sx + s, sy + s / 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }, "Estimated boundary");
    }
    if (parts.roaming) {
      row(
        (sx, sy, s) => {
          ctx.fillStyle = ROAM_OK;
          ctx.beginPath();
          ctx.arc(sx + s / 2, sy + s / 2, s / 2, 0, Math.PI * 2);
          ctx.fill();
        },
        ROAM_KIND_TITLES.roam.replace(" to another access point", ""),
      );
      row((sx, sy, s) => {
        ctx.fillStyle = ROAM_OK;
        ctx.beginPath();
        ctx.roundRect(sx, sy, s, s, s * 0.2);
        ctx.fill();
      }, "Band or radio change");
      row((sx, sy, s) => {
        ctx.fillStyle = ROAM_WARN;
        ctx.beginPath();
        ctx.arc(sx + s / 2, sy + s / 2, s / 2, 0, Math.PI * 2);
        ctx.fill();
      }, "Late roam or ping-pong");
    }
  }
  ctx.restore();
}

/** Load the floor plan image. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/* ---------- the whole picture ---------- */

export interface ApMapScene {
  layer: ApLayer;
  view: ApView;
  width: number;
  height: number;
  floorplanSrc: string;
  floorplanName: string;
  /** the enabled measurements */
  points: readonly SurveyPoint[];
  /** the same, in the order they were measured (ap-association.ts inMeasuredOrder) */
  ordered: readonly SurveyPoint[];
  accessPoints: readonly AccessPoint[];
  apMapping: readonly ApMapping[];
  palette: Map<string, number>;
  events: readonly RoamEvent[];
  summary: readonly ApSummary[];
  unknown: number;
  /** how far a measurement's region reaches, floor plan px (the heat map radius) */
  radius: number;
  gradient: Gradient;
  minOpacity: number;
  maxOpacity: number;
  signalScale: HeatmapScale | undefined;
  /** the access point (key) to highlight, or null for none */
  focus: string | null;
}

/**
 * Draw the access point map, with a legend and caption so a downloaded
 * image explains itself. A PNG data URL, or null if it can't be drawn.
 */
export async function renderApMap(scene: ApMapScene): Promise<string | null> {
  const { width: W, height: H, layer, view } = scene;
  if (W <= 1 || H <= 1) return null;
  const parts = apMapParts(layer, view);
  const hidden = new Set(view.hiddenAps);

  const fontPx = Math.max(13, Math.round(Math.min(W, H) * 0.022));
  const legendWidth = Math.round(fontPx * 13);
  const captionH = Math.round(fontPx * 2.2);
  const margin = Math.round(fontPx * 1.2);

  const out = document.createElement("canvas");
  out.width = W + margin * 3 + legendWidth;
  out.height = H + margin * 2 + captionH;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);

  // the floor plan, or the signal heat map drawn over it
  try {
    if (parts.signal) {
      const data = scene.points.map((p) => ({
        x: p.x,
        y: p.y,
        value: p.wifiData.signalStrength,
      }));
      const glCanvas = document.createElement("canvas");
      glCanvas.width = W;
      glCanvas.height = H;
      const renderer = createHeatmapWebGLRenderer(
        glCanvas,
        data,
        scene.gradient,
      );
      await renderer.render({
        points: data,
        valueRange: resolveHeatmapRange(
          "signalStrength",
          data.map((d) => d.value),
          scene.signalScale,
        ),
        influenceRadius: scene.radius,
        maxOpacity: scene.maxOpacity,
        minOpacity: scene.minOpacity,
        backgroundImageSrc: scene.floorplanSrc,
        width: W,
        height: H,
      });
      ctx.drawImage(glCanvas, margin, margin);
    } else if (scene.floorplanSrc) {
      ctx.drawImage(await loadImage(scene.floorplanSrc), margin, margin, W, H);
    }
  } catch {
    return null;
  }
  ctx.strokeStyle = "rgba(20,24,33,0.15)";
  ctx.strokeRect(margin + 0.5, margin + 0.5, W - 1, H - 1);

  const keyOf = (p: SurveyPoint) =>
    identifyAp(p.wifiData.bssid, scene.accessPoints, scene.apMapping)?.key ??
    null;

  let hasEstimated = false;
  if (parts.regions > 0 || parts.boundaries) {
    const grid = computeRegions(
      regionSamples(scene.points, scene.accessPoints, scene.apMapping),
      W,
      H,
      scene.radius,
    );
    hasEstimated = grid.conf.some((c, i) => grid.labels[i] >= 0 && c < 0.5);
    if (parts.regions > 0) {
      drawRegions(
        ctx,
        margin,
        margin,
        grid,
        scene.palette,
        hidden,
        parts.regions,
        scene.focus,
      );
    }
    if (parts.boundaries) {
      drawBoundaries(
        ctx,
        margin,
        margin,
        grid,
        hidden,
        Math.max(1.5, fontPx * 0.14),
      );
    }
  }

  if (parts.path) {
    drawPath(ctx, margin, margin, scene.ordered, Math.max(1, fontPx * 0.1));
  }
  // a highlighted access point always shows its readings
  if (parts.points || scene.focus !== null) {
    drawPoints(
      ctx,
      margin,
      margin,
      scene.points,
      keyOf,
      scene.palette,
      hidden,
      Math.max(3, fontPx * 0.38),
      scene.focus,
    );
  }

  if (parts.markers) {
    const apSize = fontPx * 1.7;
    for (const ap of scene.accessPoints) {
      if (hidden.has(`ap:${ap.id}`)) continue;
      ctx.globalAlpha = isDimmed(`ap:${ap.id}`, scene.focus) ? DIMMED_ALPHA : 1;
      drawAccessPointMarker(ctx, margin + ap.x, margin + ap.y, apSize, {
        label: accessPointName(ap),
        font: Math.round(fontPx * 0.8),
        hue: scene.palette.get(`ap:${ap.id}`),
      });
    }
    ctx.globalAlpha = 1;
  }

  if (parts.roaming) {
    const shown = scene.events.filter(
      (e) => !(hidden.has(e.from.key) && hidden.has(e.to.key)),
    );
    drawRoamEvents(
      ctx,
      margin,
      margin,
      shown,
      new Map(scene.points.map((p) => [p.id, p])),
      Math.round(fontPx * 1.25),
      scene.focus,
    );
  }

  drawLegend(ctx, margin * 2 + W, margin, legendWidth, H, fontPx, {
    parts,
    gradient: scene.gradient,
    summary: scene.summary,
    hidden,
    unknown: scene.unknown,
    hasEstimated,
  });

  // caption
  const cy = margin + H + captionH / 2 + margin / 2;
  ctx.fillStyle = "#14181f";
  ctx.font = `600 ${fontPx}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const focused = scene.summary.find((s) => s.key === scene.focus);
  ctx.fillText(
    focused
      ? `${AP_LAYER_TITLES[layer]}: ${focused.name} highlighted`
      : AP_LAYER_TITLES[layer],
    margin,
    cy,
  );
  ctx.fillStyle = "#6b7280";
  ctx.font = `${fontPx * 0.85}px ${FONT}`;
  ctx.textAlign = "right";
  const n = scene.points.length;
  const roams = parts.roaming
    ? `   ${scene.events.length} roaming event${scene.events.length === 1 ? "" : "s"}`
    : "";
  ctx.fillText(
    `${scene.floorplanName}   ${n} point${n === 1 ? "" : "s"}${roams}`,
    margin + W,
    cy,
  );

  return out.toDataURL();
}

/** The colour scale key the signal layers share with the signal heat map. */
export const SIGNAL_SCALE_KEY = heatmapKey("signalStrength", "signalStrength");
