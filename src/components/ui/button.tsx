import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        primary: "bg-navy-900 text-white hover:bg-navy-800",
        secondary: "border border-border bg-white text-navy-900 hover:bg-mist",
        ghost: "text-navy-900 hover:bg-mist",
        link: "h-auto px-0 text-turquoise-700 underline-offset-4 hover:underline",
      },
      size: {
        md: "h-11 px-4",
        sm: "h-9 px-3",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
