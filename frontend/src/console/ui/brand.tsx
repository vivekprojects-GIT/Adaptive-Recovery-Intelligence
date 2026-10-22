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

/** The product's name on screen. One place to change it once the final name is chosen. */
export const PRODUCT_NAME = "Adaptive Recovery Intelligence";

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


/** The bank this ARI deployment serves. A fictional name in the demo environment. */
export const CLIENT_BANK = "Meridian Vale Bank";
