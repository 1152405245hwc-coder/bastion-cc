import { spawn } from "node:child_process";

const CLAUDE_AUTH_HOST = /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/i;
const GITHUB_HOST = /^github\.com$/i;

export function isClaudeAuthHost(hostname) {
  return CLAUDE_AUTH_HOST.test(String(hostname || ""));
}

export function routeExternalLink(targetUrl, options = {}) {
  const url = new URL(String(targetUrl));
  if (url.protocol !== "https:") {
    throw new Error("Refusing non-HTTPS external link");
  }
  if (isClaudeAuthHost(url.hostname)) {
    const browser = options.isolatedBrowser ?? process.env.CCRF_OAUTH_BROWSER ?? "claude-us-browser";
    const spawnImpl = options.spawnImpl ?? spawn;
    const child = spawnImpl(browser, [url.toString()], {
      detached: true,
      stdio: "ignore",
    });
    child?.unref?.();
    return { target: "isolated-browser", url: url.toString() };
  }
  if (GITHUB_HOST.test(url.hostname)) {
    if (options.openExternal) {
      void options.openExternal(url.toString());
    }
    return { target: "system-browser", url: url.toString() };
  }
  throw new Error(`Unexpected external host: ${url.hostname}`);
}
