/** @type {import('next').NextConfig} */
const nextConfig = {
  // @mnl-dev-telemetry/shared is published as TypeScript source (no build step); let
  // Next transpile it as part of the app build.
  transpilePackages: ["@mnl-dev-telemetry/shared"],
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
