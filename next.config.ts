import type { NextConfig } from "next";

const config: NextConfig = {
  // The feed reads SQLite through Node's built-in driver; nothing to bundle.
  devIndicators: false,
};

export default config;
