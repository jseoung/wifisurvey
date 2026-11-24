/**
 * report-profile-store.ts - the company name and logo on survey reports,
 * kept once for the whole app in <data dir>/report-profile.json (see
 * server-paths.ts). Written atomically, one change at a time.
 */
import "server-only";
import path from "path";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { getReportProfilePath } from "./server-paths";
import { reportProfileFileSchema } from "./schema";
import { defaultReportProfile, type ReportProfile } from "./report-info";

const KEY = "__wifiHeatmapperReportProfile";
type Store = { queue: Promise<unknown> };

function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  return (g[KEY] ??= { queue: Promise.resolve() });
}

/** The saved profile, or an empty one when there is none (or it is unreadable). */
export async function readReportProfile(): Promise<ReportProfile> {
  try {
    const raw = JSON.parse(await readFile(getReportProfilePath(), "utf-8"));
    const parsed = reportProfileFileSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch {
    // missing or unreadable
  }
  return defaultReportProfile();
}

/** Replace the saved profile. */
export function writeReportProfile(
  profile: ReportProfile,
): Promise<ReportProfile> {
  const s = store();
  const next = s.queue.then(async () => {
    const file = getReportProfilePath();
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(profile, null, 2));
    await rename(tmp, file);
    return profile;
  });
  s.queue = next.catch(() => undefined);
  return next;
}
