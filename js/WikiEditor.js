(function () {
  "use strict";

  const scripts = new Map();
  let editorId = 0;
  function loadScript(path) {
    if (!scripts.has(path)) {
      scripts.set(path, new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = path;
        script.onload = resolve;
        script.onerror = () => { scripts.delete(path); script.remove(); reject(new Error("Could not load the editor.")); };
        document.head.appendChild(script);
      }));
    }
    return scripts.get(path);
  }

  function loadStyle(path) {
    if (document.querySelector('link[data-wiki-editor="' + path + '"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = path;
    link.dataset.wikiEditor = path;
    document.head.appendChild(link);
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  }

  class WikiEditor {
    constructor(container, options = {}) {
      this.container = container;
      this.options = options;
      this.mode = "markdown";
      this.source = "";
      this.lastValue = "";
      this.modeRequest = 0;
      this.id = "wiki-editor-" + (++editorId);
      container.classList.add("wiki-editor");
      container.innerHTML = '<div class="wiki-editor-modes" role="group" aria-label="Editor view"></div>' +
        '<div class="wiki-editor-toolbar" role="toolbar" aria-label="Text formatting"></div>' +
        '<div class="wiki-editor-link-form" hidden role="group" aria-label="Insert link"><label><span>Link URL</span><input type="text" autocomplete="off"></label><button type="button" data-insert>Insert link</button><button type="button" data-cancel>Cancel</button><span class="wiki-editor-link-error" role="alert"></span></div>' +
        '<div class="wiki-editor-markdown"><textarea aria-label="Page content in Markdown" spellcheck="false"></textarea></div>' +
        '<div class="wiki-editor-rich wiki-prose" hidden role="textbox" aria-multiline="true" aria-label="Page content in rich text" tabindex="0"></div>' +
        '<div class="wiki-editor-preview wiki-prose" hidden tabindex="0" aria-label="Page preview"></div>' +
        '<p class="wiki-editor-status" role="status" aria-live="polite"></p>';
      this.modes = container.querySelector(".wiki-editor-modes");
      this.toolbar = container.querySelector(".wiki-editor-toolbar");
      this.linkForm = container.querySelector(".wiki-editor-link-form");
      this.markdownPanel = container.querySelector(".wiki-editor-markdown");
      this.textarea = this.markdownPanel.querySelector("textarea");
      this.richPanel = container.querySelector(".wiki-editor-rich");
      this.richPanel.id = this.id + "-rich";
      this.previewPanel = container.querySelector(".wiki-editor-preview");
      this.status = container.querySelector(".wiki-editor-status");
      for (const [mode, label] of [["markdown", "Markdown"], ["rich", "Rich text"], ["preview", "Preview"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.dataset.mode = mode;
        button.setAttribute("aria-pressed", String(mode === this.mode));
        button.onclick = () => this.setMode(mode);
        this.modes.appendChild(button);
      }
      this.createToolbar();
      this.textarea.oninput = () => this.changed();
      this.handleSelection = () => this.rememberSelection();
      document.addEventListener("selectionchange", this.handleSelection);
      this.handleKeydown = e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (!this.readOnly && this.options.onSave) this.options.onSave();
        }
      };
      container.addEventListener("keydown", this.handleKeydown);
      this.richPanel.addEventListener("paste", e => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!this.readOnly && this.native) this.native.insertText(e.clipboardData.getData("text/plain"));
      }, true);
      this.richPanel.addEventListener("drop", e => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!this.readOnly && this.native && e.dataTransfer && !e.dataTransfer.files.length) {
          this.native.insertText(e.dataTransfer.getData("text/plain"));
        }
      }, true);
      this.richPanel.addEventListener("click", e => {
        if (e.target.closest("a")) { e.preventDefault(); e.stopPropagation(); }
      });
      this.previewPanel.addEventListener("click", e => {
        if (e.target.closest("a")) { e.preventDefault(); e.stopPropagation(); }
      });
      this.loadMarkdown();
    }

    async loadMarkdown() {
      try {
        loadStyle("editor/easymde.min.css");
        if (!window.EasyMDE) await loadScript("editor/easymde.min.js");
        if (this.destroyed || this.mde) return;
        const value = this.getValue();
        const focused = document.activeElement === this.textarea;
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        this.mde = new EasyMDE({element: this.textarea, spellChecker: false, autofocus: false,
          status: false, forceSync: true, tabSize: 2, autoDownloadFontAwesome: false,
          minHeight: "340px", toolbar: false, indentWithTabs: false});
        this.mde.codemirror.setOption("viewportMargin", Infinity);
        this.mde.codemirror.setOption("readOnly", !!this.readOnly);
        this.mde.codemirror.getInputField().setAttribute("aria-label", "Page content in Markdown");
        this.mde.codemirror.on("change", () => this.changed());
        this.mde.codemirror.refresh();
        this.markdownSource = value;
        this.markdownSnapshot = this.mde.value();
        if (focused) {
          this.mde.codemirror.setSelection(this.mde.codemirror.posFromIndex(start), this.mde.codemirror.posFromIndex(end));
          this.mde.codemirror.focus();
        }
      } catch (_) {
        if (!this.destroyed) this.status.textContent = "The plain Markdown editor is ready. Rich text can be loaded separately.";
      }
    }

    createToolbar() {
      const actions = [["bold", "Bold", "B"], ["italic", "Italic", "I"], ["strikethrough", "Strikethrough", "S"],
        ["heading", "Heading", "H2"], ["quote", "Quote", "Quote"], ["code", "Inline code", "</>"],
        ["code-block", "Code block", "Code"], ["unordered-list", "Bulleted list", "List"],
        ["ordered-list", "Numbered list", "1. List"], ["link", "Link", "Link"],
        ["wiki-link", "Wiki page link", "Wiki link"], ["image", "Image", "Image"], ["horizontal-rule", "Horizontal rule", "Rule"]];
      actions.forEach(([action, label, text], index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = action;
        button.dataset.action = action;
        button.textContent = text;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.tabIndex = index ? -1 : 0;
        button.onmousedown = e => { if (!e.button) { this.rememberSelection(); e.preventDefault(); } };
        button.onclick = () => this.format(action);
        this.toolbar.appendChild(button);
      });
      this.toolbar.onkeydown = e => {
        const buttons = Array.from(this.toolbar.querySelectorAll("button"));
        let index = buttons.indexOf(e.target);
        if (index < 0) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); return; }
        if (e.key === "ArrowRight") index = (index + 1) % buttons.length;
        else if (e.key === "ArrowLeft") index = (index + buttons.length - 1) % buttons.length;
        else if (e.key === "Home") index = 0;
        else if (e.key === "End") index = buttons.length - 1;
        else if (e.key === "Escape") { this.focus(); return; }
        else return;
        e.preventDefault();
        buttons.forEach((button, i) => button.tabIndex = i === index ? 0 : -1);
        buttons[index].focus();
      };
      this.toolbar.onkeyup = e => {
        if (e.target.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.target.click(); }
      };
      this.linkForm.querySelector("[data-insert]").onclick = () => this.insertLink();
      this.linkForm.querySelector("[data-cancel]").onclick = () => this.closeLink();
      this.linkForm.onkeydown = e => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.closeLink(); }
        // CKEditor's keyup handler must not mistake form input for rich editing.
        if (e.key === "Enter") e.preventDefault();
      };
      this.linkForm.onkeyup = e => {
        if (e.key === "Enter") { e.preventDefault(); if (e.target.tagName === "BUTTON") e.target.click(); else this.insertLink(); }
      };
    }

    validUrl(url, image) {
      url = String(url || "").trim();
      if (!url || /[\u0000-\u0020\u007f]/.test(url.replace(/ /g, ""))) return false;
      const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
      return !scheme || /^(https?|mailto)$/i.test(scheme[1]) && (!image || scheme[1].toLowerCase() !== "mailto");
    }

    // The renderer is shared with page reading. Keep the editable DOM safe as well.
    render(value) {
      const html = this.options.render ? this.options.render(value) : "<p>" + escapeHTML(value).replace(/\n/g, "<br>") + "</p>";
      const template = document.createElement("template");
      template.innerHTML = html;
      const allowed = new Set("A P BR STRONG B EM I DEL S STRIKE BLOCKQUOTE UL OL LI H1 H2 H3 H4 H5 H6 PRE CODE HR IMG TABLE THEAD TBODY TFOOT TR TH TD DIV SPAN INPUT".split(" "));
      for (const element of Array.from(template.content.querySelectorAll("*"))) {
        if (!allowed.has(element.tagName)) { element.remove(); continue; }
        for (const attr of Array.from(element.attributes)) {
          const languageClass = attr.name === "class" && element.tagName === "CODE" && /^(?:language|lang)-[a-z0-9_+.-]+$/i.test(attr.value);
          const keep = languageClass || ["href", "src", "alt", "title", "data-wiki-page", "start", "colspan", "rowspan", "type", "checked", "disabled"].includes(attr.name);
          const embeddedImage = element.tagName === "IMG" && attr.name === "src" && /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(attr.value);
          if (!keep || ((attr.name === "href" || attr.name === "src") && !embeddedImage && !this.validUrl(attr.value, attr.name === "src"))) element.removeAttribute(attr.name);
        }
        if (element.tagName === "INPUT") { element.type = "checkbox"; element.disabled = true; }
      }
      return template.innerHTML;
    }

    async ensureRich() {
      if (this.native) return;
      if (!this.richLoading) this.richLoading = (async () => {
        if (!window.toMarkdown) await loadScript("editor/to-markdown.js");
        if (!window.AlloyEditor) await loadScript("editor/alloy-editor-all-min.js");
        await loadScript("editor/rich-config.js");
        if (this.destroyed) return;
        this.alloy = AlloyEditor.editable(this.richPanel, {toolbars: {}});
        this.native = this.alloy.get("nativeEditor");
        await new Promise(resolve => {
          if (this.native.status === "ready") resolve();
          else this.native.on("instanceReady", resolve);
        });
        if (this.destroyed) return;
        this.native.on("change", () => this.changed());
        this.native.on("selectionChange", () => this.rememberSelection());
        this.native.on("paste", e => {
          if (e.data.type !== "text") {
            const template = document.createElement("template");
            template.innerHTML = e.data.dataValue;
            e.data.dataValue = escapeHTML(template.content.textContent).replace(/\n/g, "<br>");
            e.data.type = "text";
          }
        }, null, null, 1);
        this.native.setReadOnly(!!this.readOnly);
      })().catch(error => { this.richLoading = null; throw error; });
      return this.richLoading;
    }

    async setMode(mode) {
      if (this.destroyed || this.readOnly || !["markdown", "rich", "preview"].includes(mode)) return;
      const request = ++this.modeRequest;
      this.linkForm.hidden = true;
      if (mode === this.mode) { this.status.textContent = ""; return; }
      if (mode === "rich") {
        this.status.textContent = "Loading rich text editor…";
        try { await this.ensureRich(); }
        catch (_) {
          if (!this.destroyed && request === this.modeRequest) this.status.textContent = "Rich text could not load. Continue in Markdown or try Rich text again.";
          return;
        }
      }
      if (this.destroyed || this.readOnly || request !== this.modeRequest) return;
      const value = this.getValue();
      this.source = value;
      this.mode = mode;
      this.markdownPanel.hidden = mode !== "markdown";
      this.richPanel.hidden = mode !== "rich";
      this.previewPanel.hidden = mode !== "preview";
      this.toolbar.hidden = mode === "preview";
      if (mode === "rich") {
        this.richPanel.innerHTML = this.render(value) || "<p><br></p>";
        this.richSource = value;
        this.richSnapshot = this.richPanel.innerHTML;
        this.bookmarks = null;
        this.native.resetUndo();
        this.native.fire("saveSnapshot");
      } else if (mode === "markdown") {
        this.suppressChange = true;
        if (this.mde) { this.mde.value(value); this.mde.codemirror.refresh(); }
        else this.textarea.value = value;
        this.markdownSource = value;
        this.markdownSnapshot = this.mde ? this.mde.value() : this.textarea.value;
        this.suppressChange = false;
      } else this.previewPanel.innerHTML = this.render(value);
      this.modes.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.mode === mode)));
      this.status.textContent = mode === "preview" ? "Preview. Return to Markdown or Rich text to edit." : "";
      this.focus();
    }

    setValue(value) {
      ++this.modeRequest;
      this.suppressChange = true;
      this.source = this.lastValue = String(value == null ? "" : value);
      this.mode = "markdown";
      this.markdownPanel.hidden = false;
      this.richPanel.hidden = this.previewPanel.hidden = true;
      this.toolbar.hidden = false;
      this.linkForm.hidden = true;
      this.status.textContent = "";
      this.textarea.value = this.source;
      if (this.mde) { this.mde.value(this.source); this.mde.codemirror.refresh(); }
      this.markdownSource = this.source;
      this.markdownSnapshot = this.mde ? this.mde.value() : this.textarea.value;
      this.modes.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.mode === this.mode)));
      this.suppressChange = false;
    }

    getValue() {
      if (this.mode === "markdown") {
        const value = this.mde ? this.mde.value() : this.textarea.value;
        return value === this.markdownSnapshot ? this.markdownSource : value;
      }
      if (this.mode === "preview") return this.source;
      if (this.richPanel.innerHTML === this.richSnapshot) return this.richSource;
      return toMarkdown(this.richPanel.innerHTML, {gfm: true, converters: [
        {filter: "hr", replacement: () => "\n\n---\n\n"},
        {filter: "pre", replacement: (_, node) => {
          const code = node.querySelector("code") || node;
          const text = code.textContent.replace(/\n$/, "");
          const language = (code.className.match(/(?:language|lang)-([a-z0-9_+.-]+)/i) || ["", ""])[1];
          const fence = this.codeFence(text, 3);
          return "\n\n" + fence + language + "\n" + text + "\n" + fence + "\n\n";
        }},
        {filter: node => node.nodeName === "A" && node.hasAttribute("data-wiki-page"), replacement: (_, node) => {
          const page = node.getAttribute("data-wiki-page").replace(/[\[\]|\r\n]/g, "");
          const label = node.textContent.replace(/[\[\]|\r\n]/g, "");
          return "[[" + page + (label && label !== page ? "|" + label : "") + "]]";
        }},
        {filter: node => node.nodeName === "CODE" && node.parentNode.nodeName !== "PRE", replacement: (_, node) => {
          const text = node.textContent;
          const fence = this.codeFence(text, 1);
          const pad = /^`|`$/.test(text) ? " " : "";
          return fence + pad + text + pad + fence;
        }}
      ]});
    }

    changed() {
      if (this.destroyed || this.suppressChange || this.mode === "preview") return;
      const value = this.getValue();
      if (value === this.lastValue) return;
      this.lastValue = value;
      if (this.options.onChange) this.options.onChange(value);
    }

    rememberSelection() {
      if (this.destroyed || this.mode !== "rich" || !this.native || this.native.status !== "ready") return;
      const selection = window.getSelection();
      if (selection.rangeCount && this.richPanel.contains(selection.anchorNode) && this.richPanel.contains(selection.focusNode)) {
        this.bookmarks = this.native.getSelection().createBookmarks2(true);
      }
    }

    restoreSelection() {
      if (!this.native || this.destroyed) return false;
      this.native.focus();
      if (this.bookmarks) this.native.getSelection().selectBookmarks(this.bookmarks);
      else {
        const range = this.native.createRange();
        range.moveToElementEditablePosition(this.native.editable(), true);
        this.native.getSelection().selectRanges([range]);
      }
      return true;
    }

    closeLink() {
      this.linkForm.hidden = true;
      if (this.mode === "rich") this.restoreSelection();
      else this.focus();
    }

    insertLink() {
      if (this.readOnly || this.destroyed) return;
      let value = this.linkForm.querySelector("input").value.trim();
      const wiki = this.linkAction === "wiki-link";
      if (wiki ? !value || /[\[\]|\r\n]/.test(value) : !this.validUrl(value, this.linkAction === "image")) {
        this.linkForm.querySelector(".wiki-editor-link-error").textContent = wiki ? "Enter a page name without brackets or vertical bars." : "Enter a web address, relative path, or mailto: link.";
        return;
      }
      if (!wiki) value = value.replace(/[\s()<>"\\]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
      this.linkForm.hidden = true;
      this.format(this.linkAction, value);
    }

    format(action, url) {
      if (this.readOnly || this.destroyed || this.mode === "preview") return;
      if (["link", "image", "wiki-link"].includes(action) && url === undefined) {
        this.rememberSelection();
        this.linkAction = action;
        const wiki = action === "wiki-link";
        this.linkForm.querySelector("label span").textContent = wiki ? "Wiki page name" : action === "image" ? "Image URL" : "Link URL";
        this.linkForm.querySelector("[data-insert]").textContent = wiki ? "Insert wiki link" : action === "image" ? "Insert image" : "Insert link";
        this.linkForm.querySelector(".wiki-editor-link-error").textContent = "";
        const input = this.linkForm.querySelector("input");
        input.value = "";
        input.placeholder = wiki ? "Getting started" : "https://example.com";
        if (this.mode === "rich" && action !== "image" && this.restoreSelection()) {
          const link = new CKEDITOR.Link(this.native, {appendProtocol: false}).getFromSelection();
          if (link) input.value = link.getAttribute(wiki ? "data-wiki-page" : "href") || "";
        }
        this.linkForm.hidden = false;
        input.focus();
        return;
      }
      if (this.mode === "markdown") this.formatMarkdown(action, url);
      else this.formatRich(action, url);
      this.changed();
    }

    formatRich(action, url) {
      if (!this.restoreSelection()) return;
      const native = this.native;
      const commands = {bold: "bold", italic: "italic", strikethrough: "strike", quote: "blockquote",
        "unordered-list": "bulletedlist", "ordered-list": "numberedlist", "horizontal-rule": "horizontalrule"};
      native.fire("saveSnapshot");
      if (commands[action]) native.execCommand(commands[action]);
      else if (["code", "code-block", "heading"].includes(action)) {
        const style = new CKEDITOR.style({element: action === "code" ? "code" : action === "code-block" ? "pre" : "h2"});
        if (style.checkActive(native.elementPath(), native)) native.removeStyle(style);
        else native.applyStyle(style);
      } else if (action === "link" || action === "wiki-link") {
        const links = new CKEDITOR.Link(native, {appendProtocol: false});
        let link = links.getFromSelection();
        const href = action === "wiki-link" ? "?Page:" + encodeURIComponent(url) : url;
        if (link) links.update(href, link);
        else { links.create(href); link = links.getFromSelection(); }
        if (link) {
          if (action === "wiki-link") {
            link.setAttribute("data-wiki-page", url);
            if (link.getText() === href) link.setText(url);
          } else link.removeAttribute("data-wiki-page");
        }
      } else if (action === "image") {
        const image = new CKEDITOR.dom.element("img", native.document);
        image.setAttributes({src: url, alt: native.getSelection().getSelectedText() || "Image description"});
        native.insertElement(image);
      }
      native.fire("saveSnapshot");
      native.fire("change");
      native.selectionChange(true);
      this.rememberSelection();
    }

    formatMarkdown(action, url) {
      var textarea = this.textarea;
      var cm = this.mde && this.mde.codemirror;
      var value = cm ? cm.getValue() : textarea.value;
      var start = cm ? cm.indexFromPos(cm.getCursor("from")) : textarea.selectionStart;
      var end = cm ? cm.indexFromPos(cm.getCursor("to")) : textarea.selectionEnd;
      var selected = value.slice(start, end);
      var replacement, selectionStart, selectionEnd;
      var markers = {bold: "**", italic: "*", strikethrough: "~~", code: "`"};
      if (markers[action]) {
        var marker = markers[action];
        var character = marker[0];
        var leadingRun = text => { var length = 0; while (text[length] === character) length++; return length; };
        var trailingRun = text => leadingRun(text.split("").reverse().join(""));
        var removable = length => action === "italic" ? length % 2 === 1 : length >= marker.length;
        var inside = Math.min(leadingRun(selected), trailingRun(selected));
        var outside = Math.min(trailingRun(value.slice(0, start)), leadingRun(value.slice(end)));
        if (inside && removable(inside) && selected.length > inside * 2) {
          var count = action === "code" ? inside : marker.length;
          selected = selected.slice(count, -count);
          replacement = selected;
          selectionStart = start;
        } else if (outside && removable(outside)) {
          var count = action === "code" ? outside : marker.length;
          start -= count;
          end += count;
          replacement = selected;
          selectionStart = start;
        } else {
          if (action !== "code" && selected.trim()) {
            start += selected.match(/^\s*/)[0].length;
            end -= selected.match(/\s*$/)[0].length;
            selected = selected.trim();
          }
          selected = selected || (action === "code" ? "code" : "text");
          if (action === "code") marker = this.codeFence(selected, 1);
          var padding = action === "code" && /^`|`$/.test(selected) ? " " : "";
          replacement = marker + padding + selected + padding + marker;
          selectionStart = start + marker.length + padding.length;
        }
        selectionEnd = selectionStart + selected.length;
      } else if (action === "wiki-link") {
        var label = selected.replace(/[\[\]|\r\n]/g, "");
        replacement = "[[" + url + (label && label !== url ? "|" + label : "") + "]]";
        selectionStart = start + 2;
        selectionEnd = start + replacement.length - 2;
      } else if (action === "link" || action === "image") {
        var label = selected || (action === "image" ? "Image description" : url);
        label = label.replace(/([\\[\]])/g, "\\$1");
        var prefix = action === "image" ? "![" : "[";
        replacement = prefix + label + "](" + url + ")";
        selectionStart = start + prefix.length;
        selectionEnd = selectionStart + label.length;
      } else if (action === "horizontal-rule" || action === "code-block") {
        var before = start && value.slice(0, start).replace(/\n+$/, "") ? "\n\n".slice((value.slice(0, start).match(/\n*$/) || [""])[0].length) : "";
        var after = end < value.length ? "\n\n".slice((value.slice(end).match(/^\n*/) || [""])[0].length) : "";
        var fence = this.codeFence(selected, 3);
        var content = selected || "code";
        replacement = before + (action === "horizontal-rule" ? "---\n\n" : fence + "\n" + content + "\n" + fence) + after;
        selectionStart = start + (action === "horizontal-rule" ? replacement.length : before.length + fence.length + 1);
        selectionEnd = selectionStart + (action === "horizontal-rule" ? 0 : content.length);
      } else {
        // Block actions apply to complete lines, including multiline selections.
        start = value.lastIndexOf("\n", start - 1) + 1;
        if (end > start && value[end - 1] === "\n") end--;
        var lineEnd = value.indexOf("\n", end);
        end = lineEnd < 0 ? value.length : lineEnd;
        var lines = value.slice(start, end).split("\n");
        var patterns = {heading: /^#{1,6} /, quote: /^> /, "unordered-list": /^[-*+] /, "ordered-list": /^\d+\. /};
        var pattern = patterns[action];
        if (!pattern) return;
        var remove = lines.every(line => pattern.test(line));
        replacement = lines.map((line, index) => {
          if (remove) return line.replace(pattern, "");
          var prefix = action === "heading" ? "## " : action === "quote" ? "> " : action === "unordered-list" ? "- " : (index + 1) + ". ";
          return prefix + line.replace(pattern, "");
        }).join("\n");
        selectionStart = start;
        selectionEnd = start + replacement.length;
        if (lines.length === 1 && !lines[0]) selectionStart = selectionEnd;
      }
      if (cm) {
        cm.operation(() => {
          cm.replaceRange(replacement, cm.posFromIndex(start), cm.posFromIndex(end), "+input");
          cm.setSelection(cm.posFromIndex(selectionStart), cm.posFromIndex(selectionEnd));
        });
        cm.focus();
      } else {
        textarea.focus();
        textarea.setRangeText(replacement, start, end, "select");
        textarea.setSelectionRange(selectionStart, selectionEnd);
        textarea.dispatchEvent(new Event("input", {bubbles: true}));
      }
    }

    codeFence(text, minimum) {
      return "`".repeat(Math.max(minimum, ...(text.match(/`+/g) || []).map(run => run.length + 1)));
    }

    setReadOnly(readOnly) {
      this.readOnly = !!readOnly;
      if (readOnly) ++this.modeRequest;
      this.textarea.readOnly = this.readOnly;
      if (this.mde) this.mde.codemirror.setOption("readOnly", this.readOnly);
      if (this.native && this.native.status === "ready") this.native.setReadOnly(this.readOnly);
      this.container.querySelectorAll("button, .wiki-editor-link-form input").forEach(control => control.disabled = this.readOnly);
      this.richPanel.setAttribute("aria-readonly", String(this.readOnly));
    }

    focus() {
      if (this.destroyed) return;
      if (this.mode === "preview") this.previewPanel.focus();
      else if (this.mode === "rich") this.richPanel.focus();
      else if (this.mde) { this.mde.codemirror.refresh(); this.mde.codemirror.focus(); }
      else this.textarea.focus();
    }

    destroy() {
      this.destroyed = true;
      ++this.modeRequest;
      document.removeEventListener("selectionchange", this.handleSelection);
      this.container.removeEventListener("keydown", this.handleKeydown);
      if (this.mde) this.mde.toTextArea();
      if (this.alloy) this.alloy.destroy();
      this.container.replaceChildren();
      this.container.classList.remove("wiki-editor");
    }
  }

  window.WikiEditor = WikiEditor;
})();
