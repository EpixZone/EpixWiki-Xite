const test = require("node:test");
const assert = require("node:assert/strict");
const {DatabaseSync} = require("node:sqlite");
const schema = require("../dbschema.json");
const WikiStore = require("../js/WikiStore.js");

const identity = {auth_address: "epix1alice", cert_user_id: "alice@xid.epix", xid_directory: "alice.epix", settings: {own: false}};

function fixture(overrides = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE json (json_id INTEGER PRIMARY KEY, directory TEXT, file_name TEXT); CREATE TABLE keyvalue (json_id INTEGER, key TEXT, value TEXT);");
  for (const [name, spec] of Object.entries(schema.tables)) {
    db.exec("CREATE TABLE " + name + " (" + spec.cols.map(col => col.join(" ")).join(",") + ");");
    for (const index of spec.indexes) db.exec(index);
  }
  db.exec("INSERT INTO json VALUES (1,'users/alice.epix','pages.json'),(2,'users/alice.epix','data.json'),(3,'users/alice.epix','content.json'),(4,'users/bob.epix','pages.json'); INSERT INTO keyvalue VALUES (3,'cert_user_id','alice@xid.epix');");
  const calls = [];
  const rows = [];
  let currentIdentity = {...identity};
  const insert = record => {
    const fields = Object.keys(record);
    const values = fields.map(key => typeof record[key] === "boolean" ? Number(record[key]) : record[key]);
    db.prepare("INSERT INTO pages (" + fields.join(",") + ") VALUES (" + fields.map(() => "?").join(",") + ")").run(...values);
  };
  const frame = {cmd(command, params, cb) {
    calls.push({command, params});
    if (overrides[command]) return overrides[command](params, cb, {calls, insert, currentIdentity});
    if (command === "dbQuery") {
      try { cb(db.prepare(params.query).all(...params.params)); }
      catch (error) { cb({error: error.message}); }
    } else if (command === "siteInfo") cb({...currentIdentity});
    else if (command === "fileGet") cb(rows.length ? JSON.stringify({record_format: "epix-orset-1", post: rows}) : null);
    else if (command === "recordSign") cb({...params[0], author: currentIdentity.auth_address, post_id: calls.length, sign: "signed-" + params[0].id});
    else if (command === "fileWrite") {
      const container = JSON.parse(Buffer.from(params[1], "base64").toString("utf8"));
      const added = container.post.filter(record => !rows.some(old => old.sign === record.sign));
      rows.push(...added);
      added.forEach(record => {
        const stored = {};
        schema.tables.pages.cols.forEach(([key]) => { if (key in record) stored[key] = record[key]; });
        insert({...stored, json_id: 1});
      });
      cb("ok");
    } else if (command === "sitePublish") cb("ok");
    else throw Error("Unexpected command: " + command);
  }};
  const store = new WikiStore(frame, {retries: 0, retryDelay: 1, timeout: 1000});
  store.setSiteInfo(identity);
  return {db, calls, rows, insert, store, setIdentity(info) { currentIdentity = info; }};
}

test("history preserves old JSON pages and every raw signed revision, including equal timestamps", async () => {
  const f = fixture();
  f.insert({id: "old", slug: "home", body: "original", date_added: 1, json_id: 2});
  f.insert({id: "middle", slug: "home", body: "second", date_added: 2, clock: 2, sign: "s1", json_id: 1});
  f.insert({id: "newest", slug: "home", body: "third", date_added: 2, clock: 3, sign: "s2", json_id: 1});
  assert.deepEqual((await f.store.history("home")).map(page => page.id), ["newest", "middle", "old"]);
  assert.equal((await f.store.readPage("home")).body, "third");
  assert.equal((await f.store.readPage("home", "old")).body, "original");
  assert.equal((await f.store.readPage("home", "old")).cert_user_id, identity.cert_user_id);
  assert.equal(await f.store.readPage("elsewhere", "old"), null);
  assert.equal(schema.maps["users/.+/pages.json$"].fold_crdt, undefined);
  assert.equal(schema.maps["users/.+/pages.json$"].file_name, undefined);
});

test("duplicate migrated revision appears once and has deterministic signed precedence", async () => {
  const f = fixture();
  f.insert({id: "old", slug: "home", body: "legacy", date_added: 10, json_id: 2});
  f.insert({id: "old", slug: "home", body: "signed", date_added: 10, clock: 1, sign: "s1", json_id: 1});
  assert.equal((await f.store.history("home")).length, 1);
  assert.equal((await f.store.readPage("home")).body, "signed");
});

test("latest-page search binds quotes and treats percent/underscore literally", async () => {
  const f = fixture();
  f.insert({id: "1", slug: "home", body: "obsolete keyword", date_added: 1, json_id: 1});
  f.insert({id: "2", slug: "home", title: "Current", body: "100%_ ready", date_added: 2, json_id: 1});
  f.insert({id: "3", slug: "Alice's_page", body: "words", date_added: 3, json_id: 2});
  assert.equal((await f.store.listPages()).length, 2);
  assert.equal((await f.store.listPages("obsolete")).length, 0);
  assert.equal((await f.store.listPages("%_")).length, 1);
  assert.equal((await f.store.readPage("Alice's_page")).id, "3");
  assert.equal((await f.store.listPages("' OR 1=1 --")).length, 0);
});

test("errors remain errors and transient database errors retry before answering", async () => {
  let attempts = 0;
  const f = fixture({dbQuery(params, cb) { cb(++attempts === 1 ? {error: "database rebuilding"} : []); }});
  f.store.options.retries = 1;
  assert.equal(await f.store.readPage("home"), null);
  assert.equal(attempts, 2);
  const failed = fixture({dbQuery(params, cb) { cb({error: "database unavailable"}); }});
  await assert.rejects(failed.store.readPage("home"), /database unavailable/);
});

test("minimal site events retain identity and permissions", () => {
  const f = fixture();
  f.store.setSiteInfo({settings: {permissions: ["Test"]}});
  f.store.setSiteInfo({event: ["file_done", "data/users/bob.epix/pages.json"], settings: {size: 4}});
  assert.equal(f.store.siteInfo.cert_user_id, identity.cert_user_id);
  assert.deepEqual(f.store.siteInfo.settings.permissions, ["Test"]);
});

test("saving creates distinct signed revisions under xID directory and preserves Unicode", async () => {
  const f = fixture();
  const input = {slug: "home", title: "Welcome", body: "Hello 世界 🌎", summary: "Initial edit"};
  const first = await f.store.save(input, identity);
  const second = await f.store.save({...input, body: "Next"}, identity);
  assert.notEqual(first.id, second.id);
  assert.notEqual(f.rows[0].key, f.rows[1].key);
  assert.equal(f.rows[0].body, input.body);
  assert.equal(f.calls.find(call => call.command === "fileWrite").params[0], "data/users/alice.epix/pages.json");
  assert.deepEqual(f.calls.find(call => call.command === "sitePublish").params, {inner_path: "data/users/alice.epix/content.json"});
  assert.equal((await f.store.history("home")).length, 2);
});

test("write failure never publishes or reports success", async () => {
  const f = fixture({fileWrite(params, cb) { cb({error: "disk full"}); }});
  await assert.rejects(f.store.save({slug: "home", body: "test"}, identity), error => error.message === "disk full" && !error.saved);
  assert.equal(f.calls.some(call => call.command === "sitePublish"), false);
  assert.equal(f.store.pendingPublish, null);
});

test("publish failure keeps one saved revision for an exact retry", async () => {
  let attempts = 0;
  const f = fixture({sitePublish(params, cb) { cb(++attempts === 1 ? {error: "offline"} : "ok"); }});
  await assert.rejects(f.store.save({slug: "home", body: "test"}, identity), error => error.saved && error.message === "offline");
  const savedId = f.store.pendingPublish.page.id;
  await assert.rejects(f.store.save({slug: "home", body: "test"}, identity), error => error.saved);
  assert.equal((await f.store.retryPublish(identity)).id, savedId);
  assert.equal(f.calls.filter(call => call.command === "recordSign").length, 1);
  assert.equal(f.calls.filter(call => call.command === "fileWrite").length, 1);
  assert.equal(f.store.pendingPublish, null);
});

test("identity changes between sign and write stop the write", async () => {
  let checks = 0;
  const f = fixture({siteInfo(params, cb) { cb(++checks === 1 ? identity : {...identity, cert_user_id: "bob@xid.epix", auth_address: "epix1bob"}); }});
  await assert.rejects(f.store.save({slug: "home", body: "test"}, identity), /xID changed/);
  assert.equal(f.calls.some(call => call.command === "fileWrite"), false);
});

test("identity changes after local write retain publish retry state", async () => {
  let checks = 0;
  const f = fixture({siteInfo(params, cb) { cb(++checks < 3 ? identity : {...identity, cert_user_id: "bob@xid.epix", auth_address: "epix1bob"}); }});
  await assert.rejects(f.store.save({slug: "home", body: "test"}, identity), error => error.saved && /xID changed/.test(error.message));
  assert.ok(f.store.pendingPublish);
  assert.equal(f.calls.some(call => call.command === "sitePublish"), false);
});

test("existingSlugs uses current live pages and returns only requested addresses", async () => {
  const f = fixture();
  f.insert({id: "old", slug: "Alice's_page", body: "old", date_added: 1, json_id: 2});
  f.insert({id: "live", slug: "Alice's_page", body: "new", date_added: 2, json_id: 1});
  f.insert({id: "other", slug: "unrequested", body: "other", date_added: 3, json_id: 4});
  assert.deepEqual(await f.store.existingSlugs(["Alice's_page", "missing", "Alice's_page"]), new Set(["Alice's_page"]));
  const command = f.calls.at(-1);
  assert.deepEqual(command.params.params, ["Alice's_page", "missing"]);
  assert.match(command.params.query, /SELECT DISTINCT slug FROM live$/);
  const count = f.calls.length;
  assert.deepEqual(await f.store.existingSlugs([]), new Set());
  assert.equal(f.calls.length, count);
  await assert.rejects(f.store.existingSlugs(Array.from({length: 101}, (_, i) => "page" + i)), /at most 100/);
});

test("a concurrent signed tombstone wins over an edit and cannot resurrect from legacy JSON", async () => {
  const f = fixture();
  f.insert({id: "legacy", slug: "home", body: "before migration", date_added: 1, json_id: 2});
  f.insert({id: "older", slug: "home", body: "old signed", post_id: 20, date_added: 2, clock: 2, supersedes: 0, sign: "a", json_id: 1});
  f.insert({id: "edit", slug: "home", body: "newer concurrent edit", post_id: 20, date_added: 20, clock: 20, supersedes: 2, sign: "z", json_id: 1});
  f.insert({id: "delete", slug: "home", body: "", post_id: 20, date_added: 10, clock: 10, supersedes: 2, deleted: 1, sign: "b", json_id: 1});
  assert.equal(await f.store.readPage("home"), null);
  assert.deepEqual(await f.store.listPages(), []);
  assert.deepEqual(await f.store.existingSlugs(["home"]), new Set());
  assert.equal((await f.store.history("home")).length, 4);
  assert.equal((await f.store.readPage("home", "older")).body, "old signed");
  assert.equal((await f.store.readPage("home", "delete")).deleted, true);
  f.insert({id: "restore", slug: "home", body: "causal restore", post_id: 20, date_added: 30, clock: 30, supersedes: 20, sign: "c", json_id: 1});
  assert.equal((await f.store.readPage("home")).id, "restore");
});

test("deleting one author's page lineage does not hide a different author's live edit", async () => {
  const f = fixture();
  f.insert({id: "bob", slug: "home", body: "Bob's live page", date_added: 3, clock: 3, post_id: 21, sign: "bob", json_id: 4});
  f.insert({id: "alice-delete", slug: "home", body: "", date_added: 4, clock: 4, post_id: 20, deleted: 1, sign: "alice-delete", json_id: 1});
  assert.equal((await f.store.readPage("home")).id, "bob");
  assert.deepEqual(await f.store.existingSlugs(["home"]), new Set(["home"]));
});

test("first local write includes undeclared signed history instead of replacing it", async () => {
  const old = {id: "unpublished", slug: "old", body: "unsynced history", sign: "old", author: identity.auth_address, post_id: 99};
  const f = fixture({fileGet(params, cb) { cb(JSON.stringify({record_format: "epix-orset-1", post: [old]})); }});
  await f.store.save({slug: "home", body: "new"}, identity);
  const write = f.calls.find(call => call.command === "fileWrite");
  const container = JSON.parse(Buffer.from(write.params[1], "base64").toString("utf8"));
  assert.equal(container.post.length, 2);
  assert.deepEqual(container.post[0], old);
});

test("malformed local history stops saving before signing or writing", async () => {
  const f = fixture({fileGet(params, cb) { cb("{broken"); }});
  await assert.rejects(f.store.save({slug: "home", body: "new"}, identity), /left unchanged/);
  assert.equal(f.calls.some(call => ["recordSign", "fileWrite", "sitePublish"].includes(call.command)), false);
});

test("new revision clock stays valid when existing display dates are in the future", async () => {
  const f = fixture();
  const future = Date.now() + 86400000;
  f.insert({id: "future", slug: "home", body: "old", date_added: future, json_id: 2});
  const before = Date.now();
  const saved = await f.store.save({slug: "home", body: "new"}, identity);
  assert.ok(saved.clock >= before && saved.clock <= Date.now());
  assert.equal(saved.date_added, future + 1);
  assert.equal((await f.store.readPage("home")).id, saved.id);
});
