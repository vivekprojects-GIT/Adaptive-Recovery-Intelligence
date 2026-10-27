import clsx from "clsx";
import { useState } from "react";

/**
 * Capgemini brand mark.
 *
 * Official logo artwork should come from Capgemini's brand portal, not be
 * redrawn. Drop the files into frontend/public/brand/ and they are used
 * automatically:
 *   capgemini-logo.svg        - full-colour, for light backgrounds
 *   capgemini-logo-white.svg  - reversed, for the dark shell bar and sign-in panel
 * Until then a typographic wordmark in Ubuntu (Capgemini's typeface) is shown.
 */
export function BrandMark({ onDark, size = "md" }: { onDark?: boolean; size?: "sm" | "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const src = onDark ? "/brand/capgemini-logo-white.svg" : "/brand/capgemini-logo.svg";
  const h = { sm: "h-4", md: "h-5", lg: "h-7" }[size];
  if (!failed) {
    return <img src={src} alt="Capgemini" className={clsx(h, "w-auto")} onError={() => setFailed(true)} />;
  }
  return (
    <span className={clsx("font-sans font-medium leading-none tracking-[-0.01em]",
      onDark ? "text-white" : "text-primary-500",
      { sm: "text-[15px]", md: "text-[18px]", lg: "text-[26px]" }[size])}>
      Capgemini
    </span>
  );
}

/** The product's name on screen, and what it stands for. One place to change it. */
export const PRODUCT_NAME = "CARE";
export const PRODUCT_FULL_NAME = "Collection and Recovery Agent";

/** CARE's mark: an open C holding a payment coming back. Same drawing as public/favicon.svg. */
export function CareMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={clsx("shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="#12ABDB" />
      <path d="M21.2 10.3A7.6 7.6 0 1 0 21.2 21.7" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="23.1" cy="16" r="2.2" fill="#fff" />
    </svg>
  );
}

/** CARE lock-up: the mark, the name, and what it stands for. */
export function CareLogo({ onDark, size = "md", compact }: { onDark?: boolean; size?: "md" | "lg"; compact?: boolean }) {
  const lg = size === "lg";
  return (
    <div className="flex items-center gap-2.5">
      <CareMark size={lg ? 44 : 32} />
      {!compact && (
        <span className="leading-none">
          <span className={clsx("block font-semibold tracking-[0.16em]", lg ? "text-[30px]" : "text-[17px]",
            onDark ? "text-white" : "text-fg")}>{PRODUCT_NAME}</span>
          <span className={clsx("mt-1 block whitespace-nowrap", lg ? "text-[13px]" : "text-[10.5px]",
            onDark ? "text-primary-200/85" : "text-fg-3")}>{PRODUCT_FULL_NAME}</span>
        </span>
      )}
    </div>
  );
}

/** Product lock-up: Capgemini | product name. */
export function ProductLockup({ onDark, compact }: { onDark?: boolean; compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <BrandMark onDark={onDark} />
      <span className={clsx("h-5 w-px", onDark ? "bg-white/25" : "bg-line-strong")} />
      <p className={clsx("whitespace-nowrap font-medium leading-tight", compact ? "text-[13px]" : "text-[14px]",
        onDark ? "text-white" : "text-fg")}>{PRODUCT_NAME}</p>
    </div>
  );
}


/** The bank this CARE deployment serves. A fictional name in the demo environment. */
export const CLIENT_BANK = "Meridian Valley Bank";
