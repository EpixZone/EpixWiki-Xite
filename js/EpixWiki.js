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
    if (!Page.site_info.cert_user_id) {
      Page.cmd("wrapperNotification", ["info", "Please, select your account."]);
      return false;
    }
    var slug = this.getSlug();
    if (slug === false) {
      this.cmd("wrapperNotification", ["error", "Operation not permitted."]);
      return false;
    }
    var inner_path = "data/users/" + this.site_info.auth_address + "/data.json";
    this.cmd("fileGet", {
      "inner_path": inner_path,
      "required": false
    }, (data) => {
      if (data) {
        data = JSON.parse(data);
      } else {
        data = { "pages": [] };
      }
      data.pages.unshift({
        "id": uuid.v1(),
        "body": document.getElementById("editor").value,
        "date_added": new Date().getTime(),
        "slug": slug
      });
      var new_data = { "pages": [] };
      var pages_limit = {};
      for (var i = 0, len = data.pages.length; i < len; i++) {
        var page = data.pages[i];
        if (pages_limit[page.slug] === undefined) {
          pages_limit[page.slug] = 0;
        }
        if (pages_limit[page.slug] < 5) {
          new_data.pages.push(page);
          pages_limit[page.slug]++;
        }
      }
      var json_raw = unescape(encodeURIComponent(JSON.stringify(new_data, undefined, '\t')));
      this.cmd("fileWrite", [inner_path, btoa(json_raw)], (res) => {
        if (res === "ok") {
          if (reload === true) {
            window.location = "?Page:" + slug;
            return;
          }
          this.pageLoad();
          this.updateUserQuota();
          this.cmd("sitePublish", {
            "inner_path": inner_path
          }, (res) => {
            if (res.error) {
              this.cmd("wrapperNotification", ["error", res.error]);
            }
          });
        } else {
          this.cmd("wrapperNotification", ["error", "File write error: " + res]);
        }
      });
      return false;
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
