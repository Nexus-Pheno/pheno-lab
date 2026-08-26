import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest and auto-linked by Next. The brand kit's
// site.webmanifest under public/brand/web is not referenced by the app: its
// implicit scope would be /brand/web/, which makes Chrome refuse to install
// the app shell. This one scopes the whole site.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Pheno Lab Data Platform",
    short_name: "Pheno Lab",
    description: "Structured capture of perovskite solar cell experiments",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FFFFFF",
    theme_color: "#F3F5F2",
    icons: [
      { src: "/brand/web/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/web/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
