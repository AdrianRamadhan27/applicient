import type { MetadataRoute } from "next";

const SITE_URL = process.env.SITE_URL ?? "https://applicient.my.id";

// Longest-matching-rule-wins (standard robots.txt semantics, same as
// Google's own parser) — a blanket Disallow: / plus explicit Allow
// rules for the handful of genuinely public pages is the standard way
// to say "only crawl these," rather than an easy-to-forget-to-update
// disallow list of every authenticated route this app has.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/login", "/signup", "/privacy", "/terms"],
      disallow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
