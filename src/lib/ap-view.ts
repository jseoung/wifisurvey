/**
 * ap-view.ts - how the access point map is shown: which layer, how strong
 * the shading is, what is drawn on top, and which access points are hidden.
 * Saved with the survey (`apView`, PATCH /api/settings replaces it whole).
 * No Zod here, so the browser can use it (the schema is in schema.ts).
 */

/** The layers of the access point map, in the order the selector shows. */
export const AP_LAYERS = [
  "signal",
  "association",
  "combined",
  "roaming",
  "locations",
] as const;

export type ApLayer = (typeof AP_LAYERS)[number];

export const AP_LAYER_TITLES: Record<ApLayer, string> = {
  signal: "Signal strength",
  association: "Access point association",
  combined: "Signal with association boundaries",
  roaming: "Roaming events",
  locations: "Access point locations",
};

/** Most access points that can be hidden at once (keys, see ap-association.ts). */
export const HIDDEN_APS_MAX = 200;

export interface ApView {
  layer: ApLayer;
  /** how strongly association regions are shaded, 0..1 */
  regionOpacity: number;
  /** lines between regions served by different access points */
  showBoundaries: boolean;
  /** access point markers, on the floor plan and on every map */
  showMarkers: boolean;
  /** measurement dots on the access point map */
  showPoints: boolean;
  /** roaming event markers on the access point map */
  showRoaming: boolean;
  /** access points (by key) left off the access point map */
  hiddenAps: string[];
}

export function defaultApView(): ApView {
  return {
    layer: "association",
    regionOpacity: 0.35,
    showBoundaries: true,
    showMarkers: true,
    showPoints: true,
    showRoaming: true,
    hiddenAps: [],
  };
}
