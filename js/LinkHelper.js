(function() {

  class LinkHelper {
    constructor() {
      this.uniqueLinks = [];
    }

    extractLinks(content) {
      var links = [];
      var match = content.match(/(\[\[(.+?)\]\])/g);
      if (match) {
        for (var i = 0, len = match.length; i < len; i++) {
          var m = match[i];
          var text = m.match(/\[\[(.*?)(\|(.*?))?\]\]/);
          var label = text[1];
          if (text[3] !== undefined) {
            label = text[3];
          }
          links.push({
            tag: m,
            slug: slugger(text[1]),
            text: label
          });
        }
      }
      return this.getUniqueLinks(links);
    }

    getUniqueLinks(links) {
      var unique = [];
      var uniqueLinks = [];
      for (var i = 0, len = links.length; i < len; i++) {
        var link = links[i];
        if (!unique.includes(link.tag)) {
          unique.push(link.tag);
          uniqueLinks.push(link);
        }
      }
      return uniqueLinks;
    }

    parseContent(content) {
      var links = this.extractLinks(content);
      links = links.concat(this.uniqueLinks);
      this.uniqueLinks = this.getUniqueLinks(links);
      return true;
    }

    getLinks() {
      return this.uniqueLinks.sort(function(a, b) {
        if (a.slug > b.slug) {
          return 1;
        } else if (a.slug < b.slug) {
          return -1;
        } else {
          return 0;
        }
      });
    }

    getSlugs(quote = false, links = null) {
      if (links === null) {
        links = this.uniqueLinks;
      }
      var slugs = [];
      for (var i = 0, len = links.length; i < len; i++) {
        var link = links[i];
        var slug = link.slug;
        if (quote) {
          slug = "'" + slug + "'";
        }
        slugs.push(slug);
      }
      return slugs;
    }

    reset() {
      this.uniqueLinks = [];
      return true;
    }
  }

  window.LinkHelper = new LinkHelper;

})();
