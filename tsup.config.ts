import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  // We deliberately don't bundle anything — keep imports simple for tree-shaking.
  splitting: false,
  // No external deps yet — the SDK uses only platform-native fetch + localStorage.
  external: [],
});
