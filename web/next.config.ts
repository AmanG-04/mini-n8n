import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is a client-side Nhost/GraphQL console, so it can be hosted as static files.
  output: "export"
};

export default nextConfig;
