from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
import json
import cloudscraper
from bs4 import BeautifulSoup


def search_ug(query):
    scraper = cloudscraper.create_scraper()
    url = f"https://www.ultimate-guitar.com/search.php?search_type=title&value={query}"
    resp = scraper.get(url, timeout=15)

    if resp.status_code != 200:
        return {"error": f"UG returned {resp.status_code}"}

    soup = BeautifulSoup(resp.text, "html.parser")
    store = soup.find("div", class_="js-store")
    if not store:
        return {"error": "Could not parse page"}

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

        chords.append({
            "id": r.get("id"),
            "song_name": r.get("song_name"),
            "artist_name": r.get("artist_name"),
            "rating": round(r.get("rating", 0), 2),
            "votes": r.get("votes", 0),
            "version": r.get("version"),
            "tonality": r.get("tonality_name", ""),
        })

    chords.sort(key=lambda x: (x["rating"], x["votes"]), reverse=True)
    return {"results": chords}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        q = query.get("q", [""])[0].strip()

        if not q:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing ?q= parameter"}).encode())
            return

        try:
            result = search_ug(q)
            self.send_response(200)
        except Exception as e:
            result = {"error": str(e)}
            self.send_response(500)

        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
