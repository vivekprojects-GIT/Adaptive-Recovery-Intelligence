import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/** Status badges. Colour is reserved for states that need attention (warning, serious, critical). */
const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] border px-1.5 py-px text-2xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        warning: "border-warn/20 bg-warn-bg text-warn",
        serious: "border-serious/20 bg-serious-bg text-serious",
        destructive: "border-bad/20 bg-bad-bg text-bad",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
