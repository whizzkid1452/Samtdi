import type { NextConfig } from "next";

const apiOrigin = process.env.SAMTDI_API_ORIGIN ?? "http://127.0.0.1:8080";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    if (process.env.SAMTDI_LOCAL_MODE === "1") return [];

    return [
      { source: "/v1/:path*", destination: `${apiOrigin}/v1/:path*` },
      { source: "/review/:path*", destination: `${apiOrigin}/review/:path*` },
      { source: "/review-assets/:path*", destination: `${apiOrigin}/review-assets/:path*` },
    ];
  },
};

export default config;
