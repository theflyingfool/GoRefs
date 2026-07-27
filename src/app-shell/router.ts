export type Route =
  | { name: "data-entry-grid" }
  | { name: "data-entry-detail"; speciesSlug: string }
  | { name: "stats" }
  | { name: "search-tools" }
  | { name: "coverage-report" }
  | { name: "settings" }
  | { name: "help" }
  | { name: "achievements" }
  | { name: "xp-assistant" }
  | { name: "trainer" }
  | { name: "compare" }
  | { name: "tags" }
  | { name: "collection" }
  | { name: "log-catch"; prefillSpeciesSlug?: string }
  | { name: "edit-instance"; instanceId: number };

export function parseRoute(hash: string): Route {
  const rawPath = hash.replace(/^#/, "") || "/data-entry";
  // Only log-catch's deep-link (species detail's Log-a-catch FAB) carries a
  // query string today — split it off before the switch below so every other
  // route's plain string match is untouched.
  const [path, queryString] = rawPath.split("?");
  const detailMatch = path.match(/^\/data-entry\/species\/(.+)$/);
  if (detailMatch) return { name: "data-entry-detail", speciesSlug: decodeURIComponent(detailMatch[1]) };

  const editInstanceMatch = path.match(/^\/collection\/(\d+)\/edit$/);
  if (editInstanceMatch) return { name: "edit-instance", instanceId: Number(editInstanceMatch[1]) };

  switch (path) {
    // "/bulk-edit" no longer has its own route — Bulk Edit was merged into
    // the Dex grid's select-mode (see species-grid.ts). Falls through to the
    // default grid route below rather than 404-ing for anyone with an old
    // bookmark/hash.
    case "/stats":
      return { name: "stats" };
    case "/search-tools":
      return { name: "search-tools" };
    case "/coverage-report":
      return { name: "coverage-report" };
    case "/settings":
      return { name: "settings" };
    case "/help":
      return { name: "help" };
    case "/achievements":
      return { name: "achievements" };
    case "/xp-assistant":
      return { name: "xp-assistant" };
    case "/trainer":
      return { name: "trainer" };
    case "/compare":
      return { name: "compare" };
    case "/tags":
      return { name: "tags" };
    case "/collection":
      return { name: "collection" };
    case "/log-catch": {
      // URLSearchParams already percent-decodes .get() results.
      const species = new URLSearchParams(queryString ?? "").get("species");
      return { name: "log-catch", prefillSpeciesSlug: species ?? undefined };
    }
    case "/data-entry":
    default:
      return { name: "data-entry-grid" };
  }
}

export function navigate(path: string) {
  location.hash = path;
}

export function speciesDetailPath(speciesSlug: string): string {
  return `/data-entry/species/${encodeURIComponent(speciesSlug)}`;
}

export function editInstancePath(instanceId: number): string {
  return `/collection/${instanceId}/edit`;
}
