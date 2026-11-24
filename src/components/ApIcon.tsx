import { apLedColor } from "@/lib/access-points";
import { cn } from "@/lib/utils";

/**
 * A small ceiling access point, as drawn on the plan
 * (access-points.ts drawAccessPointMarker): a white disc with a light ring
 * in the access point's colour. For legends and headers.
 */
export function ApIcon({
  hue,
  className,
}: {
  hue: number | undefined;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-4 w-4 shrink-0", className)}
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="11"
        fill="#f4f5f7"
        stroke="#9aa1ab"
        strokeWidth="1.2"
      />
      <circle
        cx="12"
        cy="12"
        r="7.5"
        fill="none"
        stroke="rgba(20,24,31,0.12)"
        strokeWidth="0.8"
      />
      <circle
        cx="12"
        cy="12"
        r="3.8"
        fill="none"
        stroke={apLedColor(hue)}
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="1.3" fill="#c9cdd3" />
    </svg>
  );
}
