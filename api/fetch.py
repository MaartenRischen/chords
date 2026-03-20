from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
import json
import cloudscraper
from bs4 import BeautifulSoup


def fetch_best_chords(query):
    """Search UG and fetch the highest-rated chords version in one session."""
    scraper = cloudscraper.create_scraper()

    # Step 1: Search
    search_url = f"https://www.ultimate-guitar.com/search.php?search_type=title&value={query}"
    resp = scraper.get(search_url, timeout=20)

    if resp.status_code != 200:
        return {"error": f"Search failed (status {resp.status_code})"}

    soup = BeautifulSoup(resp.text, "html.parser")
    store = soup.find("div", class_="js-store")
    if not store:
        return {"error": "Could not parse search page"}

    data = json.loads(store.get("data-content", "{}"))
    results = data.get("store", {}).get("page", {}).get("data", {}).get("results", [])

    # Filter to chords only, no pro
    chords = []
    for r in results:
        if not isinstance(r, dict):
            continue
        if r.get("type") != "Chords":
            continue
        if r.get("marketing_type") == "pro":
            continue
        chords.append(r)

    if not chords:
        return {"error": "No chord results found"}

    # Sort by (rating, votes) descending
    chords.sort(key=lambda x: (x.get("rating", 0), x.get("votes", 0)), reverse=True)

    # Also return all search results for the frontend
    search_results = []
    for c in chords[:15]:
        search_results.append({
            "id": c.get("id"),
            "song_name": c.get("song_name"),
            "artist_name": c.get("artist_name"),
            "rating": round(c.get("rating", 0), 2),
            "votes": c.get("votes", 0),
            "version": c.get("version"),
            "tonality": c.get("tonality_name", ""),
            "tab_url": c.get("tab_url", ""),
        })

    best = chords[0]
    tab_url = best.get("tab_url")

    if not tab_url:
        return {"error": "No tab URL found", "search_results": search_results}

    # Step 2: Fetch the tab page using the SAME session (cookies carry over)
    tab_resp = scraper.get(tab_url, timeout=20)

    if tab_resp.status_code != 200:
        return {"error": f"Tab fetch failed (status {tab_resp.status_code})", "search_results": search_results}

    tab_soup = BeautifulSoup(tab_resp.text, "html.parser")
    tab_store = tab_soup.find("div", class_="js-store")
    if not tab_store:
        return {"error": "Could not parse tab page", "search_results": search_results}

    tab_data = json.loads(tab_store.get("data-content", "{}"))
    page_data = tab_data.get("store", {}).get("page", {}).get("data", {})

    tab_info = page_data.get("tab", {})
    tab_view = page_data.get("tab_view", {})
    wiki_tab = tab_view.get("wiki_tab", {})
    content = wiki_tab.get("content", "")

    if not content:
        return {"error": "No chord content found", "search_results": search_results}

    return {
        "tab": {
            "id": tab_info.get("id") or best.get("id"),
            "song_name": tab_info.get("song_name"),
            "artist_name": tab_info.get("artist_name"),
            "rating": round(tab_info.get("rating", 0), 2),
            "votes": tab_info.get("votes", 0),
            "capo": tab_info.get("capo", 0),
            "tonality": tab_info.get("tonality_name", ""),
            "version": tab_info.get("version"),
            "content": content,
        },
        "search_results": search_results,
    }


def fetch_tab_by_url(tab_url):
    """Fetch a specific tab by its full URL."""
    scraper = cloudscraper.create_scraper()

    # Warm up the session on the search page first
    scraper.get("https://www.ultimate-guitar.com/", timeout=10)

    resp = scraper.get(tab_url, timeout=20)
    if resp.status_code != 200:
        return {"error": f"Tab fetch failed (status {resp.status_code})"}

    soup = BeautifulSoup(resp.text, "html.parser")
    store = soup.find("div", class_="js-store")
    if not store:
        return {"error": "Could not parse tab page"}

    data = json.loads(store.get("data-content", "{}"))
    page_data = data.get("store", {}).get("page", {}).get("data", {})

    tab_info = page_data.get("tab", {})
    tab_view = page_data.get("tab_view", {})
    wiki_tab = tab_view.get("wiki_tab", {})
    content = wiki_tab.get("content", "")

    if not content:
        return {"error": "No chord content found"}

    return {
        "tab": {
            "id": tab_info.get("id"),
            "song_name": tab_info.get("song_name"),
            "artist_name": tab_info.get("artist_name"),
            "rating": round(tab_info.get("rating", 0), 2),
            "votes": tab_info.get("votes", 0),
            "capo": tab_info.get("capo", 0),
            "tonality": tab_info.get("tonality_name", ""),
            "version": tab_info.get("version"),
            "content": content,
        },
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        q = query.get("q", [""])[0].strip()
        url = query.get("url", [""])[0].strip()

        if not q and not url:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing ?q= or ?url= parameter"}).encode())
            return

        try:
            if url:
                result = fetch_tab_by_url(url)
            else:
                result = fetch_best_chords(q)
            self.send_response(200)
        except Exception as e:
            result = {"error": str(e)}
            self.send_response(500)

        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
