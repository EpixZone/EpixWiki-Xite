(function () {
  'use strict';
  const el = id => document.getElementById(id);
  const text = (id, value) => { el(id).textContent = value; };
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

  class EpixWiki extends EpixFrame {
    constructor() {
      super();
      this.store = new WikiStore(this);
      this.route = WikiRouter.parse(location.search + location.hash);
      this.site_info = {};
      this.page = null;
      this.editing = false;
      this.saving = false;
      this.connected = false;
      this.requestGeneration = 0;
      this.identityGeneration = 0;
      this.emptyRetries = 0;
      document.body.classList.toggle('embedded', window.parent !== window);
      this.bindUI();
      this.connectionTimer = setTimeout(() => {
        if (!this.connected) this.status('Could not connect to EpixNet. Open this wiki in EpixNet, or reconnect and try again.', true);
      }, 12000);
    }

    // Only our wrapper may drive the app or answer outstanding commands.
    _onMessage(event) {
      if (event.source !== window.parent) return;
      super._onMessage(event);
    }

    command(name, params) { return this.store.command(name, params); }
    quiet(name, params) { this._sendRaw({cmd: name, params}); }

    bindUI() {
      document.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const a = event.target.closest('a[href]');
        if (!a || a.closest('[contenteditable="true"]')) return;
        const href = a.getAttribute('href');
        if (/^\?(Page:|Index(?:$|&)|Recent(?:$|&)|New(?:$|&)|Search:)/.test(href)) {
          event.preventDefault(); this.navigate(href);
        } else if (href.startsWith('#') && href.length > 1) {
          let id; try { id = decodeURIComponent(href.slice(1)); } catch (_) { return; }
          const target = document.getElementById('wiki-heading-' + id) || document.getElementById(id);
          if (target) { event.preventDefault(); target.scrollIntoView(); target.focus({preventScroll: true}); }
        }
      });
      el('search-form').addEventListener('submit', event => {
        event.preventDefault(); this.navigate('?Search:' + encodeURIComponent(el('search-input').value.trim()));
      });
      el('login').onclick = () => this.login();
      el('retry-load').onclick = () => { this.emptyRetries = 0; this.onOpenWebsocket(); };
      el('edit-page').onclick = () => this.startEdit();
      el('restore-page').onclick = () => this.startEdit(true);
      el('cancel-edit').onclick = () => this.cancelEdit();
      el('save-page').onclick = () => this.save();
      el('load-update').onclick = () => this.navigate(WikiRouter.page(this.route.slug));
      el('edit-title').oninput = () => this.draftChanged();
      el('edit-summary').oninput = () => this.draftChanged();
      window.addEventListener('popstate', () => { if (window.parent === window) this.navigate(location.search + location.hash, 'pop'); });
      window.addEventListener('beforeunload', event => {
        if (this.dirty() || this.saving || this.store.pendingPublish) { event.preventDefault(); event.returnValue = ''; }
      });
    }

    async onOpenWebsocket() {
      this.connected = true;
      clearTimeout(this.connectionTimer);
      text('connection-label', 'Connected to EpixNet');
      el('connection-dot').classList.add('connected');
      this.quiet('wrapperSetViewport', 'width=device-width, initial-scale=1');
      this.quiet('channelJoin', ['siteChanged']);
      this.command('serverInfo', {}).then(info => {
        const theme = info && info.user_settings && info.user_settings.theme;
        if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
      }).catch(() => {});
      const generation = this.identityGeneration;
      try {
        const info = await this.command('siteInfo', {});
        if (!info || typeof info !== 'object') throw new Error('Wiki information is still loading. Try again.');
        if (generation === this.identityGeneration) this.setSiteInfo(info);
        if (!this.started) { this.started = true; this.writeHistory('replace'); }
        if (this.editing) { this.status('Reconnected. Your draft has been kept.'); this.checkForUpdate(); }
        else await this.refresh();
      } catch (error) { this.status(error.message || 'Could not load the wiki.', true); }
    }

    onCloseWebsocket() {
      this.connected = false;
      text('connection-label', 'Reconnecting');
      el('connection-dot').classList.remove('connected');
      this.status('Connection lost. Your draft stays here while EpixNet reconnects.', true);
    }

    onRequest(cmd, message) {
      const params = message.params || {};
      if (cmd === 'wrapperPopState') {
        this.navigate(params.state && params.state.url || params.href || '?Page:home', 'pop');
      } else if (cmd === 'setSiteInfo') {
        this.setSiteInfo(params);
        const event = Array.isArray(params.event) ? params.event[0] : '';
        if (!this.started) return;
        if (event || params.tasks === 0 || params.bad_files === 0) {
          clearTimeout(this.updateTimer);
          this.updateTimer = setTimeout(() => {
            if (this.editing) this.checkForUpdate(); else this.refresh(true);
          }, 180);
        }
      }
    }

    setSiteInfo(info) {
      if (!info || info.error) return;
      const old = this.site_info;
      const identityChanged = ['auth_address', 'cert_user_id', 'xid_directory'].some(key => Object.hasOwn(info, key) && info[key] !== old[key]);
      if (identityChanged) {
        this.identityGeneration++;
        if (!Object.hasOwn(info, 'xid_directory')) delete old.xid_directory;
      }
      this.site_info = Object.assign({}, old, info, {settings: Object.assign({}, old.settings, info.settings), content: Object.assign({}, old.content, info.content)});
      this.store.setSiteInfo(this.site_info);
      text('login', this.site_info.cert_user_id || 'Connect xID');
      if (identityChanged) this.updateQuota();
    }

    async login() {
      if (this.loginPending || this.saving) return;
      this.loginPending = true; el('login').disabled = true;
      try {
        await this.command('certXid', {});
        this.setSiteInfo(await this.command('siteInfo', {}));
        if (this.site_info.cert_user_id) this.status('Connected as ' + this.site_info.cert_user_id + '.');
      } catch (error) { this.status(error.message || 'Could not connect your xID.', true); }
      finally { this.loginPending = false; el('login').disabled = false; }
    }

    async updateQuota() {
      const info = this.site_info, directory = info.xid_directory || info.auth_address;
      text('user-quota', '');
      if (!info.cert_user_id || !directory) return;
      const generation = this.identityGeneration;
      try {
        const rules = await this.command('fileRules', {inner_path: 'data/users/' + directory + '/content.json'});
        const pagesRule = rules && rules.merge_files && rules.merge_files['pages.json'];
        if (pagesRule && pagesRule.max_size) {
          const raw = await this.command('fileGet', {inner_path: 'data/users/' + directory + '/pages.json', required: false});
          const bytes = raw ? new TextEncoder().encode(typeof raw === 'string' ? raw : JSON.stringify(raw)).length : 0;
          if (generation === this.identityGeneration) text('user-quota', Math.ceil(bytes / 1024) + ' / ' + Math.round(pagesRule.max_size / 1024) + ' KB page history');
        } else if (generation === this.identityGeneration && rules && rules.max_size) {
          text('user-quota', Math.ceil((rules.current_size || 0) / 1024) + ' / ' + Math.round(rules.max_size / 1024) + ' KB identity files');
        }
      } catch (_) { /* Reading and editing remain available if quota is not ready. */ }
    }

    status(message, retry = false) {
      text('status-text', message); el('status').hidden = !message; el('retry-load').hidden = !retry;
      el('status').classList.toggle('error', retry);
    }

    writeHistory(mode) {
      this.history_state = {url: this.route.url, scrollTop: 0};
      if (window.parent !== window) this.quiet(mode === 'replace' ? 'wrapperReplaceState' : 'wrapperPushState', [this.history_state, '', this.route.url]);
      else history[mode === 'replace' ? 'replaceState' : 'pushState'](this.history_state, '', this.route.url);
    }

    async canLeave() {
      if (this.saving) { this.status('Please wait for this revision to finish saving.'); return false; }
      if (this.store.pendingPublish) { this.status('This revision is saved locally. Retry publishing before leaving the editor.'); return false; }
      if (!this.dirty()) return true;
      try { return !!(await this.command('wrapperConfirm', ['Discard your unsaved changes?', 'Discard changes'])); }
      catch (_) { return false; }
    }

    async navigate(url, mode = 'push') {
      if (this.navigating) { this.queuedNavigation = {url, mode}; return; }
      this.navigating = true;
      const allowed = await this.canLeave();
      this.navigating = false;
      if (this.queuedNavigation) {
        ({url, mode} = this.queuedNavigation);
        this.queuedNavigation = null;
      }
      if (!allowed) { if (mode === 'pop') this.writeHistory('push'); return; }
      this.stopEdit();
      clearTimeout(this.retryTimer); this.emptyRetries = 0;
      this.route = WikiRouter.parse(url);
      if (mode !== 'pop') this.writeHistory(mode);
      else this.history_state = {url: this.route.url, scrollTop: 0};
      await this.refresh();
    }

    async refresh(background = false) {
      if (this.editing || this.saving) return;
      const generation = ++this.requestGeneration, route = this.route;
      this.routeReady = false;
      if (!background) {
        this.status('Loading ' + (route.kind === 'page' ? 'page' : 'wiki') + '...');
        el('page-actions').hidden = true; el('revision-notice').hidden = true;
      }
      try {
        let data;
        if (route.kind === 'new') data = null;
        else if (route.kind === 'page') data = await this.store.readPage(route.slug, route.revision);
        else if (route.kind === 'history') data = await this.store.history(route.slug);
        else if (route.kind === 'recent') data = await this.store.recent();
        else data = await this.store.listPages(route.kind === 'search' ? route.query : '');
        if (generation !== this.requestGeneration || this.editing) return;
        this.routeReady = true;
        this.status(''); el('contents').hidden = true; el('update-notice').hidden = true;
        el('page-content').hidden = false; el('revision-notice').hidden = true;
        el('page-actions').hidden = true;
        text('page-meta', '');
        document.querySelectorAll('[data-nav]').forEach(a => {
          const active = a.dataset.nav === route.kind || a.dataset.nav === 'home' && route.kind === 'page' && route.slug === 'home';
          a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        });
        if (route.kind === 'page') this.renderPage(data);
        else if (route.kind === 'history') this.renderHistory(data);
        else if (route.kind === 'recent') this.renderRecent(data);
        else if (route.kind === 'new') { this.page = null; this.heading('New page', 'CONTRIBUTE'); this.startEdit(); }
        else this.renderList(data);
        document.title = el('page-title').textContent + ' | Epix Wiki';
        this.quiet('wrapperSetTitle', document.title);
        this.quiet('wrapperInnerLoaded', {});
        if (!background && route.fragment) {
          const anchor = document.getElementById('wiki-heading-' + route.fragment) || document.getElementById(route.fragment);
          if (anchor && el('page-content').contains(anchor)) { anchor.scrollIntoView(); anchor.focus({preventScroll: true}); }
        }
        if (!data || Array.isArray(data) && !data.length) this.retryEmpty(generation);
        else this.emptyRetries = 0;
      } catch (error) {
        if (generation !== this.requestGeneration) return;
        el('page-actions').hidden = true;
        this.status('Could not load this view. ' + (error.message || 'Please try again.'), true);
        if (!background) el('page-content').innerHTML = '<div class="empty-state"><h2>We could not read the wiki yet</h2><p>Your page may still be syncing. Try again when the connection is ready.</p></div>';
      }
    }

    retryEmpty(generation) {
      if (this.route.kind === 'new' || this.route.kind === 'search' || this.emptyRetries >= 6) return;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (generation === this.requestGeneration && !this.editing) this.refresh(true);
      }, Math.min(15000, 700 * Math.pow(2, this.emptyRetries++)));
    }

    heading(title, kind) { text('page-title', title); text('page-kind', kind); }
    date(value) {
      if (!value) return 'Unknown date';
      const date = new Date(value < 100000000000 ? value * 1000 : value);
      return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
    }
    author(page) { return page.cert_user_id || page.author || 'Contributor'; }
    renderMarkdown(body) { return WikiMarkdown.render(body); }

    renderPage(page) {
      this.page = page;
      const route = this.route;
      this.heading(page ? page.title : WikiRouter.title(route.slug), route.slug === 'home' ? 'KNOWLEDGE, TOGETHER' : 'WIKI PAGE');
      el('page-history').href = WikiRouter.page(route.slug) + '&History';
      el('page-actions').hidden = !!route.revision && !page;
      text('edit-page', page ? 'Edit page' : 'Create page');
      if (!page) {
        const syncing = Number(this.site_info.tasks) > 0 || Number(this.site_info.bad_files) > 0;
        el('page-content').innerHTML = '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">▤</span><h2>' + (route.revision ? 'Revision not found' : syncing ? 'This wiki is still syncing' : 'This page has not been written yet') + '</h2><p>' + (route.revision ? 'This revision may not have arrived yet. You can return to the current page.' : syncing ? 'Pages will appear here as they arrive. There is no need to refresh.' : 'Start with what you know. Add a page and help grow this shared resource.') + '</p>' + (route.revision ? '<a class="button subtle" href="' + WikiRouter.page(route.slug) + '">View latest</a>' : '') + '</div>';
        el('edit-page').disabled = syncing;
        if (syncing) this.status('Waiting for wiki data. This page will update automatically.');
        return;
      }
      el('edit-page').disabled = false;
      text('page-meta', 'Updated ' + this.date(page.date_added) + ' · ' + this.author(page));
      el('page-content').innerHTML = this.renderMarkdown(page.body);
      if (route.revision) {
        el('revision-notice').hidden = false;
        el('current-version').href = WikiRouter.page(route.slug);
        text('edit-page', 'Edit from this revision');
      }
      this.renderContents();
      this.markMissingLinks(this.requestGeneration);
    }

    renderContents() {
      const headings = Array.from(el('page-content').querySelectorAll('h2,h3'));
      el('contents').hidden = headings.length < 2;
      el('contents').innerHTML = '<div class="sidebar-label">ON THIS PAGE</div>' + headings.map(h => '<a href="#' + encodeURIComponent(h.id) + '" class="level-' + h.tagName.toLowerCase() + '">' + escape(h.textContent) + '</a>').join('');
    }

    async markMissingLinks(generation) {
      const links = Array.from(el('page-content').querySelectorAll('[data-wiki-page]'));
      if (!links.length || !this.store.existingSlugs) return;
      try {
        const slugs = await this.store.existingSlugs(links.map(a => WikiRouter.slug(a.dataset.wikiPage)));
        if (generation !== this.requestGeneration || this.editing) return;
        const known = new Set(slugs);
        links.forEach(a => { if (!known.has(WikiRouter.slug(a.dataset.wikiPage))) { a.classList.add('missing-page'); a.title = 'Create ' + a.dataset.wikiPage; } });
      } catch (_) { /* A link remains usable when its existence is unknown. */ }
    }

    renderHistory(pages) {
      this.page = null;
      this.heading('Page history', 'REVISIONS');
      text('page-meta', WikiRouter.title(this.route.slug) + ' · ' + pages.length + ' revision' + (pages.length === 1 ? '' : 's'));
      el('page-content').innerHTML = '<a class="back-link" href="' + WikiRouter.page(this.route.slug) + '">← Back to page</a>' + (pages.length ? '<ol class="revision-list">' + pages.map((page, index) => '<li><div class="revision-number">' + (pages.length - index) + '</div><div><a href="' + WikiRouter.page(page.slug) + '&amp;Rev:' + encodeURIComponent(page.id) + '">' + escape(this.date(page.date_added)) + '</a>' + (index === 0 ? '<span class="tag">Latest</span>' : '') + '<p>' + escape(page.summary || 'Updated page') + '</p><small>' + escape(this.author(page)) + '</small></div></li>').join('') + '</ol>' : '<div class="empty-state"><h2>No revisions yet</h2><p>Published edits will appear here.</p></div>');
    }

    renderList(pages) {
      this.page = null;
      const search = this.route.kind === 'search', recent = this.route.kind === 'recent';
      this.heading(search ? 'Search results' : recent ? 'Recent changes' : 'All pages', 'EXPLORE THE WIKI');
      text('page-meta', pages.length + ' page' + (pages.length === 1 ? '' : 's') + (search ? ' matching “' + this.route.query + '”' : ''));
      if (!recent) pages.sort((a, b) => a.title.localeCompare(b.title));
      el('page-content').innerHTML = pages.length ? '<div class="page-list">' + pages.map(page => '<a class="page-card" href="' + WikiRouter.page(page.slug) + '"><span class="card-heading">' + escape(page.title) + '<span aria-hidden="true">↗</span></span><p>' + escape(page.body.replace(/[#*`>\[\]]/g, '').replace(/\s+/g, ' ').slice(0, 180)) + '</p><small>Updated ' + escape(this.date(page.date_added)) + '</small></a>').join('') + '</div>' : '<div class="empty-state"><h2>' + (search ? 'No matching pages' : 'A fresh place for shared knowledge') + '</h2><p>' + (search ? 'Try a different word or explore all pages.' : 'Create the first page to get started. Synced pages will appear automatically.') + '</p><a class="button primary" href="' + (search ? '?Index' : '?New') + '">' + (search ? 'Browse all pages' : 'Create a page') + '</a></div>';
    }

    renderRecent(pages) {
      this.page = null;
      this.heading('Recent changes', 'EXPLORE THE WIKI');
      text('page-meta', pages.length + ' recent revision' + (pages.length === 1 ? '' : 's'));
      el('page-content').innerHTML = pages.length ? '<ol class="revision-list">' + pages.map(page => '<li><div class="revision-number" aria-hidden="true">↗</div><div><a href="' + WikiRouter.page(page.slug) + '&amp;Rev:' + encodeURIComponent(page.id) + '">' + escape(page.title) + '</a><p>' + escape(page.summary || (page.deleted ? 'Deleted page' : 'Updated page')) + '</p><small>' + escape(this.date(page.date_added)) + ' · ' + escape(this.author(page)) + '</small></div></li>').join('') + '</ol>' : '<div class="empty-state"><h2>No revisions yet</h2><p>Published edits will appear here.</p></div>';
    }

    startEdit(restore = false) {
      if (!this.routeReady || this.editing || this.saving) return;
      clearTimeout(this.retryTimer); ++this.requestGeneration;
      this.editing = true; this.editBase = this.page ? this.page.id : null;
      document.body.classList.add('editing');
      this.editSlug = this.route.kind === 'new' ? null : this.route.slug;
      el('edit-panel').hidden = false; el('page-content').hidden = true;
      el('page-actions').hidden = true; el('contents').hidden = true; el('revision-notice').hidden = true;
      el('edit-title').value = this.page ? this.page.title : this.editSlug ? WikiRouter.title(this.editSlug) : '';
      el('edit-summary').value = restore ? 'Restore revision from ' + this.date(this.page.date_added) : '';
      this.editor = new WikiEditor(el('editor-host'), {render: body => this.renderMarkdown(body), onChange: () => this.draftChanged(), onSave: () => this.save()});
      this.editor.setValue(this.page ? this.page.body : '');
      this.originalDraft = this.draftValue();
      this.draftChanged();
      text('save-page', 'Publish revision');
      this.status(this.site_info.cert_user_id ? '' : 'You can write your draft now. Connect your xID to publish it.');
      if (this.editSlug) this.editor.focus(); else el('edit-title').focus();
    }

    draftValue() { return JSON.stringify([el('edit-title').value, this.editor ? this.editor.getValue() : '', el('edit-summary').value]); }
    dirty() { return this.editing && this.originalDraft !== this.draftValue(); }
    draftChanged() {
      if (!this.editing) return;
      text('edit-path', 'Page address: ' + (this.editSlug || WikiRouter.slug(el('edit-title').value) || 'choose-a-title'));
      text('draft-status', this.dirty() ? 'Unsaved changes' : 'Your changes will create a new revision.');
    }

    stopEdit() {
      if (this.editor) { this.editor.destroy(); this.editor = null; }
      this.editing = false; this.editBase = null;
      document.body.classList.remove('editing');
      el('edit-panel').hidden = true; el('update-notice').hidden = true;
      el('page-content').hidden = false;
    }

    async cancelEdit() {
      if (!(await this.canLeave())) return;
      this.stopEdit();
      if (this.route.kind === 'new') this.navigate('?Index'); else this.refresh();
    }

    async checkForUpdate() {
      if (!this.editing || this.saving || !this.editSlug) return;
      const generation = this.requestGeneration, slug = this.editSlug;
      try {
        const latest = await this.store.readPage(slug);
        if (this.editing && generation === this.requestGeneration && latest && latest.id !== this.editBase) el('update-notice').hidden = false;
      } catch (_) { /* Connection errors never replace a draft. */ }
    }

    setSaving(saving) {
      this.saving = saving;
      el('save-page').disabled = saving; el('cancel-edit').disabled = saving; el('login').disabled = saving;
      el('edit-title').disabled = saving || !!this.store.pendingPublish;
      el('edit-summary').disabled = saving || !!this.store.pendingPublish;
      if (this.editor) this.editor.setReadOnly(saving || !!this.store.pendingPublish);
    }

    async save() {
      if (!this.editing || this.saving) return;
      const editingSession = this.editor;
      if (!this.site_info.cert_user_id) {
        await this.login();
        if (!this.site_info.cert_user_id || !this.editing || this.editor !== editingSession) return;
      }
      const title = el('edit-title').value.trim(), slug = this.editSlug || WikiRouter.slug(title);
      if (!title || !slug) { this.status('Add a page title before publishing.'); el('edit-title').focus(); return; }
      const input = {slug, title, body: this.editor.getValue(), summary: el('edit-summary').value};
      this.setSaving(true);
      try {
        if (!this.store.pendingPublish) {
          const latest = await this.store.readPage(slug);
          if (latest && latest.id !== this.editBase) {
            const message = this.editBase ? 'This page changed while you were editing. Publish your draft as a new revision? The previous revision will remain in history.' : 'A page already uses this address. Publish your draft as a new revision of that page?';
            if (!(await this.command('wrapperConfirm', [message, 'Publish revision']))) return;
          }
        }
        this.status(this.store.pendingPublish ? 'Retrying publication...' : 'Signing and publishing your revision...');
        const page = this.store.pendingPublish ? await this.store.retryPublish(this.site_info) : await this.store.save(input, this.site_info);
        this.setSiteInfo(this.store.siteInfo);
        this.stopEdit(); this.route = WikiRouter.parse(WikiRouter.page(page.slug));
        this.writeHistory('push');
        // Render the successful signed record immediately, without an index race.
        ++this.requestGeneration; this.routeReady = true; this.renderPage(page);
        document.title = page.title + ' | Epix Wiki'; this.quiet('wrapperSetTitle', document.title);
        this.status('Revision published.'); this.updateQuota();
      } catch (error) {
        this.status(error.saved ? 'This revision is saved locally, but has not been published. ' + (error.message || '') + ' Use Retry publish.' : 'Could not save your revision. ' + (error.message || 'Try again.'));
        text('save-page', error.saved ? 'Retry publish' : 'Publish revision');
      } finally { this.setSaving(false); }
    }
  }
  window.Page = new EpixWiki();
})();
