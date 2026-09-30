(function (global) {
  'use strict';
  function render(source, knownPages) {
    var container = document.createElement('div');
    var html = marked(String(source || ''), {gfm: true, breaks: true});
    container.innerHTML = DOMPurify.sanitize(html, {USE_PROFILES: {html: true}, FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'], FORBID_ATTR: ['style', 'id', 'name'], ALLOW_DATA_ATTR: false});
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var nodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('a,pre,code,kbd,samp')) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      var text = node.textContent, pattern = /\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, match, start = 0;
      var fragment = document.createDocumentFragment();
      while ((match = pattern.exec(text))) {
        fragment.appendChild(document.createTextNode(text.slice(start, match.index)));
        var name = WikiRouter.slug(match[1]);
        if (name) {
          var a = document.createElement('a');
          a.href = WikiRouter.page(name); a.textContent = match[2] || match[1];
          a.dataset.wikiPage = match[1]; a.className = 'wiki-link';
          if (knownPages && !knownPages.has(name)) { a.classList.add('missing-page'); a.title = 'Create ' + match[1]; }
          fragment.appendChild(a);
        } else fragment.appendChild(document.createTextNode(match[0]));
        start = pattern.lastIndex;
      }
      if (start) { fragment.appendChild(document.createTextNode(text.slice(start))); node.replaceWith(fragment); }
    });
    container.querySelectorAll('a').forEach(a => {
      a.rel = 'noopener noreferrer';
      if (!a.getAttribute('href')) a.removeAttribute('target');
    });
    container.querySelectorAll('img').forEach(img => {
      var src = img.getAttribute('src') || '';
      if (/^data:/i.test(src) && !/^data:image\/(png|gif|jpe?g|webp);base64,/i.test(src)) img.removeAttribute('src');
      img.loading = 'lazy'; img.decoding = 'async';
    });
    var ids = new Set();
    container.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(heading => {
      var id = 'wiki-heading-' + (WikiRouter.slug(heading.textContent) || 'section'), unique = id, suffix = 2;
      while (ids.has(unique)) unique = id + '-' + suffix++;
      ids.add(unique); heading.id = unique; heading.tabIndex = -1;
    });
    return container.innerHTML;
  }
  global.WikiMarkdown = {render: render};
})(window);
