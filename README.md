# Epix Wiki

A collaborative wiki for [EpixNet](https://epixnet.io), with signed page revisions and a local editor. There is no build step or external asset service.

## Reading and writing

- Browse the home page, all pages, recent changes, and full-text search.
- Follow `[[Page name]]` or `[[Page name|Label]]` links, including links to pages that have not been written yet.
- Create pages and edit in Markdown or rich text. Both modes have formatting controls, wiki links, images by URL, and a preview.
- Browse revision history, open a revision directly, and restore it as a new revision.
- Connect an xID to publish. Reading and drafting do not require signing in.
- Keep drafts intact when files arrive, identities change, or the node reconnects. Leaving an unsaved draft requires confirmation.
- Retry a failed publication using the already signed revision. A local save is not reported as a successful publication.
- Use the responsive layout with keyboard navigation and the node's light or dark theme.

Existing URLs remain valid: `?Page:home`, `?Index`, `?Page:home&History`, and `?Page:home&Rev:ID`. Navigation and browser history use the EpixNet wrapper without reloading the iframe.

## EDX and data compatibility

The Wiki follows the current EpixTalk, EpixPost, and EpixBlog data path:

1. `recordSign` signs an immutable revision with a unique key.
2. `fileWrite` writes an `epix-orset-1` container to `data/users/<xid_directory-or-auth_address>/pages.json`.
3. `sitePublish` signs and publishes the user's manifest. The node declares the merge file and handles EDX verification, union merges, bundles, and distribution.

`dbQuery` reads the node's derived local index. It is not a separate legacy storage backend. Schema version 4 indexes authenticated signed record history without folding older revisions away. Current-page queries apply the OR-set causal frontier and delete rules before selecting the newest page revision. Legacy `data.json` pages remain readable, including their old revision URLs. Opening the wiki never rewrites legacy data.

The first save retains any existing local signed records, including a file not yet declared as a merge file. Each subsequent revision uses its own key, so an edit never replaces earlier history. The existing 3 MB per-user merge-file quota still applies. The node enforces file rules and ownership.

Startup waits for site information and retries transient database failures. File events, reconnects, and a bounded empty-result retry recover when indexing finishes after the shell loads. Missing content and failed queries have separate states.

## Source layout

- `js/EpixWiki.js`: application lifecycle, wrapper navigation, views, and editing sessions.
- `js/WikiStore.js`: parameterized queries, revision selection, signed writes, and publish retry.
- `js/WikiRouter.js`: compatible URLs and page slugs.
- `js/WikiMarkdown.js`: sanitized Markdown, wiki links, and scoped heading anchors.
- `js/WikiEditor.js`, `editor/`: EpixBlog-based editor with local, lazy-loaded dependencies.
- `css/`: responsive application and editor styles.
- `dbschema.json`: rebuildable read index.

DOMPurify sanitizes rendered page content. Wiki links are expanded only in text, never inside code examples. Editor dependencies and their licenses are documented in `editor/README.md`.

## Verification

Requires Node 22.13 or later.

```sh
npm ci
npx playwright install chromium
npm test
```

The suite uses real SQLite and Chromium. Its wrapper fixture implements the EpixFrame postMessage protocol and exercises delayed indexing, navigation, history, editing, publishing, failures, and reconnects. Editor checks cover both modes, source preservation, formatting, safe paste, keyboard controls, and fallback when an enhancement cannot load. Fixture signatures simulate the node for deterministic browser tests; they are not a cryptographic or public-peer test.

## Publishing an update

Publish from an owner-authorized EpixNet node. Re-sign the root manifest after copying the source so the node regenerates the file list, EDX hashes, bundles, and signatures. The checked-in signed file metadata describes the previous public release and must not be reused as a signature for changed source. `order_policy.first_paint` lists the new shell; the larger editor libraries load when needed. Tests, development dependencies, Git metadata, and local user data are excluded from the root package.

Cloneable wikis use `data-default/users/content-default.json`, which authorizes xID chain identities and the same signed merge-file format. The upgrade preserves the Wiki address and user-content permissions.

## License

MIT. Vendored dependencies retain their own licenses.
