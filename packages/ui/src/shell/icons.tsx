import type { ReactNode } from "react";

/** 16 px line icons for the side navigation. Drawn here, decorative, in the text's colour. */
const PATHS: Record<string, ReactNode> = {
  "/": (
    <>
      <rect x="2" y="2" width="3.5" height="12" rx="1" />
      <rect x="6.5" y="2" width="3.5" height="8" rx="1" />
      <rect x="11" y="2" width="3" height="5" rx="1" />
    </>
  ),
  "/my-work": (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.500 5 4.5" />
    </>
  ),
  "/plan": (
    <>
      <path d="M2 4h12M2 8h8M2 12h5" />
    </>
  ),
  "/knowledge": (
    <>
      <path d="M3 2.500h7.500a2 2 0 0 1 2 2V14H5a2 2 0 0 1-2-2z" />
      <path d="M5.500 6h4" />
    </>
  ),
  "/changes": (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.500V8l2.500 1.500" />
    </>
  ),
  "/team": (
    <>
      <circle cx="5.500" cy="5.500" r="2" />
      <circle cx="11" cy="6" r="1.500" />
      <path d="M2 13c.4-2.400 1.800-3.500 3.500-3.500S8.600 10.600 9 13M10 10c1.800-.2 3.500.6 4 3" />
    </>
  ),
  "/settings": (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.500v2M8 12.500v2M1.500 8h2M12.500 8h2M3.400 3.400l1.400 1.400M11.200 11.200l1.400 1.400M12.600 3.400l-1.400 1.400M4.800 11.200l-1.400 1.400" />
    </>
  ),
  help: (
    <>
      <rect x="1.500" y="3.500" width="13" height="9" rx="1.500" />
      <path d="M4 6.500h1M7 6.500h1M10 6.500h2M5 9.500h6" />
    </>
  ),
};

export function Icon({ name }: { name: string }) {
  return (
    <svg
      className="nav-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
