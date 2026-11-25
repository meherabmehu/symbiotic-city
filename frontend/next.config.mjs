/** @type {import('next').NextConfig} */
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The `eslint` key was removed in Next 16 -- linting moved out of the build
  // entirely. Keeping it produced an "Unrecognized key(s)" warning on every
  // build, which is noise that hides real warnings.
  //
  // Next 16 refuses cross-origin requests for dev assets, and its built-in
  // allowlist covers `localhost` and the hostname the server was started with.
  // It does not cover `127.0.0.1`, which is a different hostname to the dev
  // server even though it reaches the same machine. The development scripts
  // bind `-H 0.0.0.0` (so a phone on the same network can reach the console),
  // which leaves no useful hostname to inherit -- so a browser opened at
  // http://127.0.0.1:3000 gets 403 on every /_next/static chunk, the page
  // renders from HTML but never hydrates, and the login form falls back to a
  // native GET submit. That silently breaks sign-in, so both loopback
  // hostnames have to be allowed explicitly. Hostnames only: no scheme, no port.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
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
