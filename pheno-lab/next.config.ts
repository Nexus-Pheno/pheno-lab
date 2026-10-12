import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // RDKit's WASM runtime reads its packaged binary locally, never from a CDN.
  serverExternalPackages: ["@rdkit/rdkit"],
};

export default nextConfig;
