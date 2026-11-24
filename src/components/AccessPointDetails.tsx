import React, { useState } from "react";
import { Trash2, X } from "lucide-react";
import { ApIcon } from "./ApIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ACCESS_POINT_BSSIDS_MAX,
  ACCESS_POINT_CHANNELS_MAX,
  ACCESS_POINT_MODEL_MAX,
  ACCESS_POINT_NAME_MAX,
  ACCESS_POINT_NOTE_MAX,
  ACCESS_POINT_SSID_MAX,
  AP_BANDS,
  CHANNEL_MAX,
  cleanAccessPointNote,
  cleanBandList,
  cleanBssidList,
  cleanChannelList,
  cleanOptionalText,
  splitListInput,
} from "@/lib/access-points";
import { formatApPattern, isValidApPattern } from "@/lib/apName";
import type { AccessPoint } from "@/lib/types";

interface AccessPointDetailsProps {
  ap: AccessPoint;
  /** the marker's colour on the maps (ap-association.ts apPalette) */
  hue?: number;
  /** measurements connected to one of its BSSIDs */
  measured?: number;
  /** the changed fields; undefined removes an optional one */
  onChange: (patch: Partial<Omit<AccessPoint, "id">>) => void;
  onDelete: () => void;
  onClose: () => void;
}

const bssidText = (ap: AccessPoint) =>
  (ap.bssids ?? []).map(formatApPattern).join("\n");
const channelText = (ap: AccessPoint) => (ap.channels ?? []).join(", ");

/**
 * An access point marker's details, next to it on the floor plan: name,
 * model, what it broadcasts (SSID, BSSIDs, bands, channels) and a note.
 * Each field saves when you leave it (Enter saves the one-line ones).
 * Give it a `key` of the marker's id, so another marker starts with its
 * own text.
 */
export default function AccessPointDetails({
  ap,
  hue,
  measured,
  onChange,
  onDelete,
  onClose,
}: AccessPointDetailsProps) {
  const [name, setName] = useState(ap.name);
  const [model, setModel] = useState(ap.model ?? "");
  const [ssid, setSsid] = useState(ap.ssid ?? "");
  const [bssids, setBssids] = useState(() => bssidText(ap));
  const [bssidError, setBssidError] = useState("");
  const [channels, setChannels] = useState(() => channelText(ap));
  const [channelError, setChannelError] = useState("");
  const [note, setNote] = useState(ap.note ?? "");

  // A BSSID assigned from the summary panel updates the open form
  const [shownBssids, setShownBssids] = useState(ap.bssids);
  if (ap.bssids !== shownBssids) {
    setShownBssids(ap.bssids);
    setBssids(bssidText(ap));
    setBssidError("");
  }

  const saveName = () => {
    const next = name.trim().slice(0, ACCESS_POINT_NAME_MAX);
    setName(next);
    if (next !== ap.name) onChange({ name: next });
  };
  const saveText = (field: "model" | "ssid", value: string, max: number) => {
    const next = cleanOptionalText(value, max);
    (field === "model" ? setModel : setSsid)(next ?? "");
    if (next !== ap[field]) onChange({ [field]: next });
  };
  const saveBssids = () => {
    const entries = splitListInput(bssids);
    const bad = entries.filter((b) => !isValidApPattern(b));
    if (bad.length) {
      setBssidError(
        `Not a MAC address: ${bad.join(", ")}. Use 12 hex digits, e.g. 9E:05:D6:96:E8:30, or end with *.`,
      );
      return;
    }
    if (entries.length > ACCESS_POINT_BSSIDS_MAX) {
      setBssidError(`At most ${ACCESS_POINT_BSSIDS_MAX} BSSIDs.`);
      return;
    }
    setBssidError("");
    const next = cleanBssidList(entries);
    setBssids(next.map(formatApPattern).join("\n"));
    if (next.join() !== (ap.bssids ?? []).join()) {
      onChange({ bssids: next.length ? next : undefined });
    }
  };
  const saveChannels = () => {
    const entries = splitListInput(channels);
    const numbers = entries.map(Number);
    const bad = entries.filter(
      (_, i) =>
        !Number.isInteger(numbers[i]) ||
        numbers[i] < 1 ||
        numbers[i] > CHANNEL_MAX,
    );
    if (bad.length) {
      setChannelError(
        `Not a channel: ${bad.join(", ")}. Channels are 1 to ${CHANNEL_MAX}.`,
      );
      return;
    }
    if (entries.length > ACCESS_POINT_CHANNELS_MAX) {
      setChannelError(`At most ${ACCESS_POINT_CHANNELS_MAX} channels.`);
      return;
    }
    setChannelError("");
    const next = cleanChannelList(numbers);
    setChannels(next.join(", "));
    if (next.join() !== (ap.channels ?? []).join()) {
      onChange({ channels: next.length ? next : undefined });
    }
  };
  const toggleBand = (band: number, on: boolean) => {
    const current = ap.bands ?? [];
    const next = cleanBandList(
      on ? [...current, band] : current.filter((b) => b !== band),
    );
    onChange({ bands: next.length ? next : undefined });
  };
  const saveNote = () => {
    const next = cleanAccessPointNote(note);
    setNote(next ?? "");
    if (next !== ap.note) onChange({ note: next });
  };
  const enterSaves = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const field = (id: string) => `ap-${id}-${ap.id}`;

  return (
    <div
      className="w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-float"
      data-testid="access-point-details"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span data-testid="access-point-colour">
          <ApIcon hue={hue} className="h-5 w-5" />
        </span>
        <Input
          value={name}
          maxLength={ACCESS_POINT_NAME_MAX}
          placeholder="Access point"
          aria-label="Access point name"
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={enterSaves}
          className="h-7 min-w-0 flex-1 px-2 py-0 text-sm font-semibold"
          data-testid="access-point-name"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[min(60vh,28rem)] space-y-2.5 overflow-y-auto px-3 py-2">
        <div className="space-y-1">
          <label
            htmlFor={field("model")}
            className="text-xs text-muted-foreground"
          >
            Manufacturer and model
          </label>
          <Input
            id={field("model")}
            value={model}
            maxLength={ACCESS_POINT_MODEL_MAX}
            placeholder="Ubiquiti U6 Pro"
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => saveText("model", model, ACCESS_POINT_MODEL_MAX)}
            onKeyDown={enterSaves}
            className="h-7 text-xs"
            data-testid="access-point-model"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor={field("ssid")}
            className="text-xs text-muted-foreground"
          >
            Network name (SSID)
          </label>
          <Input
            id={field("ssid")}
            value={ssid}
            maxLength={ACCESS_POINT_SSID_MAX}
            placeholder="Office"
            onChange={(e) => setSsid(e.target.value)}
            onBlur={() => saveText("ssid", ssid, ACCESS_POINT_SSID_MAX)}
            onKeyDown={enterSaves}
            className="h-7 text-xs"
            data-testid="access-point-ssid"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor={field("bssids")}
            className="text-xs text-muted-foreground"
          >
            BSSIDs (MAC addresses), one per line
          </label>
          <Textarea
            id={field("bssids")}
            value={bssids}
            placeholder={"9E:05:D6:96:E8:30\n9E:05:D6:96:E8:31"}
            onChange={(e) => setBssids(e.target.value)}
            onBlur={saveBssids}
            className="min-h-14 font-mono text-xs"
            aria-invalid={bssidError ? true : undefined}
            data-testid="access-point-bssids"
          />
          {bssidError ? (
            <p className="text-xs text-destructive" role="alert">
              {bssidError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              One per radio. End with * to match every BSSID that starts with
              it. Measurements connected to these count as this access point.
            </p>
          )}
        </div>
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted-foreground">Bands</legend>
          <div className="flex gap-3">
            {AP_BANDS.map((band) => (
              <label key={band} className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={(ap.bands ?? []).includes(band)}
                  onCheckedChange={(v) => toggleBand(band, v === true)}
                  data-testid={`access-point-band-${band}`}
                />
                {band} GHz
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1">
          <label
            htmlFor={field("channels")}
            className="text-xs text-muted-foreground"
          >
            Channels
          </label>
          <Input
            id={field("channels")}
            value={channels}
            placeholder="6, 36"
            onChange={(e) => setChannels(e.target.value)}
            onBlur={saveChannels}
            onKeyDown={enterSaves}
            className="h-7 text-xs"
            aria-invalid={channelError ? true : undefined}
            data-testid="access-point-channels"
          />
          {channelError && (
            <p className="text-xs text-destructive" role="alert">
              {channelError}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label
            htmlFor={field("note")}
            className="text-xs text-muted-foreground"
          >
            Note
          </label>
          <Textarea
            id={field("note")}
            value={note}
            maxLength={ACCESS_POINT_NOTE_MAX}
            placeholder="Height, mounting, which way the antennas point"
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            className="min-h-14 text-xs"
            data-testid="access-point-note"
          />
        </div>
        <p
          className="text-xs text-muted-foreground"
          data-testid="access-point-measured"
        >
          {measured === undefined
            ? "Drag the marker to move it."
            : measured === 0
              ? "No measurement is connected to its BSSIDs yet. Drag the marker to move it."
              : `${measured} measurement${measured === 1 ? " was" : "s were"} connected to it. Drag the marker to move it.`}
        </p>
      </div>
      <div className="flex items-center justify-end border-t bg-muted/40 px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          data-testid="access-point-delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </Button>
      </div>
    </div>
  );
}
