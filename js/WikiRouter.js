(function (global) {
  'use strict';
  function decode(value) { try { return decodeURIComponent(value); } catch (_) { return value; } }
  function slug(value) {
    return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 160);
  }
  function parse(input) {
    var raw = String(input || ''), hashIndex = raw.indexOf('#');
    var fragment = hashIndex < 0 ? '' : decode(raw.slice(hashIndex + 1));
    var query = (hashIndex < 0 ? raw : raw.slice(0, hashIndex)).split('?').pop();
    var parts = query.split('&').filter(p => !/^(wrapper|ajax_key|_=)/i.test(p));
    var first = parts[0] || '';
    if (first === 'Index') return {kind: 'index', url: '?Index'};
    if (first === 'Recent') return {kind: 'recent', url: '?Recent'};
    if (first === 'New') return {kind: 'new', url: '?New'};
    if (first.startsWith('Search:')) {
      var term = decode(first.slice(7)).slice(0, 150);
      return {kind: 'search', query: term, url: '?Search:' + encodeURIComponent(term)};
    }
    var name = first.startsWith('Page:') ? slug(decode(first.slice(5))) : 'home';
    if (!name) name = 'home';
    var revision = parts.find(p => p.startsWith('Rev:'));
    var history = parts.includes('History');
    var result = {kind: history ? 'history' : 'page', slug: name, revision: revision ? decode(revision.slice(4)) : null, fragment: fragment};
    result.url = page(name) + (history ? '&History' : result.revision ? '&Rev:' + encodeURIComponent(result.revision) : '');
    if (fragment) result.url += '#' + encodeURIComponent(fragment);
    return result;
  }
  function page(name) { return '?Page:' + encodeURIComponent(slug(name)); }
  function title(name) { return String(name || '').replace(/[-_]+/g, ' ').replace(/^./u, c => c.toUpperCase()); }
  global.WikiRouter = {parse: parse, slug: slug, page: page, title: title};
})(typeof window !== 'undefined' ? window : globalThis);
