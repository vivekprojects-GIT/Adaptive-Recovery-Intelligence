import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";

import { cn } from "@/lib/utils";

/** A segmented control: one connected group, one choice. Used for view filters. */
const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root ref={ref}
    className={cn("inline-flex max-w-full flex-wrap overflow-hidden rounded-md border border-input bg-background shadow-sm", className)}
    {...props} />
));
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Item ref={ref}
    className={cn(
      "inline-flex h-7 items-center gap-1.5 border-l border-input px-3 text-xs text-muted-foreground transition-colors first:border-l-0",
      "hover:bg-accent hover:text-accent-foreground focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      "data-[state=on]:bg-accent data-[state=on]:font-medium data-[state=on]:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
      className)} {...props} />
));
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;

export { ToggleGroup, ToggleGroupItem };
