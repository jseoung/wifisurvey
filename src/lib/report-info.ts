/**
 * report-info.ts - what the surveyor types for a report: the details of
 * one survey (saved with it) and the company profile (saved once for the
 * whole app). Small and import-free, so the schema and the survey defaults
 * can use it; the report itself is built in report.ts.
 */

/** Details of one survey's report, saved with the survey. */
export interface ReportInfo {
  client: string;
  site: string;
  address: string;
  surveyor: string;
  /** YYYY-MM-DD, or empty for the day of the last measurement */
  surveyDate: string;
  summary: string;
  recommendations: string;
  notes: string;
}

export const REPORT_SHORT_FIELDS = [
  "client",
  "site",
  "address",
  "surveyor",
] as const;
export const REPORT_LONG_FIELDS = [
  "summary",
  "recommendations",
  "notes",
] as const;
/** Longest client, site, address or surveyor, in characters. */
export const REPORT_SHORT_MAX = 200;
/** Longest summary, recommendations or notes, in characters. */
export const REPORT_LONG_MAX = 10_000;

export function defaultReportInfo(): ReportInfo {
  return {
    client: "",
    site: "",
    address: "",
    surveyor: "",
    surveyDate: "",
    summary: "",
    recommendations: "",
    notes: "",
  };
}

/** The company on every report, kept once for the whole app. */
export interface ReportProfile {
  companyName: string;
  /** a PNG or JPEG as a data URL, or null */
  logo: string | null;
}

export const COMPANY_NAME_MAX = 120;
/** Largest logo file, in bytes (it is stored as a data URL). */
export const LOGO_MAX_BYTES = 512 * 1024;
/** What a stored logo looks like. */
export const LOGO_DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;

export function defaultReportProfile(): ReportProfile {
  return { companyName: "", logo: null };
}
