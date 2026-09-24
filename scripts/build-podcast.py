#!/usr/bin/env python3
"""Regenerate the podcast pages from podcast/episodes.json.

    python3 scripts/build-podcast.py

Writes podcast/index.html (episodes hub) and podcast/<slug>/index.html (one page
per episode), and refreshes the podcast block in sitemap.xml. Normally run by
scripts/sync-podcast.py, which also pulls new episodes from the RSS feed.
Standard library only.
"""
import html
import json
import pathlib
import re
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = "https://averywhitted.com"
DATA = json.loads((ROOT / "podcast" / "episodes.json").read_text(encoding="utf-8"))
SHOW = DATA["show"]
EPS = sorted(DATA["episodes"], key=lambda ep: ep["published"])  # oldest -> newest
BOOK = "https://cal.com/averywhitted"
SHOW_URL = f"{SITE}/podcast/"
HOST = {"@type": "Person", "name": "Avery Whitted", "url": f"{SITE}/"}
COVER_ALT = "90% of the Job podcast cover art: Surviving Auditions as a Working Actor, hosted by Avery Whitted"

esc = lambda s: html.escape(str(s), quote=True)


def ld(obj):
    body = json.dumps(obj, indent=2, ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/ld+json">\n{body}\n</script>'


def when(ep):
    dt = datetime.fromisoformat(ep["published"].replace("Z", "+00:00")).astimezone(timezone.utc)  # same day Apple's embed shows
    return f"{dt:%b} {dt.day}, {dt.year}"


def mins(ep):
    return f"{round(ep['duration_seconds'] / 60)} min"


def iso_duration(ep):
    m, s = divmod(ep["duration_seconds"], 60)
    return f"PT{m}M{s}S"


def num(ep):
    return f"{ep['number']:02d}"


def code(ep):
    return f"S{ep['season']} E{ep['number']}" if ep.get("season") else f"E{ep['number']}"


def label(ep):
    return f"Season {ep['season']} &middot; Episode {ep['number']}" if ep.get("season") else f"Episode {ep['number']}"


def tile(ep):
    season = f'<span class="num-season">S{ep["season"]}</span>' if ep.get("season") else ""
    return f"{season}<span>{num(ep)}</span>"


def path(ep):
    return f"/podcast/{ep['slug']}/"


def guest(ep):
    return ep.get("guest", "")


def meta_description(ep):
    if ep.get("meta_description"):
        return ep["meta_description"]
    text = ep["summary"]
    if len(text) > 130:
        text = text[:130].rsplit(" ", 1)[0].rstrip(",;:.") + "..."
    return f"{text} {SHOW['title']}, hosted by Avery Whitted."


def apple_page(ep):
    return f"https://podcasts.apple.com/us/podcast/{ep['apple_episode_slug']}/id{SHOW['apple_show_id']}?i={ep['apple_episode_id']}"


def apple_embed(ep):
    return (
        f"https://embed.podcasts.apple.com/us/podcast/{ep['apple_episode_slug']}/id{SHOW['apple_show_id']}"
        f"?i={ep['apple_episode_id']}&itscg=30200&itsct=podcast_box_player&ls=1&mttnsubad={ep['apple_episode_id']}&theme=auto"
    )


APPLE_SHOW = f"https://podcasts.apple.com/us/podcast/{SHOW['apple_show_slug']}/id{SHOW['apple_show_id']}"


def sort_control(target, small=False):
    """Newest/oldest toggle, wired up by podcast.js. Hidden until JS is available."""
    cls = "sort sort-sm" if small else "sort"
    heading = "" if small else '<span class="sort-label">Sort by date</span>'
    return (
        f'<div class="{cls}" role="group" aria-label="Sort episodes by date" data-sort-for="{target}">{heading}'
        f'<button type="button" class="sort-btn" data-order="newest" aria-pressed="true">Newest</button>'
        f'<button type="button" class="sort-btn" data-order="oldest" aria-pressed="false">Oldest</button></div>'
    )


def head(title, description, canonical, jsonld, og_type="website"):
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>{esc(title)}</title>
    <meta name="description" content="{esc(description)}" />
    <meta name="author" content="Avery Whitted" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="{canonical}" />
    <meta name="theme-color" content="#f6f7f9" />

    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="alternate" type="application/rss+xml" title="{esc(SHOW['title'])}" href="{esc(SHOW['rss'])}" />

    <meta property="og:title" content="{esc(title)}" />
    <meta property="og:description" content="{esc(description)}" />
    <meta property="og:image" content="{SITE}/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Avery Whitted: Acting Workshops + Private Coaching" />
    <meta property="og:url" content="{canonical}" />
    <meta property="og:type" content="{og_type}" />
    <meta property="og:site_name" content="Avery Whitted" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="{esc(title)}" />
    <meta name="twitter:description" content="{esc(description)}" />
    <meta name="twitter:image" content="{SITE}/og-image.png" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/podcast/podcast.css" />
    <script>document.documentElement.classList.add("js");</script>
    <script src="/podcast/podcast.js" defer></script>
    {jsonld}
  </head>
"""


def header(hub_current):
    cur = ' aria-current="page"' if hub_current else ""
    return f"""      <header>
        <div class="brand">
          <a href="/">
            <span class="brand-name">Avery Whitted</span>
            <span class="brand-sub">Acting Workshops + Private Coaching</span>
          </a>
        </div>
        <nav aria-label="Site">
          <a class="pill" href="/">Home</a>
          <a class="pill is-active" href="/podcast/"{cur}>Podcast</a>
          <a class="pill pill-cta" href="{BOOK}" target="_blank" rel="noopener noreferrer">Book a Session</a>
        </nav>
      </header>
"""


FOOTER = """      <footer class="footer">
        <div>&copy; <span id="year"></span> Avery Whitted &middot; <a class="footer-link" href="/">Home</a> &middot; <a class="footer-link" href="/policies.html">Policies</a></div>
        <div>
          <a class="social-icon" href="https://www.broadwayworld.com/people/Avery-Whitted/" target="_blank" rel="noreferrer" aria-label="BroadwayWorld">
            <svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden="true">
              <rect x="3.5" y="3.5" width="41" height="41" rx="20.5" stroke="currentColor" stroke-width="2" />
              <text x="24" y="28" text-anchor="middle" font-family="Source Sans 3, Arial, sans-serif" font-size="13" font-weight="700" fill="currentColor">BW</text>
            </svg>
          </a>
          <a class="social-icon" href="https://www.imdb.com/name/nm10031930/" target="_blank" rel="noreferrer" aria-label="IMDb">
            <svg width="24" height="24" viewBox="0 0 64 40" fill="none" aria-hidden="true">
              <rect x="2.5" y="2.5" width="59" height="35" rx="8" stroke="currentColor" stroke-width="3" />
              <text x="32" y="26" text-anchor="middle" font-family="Source Sans 3, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing=".06em" fill="currentColor">IMDb</text>
            </svg>
          </a>
          <a class="social-icon" href="https://www.instagram.com/avery_whitted" target="_blank" rel="noreferrer" aria-label="Instagram">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" stroke-width="1.8" />
              <circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.8" />
              <circle cx="17.6" cy="6.4" r="1.2" fill="currentColor" />
            </svg>
          </a>
        </div>
      </footer>
"""


def page(head_html, header_html, main_html):
    return f"""{head_html}
  <body>
    <div class="wrap">
{header_html}
      <main>
{main_html}
      </main>

{FOOTER}    </div>
    <script>
      document.getElementById("year").textContent = new Date().getFullYear();
    </script>
  </body>
</html>
"""


def breadcrumbs(*crumbs):
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i, "name": name, "item": item}
            for i, (name, item) in enumerate(crumbs, 1)
        ],
    }


def hub_page():
    newest = EPS[-1]
    cards = []
    for ep in reversed(EPS):
        latest = '<span class="tag">Latest</span>' if ep is newest else ""
        with_line = f'\n                <p class="ep-card-guest">with {esc(guest(ep))}</p>' if guest(ep) else ""
        cards.append(f"""          <li data-date="{esc(ep['published'])}">
            <a class="panel ep-card" href="{path(ep)}">
              <div class="ep-card-num" aria-hidden="true">{tile(ep)}</div>
              <div>
                <p class="ep-card-meta">{latest}<span>{code(ep)}</span><span>&middot;</span><span>{when(ep)}</span><span>&middot;</span><span>{mins(ep)}</span></p>
                <h3 class="ep-card-title">{esc(ep['headline'])}</h3>{with_line}
                <p class="ep-card-summary">{esc(ep['summary'])}</p>
              </div>
              <span class="ep-card-cta">Listen &rarr;</span>
            </a>
          </li>""")
    desc = "".join(f"                <p>{esc(p)}</p>\n" for p in SHOW["description"])
    n = len(EPS)
    sort = sort_control("#ep-list") if n > 1 else ""
    main = f"""        <section class="panel show-hero" aria-labelledby="show-title">
          <div class="show-hero-grid">
            <div>
              <p class="tag">Podcast</p>
              <h1 class="show-title" id="show-title">{esc(SHOW['title'])}</h1>
              <p class="show-tagline">{esc(SHOW['tagline'])}</p>
              <div class="prose">
{desc}              </div>
              <div class="show-actions">
                <a class="btn primary" href="{APPLE_SHOW}" target="_blank" rel="noopener noreferrer">Listen on Apple Podcasts &nearr;</a>
                <a class="btn" href="{esc(SHOW['rss'])}" target="_blank" rel="noopener noreferrer">RSS feed</a>
              </div>
            </div>
            <img class="show-cover" src="/podcast/cover.webp" width="600" height="600" alt="{esc(COVER_ALT)}" decoding="async" />
          </div>
        </section>

        <section aria-labelledby="eps-title">
          <div class="eps-head">
            <div class="eps-head-left">
              <h2 class="eps-title" id="eps-title">Episodes</h2>
              <span class="eps-count">{n} episode{'s' if n != 1 else ''}</span>
            </div>
            {sort}
          </div>
          <ol class="ep-cards" id="ep-list">
{chr(10).join(cards)}
          </ol>
        </section>"""
    jsonld = ld({
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "CollectionPage",
                "@id": f"{SHOW_URL}#page",
                "url": SHOW_URL,
                "name": f"{SHOW['title']}: Podcast Episodes",
                "description": SHOW["meta_description"],
                "isPartOf": {"@id": f"{SITE}/#website"},
                "about": {"@id": f"{SITE}/#podcast"},
                "mainEntity": {
                    "@type": "ItemList",
                    "itemListElement": [
                        {"@type": "ListItem", "position": i, "url": f"{SITE}{path(ep)}", "name": ep["title"]}
                        for i, ep in enumerate(reversed(EPS), 1)
                    ],
                },
            },
            breadcrumbs(("Home", f"{SITE}/"), ("Podcast", SHOW_URL)),
        ],
    })
    title = f"{SHOW['title']}: Podcast Episodes | Avery Whitted"
    return page(head(title, SHOW["meta_description"], SHOW_URL, jsonld), header(True), main)


def episode_page(i, ep):
    older = EPS[i - 1] if i > 0 else None
    newer = EPS[i + 1] if i < len(EPS) - 1 else None

    def pager(other, side):
        if other is None:
            label = "First episode" if side == "prev" else "Latest episode"
            return f'          <div class="pager {side} is-empty"><span class="pager-dir">{label}</span></div>'
        arrow = f"&larr; Previous &middot; {code(other)}" if side == "prev" else f"Next &middot; {code(other)} &rarr;"
        with_line = f'\n            <span class="pager-guest">with {esc(guest(other))}</span>' if guest(other) else ""
        return f"""          <a class="pager {side}" href="{path(other)}" rel="{'prev' if side == 'prev' else 'next'}">
            <span class="pager-dir">{arrow}</span>
            <span class="pager-title">{esc(other['headline'])}</span>{with_line}
          </a>"""

    rail_items = []
    for other in reversed(EPS):
        sub = f"{esc(guest(other))} &middot; {when(other)}" if guest(other) else when(other)
        inner = (
            f'<span class="rail-num" aria-hidden="true">{tile(other)}</span>'
            f'<span class="rail-text"><strong>{esc(other["headline"])}</strong><em>{sub}</em></span>'
        )
        if other is ep:
            rail_items.append(f'            <li data-date="{esc(other["published"])}"><div class="rail-item is-current" aria-current="page">{inner}</div></li>')
        else:
            rail_items.append(f'            <li data-date="{esc(other["published"])}"><a class="rail-item" href="{path(other)}">{inner}</a></li>')

    links = ""
    if ep.get("links"):
        rows = "".join(
            "\n              <li>"
            + (f'<span class="lk">{esc(l["label"])}:</span>' if l.get("label") else "")
            + f'<a href="{esc(l["url"])}" target="_blank" rel="noopener noreferrer">{esc(l["text"])}</a></li>'
            for l in ep["links"]
        )
        links = f'          <div class="notes-group">\n            <h3>Links</h3>\n            <ul>{rows}\n            </ul>\n          </div>'

    guest_line = f'\n              <p class="ep-guest">with <span class="hl">{esc(guest(ep))}</span></p>' if guest(ep) else ""
    rail_sort = sort_control("#rail-list", small=True) if len(EPS) > 1 else ""

    main = f"""        <a class="back" href="/podcast/">&larr; All episodes</a>
        <div class="ep-layout">
          <article class="ep-main">
            <section class="panel ep-hero" aria-labelledby="ep-title">
              <p class="eyebrow">{esc(SHOW['title'])} &middot; {label(ep)}</p>
              <h1 class="ep-title" id="ep-title">{esc(ep['headline'])}</h1>{guest_line}
              <p class="ep-meta"><span>{when(ep)}</span><span>{mins(ep)}</span></p>
            </section>

            <section class="panel player" aria-label="Episode player">
              <div class="player-head">
                <span class="label">Listen</span>
                <a class="ext" href="{esc(apple_page(ep))}" target="_blank" rel="noopener noreferrer">Open in Apple Podcasts &nearr;</a>
              </div>
              <div class="player-slot">
                <iframe
                  title="Play: {esc(ep['title'])}"
                  src="{esc(apple_embed(ep))}"
                  loading="lazy"
                  sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
                  allow="autoplay *; encrypted-media *; clipboard-write"
                ></iframe>
              </div>
            </section>

            <section class="panel notes" aria-labelledby="notes-title">
              <h2 class="h2" id="notes-title">About this episode</h2>
              <div class="prose"><p>{esc(ep['summary'])}</p></div>
              <p class="hosted">Hosted by <strong>Avery Whitted</strong></p>
{links}
            </section>

            <nav class="ep-pager" aria-label="Previous and next episode">
{pager(older, 'prev')}
{pager(newer, 'next')}
            </nav>

            <section class="panel cta" aria-labelledby="cta-title">
              <h2 class="cta-title" id="cta-title">Private coaching</h2>
              <p>If you're interested in audition coaching, scene work, or guidance in navigating the industry, one-on-one sessions are available on Zoom or in person.</p>
              <div class="cta-actions">
                <a class="btn lime" href="{BOOK}" target="_blank" rel="noopener noreferrer">Book a Session</a>
              </div>
            </section>
          </article>

          <aside class="ep-rail" aria-label="All episodes">
            <div class="panel rail">
              <div class="rail-head">
                <h2 class="rail-title">All episodes</h2>
                {rail_sort}
              </div>
              <ol class="rail-list" id="rail-list">
{chr(10).join(rail_items)}
              </ol>
              <a class="rail-all" href="/podcast/">&larr; Back to episodes</a>
            </div>
          </aside>
        </div>"""

    canonical = f"{SITE}{path(ep)}"
    jsonld = ld({
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "PodcastEpisode",
                "@id": f"{canonical}#episode",
                "url": canonical,
                "name": ep["title"],
                "description": ep["summary"],
                "datePublished": ep["published"],
                "episodeNumber": ep["number"],
                **({"partOfSeason": {"@type": "PodcastSeason", "seasonNumber": ep["season"], "partOfSeries": {"@type": "PodcastSeries", "name": SHOW["title"], "url": SHOW_URL}}} if ep.get("season") else {}),
                "timeRequired": iso_duration(ep),
                "inLanguage": "en-US",
                "author": HOST,
                "sameAs": apple_page(ep),
                "partOfSeries": {"@type": "PodcastSeries", "name": SHOW["title"], "url": SHOW_URL},
            },
            breadcrumbs(("Home", f"{SITE}/"), ("Podcast", SHOW_URL), (ep["title"], canonical)),
        ],
    })
    title = f"{ep['title']} | {SHOW['title']}"
    return page(head(title, meta_description(ep), canonical, jsonld, og_type="article"), header(False), main)


def write(rel, text):
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and out.read_text(encoding="utf-8") == text:
        return
    out.write_text(text, encoding="utf-8")
    print("wrote", rel)


def update_sitemap():
    """Rewrite the block between the podcast markers in sitemap.xml."""
    p = ROOT / "sitemap.xml"
    s = p.read_text(encoding="utf-8")
    pattern = re.compile(r"(<!-- podcast:start -->).*?(<!-- podcast:end -->)", re.S)
    if not pattern.search(s):
        print("warning: podcast markers not found in sitemap.xml; sitemap not updated")
        return
    entries = [(SHOW_URL, "0.7")] + [(f"{SITE}{path(ep)}", "0.6") for ep in reversed(EPS)]
    block = "\n".join(f"  <url>\n    <loc>{u}</loc>\n    <priority>{pr}</priority>\n  </url>" for u, pr in entries)
    new = pattern.sub(lambda m: f"{m.group(1)}\n{block}\n  {m.group(2)}", s)
    if new != s:
        p.write_text(new, encoding="utf-8")
        print("wrote sitemap.xml")


if __name__ == "__main__":
    write("podcast/index.html", hub_page())
    for i, ep in enumerate(EPS):
        write(f"podcast/{ep['slug']}/index.html", episode_page(i, ep))
    update_sitemap()
