import type { MetadataRoute } from "next";

const SITE_URL = "https://rebuildlaagent.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      priority: 1,
    },
    {
      url: `${SITE_URL}/landing`,
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/chat`,
      priority: 0.8,
    },
  ];
}
