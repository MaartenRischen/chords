# Chords

Mobile web app: search any song, get its **highest-rated user-submitted chord
version** from Ultimate Guitar in a clean read-while-you-play view, with
transposition.

## Run

```sh
npm start          # http://localhost:3456
```

Zero dependencies, Node 18+. Open it on your phone via your Mac's LAN IP
(`http://<mac-ip>:3456`).

## Features

- **Best version auto-pick** — all user-submitted (non-Pro) chord versions are
  ranked by rating with Bayesian shrinkage on vote count, so a 5.0★ with 3
  votes doesn't beat a 4.86★ with 12,000.
- **Transpose** ± any number of semitones (slash chords handled; flat keys keep
  flat spelling). Chord-over-lyric alignment is re-padded so columns stay put.
- **Version picker** — switch to any other chords version of the song.
- **Autoscroll** with adjustable speed + screen wake-lock while scrolling.
- **Font size** controls, capo/tuning/key chips, recent searches.
- **Library** — every loaded song is auto-saved (content + your transpose
  setting) to localStorage. Open saved songs instantly from the home screen,
  no network needed. 🎸 button returns to the library.
- **Search suggestions** — typeahead (iTunes-backed) with album art; pick the
  exact artist when a title is ambiguous (e.g. "One" → Metallica vs U2).

## How it works (the interesting part)

Ultimate Guitar's website is behind a Cloudflare JS challenge, and the mobile
API's search endpoint is locked. But:

1. **iTunes Search API** (open) resolves free-text queries to a canonical
   artist + title.
2. **Wayback Machine CDX index** (open) is queried with the exact UG URL prefix
   `tab/<artist-slug>/<song-slug>-chords-` — a fast range scan that yields real
   tab IDs. Bing RSS is the fallback.
3. **UG mobile API** `tab/info` *is* accessible with the app's signed headers
   (md5 of client-id + date-hour + a known constant). One tab ID returns the
   song's full version list with ratings *and* the chord content.

Results are cached in memory for 30 minutes.
