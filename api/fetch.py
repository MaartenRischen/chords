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


def scrape_with_retry(url, max_retries=3):
    last_error = None
    for attempt in range(max_retries):
        try:
            idx = attempt % len(BROWSER_CONFIGS)
            scraper = cloudscraper.create_scraper(**BROWSER_CONFIGS[idx])
            resp = scraper.get(url, timeout=20)
            if resp.status_code == 200:
                return resp
            last_error = f"status {resp.status_code}"
        except Exception as e:
            last_error = str(e)
        if attempt < max_retries - 1:
            time.sleep(0.5)
    return last_error


def fetch_tab_by_url(tab_url):
    resp = scrape_with_retry(tab_url)
    if isinstance(resp, str):
        return {"error": f"Tab fetch failed ({resp})"}

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
        url = query.get("url", [""])[0].strip()

        if not url:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing ?url= parameter"}).encode())
            return

        try:
            result = fetch_tab_by_url(url)
            self.send_response(200)
        except Exception as e:
            result = {"error": str(e)}
            self.send_response(500)

        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
