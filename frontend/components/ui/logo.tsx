import Link from "next/link";
import clsx from "clsx";

/**
 * Wordmark from the design: a connected-node glyph beside the two-line
 * SYMBIOTIC CITY lockup.
 */
export function Logo({
  size = "md",
  href = "/",
  showTagline = true,
}: {
  size?: "sm" | "md" | "lg";
  href?: string | null;
  showTagline?: boolean;
}) {
  const dims = { sm: 30, md: 36, lg: 46 }[size];
  const content = (
    <span className="flex items-center gap-3">
      <span
        className="relative grid place-items-center rounded-xl border border-accent/30 bg-accent/10"
        style={{ height: dims, width: dims }}
        aria-hidden
      >
        <svg viewBox="0 0 24 24" className="text-accent" width={dims * 0.62} height={dims * 0.62}>
          <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M12 4.5 5.5 8v8l6.5 3.5L18.5 16V8z" opacity="0.55" />
            <path d="M12 4.5v15M5.5 8l13 8M18.5 8l-13 8" opacity="0.35" />
          </g>
          <circle cx="12" cy="4.5" r="1.9" fill="currentColor" />
          <circle cx="5.5" cy="8" r="1.5" fill="currentColor" opacity="0.8" />
          <circle cx="18.5" cy="8" r="1.5" fill="currentColor" opacity="0.8" />
          <circle cx="12" cy="19.5" r="1.9" fill="currentColor" />
        </svg>
      </span>
      <span className="leading-tight">
        <span
          className={clsx(
            "block font-display font-semibold tracking-[0.14em] text-white",
            size === "lg" ? "text-lg" : size === "md" ? "text-sm" : "text-xs",
          )}
        >
          SYMBIOTIC CITY
        </span>
        {showTagline ? (
          <span className="block text-[10px] font-medium uppercase tracking-[0.22em] text-ink-400">
            Self-Healing Urban Intelligence
          </span>
        ) : null}
      </span>
    </span>
  );
  if (!href) return content;
  return (
    <Link href={href} className="inline-flex rounded-xl focus-visible:outline-none">
      {content}
    </Link>
  );
}

export function LiveTwinPill({ synced = true }: { synced?: boolean }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
        synced
          ? "border-mint/30 bg-mint/10 text-mint"
          : "border-amber/30 bg-amber/10 text-amber",
      )}
      role="status"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-mint opacity-75" />
        <span className={clsx("relative inline-flex h-2 w-2 rounded-full", synced ? "bg-mint" : "bg-amber")} />
      </span>
      LIVE DIGITAL TWIN • {synced ? "SYNCED" : "DEGRADED"}
    </span>
  );
}
