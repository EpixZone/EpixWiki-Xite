(function() {
var EpixFrame = window.EpixFrame;

class EpixWiki extends EpixFrame {
  constructor() {
    super();
    this.selectUser = this.selectUser.bind(this);
    this.editingPage = false;
    this.pageId = null;
    this.waitingConfirmation = false;
  }

  onOpenWebsocket(e) {
    this.cmd("siteInfo", {}, (site_info) => {
      this.site_info = site_info;
      WikiUi.loggedInMessage(site_info.cert_user_id);
      this.updateUserQuota();
      // Move any legacy data.json pages into the signed-CRDT pages.json merge
      // file, in the background. Additive and idempotent, so it is safe to run
      // on every load.
      this.migratePages();
    });
    if (!this.isStaticRequest()) {
      this.pageLoad();
    }
  }

  onRequest(cmd, message) {
    if (cmd === "setSiteInfo") {
      this.site_info = message.params;
      WikiUi.loggedInMessage(message.params.cert_user_id);
      this.updateUserQuota();
      if (message.params.event[0] === "file_done") {
        var slug = this.getSlug();
        var query = "SELECT * FROM pages WHERE pages.slug = '" + slug + "' ORDER BY date_added DESC LIMIT 1";
        this.cmd("dbQuery", [query], (page) => {
          if (page.length === 1 && this.editingPage === true) {
            if (page[0].id !== this.pageId && this.waitingConfirmation !== true) {
              this.waitingConfirmation = true;
              var confirmMessage = "This page has been updated. Do you want to load the changes?";
              this.cmd("wrapperConfirm", [confirmMessage, "Yes"], (confirmed) => {
                this.waitingConfirmation = false;
                this.pageLoad();
              });
            }
          } else {
            if (!this.isStaticRequest()) {
              this.pageLoad();
            }
          }
        });
      }
    }
  }

  selectUser() {
    Page.certSelect();
    return false;
  }

  pageLoad(slug = null, rev = null) {
    this.editingPage = false;
    if (slug === null) {
      slug = this.getSlug();
    }
    if (rev === null) {
      rev = this.getRevisionNumber();
    }
    var query;
    if (rev === null) {
      query = "SELECT * FROM pages WHERE pages.slug = '" + slug + "' ORDER BY date_added DESC LIMIT 1";
    } else {
      query = "SELECT * FROM pages WHERE pages.id = '" + rev + "'";
    }
    this.cmd("dbQuery", [query], (page) => {
      if (page.length === 1) {
        this.pageId = page[0].id;
        this.parseContent(page[0].body, rev);
      } else {
        if (rev !== null) {
          this.cmd("wrapperNotification", ["error", "Wrong revision number."]);
        } else {
          WikiUi.showNewPageMessage();
        }
      }
    });
  }

  pageSave(reload = false) {
    if (!this.site_info.cert_user_id) {
      this.cmd("wrapperNotification", ["info", "Please, select your account."]);
      return false;
    }
    var slug = this.getSlug();
    if (slug === false) {
      this.cmd("wrapperNotification", ["error", "Operation not permitted."]);
      return false;
    }
    var body = document.getElementById("editor").value;
    // A page save is a signed CRDT record keyed by slug. The node union-merges
    // it into pages.json (so it can never overwrite anyone else's pages) and
    // republishes content.json. A merge write can never wipe pages, so the old
    // data.json last-writer-wins sync/blank guard is gone.
    this.savePage(slug, { body: body }, (res) => {
      if (res !== "ok") {
        return;
      }
      if (reload === true) {
        window.location = "?Page:" + slug;
        return;
      }
      this.pageLoad();
      this.updateUserQuota();
    });
    return false;
  }

  // Path to this user's pages merge file and their user content.json.
  pagesPath() {
    return "data/users/" + this.site_info.auth_address + "/pages.json";
  }

  contentPath() {
    return "data/users/" + this.site_info.auth_address + "/content.json";
  }

  // A 128-bit random nonce (hex). Every record carries one - the node still
  // requires nonce for record verification even when the post_id is derived
  // from `key`.
  randNonce() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Read this user's pages.json (all signed record versions).
  getRecords(cb) {
    this.cmd("fileGet", { "inner_path": this.pagesPath(), "required": false }, (data) => {
      var container = data ? JSON.parse(data) : null;
      if (!container || !container.post) {
        container = { "record_format": "epix-orset-1", "post": [] };
      }
      cb(container);
    });
  }

  // Write ONE signed record to pages.json and publish. The node union-merges
  // the record into the on-disk set (so this never overwrites other pages),
  // then signs+bumps content.json (auto-declaring files_merged), which
  // propagates the merge to peers.
  saveRecord(record, cb) {
    if (cb == null) cb = null;
    var container = { "record_format": "epix-orset-1", "post": [record] };
    var json_raw = unescape(encodeURIComponent(JSON.stringify(container, undefined, '\t')));
    this.cmd("fileWrite", [this.pagesPath(), btoa(json_raw)], (res_write) => {
      if (res_write !== "ok") {
        this.cmd("wrapperNotification", ["error", "File write error: " + res_write]);
        if (cb) cb(res_write);
        return;
      }
      this.cmd("sitePublish", { "inner_path": this.contentPath() }, (res_pub) => {
        if (res_pub && res_pub.error) {
          this.cmd("wrapperNotification", ["error", res_pub.error]);
        }
        if (cb) cb(res_write);
      });
    });
  }

  // Build + sign a new version of the page for `slug` (a create, an edit, or a
  // delete tombstone) and save it. key=slug gives a stable per-(author,slug)
  // post_id, so every version supersedes the prior one and one slug stays one
  // page. clock/supersedes are derived from what is on disk so the merge orders
  // this after every version this device has seen.
  savePage(slug, changes, cb) {
    if (cb == null) cb = null;
    this.getRecords((container) => {
      var maxClock = 0;
      var orig = null;
      container.post.forEach((r) => {
        if (r.slug === slug || r.key === slug) {
          if ((r.clock || 0) > maxClock) {
            maxClock = r.clock;
          }
          if (!orig || (r.clock || 0) >= (orig.clock || 0)) {
            orig = r;
          }
        }
      });
      var deleted = changes.deleted === true;
      var record = {
        "key": slug,
        "id": uuid.v1(),
        "slug": slug,
        "nonce": this.randNonce(),
        "clock": Math.max(maxClock + 1, Date.now()),
        "supersedes": maxClock,
        "deleted": deleted,
        "body": deleted ? "" : (changes.body != null ? changes.body : (orig ? orig.body : "")),
        "date_added": Date.now()
      };
      this.cmd("recordSign", [record], (signed) => {
        if (!signed || signed.error) {
          if (signed && signed.error) {
            this.cmd("wrapperNotification", ["error", "Sign error: " + signed.error]);
          }
          if (cb) cb(signed);
          return;
        }
        this.saveRecord(signed, cb);
      });
    });
  }

  // One-time-ish migration of legacy data.json `pages[]` into pages.json.
  // ADDITIVE and per-slug idempotent: signs only the newest legacy revision of
  // each slug not already in pages.json (keeping its legacy uuid as the record
  // `id` for revision-URL continuity), and NEVER strips data.json.pages[] (that
  // last-writer-wins write could clobber pages not yet synced). Runs in the
  // background on load and converges as data syncs.
  migratePages(cb) {
    if (cb == null) cb = null;
    var done = () => { if (cb) cb(); };
    if (!this.site_info || !this.site_info.cert_user_id || !this.site_info.auth_address) {
      return done();
    }
    var data_path = "data/users/" + this.site_info.auth_address + "/data.json";
    this.cmd("fileGet", { "inner_path": data_path, "required": false }, (data) => {
      var parsed = data ? JSON.parse(data) : null;
      var legacy = (parsed && parsed.pages) || [];
      if (!legacy.length) {
        return done();
      }
      this.getRecords((container) => {
        var have = {};
        container.post.forEach((r) => {
          var s = (r.slug != null) ? r.slug : r.key;
          if (s != null) {
            have[s] = true;
          }
        });
        // Legacy pages[] is newest-first; keep only the newest revision per
        // slug, skipping slugs already migrated.
        var seen = {};
        var todo = [];
        for (var i = 0, len = legacy.length; i < len; i++) {
          var p = legacy[i];
          if (!p || !p.slug || seen[p.slug]) {
            continue;
          }
          seen[p.slug] = true;
          if (have[p.slug]) {
            continue;
          }
          todo.push(p);
        }
        if (!todo.length) {
          return done();
        }
        var signed = [];
        var idx = 0;
        var signNext = () => {
          if (idx >= todo.length) {
            if (!signed.length) {
              return done();
            }
            // One union-write + one publish for the whole batch.
            var merged = { "record_format": "epix-orset-1", "post": signed };
            var json_raw = unescape(encodeURIComponent(JSON.stringify(merged, undefined, '\t')));
            return this.cmd("fileWrite", [this.pagesPath(), btoa(json_raw)], () => {
              return this.cmd("sitePublish", { "inner_path": this.contentPath() }, () => done());
            });
          }
          var pg = todo[idx++];
          var record = {
            "key": pg.slug,
            "id": pg.id ? pg.id : uuid.v1(),
            "slug": pg.slug,
            "nonce": this.randNonce(),
            "clock": 1,
            "supersedes": 0,
            "deleted": false,
            "body": pg.body != null ? pg.body : "",
            "date_added": pg.date_added != null ? pg.date_added : Date.now()
          };
          return this.cmd("recordSign", [record], (s) => {
            if (s && !s.error) {
              signed.push(s);
            }
            return signNext();
          });
        };
        return signNext();
      });
    });
  }

  pageEdit() {
    this.editingPage = true;
    WikiUi.showEdit();
  }

  pageHistory(slug) {
    var query = "SELECT pages.*, keyvalue.value AS cert_user_id FROM pages\n" +
      "LEFT JOIN json AS data_json USING (json_id)\n" +
      "LEFT JOIN json AS content_json ON (\n" +
      "    data_json.directory = content_json.directory AND content_json.file_name = 'content.json'\n" +
      ")\n" +
      "LEFT JOIN keyvalue ON (keyvalue.key = 'cert_user_id' AND keyvalue.json_id = content_json.json_id)\n" +
      "WHERE pages.slug = '" + slug + "'\n" +
      "ORDER BY date_added DESC";
    this.cmd("dbQuery", [query], (pages) => {
      WikiUi.showHistory(pages);
    });
  }

  showIndexPage() {
    var query = "SELECT id, body, slug, MAX(date_added), json_id FROM pages GROUP BY pages.slug ORDER BY date_added DESC";
    this.cmd("dbQuery", [query], (pages) => {
      LinkHelper.reset();
      for (var i = 0, len = pages.length; i < len; i++) {
        LinkHelper.parseContent(pages[i].body);
      }
      var linkTags = LinkHelper.getLinks();
      var slugsStr = LinkHelper.getSlugs(true).join(",");
      query = "SELECT slug FROM pages WHERE pages.slug in (" + slugsStr + ") GROUP BY slug";
      this.cmd("dbQuery", [query], (slugs) => {
        var existingPages = LinkHelper.getSlugs(false, slugs);
        var links = [];
        var normalized = [];
        for (var j = 0, len1 = linkTags.length; j < len1; j++) {
          var tag = linkTags[j];
          var lowerText = tag.text.toLowerCase();
          if (!normalized.includes(lowerText)) {
            var cssClass = "";
            if (!existingPages.includes(tag.slug)) {
              cssClass = "red";
            }
            links.push("<a href=\"?Page:" + tag.slug + "\" class=\"" + cssClass + "\">" + tag.text + "</a>");
            normalized.push(lowerText);
          }
        }
        var allSlugs = LinkHelper.getSlugs();
        var orphaned = [];
        var uniqueOrphans = [];
        for (var k = 0, len2 = pages.length; k < len2; k++) {
          var page = pages[k];
          if (!allSlugs.includes(page.slug) && !uniqueOrphans.includes(page.slug) && page.slug !== "home") {
            orphaned.push("<a href=\"?Page:" + page.slug + "\">[[" + page.slug + "]]</a>");
            uniqueOrphans.push(page.slug);
          }
        }
        WikiUi.showIndexPage(links, orphaned.sort());
      });
    });
  }

  isStaticRequest(url = null) {
    if (url === null) {
      url = window.location.search.substring(1);
    }
    if (url.match(/Index(&.*)?$/)) {
      this.showIndexPage();
      return true;
    }
    if (this.isHistory(url)) {
      this.pageHistory(this.getSlug());
      return true;
    }
    return false;
  }

  isHistory(url = null) {
    if (url === null) {
      url = window.location.search.substring(1);
    }
    if (url.match(/Page:([a-z0-9\-]*)(&.*)?History(&.*)?$/)) {
      return true;
    }
    return false;
  }

  getSlug(url = null) {
    if (url === null) {
      url = window.location.search.substring(1);
    }
    var match = url.match(/Page:([a-z0-9\-]*)(&.*)?$/);
    if (match) {
      return match[1].toLowerCase();
    } else {
      return "home";
    }
  }

  getRevisionNumber(url = null) {
    if (url === null) {
      url = window.location.search.substring(1);
    }
    var match = url.match(/Rev:([a-z0-9\-]*)(&.*)?$/);
    if (match) {
      return match[1];
    } else {
      return null;
    }
  }

  parseContent(content, rev = null) {
    var HTMLcontent = content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    HTMLcontent = marked(HTMLcontent, WikiUi.markedOptions);
    LinkHelper.reset();
    LinkHelper.parseContent(HTMLcontent);
    var links = LinkHelper.getLinks();
    var slugsStr = LinkHelper.getSlugs(true).join(",");
    var query = "SELECT slug FROM pages WHERE pages.slug in (" + slugsStr + ") GROUP BY slug ORDER BY date_added";
    this.cmd("dbQuery", [query], (slugs) => {
      var existingPages = LinkHelper.getSlugs(false, slugs);
      for (var i = 0, len = links.length; i < len; i++) {
        var link = links[i];
        var cssClass = "internal";
        if (!existingPages.includes(link.slug)) {
          cssClass += " red";
        }
        var replacement = "<a href=\"?Page:" + link.slug + "\" class=\"" + cssClass + "\">" + link.text + "</a>";
        link.tag = link.tag.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
        HTMLcontent = HTMLcontent.replace(new RegExp(link.tag, "g"), replacement);
      }
      WikiUi.loadContent(content, HTMLcontent, rev);
    });
  }

  updateUserQuota() {
    if (this.site_info.cert_user_id) {
      this.cmd("fileRules", "data/users/" + this.site_info.auth_address + "/content.json", (rules) => {
        WikiUi.setUserQuota(rules.current_size, rules.max_size);
      });
    } else {
      WikiUi.setUserQuota();
    }
  }

  getCurrentRevision() {
    var slug = this.getSlug();
    window.location = "?Page:" + slug;
  }

  getHistory() {
    var slug = this.getSlug();
    window.location = "?Page:" + slug + "&History";
  }
}

window.Page = new EpixWiki();
})();
