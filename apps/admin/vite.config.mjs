import { defineConfig } from "vite";
export default defineConfig({
  worker: {format:"es",rollupOptions:{output:{inlineDynamicImports:true}}},
  build: { outDir: "dist" },
  server: { host: "127.0.0.1" },
});
