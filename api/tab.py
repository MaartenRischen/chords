from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
import json
import re
import cloudscraper
from bs4 import BeautifulSoup


def fetch_tab(tab_id):
    scraper = cloudscraper.create_scraper()

    # First, find the URL for this tab ID by searching for it
    # We need to construct the URL - UG uses a slug format
    # The easiest way is to use the tab_url from search, but we can also
    # try the direct URL pattern
    url = f"https://www.ultimate-guitar.com/search.php?search_type=title&value=tab_id_{tab_id}"

    # Actually, let's try fetching the tab page directly via their redirect
    url = f"https://tabs.ultimate-guitar.com/tab/{tab_id}"
    resp = scraper.get(url, timeout=15, allow_redirects=True)

    if resp.status_code != 200:
        # Fallback: try to find the tab via the explore page
        return {"error": f"Could not fetch tab (status {resp.status_code})"}

    soup = BeautifulSoup(resp.text, "html.parser")
    store = soup.find("div", class_="js-store")
    if not store:
        return {"error": "Could not parse page data"}

    data = json.loads(store.get("data-content", "{}"))
    page_data = data.get("store", {}).get("page", {}).get("data", {})

    tab_info = page_data.get("tab", {})
    tab_view = page_data.get("tab_view", {})
    wiki_tab = tab_view.get("wiki_tab", {})
    content = wiki_tab.get("content", "")

    if not content:
        return {"error": "No chord content found"}

    # Get all versions to find the best one
    versions = tab_view.get("versions", [])
    chord_versions = []
    for v in versions:
        if v.get("type_name") == "Chords":
            chord_versions.append({
                "id": v.get("id"),
                "version": v.get("version"),
                "rating": round(v.get("rating", 0), 2),
                "votes": v.get("votes", 0),
            })

    return {
        "song_name": tab_info.get("song_name"),
        "artist_name": tab_info.get("artist_name"),
        "rating": round(tab_info.get("rating", 0), 2),
        "votes": tab_info.get("votes", 0),
        "capo": tab_info.get("capo", 0),
        "tonality": tab_info.get("tonality_name", ""),
        "version": tab_info.get("version"),
        "content": content,
        "versions": chord_versions,
        "applicature": tab_view.get("applicature", {}),
    }


def find_best_tab(search_query):
    """Search and automatically return the best chords version."""
    scraper = cloudscraper.create_scraper()
    url = f"https://www.ultimate-guitar.com/search.php?search_type=title&value={search_query}"
    resp = scraper.get(url, timeout=15)

    if resp.status_code != 200:
        return None, f"Search failed ({resp.status_code})"

    soup = BeautifulSoup(resp.text, "html.parser")
    store = soup.find("div", class_="js-store")
    if not store:
        return None, "Could not parse search results"

    data = json.loads(store.get("data-content", "{}"))
    results = data.get("store", {}).get("page", {}).get("data", {}).get("results", [])

    best = None
    for r in results:
        if not isinstance(r, dict):
            continue
        if r.get("type") != "Chords":
            continue
        if r.get("marketing_type") == "pro":
            continue

        score = (r.get("rating", 0), r.get("votes", 0))
        if best is None or score > (best.get("rating", 0), best.get("votes", 0)):
            best = r

    if best:
        return best.get("tab_url") or best.get("id"), None
    return None, "No chord results found"


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        tab_id = query.get("id", [""])[0].strip()

        if not tab_id:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing ?id= parameter"}).encode())
            return

        try:
            # tab_id can be a numeric ID or a full URL
            if tab_id.startswith("http"):
                scraper = cloudscraper.create_scraper()
                resp = scraper.get(tab_id, timeout=15)
                if resp.status_code != 200:
                    raise Exception(f"Could not fetch tab (status {resp.status_code})")
                soup = BeautifulSoup(resp.text, "html.parser")
                store = soup.find("div", class_="js-store")
                if not store:
                    raise Exception("Could not parse page data")
                data = json.loads(store.get("data-content", "{}"))
                page_data = data.get("store", {}).get("page", {}).get("data", {})
                tab_info = page_data.get("tab", {})
                tab_view = page_data.get("tab_view", {})
                wiki_tab = tab_view.get("wiki_tab", {})

                versions = tab_view.get("versions", [])
                chord_versions = []
                for v in versions:
                    if v.get("type_name") == "Chords":
                        chord_versions.append({
                            "id": v.get("id"),
                            "version": v.get("version"),
                            "rating": round(v.get("rating", 0), 2),
                            "votes": v.get("votes", 0),
                        })

                result = {
                    "song_name": tab_info.get("song_name"),
                    "artist_name": tab_info.get("artist_name"),
                    "rating": round(tab_info.get("rating", 0), 2),
                    "votes": tab_info.get("votes", 0),
                    "capo": tab_info.get("capo", 0),
                    "tonality": tab_info.get("tonality_name", ""),
                    "version": tab_info.get("version"),
                    "content": wiki_tab.get("content", ""),
                    "versions": chord_versions,
                    "applicature": tab_view.get("applicature", {}),
                }
            else:
                result = fetch_tab(int(tab_id))

            self.send_response(200)
        except Exception as e:
            result = {"error": str(e)}
            self.send_response(500)

        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
