from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
import json
import time
import cloudscraper
from bs4 import BeautifulSoup


BROWSER_CONFIGS = [
    {"browser": {"browser": "chrome", "platform": "windows", "desktop": True}},
    {"browser": {"browser": "chrome", "platform": "linux", "desktop": True}},
    {"browser": {"browser": "firefox", "platform": "windows", "desktop": True}},
    {"browser": "chrome"},
    {},
]


def make_scraper(attempt=0):
    idx = attempt % len(BROWSER_CONFIGS)
    return cloudscraper.create_scraper(**BROWSER_CONFIGS[idx])


def scrape_with_retry(url, max_retries=3):
    """Try fetching a URL with different cloudscraper configs until one works."""
    last_error = None
    for attempt in range(max_retries):
        try:
            scraper = make_scraper(attempt)
            resp = scraper.get(url, timeout=20)
            if resp.status_code == 200:
                return scraper, resp
            last_error = f"status {resp.status_code}"
        except Exception as e:
            last_error = str(e)
        if attempt < max_retries - 1:
            time.sleep(0.5)
    return None, last_error


def parse_tab_page(html):
    """Extract tab data from a UG page HTML."""
    soup = BeautifulSoup(html, "html.parser")
    store = soup.find("div", class_="js-store")
    if not store:
        return None, "Could not parse page"

    data = json.loads(store.get("data-content", "{}"))
    page_data = data.get("store", {}).get("page", {}).get("data", {})

    tab_info = page_data.get("tab", {})
    tab_view = page_data.get("tab_view", {})
    wiki_tab = tab_view.get("wiki_tab", {})
    content = wiki_tab.get("content", "")

    if not content:
        return None, "No chord content found"

    return {
        "id": tab_info.get("id"),
        "song_name": tab_info.get("song_name"),
        "artist_name": tab_info.get("artist_name"),
        "rating": round(tab_info.get("rating", 0), 2),
        "votes": tab_info.get("votes", 0),
        "capo": tab_info.get("capo", 0),
        "tonality": tab_info.get("tonality_name", ""),
        "version": tab_info.get("version"),
        "content": content,
    }, None


def parse_search_results(html):
    """Extract chord search results from a UG search page HTML."""
    soup = BeautifulSoup(html, "html.parser")
    store = soup.find("div", class_="js-store")
    if not store:
        return [], "Could not parse search page"

    data = json.loads(store.get("data-content", "{}"))
    results = data.get("store", {}).get("page", {}).get("data", {}).get("results", [])

    chords = []
    for r in results:
        if not isinstance(r, dict):
            continue
        if r.get("type") != "Chords":
            continue
        if r.get("marketing_type") == "pro":
            continue
        chords.append(r)

    chords.sort(key=lambda x: (x.get("rating", 0), x.get("votes", 0)), reverse=True)
    return chords, None


def fetch_best_chords(query):
    """Search UG and fetch the highest-rated chords version."""
    search_url = f"https://www.ultimate-guitar.com/search.php?search_type=title&value={query}"

    scraper, resp = scrape_with_retry(search_url)
    if scraper is None:
        return {"error": f"Search failed ({resp})"}

    chords, err = parse_search_results(resp.text)
    if err:
        return {"error": err}
    if not chords:
        return {"error": "No chord results found"}

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

    # Fetch tab using the SAME session first (cookies help), fallback to retry
    tab_resp = scraper.get(tab_url, timeout=20)
    if tab_resp.status_code != 200:
        # Retry with fresh scrapers
        _, tab_resp = scrape_with_retry(tab_url)
        if not isinstance(tab_resp, type(resp)):
            return {"error": f"Tab fetch failed ({tab_resp})", "search_results": search_results}

    tab, err = parse_tab_page(tab_resp.text)
    if err:
        return {"error": err, "search_results": search_results}

    return {"tab": tab, "search_results": search_results}


def fetch_tab_by_url(tab_url):
    """Fetch a specific tab by its full URL."""
    scraper, resp = scrape_with_retry(tab_url)
    if scraper is None:
        return {"error": f"Tab fetch failed ({resp})"}

    tab, err = parse_tab_page(resp.text)
    if err:
        return {"error": err}

    return {"tab": tab}


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
