export interface RouteExternalLinkOptions {
  isolatedBrowser?: string;
  spawnImpl?: (
    cmd: string,
    args: string[],
    options?: { detached?: boolean; stdio?: string },
  ) => { unref?: () => void } | undefined;
  openExternal?: (url: string) => unknown;
}

export interface RouteExternalLinkResult {
  target: "isolated-browser" | "system-browser";
  url: string;
}

export function isClaudeAuthHost(hostname: string): boolean;
export function routeExternalLink(
  targetUrl: string,
  options?: RouteExternalLinkOptions,
): RouteExternalLinkResult;
