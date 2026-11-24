/**
 * GET /api/report-profile - the company name and logo on survey reports
 * PUT /api/report-profile - replace them: { companyName, logo }
 *
 * The logo is a PNG or JPEG data URL (at most 512 KB), or null. Kept once
 * for the whole app, not per survey (lib/report-profile-store.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBody } from "@/lib/api-helpers";
import { reportProfileSchema } from "@/lib/schema";
import {
  readReportProfile,
  writeReportProfile,
} from "@/lib/report-profile-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readReportProfile());
}

export async function PUT(request: NextRequest) {
  const body = await readBody(request, reportProfileSchema);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(await writeReportProfile(body.data));
  } catch (err) {
    return jsonError(500, `Unable to save the report profile: ${err}`);
  }
}
