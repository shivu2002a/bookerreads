import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BookerReads",
    short_name: "BookerReads",
    description: "Borrow books from readers in your neighbourhood.",
    start_url: "/shelf",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f3ecda",
    theme_color: "#f3ecda",
    lang: "en-IN",
    categories: ["books", "lifestyle"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Add a book",
        url: "/shelf/add",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Requests",
        url: "/requests",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
