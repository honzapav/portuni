// Google Drive mark, monochrome (currentColor) so it sits next to lucide
// icons in the node header. Lucide ships no Drive icon.
import type { SVGProps } from "react";

export function GoogleDriveIcon({ size = 14, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M8.5 3h7l6.5 11.5-3.5 6H5.5l-3.5-6Z" />
      <path d="M8.5 3 2 14.5M15.5 3 9 14.5h13" />
    </svg>
  );
}
