/** @type {import('next').NextConfig} */
const nextConfig = {
  // The engine is a local ESM workspace package — let Next transpile it.
  transpilePackages: ["@ctxvault/engine"],
};

export default nextConfig;
