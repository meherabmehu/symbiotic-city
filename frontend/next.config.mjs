/** @type {import('next').NextConfig} */
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The `eslint` key was removed in Next 16 -- linting moved out of the build
  // entirely. Keeping it produced an "Unrecognized key(s)" warning on every
  // build, which is noise that hides real warnings.
  async rewrites() {
    // The browser only ever talks to this origin; /api/* is proxied to FastAPI.
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
