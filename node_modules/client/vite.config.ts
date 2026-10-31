import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Colours shared with the app's dark green glass look.
const THEME = "#0a241c"; // the browser / status bar colour
const BACKGROUND = "#12382d"; // the splash screen behind the icon while the app starts

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // A new build downloads in the background and takes over on the next launch, with no prompt.
      registerType: "autoUpdate",

      // Files from /public that must be in the offline cache even though no code imports them.
      includeAssets: [
        "favicon.ico",
        "apple-touch-icon.png",
        "sounds/*.mp3",
        "sounds/*.wav",
      ],

      manifest: {
        id: "/",
        name: "Ourjong",
        short_name: "Ourjong",
        description: "Hong Kong Old Style Mahjong. Play offline, alone or passing one device around.",
        lang: "en",
        start_url: "/",
        scope: "/",
        display: "standalone", // no browser bars: it opens like a native app
        orientation: "any",
        theme_color: THEME,
        background_color: BACKGROUND,
        categories: ["games"],
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          // The same artwork with extra margin, so Android can crop it to a circle or squircle.
          { src: "pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },

      workbox: {
        // Everything the build produces, plus everything in /public, is cached on first visit.
        // That is the whole game: after one online launch it runs with no connection at all.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,mp3,wav,webmanifest}"],
        // Open any address while offline and get the app shell.
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        // Sound files can be bigger than the 2 MiB default.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
});
