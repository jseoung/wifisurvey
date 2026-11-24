import React from "react";
import { MapPin, Router, X, Trash2 } from "lucide-react";
import {
  SurveyPoint,
  HeatmapSettings,
  IperfTestProperty,
  SurveyPointActions,
} from "@/lib/types";
import { snrOf, validNoise } from "@/lib/utils";
import { identifyAp } from "@/lib/ap-association";
import { ApChip } from "./ApChip";
import { pointName } from "@/lib/point-label";
import { PointLabel } from "@/components/PointLabel";
import { hasSpeedData } from "@/lib/measurement-mode";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { AlertDialogModal } from "@/components/AlertDialogModal";
import { getColorAt, objectToRGBAString } from "@/lib/utils-gradient";

interface PopupDetailsProps {
  point: SurveyPoint | null;
  settings: HeatmapSettings;
  surveyPointActions: SurveyPointActions;
  /** access point colours (ap-association.ts apPalette) */
  palette: Map<string, number>;
  /** put an access point marker on this point's spot */
  onMarkAsAccessPoint: (point: SurveyPoint) => void;
  /** open the marker this point's BSSID belongs to */
  onShowAccessPoint: (id: string) => void;
  /** move that marker onto this point's spot */
  onMoveAccessPoint: (id: string, point: SurveyPoint) => void;
  onClose: () => void;
}

/**
 * Details of one survey point, shown next to it on the floor plan.
 * Renders nothing when `point` is null.
 */
const PopupDetails: React.FC<PopupDetailsProps> = ({
  point,
  settings,
  surveyPointActions,
  palette,
  onMarkAsAccessPoint,
  onShowAccessPoint,
  onMoveAccessPoint,
  onClose,
}) => {
  if (!point) return null;

  const wifi = point.wifiData;
  // the BSSID it was connected to; null when the system didn't report one
  const ap = identifyAp(wifi?.bssid, settings.accessPoints, settings.apMapping);
  const color = objectToRGBAString({
    ...getColorAt(wifi.signalStrength / 100, settings.gradient),
    a: 1,
  });

  // a test that did not run is null ("—"); a measured 0 shows as 0.0
  const mbps = (test: IperfTestProperty | null) =>
    test ? (test.bitsPerSecond / 1_000_000).toFixed(1) : "—";
  const noise = validNoise(wifi.noise);
  const snr = snrOf(wifi);
  const hasIperf = hasSpeedData(point);

  const rows: [string, React.ReactNode][] = [
    ["Signal", `${wifi.signalStrength}% (${wifi.rssi} dBm)`],
    ["Noise", noise === null ? "—" : `${noise} dBm`],
    ["Signal-to-noise", snr === null ? "—" : `${snr} dB`],
    ["Network", wifi.ssid || "not available"],
    [
      "Access point",
      ap ? (
        <ApChip key="ap" hue={palette.get(ap.key)} mono={ap.source === "bssid"}>
          {ap.name}
        </ApChip>
      ) : (
        "not reported"
      ),
    ],
    [
      "Channel",
      wifi.channel ? `${wifi.channel} (${wifi.band} GHz)` : "not available",
    ],
  ];
  if (hasIperf) {
    const { tcpDownload, tcpUpload, udpDownload, udpUpload } = point.iperfData;
    rows.push([
      "Download / upload",
      `${mbps(tcpDownload)} / ${mbps(tcpUpload)} Mbps`,
    ]);
    if (udpDownload || udpUpload) {
      rows.push([
        "Fixed rate (UDP)",
        `${mbps(udpDownload)} / ${mbps(udpUpload)} Mbps`,
      ]);
    }
  } else {
    rows.push(["Speed", "not measured"]);
  }
  rows.push(["Measured", new Date(point.timestamp).toLocaleString()]);

  return (
    <div
      className="w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-float"
      data-testid="point-details"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span
          className="h-3 w-3 shrink-0 rounded-full border border-black/20"
          style={{ background: color }}
          aria-hidden="true"
        />
        <h3 className="min-w-0 flex-1 text-sm font-semibold">
          <PointLabel
            point={point}
            onSave={(label) => surveyPointActions.update(point, { label })}
          />
        </h3>
        <span className="tabular shrink-0 text-xs text-muted-foreground">
          {point.label ? `${point.id} · ` : ""}x {point.x}, y {point.y}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate text-right">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-x-1 border-t px-3 py-1.5">
        {ap?.markerId ? (
          // this BSSID already belongs to a marker: show it, or say it is here
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onShowAccessPoint(ap.markerId!)}
              data-testid="point-show-access-point"
            >
              <Router className="h-3.5 w-3.5" />
              Show access point
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onMoveAccessPoint(ap.markerId!, point)}
              title={`This measurement was connected to ${ap.name}. Move its marker to this spot.`}
              data-testid="point-move-access-point"
            >
              <MapPin className="h-3.5 w-3.5" />
              Move access point here
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onMarkAsAccessPoint(point)}
            title="Put an access point marker here, with the BSSID, network, band and channel of this measurement"
            data-testid="point-mark-access-point"
          >
            <Router className="h-3.5 w-3.5" />
            Mark as access point
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between border-t bg-muted/40 px-3 py-2">
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={point.isEnabled}
            onCheckedChange={(v) =>
              surveyPointActions.update(point, { isEnabled: v })
            }
            aria-label="Use this point in heat maps"
          />
          {point.isEnabled ? "Used in heat maps" : "Ignored"}
        </label>
        <AlertDialogModal
          title={`Delete ${pointName(point)}?`}
          description="The measurement is removed from this survey. This cannot be undone."
          confirmLabel="Delete point"
          destructive
          onCancel={() => {}}
          onConfirm={() => {
            surveyPointActions.delete([point]);
            onClose();
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        </AlertDialogModal>
      </div>
    </div>
  );
};

export default PopupDetails;
