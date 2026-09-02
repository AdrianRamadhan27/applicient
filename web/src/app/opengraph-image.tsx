import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PRIMARY = "#0f62fe";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="72" height="72" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="11" fill={PRIMARY} />
            <circle cx="12" cy="12" r="7.3" fill="white" />
            <circle cx="12" cy="12" r="3.6" fill={PRIMARY} />
          </svg>
          <span style={{ fontSize: 64, fontWeight: 600, color: "#fafafa", letterSpacing: -1 }}>applicient</span>
        </div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 34, color: "#a3a3a3" }}>
          <span>Make your job&nbsp;</span>
          <span style={{ color: PRIMARY }}>appli</span>
          <span>cations effi</span>
          <span style={{ color: PRIMARY }}>cient</span>
          <span>.</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
