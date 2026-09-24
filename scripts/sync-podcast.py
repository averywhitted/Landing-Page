#!/usr/bin/env python3
"""Pull the podcast RSS feed into podcast/episodes.json, then rebuild the pages.

    python3 scripts/sync-podcast.py             # sync and rebuild
    python3 scripts/sync-podcast.py --dry-run   # show what would change, write nothing

The feed is the source of truth for each episode's title, date, length, description,
links, season, and episode number, so edit those in Spotify for Podcasters, not in
episodes.json. Never overwritten: slug and meta_description. An episode with no season
or number in the feed joins the latest season with the next free number.

Titles written as "Guest: Headline" get a guest line, when the guest's name also
appears in the description. Any other title is shown as-is.

An episode is published once Apple Podcasts lists it (the player needs Apple's
episode id), usually a few hours after it shows up in the feed. Episodes removed from
the feed are not deleted from the site. Standard library only.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "podcast" / "episodes.json"
ITUNES_NS = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
FIELD_ORDER = [
    "season", "number", "slug", "title", "guest", "headline", "guid", "published", "duration_seconds",
    "apple_episode_id", "apple_episode_slug", "summary", "meta_description", "links",
]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "averywhitted.com podcast sync (+https://averywhitted.com)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def norm(text):
    return re.sub(r"\s+", " ", text).strip()


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


class Notes(HTMLParser):
    """Reads an episode description: paragraph text, plus each link with the text just before it as its label."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paragraphs = []
        self.links = []  # (label, text, href)
        self._para = []
        self._pending = []
        self._href = None
        self._anchor = []

    def _end_paragraph(self):
        text = norm("".join(self._para))
        if text:
            self.paragraphs.append(text)
        self._para, self._pending = [], []

    def handle_starttag(self, tag, attrs):
        if tag == "p":
            self._end_paragraph()
        elif tag == "br":
            self.handle_data(" ")
        elif tag == "a":
            self._href = dict(attrs).get("href") or ""
            self._anchor = []

    def handle_endtag(self, tag):
        if tag == "p":
            self._end_paragraph()
        elif tag == "a" and self._href is not None:
            text = norm("".join(self._anchor))
            label = norm("".join(self._pending)).rstrip(":").strip()
            if self._href and text:
                self.links.append((label, text, self._href))
            self._pending, self._href = [], None

    def handle_data(self, data):
        self._para.append(data)
        (self._anchor if self._href is not None else self._pending).append(data)

    def close(self):
        super().close()
        self._end_paragraph()


def clean_href(href):
    if not re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I):
        href = "https://" + href.lstrip("/")
    if not re.match(r"^https?://", href, re.I):
        return None  # web links only: never javascript:, data:, etc.
    host = re.sub(r"^https?://(www\.)?", "", href, flags=re.I).split("/")[0].lower()
    return None if host.endswith("averywhitted.com") else href


def seconds(value):
    total = 0
    for part in value.split(":"):
        total = total * 60 + int(float(part))
    return total


def parse_feed(xml_bytes):
    channel = ET.fromstring(xml_bytes).find("channel")
    items = []
    for it in channel.findall("item"):
        text = lambda tag: (it.findtext(tag) or "").strip()
        notes = Notes()
        notes.feed(text("description"))
        notes.close()
        links = []
        for label, link_text, href in notes.links:
            href = clean_href(href)
            if href:
                links.append({"label": label, "text": link_text, "url": href} if label else {"text": link_text, "url": href})
        title = text("title")
        summary = notes.paragraphs[0] if notes.paragraphs else title
        guest, headline = "", title
        if ": " in title:
            prefix, rest = title.split(": ", 1)
            if prefix and prefix in summary:
                guest, headline = prefix, rest
        published = parsedate_to_datetime(text("pubDate")).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        items.append({
            "guid": text("guid"),
            "title": title,
            "guest": guest,
            "headline": headline,
            "published": published,
            "duration_seconds": seconds(text(f"{ITUNES_NS}duration") or "0"),
            "summary": summary,
            "links": links,
            "season": int(text(f"{ITUNES_NS}season")) if text(f"{ITUNES_NS}season").isdigit() else None,
            "number": int(text(f"{ITUNES_NS}episode")) if text(f"{ITUNES_NS}episode").isdigit() else None,
        })
    return items


def apple_episodes(show_id):
    url = f"https://itunes.apple.com/lookup?id={show_id}&entity=podcastEpisode&limit=200&country=us"
    found = {}
    for row in json.loads(fetch(url)).get("results", []):
        guid = row.get("episodeGuid")
        if not guid:
            continue
        m = re.search(r"/podcast/([^/]+)/id\d+", row.get("trackViewUrl", ""))
        found[guid] = {"apple_episode_id": str(row["trackId"]), "apple_episode_slug": m.group(1) if m else ""}
    return found


def auto_meta_description(summary):
    text = summary if len(summary) <= 130 else summary[:130].rsplit(" ", 1)[0].rstrip(",;:.") + "..."
    return f"{text} 90% of the Job, hosted by Avery Whitted."


def ordered(ep):
    return {k: ep[k] for k in FIELD_ORDER if k in ep and ep[k] not in (None, "")}


def merge(episodes, feed, apple):
    """Fold feed items into the episodes list, in place. Returns (added, updated, waiting) titles."""
    by_guid = {ep["guid"]: ep for ep in episodes if ep.get("guid")}
    by_title = {ep["title"]: ep for ep in episodes}
    used_slugs = {ep["slug"] for ep in episodes}
    added, updated, waiting = [], [], []

    for item in sorted(feed, key=lambda i: i["published"]):
        ep = by_guid.get(item["guid"]) or by_title.get(item["title"])
        listing = apple.get(item["guid"])
        if ep is None and listing is None:
            waiting.append(item["title"])
            continue

        before = json.dumps(ordered(ep), sort_keys=True) if ep else None
        is_new = ep is None
        if is_new:
            ep = {}
            episodes.append(ep)
        for key in ("guid", "title", "guest", "headline", "published", "duration_seconds", "summary", "links"):
            ep[key] = item[key]

        if item["season"]:
            ep["season"] = item["season"]
        elif is_new:
            latest = max([e["season"] for e in episodes if e.get("season")] or [0])
            if latest:
                ep["season"] = latest
        if item["number"]:
            ep["number"] = item["number"]
        elif "number" not in ep:
            in_season = [e["number"] for e in episodes if e.get("season") == ep.get("season") and "number" in e]
            ep["number"] = max(in_season + [0]) + 1

        if is_new:
            slug = slugify(item["guest"] or item["headline"])[:60] or f"episode-{ep['number']}"
            base, n = slug, 2
            while slug in used_slugs:
                slug, n = f"{base}-{n}", n + 1
            ep["slug"] = slug
            used_slugs.add(slug)
        if listing:
            ep.update(listing)
        if not ep.get("meta_description"):
            ep["meta_description"] = auto_meta_description(item["summary"])

        after = json.dumps(ordered(ep), sort_keys=True)
        if is_new:
            added.append(ep["title"])
        elif before != after:
            updated.append(ep["title"])
    return added, updated, waiting


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="show what would change without writing anything")
    args = ap.parse_args()

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    show, episodes = data["show"], data["episodes"]
    feed = parse_feed(fetch(show["rss"]))
    apple = apple_episodes(show["apple_show_id"])
    added, updated, waiting = merge(episodes, feed, apple)

    data["episodes"] = [ordered(ep) for ep in sorted(episodes, key=lambda e: e["published"])]
    new_text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"

    print(f"added:   {added or 'none'}")
    print(f"updated: {updated or 'none'}")
    if waiting:
        print(f"waiting for Apple Podcasts to list: {waiting}")
    if args.dry_run:
        print("dry run: nothing written")
        return
    if new_text != DATA_PATH.read_text(encoding="utf-8"):
        DATA_PATH.write_text(new_text, encoding="utf-8")
        print("wrote podcast/episodes.json")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build-podcast.py")], check=True)


if __name__ == "__main__":
    main()
