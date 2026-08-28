/** Cached release + download stats for the website's Downloads section.
 *
 *  The page used to call api.github.com twice on every visit, straight from the browser.
 *  Unauthenticated that is 60 requests/hour per visitor IP — a visitor who reloads a few
 *  times (or shares an office NAT) gets a 403 and an empty Downloads section — and it put
 *  two cross-origin round trips on the critical path.
 *
 *  This proxies both APIs once and caches the answer twice: Vercel's CDN holds it for
 *  `s-maxage` (stale-while-revalidate keeps serving while it refreshes), and warm function
 *  instances keep the last payload in memory, which also doubles as the stale copy served
 *  if GitHub is down or rate-limited. Set GITHUB_TOKEN in the project env to lift the
 *  upstream limit further; it is optional and never reaches the browser. */

const REPO = "ra3orblade/swarm";
const PKG = "@ra3orblade/swarm";
/** Warm-instance memo. Shorter than the CDN's s-maxage, so it only serves the gap. */
const MEMO_MS = 5 * 60_000;

type Asset = { name: string; url: string; size: number };
type Payload = {
  tag: string;
  published_at: string;
  assets: Asset[];
  downloads: { github: number; npm: number };
};

let memo: { at: number; body: Payload } | null = null;

const gh = async (path: string): Promise<unknown> => {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "getswarm.vercel.app",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
};

/** Every asset of every release, summed — GitHub only reports per-asset counts. */
const ghDownloads = (rels: unknown): number =>
  Array.isArray(rels)
    ? rels.reduce(
        (n: number, r: { assets?: { download_count?: number }[] }) =>
          n + (r.assets ?? []).reduce((m, a) => m + (a.download_count ?? 0), 0),
        0,
      )
    : 0;

const build = async (): Promise<Payload> => {
  const [latest, all, npm] = await Promise.all([
    gh("releases/latest") as Promise<{
      tag_name?: string;
      published_at?: string;
      assets?: { name: string; browser_download_url: string; size: number }[];
    }>,
    // Both counters are decoration: a failure there must not cost us the download links.
    gh("releases?per_page=100").catch(() => []),
    fetch(`https://api.npmjs.org/downloads/point/last-month/${PKG}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ downloads?: number }>) : null))
      .catch(() => null),
  ]);
  return {
    tag: latest.tag_name ?? "",
    published_at: latest.published_at ?? "",
    assets: (latest.assets ?? []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
    downloads: { github: ghDownloads(all), npm: npm?.downloads ?? 0 },
  };
};

export async function GET(): Promise<Response> {
  if (!memo || Date.now() - memo.at > MEMO_MS) {
    try {
      memo = { at: Date.now(), body: await build() };
    } catch (err) {
      if (!memo)
        return Response.json(
          { error: String(err) },
          // Short cache on the error too, so a GitHub outage can't become a stampede.
          { status: 502, headers: { "cache-control": "public, s-maxage=60" } },
        );
      // Otherwise fall through and serve the stale payload.
    }
  }
  return Response.json(memo.body, {
    headers: { "cache-control": "public, max-age=60, s-maxage=900, stale-while-revalidate=86400" },
  });
}
