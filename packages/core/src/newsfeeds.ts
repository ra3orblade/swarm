/**
 * The built-in news sources (M14.2). Shipped in code, not in config, for three reasons: `merge()`
 * replaces arrays, so a user who writes one `[[security.feeds]]` must not lose these; a feed that
 * dies or moves is fixed by a release, not by every user editing TOML; and `feeds_off` by name is
 * the clean opt-out. Every kind is read by default; `[security] kinds` narrows them.
 *
 * Every entry is a public RSS / Atom feed; the request carries nothing about the user.
 */
import type { FeedSource } from "./config";

export const BUILTIN_FEEDS: readonly FeedSource[] = [
  // the projects' own security channels — shown whole
  {
    name: "Node.js vulnerability reports",
    url: "https://nodejs.org/en/feed/vulnerability.xml",
    kind: "vendor",
  },
  {
    name: "Python forum, security tag",
    url: "https://discuss.python.org/tag/security.rss",
    kind: "vendor",
  },
  {
    name: "Python Insider",
    url: "https://blog.python.org/feeds/posts/default?alt=rss",
    kind: "vendor",
  },
  { name: "PyPI blog", url: "https://blog.pypi.org/feed_rss_created.xml", kind: "vendor" },
  { name: "Django weblog", url: "https://www.djangoproject.com/rss/weblog/", kind: "vendor" },
  { name: "PostgreSQL news", url: "https://www.postgresql.org/news.rss", kind: "vendor" },
  { name: "GitHub blog, security", url: "https://github.blog/security/feed/", kind: "vendor" },
  {
    name: "AWS security bulletins",
    url: "https://aws.amazon.com/security/security-bulletins/rss/feed/",
    kind: "vendor",
  },
  {
    name: "HashiCorp security",
    url: "https://discuss.hashicorp.com/c/security/52.rss",
    kind: "vendor",
  },
  { name: "Next.js blog", url: "https://nextjs.org/feed.xml", kind: "vendor" },
  // authorities — narrowed to the stack's keywords
  {
    name: "CISA advisories",
    url: "https://www.cisa.gov/cybersecurity-advisories/all.xml",
    kind: "authority",
  },
  {
    name: "CERT-Bund (BSI)",
    url: "https://wid.cert-bund.de/content/public/securityAdvisory/rss",
    kind: "authority",
  },
  // the security press and vendor blogs — narrowed
  { name: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", kind: "press" },
  { name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/", kind: "press" },
  { name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/", kind: "press" },
  { name: "The Record", url: "https://therecord.media/feed", kind: "press" },
  { name: "Dark Reading", url: "https://www.darkreading.com/rss.xml", kind: "press" },
  { name: "Schneier on Security", url: "https://www.schneier.com/feed/atom/", kind: "press" },
  { name: "Snyk blog", url: "https://snyk.io/blog/feed/", kind: "press" },
  { name: "ReversingLabs blog", url: "https://www.reversinglabs.com/blog/rss.xml", kind: "press" },
  { name: "OpenSSF blog", url: "https://openssf.org/feed/", kind: "press" },
  { name: "GitGuardian blog", url: "https://blog.gitguardian.com/rss/", kind: "press" },
  { name: "StepSecurity blog", url: "https://www.stepsecurity.io/blog/rss.xml", kind: "press" },
  { name: "Unit 42", url: "https://unit42.paloaltonetworks.com/feed/", kind: "press" },
  { name: "Wiz blog", url: "https://www.wiz.io/feed/rss.xml", kind: "press" },
  {
    name: "Google security blog",
    url: "https://security.googleblog.com/feeds/posts/default?alt=rss",
    kind: "press",
  },
  {
    name: "Red Hat security blog",
    url: "https://www.redhat.com/en/rss/blog/channel/security",
    kind: "press",
  },
  // the AI press — shown whole
  { name: "OpenAI news", url: "https://openai.com/news/rss.xml", kind: "ai" },
  { name: "Google DeepMind blog", url: "https://deepmind.google/blog/rss.xml", kind: "ai" },
  { name: "Google AI blog", url: "https://blog.google/technology/ai/rss/", kind: "ai" },
  { name: "Hugging Face blog", url: "https://huggingface.co/blog/feed.xml", kind: "ai" },
  { name: "Microsoft Research", url: "https://www.microsoft.com/en-us/research/feed/", kind: "ai" },
  {
    name: "AWS machine learning blog",
    url: "https://aws.amazon.com/blogs/machine-learning/feed/",
    kind: "ai",
  },
  {
    name: "MIT News, artificial intelligence",
    url: "https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml",
    kind: "ai",
  },
  { name: "BAIR blog", url: "https://bair.berkeley.edu/blog/feed.xml", kind: "ai" },
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", kind: "ai" },
  { name: "Import AI", url: "https://importai.substack.com/feed", kind: "ai" },
  { name: "Latent Space", url: "https://www.latent.space/feed", kind: "ai" },
  { name: "Last Week in AI", url: "https://lastweekin.ai/feed", kind: "ai" },
  { name: "The Gradient", url: "https://thegradient.pub/rss/", kind: "ai" },
  {
    name: "MIT Technology Review, AI",
    url: "https://www.technologyreview.com/topic/artificial-intelligence/feed",
    kind: "ai",
  },
  { name: "Ars Technica, AI", url: "https://arstechnica.com/ai/feed/", kind: "ai" },
  {
    name: "The Verge, AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    kind: "ai",
  },
  {
    name: "TechCrunch, AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
    kind: "ai",
  },
  { name: "Wired, AI", url: "https://www.wired.com/feed/tag/ai/latest/rss", kind: "ai" },
  { name: "GitHub blog, AI & ML", url: "https://github.blog/ai-and-ml/feed/", kind: "ai" },
  { name: "Cloudflare blog, AI", url: "https://blog.cloudflare.com/tag/ai/rss/", kind: "ai" },
  { name: "Interconnects", url: "https://www.interconnects.ai/feed", kind: "ai" },
  { name: "Ahead of AI", url: "https://magazine.sebastianraschka.com/feed", kind: "ai" },
  { name: "One Useful Thing", url: "https://www.oneusefulthing.org/feed", kind: "ai" },
  // the agent Swarm watches most, by its own release notes
  {
    name: "Claude Code releases",
    url: "https://github.com/anthropics/claude-code/releases.atom",
    kind: "ai",
  },
];

/** The sources to read for a config: built-ins by kind minus `feeds_off`, then the user's own, a config URL replacing a built-in. */
export function resolveSources(cfg: {
  kinds: FeedSource["kind"][];
  feeds_off: string[];
  feeds: FeedSource[];
}): Array<FeedSource & { source: "builtin" | "config"; on: boolean }> {
  const off = new Set(cfg.feeds_off.map((n) => n.toLowerCase()));
  const kinds = new Set(cfg.kinds);
  const key = (u: string) =>
    u
      .toLowerCase()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  const own = new Set(cfg.feeds.map((f) => key(f.url)));
  const out: Array<FeedSource & { source: "builtin" | "config"; on: boolean }> = [];
  for (const f of BUILTIN_FEEDS) {
    if (own.has(key(f.url))) continue;
    out.push({ ...f, source: "builtin", on: kinds.has(f.kind) && !off.has(f.name.toLowerCase()) });
  }
  for (const f of cfg.feeds)
    out.push({ ...f, source: "config", on: !off.has(f.name.toLowerCase()) });
  return out;
}

/**
 * `feeds_off` with one source switched: on drops every spelling of the name (the match is
 * case-blind, as `resolveSources` reads it), off adds it once. The order of the rest is kept, so a
 * hand-written list in `settings.toml` does not reshuffle.
 */
export function feedsOffWith(off: readonly string[], name: string, on: boolean): string[] {
  const key = name.toLowerCase();
  const rest = off.filter((n) => n.toLowerCase() !== key);
  return on ? rest : [...rest, name];
}
