(function(root) {
  "use strict";

  // EDX owns verification, union merges and transport. SQLite is the node's
  // derived read index. Every edit has its own signed key so revision history
  // survives database rebuilds and CRDT folding by other readers.
  class WikiStore {
    constructor(frame, options) {
      this.frame = frame;
      this.options = Object.assign({timeout: 30000, retries: 3, retryDelay: 300}, options);
      this.siteInfo = null;
      this.pendingPublish = null;
      this.saving = false;
    }

    setSiteInfo(info) {
      if (!info || typeof info !== "object" || info.error) return this.siteInfo;
      const previous = this.siteInfo || {};
      this.siteInfo = Object.assign({}, previous, info, {
        settings: Object.assign({}, previous.settings, info.settings),
        content: Object.assign({}, previous.content, info.content)
      });
      const identityChanged = ["auth_address", "cert_user_id"].some(key =>
        Object.prototype.hasOwnProperty.call(info, key) && info[key] !== previous[key]);
      if (identityChanged && !Object.prototype.hasOwnProperty.call(info, "xid_directory")) delete this.siteInfo.xid_directory;
      return this.siteInfo;
    }

    error(message, stage, saved) {
      const error = new Error(message);
      error.stage = stage;
      error.saved = !!saved;
      return error;
    }

    command(command, params) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(this.error("The node did not answer " + command + ". Try again.", command)), this.options.timeout);
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve(value);
        };
        try {
          const returned = this.frame.cmd(command, params, value => {
            if (value && value.error) finish(this.error(String(value.error), command));
            else finish(null, value);
          });
          if (returned && typeof returned.catch === "function") returned.catch(error => finish(error));
        } catch (error) { finish(error); }
      });
    }

    async query(query, params) {
      let lastError;
      for (let attempt = 0; attempt <= this.options.retries; attempt++) {
        try {
          const rows = await this.command("dbQuery", {query, params: params || []});
          if (!Array.isArray(rows)) throw this.error("The wiki database is still loading. Try again.", "dbQuery");
          return rows;
        } catch (error) {
          lastError = error;
          if (attempt < this.options.retries) await new Promise(resolve => setTimeout(resolve, this.options.retryDelay * Math.pow(2, attempt)));
        }
      }
      throw lastError;
    }

    baseQuery() {
      return "SELECT p.*, j.directory, j.file_name, " +
        "(SELECT k.value FROM json c JOIN keyvalue k ON k.json_id = c.json_id " +
        "WHERE c.directory = j.directory AND c.file_name = 'content.json' AND k.key = 'cert_user_id' LIMIT 1) AS cert_user_id " +
        "FROM pages p JOIN json j ON j.json_id = p.json_id";
    }

    // Preserve every authenticated version for history, but match the node's
    // OR-set frontier when choosing current pages. A causally newer version
    // dominates its predecessors; a concurrent tombstone beats a live edit.
    liveQuery(where) {
      const columns = "id,slug,title,body,summary,date_added,clock,supersedes,post_id,author,deleted,sign,json_id,directory,file_name,cert_user_id";
      return "WITH source AS (" + this.baseQuery() + (where ? " WHERE " + where : "") + "), " +
        "frontier AS (SELECT s.* FROM source s WHERE COALESCE(s.sign, '') <> '' AND NOT EXISTS (" +
        "SELECT 1 FROM source newer WHERE newer.json_id = s.json_id AND newer.post_id = s.post_id " +
        "AND COALESCE(newer.sign, '') <> '' AND newer.sign <> s.sign AND COALESCE(newer.supersedes, 0) >= COALESCE(s.clock, 0))), " +
        "folded AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY json_id, COALESCE(CAST(post_id AS TEXT), id) " +
        "ORDER BY COALESCE(deleted, 0) DESC, COALESCE(clock, 0) DESC, sign DESC) AS record_rank FROM frontier), " +
        "live AS (SELECT " + columns + " FROM folded WHERE record_rank = 1 AND COALESCE(deleted, 0) = 0 " +
        "UNION ALL SELECT " + columns.split(",").map(column => "old." + column).join(",") +
        " FROM source old WHERE COALESCE(old.sign, '') = '' AND COALESCE(old.deleted, 0) = 0 AND NOT EXISTS (" +
        "SELECT 1 FROM source modern WHERE modern.directory = old.directory AND modern.slug = old.slug AND COALESCE(modern.sign, '') <> '')) ";
    }

    // A total order gives every node the same page for equal timestamps.
    orderBy() {
      return "COALESCE(date_added, 0) DESC, COALESCE(clock, 0) DESC, " +
        "CASE WHEN COALESCE(sign, '') <> '' THEN 1 ELSE 0 END DESC, " +
        "COALESCE(id, '') DESC, COALESCE(author, '') DESC, directory DESC, COALESCE(sign, '') DESC";
    }

    normalize(row) {
      return Object.assign({}, row, {
        id: String(row.id || row.sign || [row.slug, row.date_added, row.directory].join(":")),
        slug: String(row.slug || ""),
        title: row.title ? String(row.title) : String(row.slug || "Untitled").replace(/[-_]+/g, " ").replace(/^./u, character => character.toUpperCase()),
        body: String(row.body || ""),
        summary: String(row.summary || ""),
        author: String(row.author || (row.directory || "").replace(/^users\//, "")),
        cert_user_id: row.cert_user_id || null,
        date_added: Number(row.date_added) || 0,
        clock: Number(row.clock) || 0,
        deleted: row.deleted === true || row.deleted === 1
      });
    }

    async readPage(slug, revision) {
      const params = [String(slug)];
      let query;
      if (revision) {
        params.push(String(revision));
        query = this.baseQuery() + " WHERE p.slug = ? AND p.id = ?";
      } else query = this.liveQuery("p.slug = ?") + "SELECT * FROM live";
      const rows = await this.query(query + " ORDER BY " + this.orderBy() + " LIMIT 1", params);
      if (!rows.length) return null;
      const page = this.normalize(rows[0]);
      return page.deleted && !revision ? null : page;
    }

    async listPages(search) {
      const text = String(search || "").trim();
      // Search current revisions only, never stale matching history bodies.
      let query = this.liveQuery() + ", ranked AS (SELECT *, " +
        "ROW_NUMBER() OVER (PARTITION BY slug ORDER BY " + this.orderBy() + ") AS rank FROM live) " +
        "SELECT * FROM ranked WHERE rank = 1 AND COALESCE(deleted, 0) = 0";
      const params = [];
      if (text) {
        const needle = "%" + text.replace(/[\\%_]/g, "\\$&") + "%";
        query += " AND (slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')";
        params.push(needle, needle, needle);
      }
      const rows = await this.query(query + " ORDER BY " + this.orderBy(), params);
      return rows.map(row => this.normalize(row));
    }

    async existingSlugs(slugs) {
      const unique = Array.from(new Set(slugs.map(slug => String(slug)).filter(Boolean)));
      if (unique.length > 100) throw this.error("Check at most 100 wiki links at a time.", "validation");
      if (!unique.length) return new Set();
      const query = this.liveQuery("p.slug IN (" + unique.map(() => "?").join(",") + ")") +
        "SELECT DISTINCT slug FROM live";
      const rows = await this.query(query, unique);
      return new Set(rows.map(row => row.slug));
    }

    async history(slug) {
      const rows = await this.query(this.baseQuery() + " WHERE p.slug = ? ORDER BY " + this.orderBy(), [String(slug)]);
      const seen = new Set();
      return rows.map(row => this.normalize(row)).filter(page => {
        if (seen.has(page.id)) return false;
        seen.add(page.id);
        return true;
      });
    }

    async recent(limit = 100) {
      const query = "WITH source AS (" + this.baseQuery() + "), revisions AS (SELECT *, " +
        "ROW_NUMBER() OVER (PARTITION BY id ORDER BY " + this.orderBy() + ") AS revision_rank FROM source) " +
        "SELECT * FROM revisions WHERE revision_rank = 1 ORDER BY " + this.orderBy() + " LIMIT ?";
      const rows = await this.query(query, [Math.max(1, Math.min(100, Number(limit) || 100))]);
      return rows.map(row => this.normalize(row));
    }

    identity(info) {
      return JSON.stringify([info && info.cert_user_id, info && info.auth_address, info && info.xid_directory]);
    }

    userDirectory(info) {
      const directory = info && (info.xid_directory || info.auth_address);
      if (!info || !info.cert_user_id || !info.auth_address || !directory) throw this.error("Connect your xID before saving a page.", "identity");
      if (!/^[a-zA-Z0-9._-]+$/.test(directory) || directory === "." || directory === "..") throw this.error("The node returned an invalid identity directory.", "identity");
      return directory;
    }

    async checkIdentity(expected) {
      const fresh = await this.command("siteInfo", {});
      if (!fresh || !fresh.auth_address) throw this.error("Could not confirm your xID. Try again.", "identity");
      this.setSiteInfo(fresh);
      this.userDirectory(fresh);
      if (this.identity(fresh) !== expected) throw this.error("Your xID changed while saving. Review the page and save again.", "identity");
      return fresh;
    }

    nonce() {
      const bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    }

    encode(value) {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      return root.btoa(binary);
    }

    async localRecords(directory) {
      const path = "data/users/" + directory + "/pages.json";
      const data = await this.command("fileGet", {inner_path: path, required: false});
      if (data == null || data === false || data === "") return [];
      let container;
      try { container = typeof data === "string" ? JSON.parse(data) : data; }
      catch (error) { throw this.error("Your local page history is not valid JSON. It has been left unchanged.", "fileGet"); }
      if (!container || container.record_format !== "epix-orset-1" || !Array.isArray(container.post)) {
        throw this.error("Your local page history has an unsupported format. It has been left unchanged.", "fileGet");
      }
      return container.post;
    }

    async save(input, siteInfo) {
      if (this.saving) throw this.error("A save is already in progress.", "save");
      if (this.pendingPublish) throw this.error("This revision is saved locally. Retry publishing it before saving another revision.", "sitePublish", true);
      const info = siteInfo || this.siteInfo;
      const directory = this.userDirectory(info);
      const expected = this.identity(info);
      const slug = String(input.slug || "").trim();
      const title = String(input.title || slug).trim();
      if (!slug || slug.length > 256) throw this.error("Use a page address between 1 and 256 characters.", "validation");
      if (!title || title.length > 256) throw this.error("Use a title between 1 and 256 characters.", "validation");
      this.saving = true;
      try {
        await this.checkIdentity(expected);
        // A user's first pages.json has no accepted files_merged declaration
        // yet. The node only union-writes declared files, so include any local
        // signed history as well as the new record until publishing declares it.
        const local = await this.localRecords(directory);
        const latest = await this.readPage(slug);
        const now = Date.now();
        // Each revision has an independent CRDT key. Its verified clock must
        // stay in the node's five-minute future-skew bound, even if an older
        // author's display timestamp was far ahead of the device clock.
        const previousDate = latest && Number.isSafeInteger(latest.date_added) ? latest.date_added : 0;
        const dateAdded = Math.max(now, previousDate < Number.MAX_SAFE_INTEGER ? previousDate + 1 : now);
        const nonce = this.nonce();
        const record = {
          key: "revision:" + nonce, id: nonce, slug, title,
          body: String(input.body || ""), summary: String(input.summary || "").trim(),
          nonce, clock: now, supersedes: 0, deleted: false, date_added: dateAdded
        };
        const signed = await this.command("recordSign", [record]);
        if (!signed || !signed.sign || !signed.author || signed.id !== record.id || signed.slug !== slug) throw this.error("The node could not sign this revision.", "recordSign");
        await this.checkIdentity(expected);
        if (signed.author !== info.auth_address) throw this.error("The revision was signed by a different identity. Save again.", "identity");
        const innerPath = "data/users/" + directory + "/pages.json";
        const result = await this.command("fileWrite", [innerPath, this.encode({record_format: "epix-orset-1", post: local.concat([signed])})]);
        if (result !== "ok") throw this.error("Could not save this revision: " + String(result), "fileWrite");
        this.pendingPublish = {
          identity: expected,
          innerPath: "data/users/" + directory + "/content.json",
          page: this.normalize(Object.assign({}, signed, {directory: "users/" + directory, cert_user_id: info.cert_user_id}))
        };
        return await this.publishPending();
      } catch (error) {
        if (this.pendingPublish) { error.saved = true; error.page = this.pendingPublish.page; }
        throw error;
      } finally { this.saving = false; }
    }

    async publishPending() {
      const pending = this.pendingPublish;
      if (!pending) throw this.error("There is no saved revision waiting to publish.", "sitePublish");
      try {
        await this.checkIdentity(pending.identity);
        const result = await this.command("sitePublish", {inner_path: pending.innerPath});
        if (result !== "ok") throw this.error("The revision is saved locally, but publishing failed: " + String(result), "sitePublish", true);
        this.pendingPublish = null;
        return pending.page;
      } catch (error) { error.saved = true; error.page = pending.page; throw error; }
    }

    async retryPublish(siteInfo) {
      if (this.saving) throw this.error("A save is already in progress.", "save");
      if (siteInfo) this.setSiteInfo(siteInfo);
      this.saving = true;
      try { return await this.publishPending(); }
      finally { this.saving = false; }
    }
  }

  root.WikiStore = WikiStore;
  if (typeof module !== "undefined" && module.exports) module.exports = WikiStore;
})(typeof window === "undefined" ? globalThis : window);
