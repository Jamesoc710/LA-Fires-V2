import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: { '/api/chat': ['./context/municode_index.json'] },
};

export default nextConfig;
