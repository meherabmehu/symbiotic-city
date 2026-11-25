#!/usr/bin/env node
/**
 * Refuse to install with an npm that cannot install this project.
 *
 * npm 9 and 10 crash while resolving vitest's optional browser-mode peers:
 *
 *   npm error Cannot read properties of null (reading 'edgesOut')
 *
 * The install aborts before writing anything, so the failure looks like a missing
 * dependency later -- "next is not recognized", or "Module not found: Can't resolve
 * '@react-three/drei'" -- rather than like an npm bug. It is reproducible with a
 * package.json containing nothing but `"vitest": "4.1.12"`, so it is not something
 * this project's dependency graph can fix; every npm 9.x and 10.x tried does it, and
 * 11 does not.
 *
 * This guard runs as a preinstall step, so the user gets one sentence explaining
 * the actual cause instead of a crash three layers down. It only checks the npm
 * that is running the install -- which is the one that matters, and which
 * `packageManager` in package.json cannot enforce on older npm.
 */

const REQUIRED_MAJOR = 11;

function npmVersion() {
  // npm sets npm_config_user_agent when it runs a lifecycle script, e.g.
  // "npm/10.9.8 node/v20.19.0 linux x64 workspaces/false". This is the npm
  // performing the install, which is more precise than shelling out to `npm -v`
  // (that can be a different npm on PATH, and costs a process spawn).
  const agent = process.env.npm_config_user_agent;
  if (!agent) return null;
  const match = /npm\/(\d+)\.(\d+)\.(\d+)/.exec(agent);
  return match ? { major: Number(match[1]), text: `${match[1]}.${match[2]}.${match[3]}` } : null;
}

const npm = npmVersion();

if (npm && npm.major < REQUIRED_MAJOR) {
  const lines = [
    "",
    "  This project needs npm 11 or newer. You are running npm " + npm.text + ".",
    "",
    "  npm 9 and 10 crash while resolving vitest's browser-mode peers",
    "  (\"Cannot read properties of null (reading 'edgesOut')\") and abort the",
    "  install before writing anything. That is why node_modules ends up missing",
    "  packages -- it is not a problem with this project's dependencies.",
    "",
    "  Fix it once:",
    "",
    "      npm install -g npm@11",
    "",
    "  then re-run your install:",
    "",
    "      npm ci",
    "",
    "  (On Windows, if the global install hits EPERM because npm is in use,",
    "  close other terminals and editors first, or use `nvm use 22` which",
    "  ships npm 11.)",
    "",
  ];
  console.error(lines.join("\n"));
  process.exit(1);
}
