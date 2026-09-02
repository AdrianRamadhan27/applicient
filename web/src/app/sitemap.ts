import type { MetadataRoute } from "next";

const SITE_URL = process.env.SITE_URL ?? "https://applicient.my.id";

// Only the genuinely public routes — everything else needs a signed-in
// session, so it's meaningless (and per robots.ts, disallowed) for a
// crawler regardless.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/signup`, changeFrequency: "yearly", priority: 0.6 },
    { url: `${SITE_URL}/login`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.1 },
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.1 },
  ];
}
