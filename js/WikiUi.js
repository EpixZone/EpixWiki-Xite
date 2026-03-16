(function() {

  class WikiUi {
    constructor() {
      this.historyTools = document.getElementById("content-history-tools");
      this.viewTools = document.getElementById("content-view-tools");
      this.editTools = document.getElementById("content-edit-tools");
      this.contentPanel = document.getElementById("messages");
      this.contentEditor = document.getElementById("editor");
      this.contentHistory = document.getElementById("history");
      this.markedOptions = {
        "gfm": true,
        "breaks": true,
        "sanitize": true
      };
    }

    hideTools() {
      this.historyTools.style.display = "none";
      this.viewTools.style.display = "none";
      this.editTools.style.display = "none";
    }

    showHistoryTools() {
      this.historyTools.style.display = "block";
    }

    showViewTools() {
      this.viewTools.style.display = "block";
    }

    showEditTools() {
      this.editTools.style.display = "block";
    }

    hidePanels() {
      this.contentPanel.style.display = "none";
      this.contentEditor.style.display = "none";
      this.contentHistory.style.display = "none";
    }

    showContent(rev = null) {
      this.hideTools();
      this.showViewTools();
      this.hidePanels();
      if (rev !== null) {
        document.getElementById('revision').style.display = "block";
        document.getElementById('edit_page').style.display = "none";
      }
      this.contentPanel.style.display = "block";
    }

    showEdit() {
      this.hideTools();
      this.showEditTools();
      this.hidePanels();
      this.contentEditor.style.display = "block";
      this.contentEditor.focus();
    }

    showNewPageMessage() {
      this.hideTools();
      this.hidePanels();
      var body = "<div class=\"new-page-message\">";
      body += "<p class=\"muted\">This page doesn't exist yet.</p>";
      body += "<p><a href=\"#\" class=\"pure-button\" onclick=\"return Page.pageEdit()\">Create this page</a></p>";
      body += "</div>";
      this.contentPanel.innerHTML = body;
      this.contentPanel.style.display = "block";
    }

    showHistory(messages) {
      this.hideTools();
      this.showHistoryTools();
      this.hidePanels();
      this.contentHistory.style.display = "block";
      var history_list = document.getElementById("history_list");
      var body = "";
      for (var i = 0, len = messages.length; i < len; i++) {
        var message = messages[i];
        var parsedDate = Time.since(message.date_added / 1000);
        body += "<li>Edited by " + message.cert_user_id + " <span class=\"muted\">" + parsedDate + "</span>";
        body += "<a href=\"?Page:" + message.slug + "&Rev:" + message.id + "\" class=\"pure-button button-success\">";
        body += "View</a></li>";
      }
      history_list = document.getElementById("history_list");
      history_list.innerHTML = body;
    }

    loadContent(originalContent, HTMLContent, rev = null) {
      this.contentEditor.innerHTML = originalContent;
      this.contentPanel.innerHTML = HTMLContent;
      var ref = this.contentPanel.querySelectorAll('a:not(.internal)');
      for (var i = 0, len = ref.length; i < len; i++) {
        var link = ref[i];
        link.className += ' external';
        if (link.href.indexOf(location.origin) === 0) {
          link.className += ' epixnet';
        } else {
          link.className += ' clearnet';
        }
      }
      this.showContent(rev);
    }

    showIndexPage(links, orphaned) {
      this.hideTools();
      this.hidePanels();
      this.contentPanel.style.display = "block";
      var body = "";
      var linksBody = "";
      for (var i = 0, len = links.length; i < len; i++) {
        var link = links[i];
        linksBody += "<li>" + link + "</li>";
      }
      if (linksBody !== "") {
        body = "<h1>Linked Pages</h1><ul>" + linksBody + "</ul>";
      }
      if (orphaned.length > 0) {
        body += "<h1>Orphaned pages</h1><ul>";
        for (var j = 0, len1 = orphaned.length; j < len1; j++) {
          var orphanLink = orphaned[j];
          body += "<li>" + orphanLink + "</li>";
        }
        body += "</ul>";
      }
      if (body === "") {
        body = "<p class=\"muted\">There are no pages yet.</p>";
      }
      this.contentPanel.innerHTML = body;
    }

    loggedInMessage(cert) {
      if (cert) {
        document.getElementById("select_user").innerHTML = "You are logged in as " + cert;
      } else {
        document.getElementById("select_user").innerHTML = "Login";
      }
    }

    setUserQuota(current = null, max = null) {
      var quotaElement = document.getElementById("user_quota");
      if (current !== null && max !== null) {
        quotaElement.innerHTML = "(" + ((current / 1024).toFixed(1)) + "kb/" + ((max / 1024).toFixed(1)) + "kb)";
      } else {
        quotaElement.innerHTML = "";
      }
    }
  }

  window.WikiUi = new WikiUi;

})();
