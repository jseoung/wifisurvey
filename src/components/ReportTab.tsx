"use client";
import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import { FileText, ImagePlus, Printer, Sparkles, Trash2 } from "lucide-react";

import { useSettings } from "@/components/GlobalSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { FormRow } from "./FormRow";
import { calculateRadiusByBoundingBox } from "@/lib/radiusCalculations";
import { detectRoaming, findIssues } from "@/lib/ap-association";
import {
  buildReport,
  COMPANY_NAME_MAX,
  defaultReportProfile,
  LOGO_MAX_BYTES,
  REPORT_LONG_MAX,
  REPORT_SHORT_MAX,
  reportDate,
  signalStats,
  suggestRecommendations,
  type ReportInfo,
  type ReportInput,
  type ReportModel,
  type ReportProfile,
} from "@/lib/report";
import { reportHtml } from "@/lib/report-html";
import { renderReportImages } from "@/lib/report-images";
import { sanitizeFilename } from "@/lib/utils";
import type { HeatmapSettings } from "@/lib/types";

async function loadProfile(): Promise<ReportProfile> {
  const res = await fetch("/api/report-profile");
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function saveProfile(profile: ReportProfile): Promise<ReportProfile> {
  const res = await fetch("/api/report-profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `status ${res.status}`);
  }
  return res.json();
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("not an image"));
    img.src = src;
  });
}

/** The Word file; docx is loaded only when someone asks for one. */
async function makeDocx(
  model: ReportModel,
  logoSize: { width: number; height: number } | undefined,
): Promise<Blob> {
  const [{ reportDocument }, { Packer }] = await Promise.all([
    import("@/lib/report-docx"),
    import("docx"),
  ]);
  return Packer.toBlob(reportDocument(model, { logoSize }));
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The Report tab: the details of the report (company once for the app,
 * the rest saved with the survey), a live preview, and Word and PDF export.
 * The preview frame shows exactly the page that is printed to PDF.
 */
export function ReportTab() {
  const { settings, updateSettings } = useSettings();
  const info = settings.report;
  const points = settings.surveyPoints.filter((p) => p.isEnabled);

  const [profile, setProfile] = useState<ReportProfile>(defaultReportProfile);
  const [companyName, setCompanyName] = useState("");
  const [logoSize, setLogoSize] = useState<{ width: number; height: number }>();
  // the maps, and what they were drawn from
  const [drawn, setDrawn] = useState<{
    images: ReportInput["images"];
    from: readonly unknown[];
  } | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");
  const [exporting, setExporting] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const scrollY = useRef(0);
  const logoInput = useRef<HTMLInputElement>(null);

  // the company profile, once
  useEffect(() => {
    let cancelled = false;
    loadProfile()
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setCompanyName(p.companyName);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!profile.logo) return;
    imageSize(profile.logo)
      .then((size) => !cancelled && setLogoSize(size))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile.logo]);

  // what the maps are drawn from (not the report's text)
  const mapInputs = mapInputsOf(settings);
  const images = drawn?.images ?? {};
  const drawing = !drawn || drawn.from.some((v, i) => v !== mapInputs[i]);

  const drawImages = useEffectEvent(async () => {
    const from = mapInputsOf(settings);
    const enabled = settings.surveyPoints.filter((p) => p.isEnabled);
    const radius =
      settings.radiusDivider ??
      Math.round(calculateRadiusByBoundingBox(enabled));
    const imgs = await renderReportImages(settings, enabled, radius).catch(
      () => ({}),
    );
    return { images: imgs, from };
  });

  // the maps, redrawn when something they show changes
  useEffect(() => {
    let cancelled = false;
    void drawImages().then((result) => !cancelled && setDrawn(result));
    return () => {
      cancelled = true;
    };
  }, [
    settings.surveyPoints,
    settings.accessPoints,
    settings.apMapping,
    settings.dimensions,
    settings.floorplanImagePath,
    settings.floorplanImageName,
    settings.gradient,
    settings.minOpacity,
    settings.maxOpacity,
    settings.heatmapRanges,
    settings.radiusDivider,
  ]);

  const model = buildReport({
    info,
    profile,
    floorplanName: settings.floorplanImageName,
    points,
    accessPoints: settings.accessPoints,
    apMapping: settings.apMapping,
    images,
  });
  const html = reportHtml(model);

  // the preview follows typing after a short pause, keeping its scroll
  useEffect(() => {
    const t = setTimeout(() => {
      scrollY.current = frame.current?.contentWindow?.scrollY ?? 0;
      setPreviewHtml(html);
    }, 300);
    return () => clearTimeout(t);
  }, [html]);

  const setInfo = (change: Partial<ReportInfo>) =>
    updateSettings((prev) => ({ report: { ...prev.report, ...change } }));

  const storeProfile = (next: ReportProfile) => {
    setProfile(next);
    saveProfile(next).catch((err) =>
      toast({
        variant: "destructive",
        title: "Could not save the company details",
        description: String(err.message ?? err),
      }),
    );
  };

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      toast({
        variant: "destructive",
        title: "Use a PNG or JPEG logo",
        description: `${file.name} is not a PNG or JPEG image.`,
      });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast({
        variant: "destructive",
        title: "The logo is too large",
        description: `Use an image of at most ${LOGO_MAX_BYTES / 1024} KB.`,
      });
      return;
    }
    storeProfile({ ...profile, logo: await readAsDataUrl(file) });
  };

  const suggest = () => {
    const events = detectRoaming(
      points,
      settings.accessPoints,
      settings.apMapping,
    );
    const text = suggestRecommendations(
      findIssues(points, settings.accessPoints, settings.apMapping, events),
      signalStats(points),
    );
    if (!text) {
      toast({
        title: "Nothing to suggest",
        description: "The survey found no weak spots or roaming problems.",
      });
      return;
    }
    const current = info.recommendations.trim();
    setInfo({
      recommendations: (current ? `${current}\n\n${text}` : text).slice(
        0,
        REPORT_LONG_MAX,
      ),
    });
  };

  const fileBase = `${sanitizeFilename(
    info.site.trim() ||
      settings.floorplanImageName.replace(/\.[^.]+$/, "") ||
      "survey",
  )}-wifi-survey-report`;

  const downloadWord = async () => {
    setExporting(true);
    const result = await makeDocx(model, logoSize)
      .then((blob) => ({ blob }))
      .catch((err: unknown) => ({ err }));
    setExporting(false);
    if ("err" in result) {
      toast({
        variant: "destructive",
        title: "Could not make the Word file",
        description: String(result.err),
      });
      return;
    }
    download(result.blob, `${fileBase}.docx`);
  };

  const printPdf = () => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  };

  const field = (
    key: (typeof SHORT)[number],
    label: string,
    placeholder: string,
  ) => (
    <FormRow id={`report-${key}`} label={label}>
      <Input
        id={`report-${key}`}
        value={info[key]}
        maxLength={REPORT_SHORT_MAX}
        placeholder={placeholder}
        onChange={(e) => setInfo({ [key]: e.target.value })}
        data-testid={`report-${key}`}
      />
    </FormRow>
  );

  const area = (
    key: "summary" | "recommendations" | "notes",
    label: string,
    help: string,
    rows: number,
  ) => (
    <Textarea
      id={`report-${key}`}
      value={info[key]}
      maxLength={REPORT_LONG_MAX}
      rows={rows}
      aria-label={label}
      placeholder={help}
      onChange={(e) => setInfo({ [key]: e.target.value })}
      data-testid={`report-${key}`}
    />
  );

  if (settings.surveyPoints.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Report</h1>
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Take some measurements on the Floor plan tab first. The report is made
          from them.
        </div>
      </div>
    );
  }

  const lastDay = reportDate({ surveyDate: "" }, points);

  return (
    <div className="space-y-4" data-testid="report-tab">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Report</h1>
          <p className="text-sm text-muted-foreground">
            Fill in the details, check the preview, then download it for Word or
            save it as a PDF.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => void downloadWord()}
            disabled={exporting || drawing}
            data-testid="report-download-docx"
          >
            <FileText className="h-4 w-4" />
            {exporting ? "Making the Word file…" : "Download Word (.docx)"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={printPdf}
            disabled={drawing || !previewHtml}
            title="Opens the print dialog: choose Save as PDF (or Microsoft Print to PDF) as the printer"
            data-testid="report-print"
          >
            <Printer className="h-4 w-4" />
            Print or save as PDF
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="space-y-6">
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold">Your company</h2>
              <p className="text-xs text-muted-foreground">
                On every report, saved once for the app.
              </p>
            </div>
            <FormRow id="report-company" label="Company name">
              <Input
                id="report-company"
                value={companyName}
                maxLength={COMPANY_NAME_MAX}
                onChange={(e) => setCompanyName(e.target.value)}
                onBlur={() => {
                  if (companyName.trim() !== profile.companyName) {
                    storeProfile({
                      ...profile,
                      companyName: companyName.trim(),
                    });
                  }
                }}
                data-testid="report-company"
              />
            </FormRow>
            <FormRow
              label="Logo"
              hint={`PNG or JPEG, at most ${LOGO_MAX_BYTES / 1024} KB.`}
            >
              <div className="flex items-center gap-3">
                {profile.logo ? (
                  <img
                    src={profile.logo}
                    alt="Company logo"
                    className="h-12 max-w-40 rounded border bg-white object-contain p-1"
                    data-testid="report-logo-preview"
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">No logo</span>
                )}
                <input
                  ref={logoInput}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => {
                    void pickLogo(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                  data-testid="report-logo-input"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => logoInput.current?.click()}
                >
                  <ImagePlus className="h-4 w-4" />
                  {profile.logo ? "Change" : "Add logo"}
                </Button>
                {profile.logo && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => storeProfile({ ...profile, logo: null })}
                    aria-label="Remove the logo"
                    data-testid="report-logo-remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </FormRow>
          </section>

          <section className="space-y-4 border-t pt-5">
            <div>
              <h2 className="text-sm font-semibold">This survey</h2>
              <p className="text-xs text-muted-foreground">
                Saved with the survey.
              </p>
            </div>
            {field("client", "Client", "Who the survey is for")}
            {field("site", "Site", "Building or site name")}
            {field("address", "Address", "Street, city")}
            <div className="grid grid-cols-2 gap-3">
              <FormRow
                id="report-date"
                label="Survey date"
                hint={
                  info.surveyDate ? undefined : "The last measurement's day"
                }
              >
                <Input
                  id="report-date"
                  type="date"
                  value={info.surveyDate || lastDay}
                  onChange={(e) => setInfo({ surveyDate: e.target.value })}
                  data-testid="report-date"
                />
              </FormRow>
              {field("surveyor", "Surveyor", "Your name")}
            </div>
          </section>

          <section className="space-y-4 border-t pt-5">
            <FormRow id="report-summary" label="Summary">
              {area(
                "summary",
                "Summary",
                "What was surveyed and the overall result. The numbers and findings are added for you.",
                4,
              )}
            </FormRow>
            <FormRow
              id="report-recommendations"
              label="Recommendations"
              hint='Start lines with "- " for a bulleted list. A blank line starts a new paragraph.'
            >
              {area(
                "recommendations",
                "Recommendations",
                "What the client should change.",
                6,
              )}
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={suggest}
                data-testid="report-suggest"
              >
                <Sparkles className="h-4 w-4" />
                Suggest from the findings
              </Button>
            </FormRow>
            <FormRow id="report-notes" label="Additional notes">
              {area(
                "notes",
                "Additional notes",
                "Anything else: access, equipment used, limits of the survey.",
                4,
              )}
            </FormRow>
          </section>
        </aside>

        <div className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <div className="mb-2 flex items-baseline justify-between text-xs text-muted-foreground">
            <span>Preview</span>
            <span>
              {drawing
                ? "Drawing the maps…"
                : `${points.length} measurement${points.length === 1 ? "" : "s"} used`}
            </span>
          </div>
          <iframe
            ref={frame}
            title="Report preview"
            srcDoc={previewHtml}
            sandbox="allow-same-origin allow-modals"
            onLoad={() =>
              frame.current?.contentWindow?.scrollTo(0, scrollY.current)
            }
            className="h-[calc(100vh-8rem)] min-h-[32rem] w-full rounded-md border bg-muted"
            data-testid="report-preview"
          />
        </div>
      </div>
    </div>
  );
}

const SHORT = ["client", "site", "address", "surveyor"] as const;

/** What the report's maps depend on; when one changes they are redrawn. */
function mapInputsOf(settings: HeatmapSettings): readonly unknown[] {
  return [
    settings.surveyPoints,
    settings.accessPoints,
    settings.apMapping,
    settings.dimensions,
    settings.floorplanImagePath,
    settings.floorplanImageName,
    settings.gradient,
    settings.minOpacity,
    settings.maxOpacity,
    settings.heatmapRanges,
    settings.radiusDivider,
  ];
}
