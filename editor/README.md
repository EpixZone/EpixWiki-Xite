# Editor dependencies

These files reuse the editor shipped by EpixBlog-Xite at commit
`88d78c6524da9b3a02af1e8432e3c1fb8042d7b3`.

- `easymde.min.js` and `easymde.min.css`: EasyMDE 2.20.0, MIT.
- `alloy-editor-all-min.js`: AlloyEditor 1.3.0 and its bundled CKEditor 4.6.0. See `ALLOY-LICENSE` and `CKEDITOR-LICENSE`.
- `to-markdown.js`: EpixBlog's HTML-to-Markdown converter, MIT. Preserve its local conversion fixes when updating it.
- `rich-config.js`: the bundled English labels from EpixBlog and Wiki's local configuration. The shared Wiki toolbar handles formatting and link validation. Floating toolbars, remote config, embeds and file drop uploads are disabled.

The Markdown enhancement loads when the page editor opens. Rich text dependencies
load only when the author selects Rich text. All dependencies are served locally.
The plain Markdown textarea remains usable if an enhancement cannot load.

`js/WikiEditor.js` shares EpixBlog's selection formatting behavior. The caller
provides the same `render(markdown)` function used for page reading. Wiki anchors
must include `data-wiki-page` with the page name to preserve their wiki syntax
after rich text edits. Rendering is sanitized again before entering the editor.

Untouched Markdown, including line endings, survives mode switches verbatim.
Rich text changes serialize through the shared converter. Pasting in rich text
uses plain text, and the toolbar accepts HTTP, HTTPS, mailto links and relative
paths. Image URLs cannot use mailto.

Run `npm run test:editor` for browser checks of formatting, source preservation,
wiki links, paste handling, undo, keyboard access and the Markdown fallback.
