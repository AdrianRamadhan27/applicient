import { ImageResponse } from "next/og";

// Next's icon.tsx convention, generating the browser-tab favicon
// directly from the same mark app-shell.tsx's header actually renders
// (lucide's Target — three concentric circles) instead of a separate
// static favicon.ico someone has to remember to keep in sync by hand.
// Filled rings (not outlined, like the header's own stroke-only
// version) — a hairline-stroke bullseye reads as a blur at 16-32px,
// filled concentric shapes stay legible at favicon size.

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const PRIMARY = "#0f62fe"; // --primary, globals.css

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="11" fill={PRIMARY} />
          <circle cx="12" cy="12" r="7.3" fill="white" />
          <circle cx="12" cy="12" r="3.6" fill={PRIMARY} />
        </svg>
      </div>
    ),
    { ...size },
  );
}
