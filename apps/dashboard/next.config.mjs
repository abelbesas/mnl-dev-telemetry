/** @type {import('next').NextConfig} */
const nextConfig = {
  // @devpulse/shared is published as TypeScript source (no build step); let
  // Next transpile it as part of the app build.
  transpilePackages: ["@devpulse/shared"],
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
