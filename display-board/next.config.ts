import type { NextConfig } from "next";

// Where the team backend (functions/, `npm start`) is running.
// Deployed: https://nova-ffc.web.app (set in apphosting.yaml).
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Keep the projector board clean: no dev badge in the corner.
  devIndicators: false,
  // Let phones on the same Wi-Fi load the dev server (camera page) by LAN IP.
  allowedDevOrigins: ["10.*.*.*", "172.*.*.*", "192.168.*.*", "*.local"],
  // Forward API + photo requests to the team backend so the browser only talks to this app.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/photos/:path*", destination: `${BACKEND_URL}/photos/:path*` },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
