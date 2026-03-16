# Epix Wiki

Collaborative knowledge, fully decentralized. A wiki platform on [EpixNet](https://epixnet.io).

## Features

- Markdown-based page editing
- Wiki links with `[[Page Name]]` syntax
- Full revision history per page
- Restore previous versions
- Link validation (highlights broken links)
- Auto-generated index of all pages
- xID-authenticated contributors
- Per-user storage quotas
- Cloneable — create your own wiki

## Structure

```
epix1wkkpkx4ldeuh30e3wnz25ft70j9rj9ns77plwa/
├── index.html
├── content.json
├── dbschema.json          # EpixWiki DB (v2)
├── LICENSE                # MIT
├── css/
│   └── all.css            # Bundled stylesheet
├── js/
│   ├── EpixWiki.js        # Main app (extends EpixFrame)
│   ├── WikiUi.js          # UI state management
│   ├── LinkHelper.js      # Wiki link parser
│   ├── Time.js            # Time formatting
│   └── lib/               # EpixFrame, marked, slugger, uuid
└── data-default/
    ├── data.json           # Default wiki config
    └── users/
        └── content-default.json
```

## Database

- **File:** `data/epixwiki.db`
- **Tables:** `pages` (id, body, slug, date_added)

## Tech Stack

- Vanilla ES6 JavaScript (no build step)
- EpixFrame WebSocket bridge
- marked.js for markdown rendering
- UUID v1 for revision IDs
- All JS wrapped in IIFEs

## License

MIT
