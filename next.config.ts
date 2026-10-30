import type { NextConfig } from "next";
const nextConfig: NextConfig = { serverExternalPackages: ["better-sqlite3"], distDir: process.env.NEXT_DIST_DIR || ".next" };
export default nextConfig;
