/* Integration tests use the actual EpixFrame postMessage protocol and SQLite queries.
 * The local wrapper supplies a deterministic EpixNet node, without network access.
 * Run npm install && npx playwright install chromium && npm test.
 */
const assert = require('node:assert/strict');
const {before, after, test} = require('node:test');
const {readFile, mkdir} = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const scenarios = new Map();
const epoch = 1700000000000;
let browser, server, origin, nextId = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = name => '"' + name.replaceAll('"', '""') + '"';

function record(id, slug, title, body, offset = 0) {
  return {id, slug, title, body, summary: '', date_added: epoch + offset,
    clock: epoch + offset, post_id: epoch + offset, author: 'alice',
    deleted: 0, sign: 'fixture-signature', key: 'revision:' + id, supersedes: 0,
    nonce: id.padEnd(32, '0'), json_id: 1};
}

const defaultRecords = () => [
  {...record('home-old', 'home', 'Home', '# Home\n\nOriginal home text.', 1), json_id: 3, sign: null, author: null, clock: null, post_id: null},
  record('home-current', 'home', 'Home', '# Home\n\nWelcome to our wiki. Read [[Guide]] or [[Missing Page]].', 2),
  record('guide-current', 'guide', 'Guide', '# Guide\n\nA guide to EDX. Return to [[Home]].', 3),
  record('orphan-current', 'orphan', 'Orphan', '# Orphan\n\nA page without incoming links.', 4)
];

class Scenario {
  constructor(schema, options = {}) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('CREATE TABLE json (json_id INTEGER PRIMARY KEY, directory TEXT, file_name TEXT); CREATE TABLE keyvalue (key TEXT, value TEXT, json_id INTEGER);');
    this.db.exec("INSERT INTO json VALUES (1, 'users/alice', 'pages.json'), (2, 'users/alice', 'content.json'), (3, 'users/alice', 'data.json'); INSERT INTO keyvalue VALUES ('cert_user_id', 'alice@xid', 2);");
    for (const [name, definition] of Object.entries(schema.tables)) {
      this.db.exec('CREATE TABLE ' + quote(name) + ' (' + definition.cols.map(([name, type]) => quote(name) + ' ' + type).join(', ') + ')');
      for (const index of definition.indexes || []) this.db.exec(index);
    }
    this.columns = schema.tables.pages.cols.map(([name]) => name);
    this.records = [];
    this.files = new Map();
    this.commands = [];
    this.queryErrors = null;
    this.queryDelay = null;
    this.publishError = null;
    this.writeError = null;
    this.signError = null;
    this.queryCount = 0;
    this.info = {address: 'wiki', auth_address: 'alice', cert_user_id: 'alice@xid',
      settings: {own: false}, content: {title: 'Epix Wiki'}, peers: 3,
      tasks: 0, bad_files: 0, size: 2000};
    const {records: initialRecords, route, ...settings} = options;
    Object.assign(this, settings);
    for (const entry of options.records || defaultRecords()) this.addRecord(entry);
  }

  addRecord(entry) {
    const row = {...entry, json_id: entry.json_id || 1};
    this.records.push(row);
    const keys = this.columns.filter(key => row[key] !== undefined);
    this.db.prepare('INSERT INTO pages (' + keys.map(quote).join(', ') + ') VALUES (' + keys.map(() => '?').join(', ') + ')')
      .run(...keys.map(key => row[key]));
    const source = this.db.prepare('SELECT directory, file_name FROM json WHERE json_id = ?').get(row.json_id);
    const rows = this.records.filter(existing => existing.json_id === row.json_id);
    this.files.set('data/' + source.directory + '/' + source.file_name, JSON.stringify(source.file_name === 'pages.json' ? {record_format: 'epix-orset-1', post: rows} : {pages: rows}));
  }

  async command({cmd, params}) {
    this.commands.push({cmd, params});
    if (cmd === 'siteInfo') return this.siteInfoError ? {error: this.siteInfoError} : {...this.info};
    if (cmd === 'serverInfo') return {version: 'test', platform: 'linux'};
    if (cmd === 'dbQuery') {
      this.queryCount++;
      const sql = Array.isArray(params) ? params[0] : params.query;
      const values = Array.isArray(params) ? params[1] : params.params;
      const queryError = typeof this.queryErrors === 'function' ? this.queryErrors(sql, values) : this.queryErrors;
      if (queryError) return {error: queryError};
      try {
        const rows = this.db.prepare(sql).all(...(values || []));
        const wait = this.queryDelay && this.queryDelay(sql, values);
        if (wait) await delay(wait);
        return rows;
      } catch (error) { return {error: error.message}; }
    }
    if (cmd === 'fileGet') {
      const name = typeof params === 'string' ? params : (Array.isArray(params) ? params[0] : params.inner_path);
      return this.files.get(name) || null;
    }
    if (cmd === 'fileRules') return this.quotaError ? {error: this.quotaError} : {current_size: 500, max_size: 1000000};
    if (cmd === 'recordSign') {
      if (this.signError) return {error: this.signError};
      return {...(Array.isArray(params) ? params[0] : params), author: this.info.auth_address, post_id: Date.now(), sign: 'signed-fixture'};
    }
    if (cmd === 'fileWrite') {
      if (this.writeError) return {error: this.writeError};
      const [name, payload] = params;
      const contents = Buffer.from(payload, 'base64').toString('utf8');
      const container = JSON.parse(contents);
      if (name.endsWith('/pages.json')) {
        const directory = name.replace(/^data\//, '').replace(/\/pages\.json$/, '');
        let source = this.db.prepare("SELECT json_id FROM json WHERE directory = ? AND file_name = 'pages.json'").get(directory);
        if (!source) {
          const jsonId = this.db.prepare("INSERT INTO json (directory, file_name) VALUES (?, 'pages.json')").run(directory).lastInsertRowid;
          const contentId = this.db.prepare("INSERT INTO json (directory, file_name) VALUES (?, 'content.json')").run(directory).lastInsertRowid;
          this.db.prepare("INSERT INTO keyvalue (key, value, json_id) VALUES ('cert_user_id', ?, ?)").run(this.info.cert_user_id, contentId);
          source = {json_id: Number(jsonId)};
        }
        for (const row of container.post || []) {
          if (!this.records.some(existing => existing.id === row.id)) this.addRecord({...row, json_id: source.json_id, deleted: Number(row.deleted)});
        }
      } else this.files.set(name, contents);
      return 'ok';
    }
    if (cmd === 'sitePublish') return this.publishError ? {error: this.publishError} : 'ok';
    if (cmd === 'certXid') {
      if (this.loginDelay) await delay(this.loginDelay);
      if (this.loginInfo) Object.assign(this.info, this.loginInfo);
      return 'ok';
    }
    if (cmd === 'channelJoin') return 'ok';
    if (cmd === 'xidResolveBatch') return {};
    if (cmd.startsWith('xid')) return {name: 'alice', address: 'alice'};
    return {error: 'Unhandled test bridge command: ' + cmd};
  }
}

before(async () => {
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/__bridge/')) {
        let body = '';
        for await (const chunk of request) body += chunk;
        const scenario = scenarios.get(decodeURIComponent(url.pathname.substring('/__bridge/'.length)));
        if (!scenario) throw new Error('Unknown test scenario');
        const result = await scenario.command(JSON.parse(body));
        response.writeHead(200, {'Content-Type': 'application/json'});
        return response.end(JSON.stringify(result));
      }
      const pathname = decodeURIComponent(url.pathname).replace(/^\/(?:media\/)?test-site\//, '/');
      const filename = path.resolve(root, '.' + pathname);
      if (!filename.startsWith(root + path.sep)) throw new Error('Invalid file path');
      const data = await readFile(filename);
      const types = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png'};
      response.writeHead(200, {'Content-Type': types[path.extname(filename)] || 'application/octet-stream'});
      response.end(data);
    } catch (error) { response.writeHead(404); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});
});

after(async () => {
  await browser?.close();
  for (const scenario of scenarios.values()) scenario.db.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function open(t, options = {}) {
  const schema = JSON.parse(await readFile(path.join(root, 'dbschema.json'), 'utf8'));
  const scenario = new Scenario(schema, options);
  const testId = String(++nextId);
  scenarios.set(testId, scenario);
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.setDefaultTimeout(8000);
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  await page.goto(origin + '/tests/wrapper.html?test=' + testId + '&route=' + encodeURIComponent(options.route || '?Page:home') + (options.media ? '&media=1' : ''));
  const frame = page.frameLocator('#site');
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'No unhandled browser exceptions');
    assert.deepEqual(externalRequests, [], 'Reader and editor work entirely from bundled assets');
  });
  return {page, frame, scenario};
}

async function content(frame, text) {
  await frame.locator('#page-content').filter({hasText: text}).waitFor({state: 'visible', timeout: 8000});
}

async function event(page, params = {}) {
  await page.evaluate(params => window.sendEvent('setSiteInfo', params), params);
}

async function navigate(frame, url) {
  await frame.locator('body').evaluate((body, url) => window.Page.navigate(url), url);
}

async function editBody(page, frame, text) {
  await frame.locator('#editor-host .CodeMirror').waitFor({state: 'visible'});
  await frame.locator('#editor-host .CodeMirror').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
}

async function editorValue(frame) {
  return frame.locator('#editor-host').evaluate(() => window.Page.editor.getValue());
}

async function screenshot(page, name) {
  if (!process.env.WIKI_SCREENSHOT_DIR) return;
  await mkdir(process.env.WIKI_SCREENSHOT_DIR, {recursive: true});
  const previous = await page.evaluate(() => {
    const iframe = document.getElementById('site');
    const state = {height: iframe.style.height, scrollY: iframe.contentWindow.scrollY};
    iframe.style.height = iframe.contentDocument.documentElement.scrollHeight + 'px';
    iframe.contentWindow.scrollTo(0, 0);
    return state;
  });
  try { await page.screenshot({path: path.join(process.env.WIKI_SCREENSHOT_DIR, name + '.png'), fullPage: true}); }
  finally {
    await page.evaluate(previous => {
      const iframe = document.getElementById('site');
      iframe.style.height = previous.height;
      iframe.contentWindow.scrollTo(0, previous.scrollY);
    }, previous);
  }
}

test('first load renders when the initial database is populated later', async t => {
  const {page, frame, scenario} = await open(t, {records: [], info: {address: 'wiki', auth_address: 'alice', cert_user_id: 'alice@xid', tasks: 2, bad_files: 2, peers: 3, settings: {}}});
  await frame.locator('#status').waitFor();
  scenario.info.tasks = 0;
  scenario.info.bad_files = 0;
  await event(page, {...scenario.info, event: ['file_done', 'data/users/alice/pages.json']});
  // File delivery can precede the node's SQLite index update. No second event
  // is guaranteed after those rows become queryable.
  await delay(350);
  for (const row of defaultRecords()) scenario.addRecord(row);
  await content(frame, 'Welcome to our wiki');
  assert.equal(await frame.locator('#page-title').innerText(), 'Home');
});

test('internal links, index, history, old revisions and browser history work', async t => {
  const {page, frame} = await open(t);
  await content(frame, 'Welcome to our wiki');
  await screenshot(page, 'desktop-home');
  await frame.locator('#page-content a').filter({hasText: 'Guide'}).click();
  await content(frame, 'A guide to EDX');
  await page.goBack();
  await content(frame, 'Welcome to our wiki');
  await page.goForward();
  await content(frame, 'A guide to EDX');
  await navigate(frame, '?Index');
  await frame.locator('#page-content a[href="?Page:orphan"]').waitFor();
  await screenshot(page, 'desktop-index');
  await navigate(frame, '?Page:home&History');
  await frame.locator('#page-content a[href="?Page:home&Rev:home-old"]').click();
  await content(frame, 'Original home text');
  await navigate(frame, '?Page:home');
  await content(frame, 'Welcome to our wiki');
});

test('revision deep links load the requested revision on the first visit', async t => {
  const {frame} = await open(t, {route: '?Page:home&Rev:home-old'});
  await content(frame, 'Original home text');
  assert.doesNotMatch(await frame.locator('#page-content').innerText(), /Welcome to our wiki/);
});

test('query failures show retry and are not treated as nonexistent pages', async t => {
  const {frame, scenario} = await open(t, {queryErrors: 'Database rebuilding'});
  await frame.locator('#retry-load').waitFor({state: 'visible'});
  assert.match(await frame.locator('#status').innerText(), /database|load|rebuilding|error|retry/i);
  scenario.queryErrors = null;
  await frame.locator('#retry-load').click();
  await content(frame, 'Welcome to our wiki');
  await navigate(frame, '?Page:missing-page');
  await content(frame, /does not exist|not exist|no page|not been written|not found/i);
});

test('a slow earlier request cannot replace the page selected afterward', async t => {
  const {frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  scenario.queryDelay = (sql, values) => values?.includes('guide') ? 500 : 0;
  await frame.locator('body').evaluate(() => { window.Page.navigate('?Page:guide'); });
  await frame.locator('body').evaluate(() => { window.Page.navigate('?Page:orphan'); });
  await content(frame, 'A page without incoming links');
  await delay(650);
  assert.match(await frame.locator('#page-content').innerText(), /A page without incoming links/);
});

test('markdown blocks unsafe URLs and HTML and leaves code examples alone', async t => {
  const body = '# Safety\n\n<script>window.injected=true</script>\n<img src=x onerror="window.injected=true">\n\n[Bad](javascript:alert(1))\n\n[Good](https://example.com)\n\n`[[Guide]]`\n\n```text\n[[Guide]]\n```\n\n[[Guide]]';
  const {frame} = await open(t, {records: [record('safe', 'home', 'Safety', body)]});
  await content(frame, 'Safety');
  assert.equal(await frame.locator('#page-content script, #page-content [onerror], #page-content a[href^="javascript:"]').count(), 0);
  assert.equal(await frame.locator('#page-content code a').count(), 0);
  assert.equal(await frame.locator('#page-content a[href="?Page:guide"]').count(), 1);
  assert.equal(await frame.locator('body').evaluate(() => window.injected), undefined);
});

test('editing survives synchronization, identity changes and canceled navigation', async t => {
  const {page, frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#edit-page').click();
  const draft = '# A draft\n\nThese edits have not been saved.';
  await editBody(page, frame, draft);
  scenario.addRecord(record('home-concurrent', 'home', 'Home', '# Home\n\nAnother contributor changed this page.', 50));
  await event(page, {...scenario.info, event: ['file_done', 'data/users/alice/pages.json']});
  await event(page, {...scenario.info, cert_user_id: 'bob@xid', auth_address: 'bob', event: ['cert_changed']});
  await page.evaluate(() => {
    sendEvent('wrapperClosedWebsocket', {});
    sendEvent('wrapperOpenedWebsocket', {});
  });
  await navigate(frame, '?Page:guide');
  await delay(400);
  assert.equal(await editorValue(frame), draft);
  assert.equal(await frame.locator('#edit-panel').isVisible(), true);
  assert.equal(scenario.commands.filter(command => command.cmd === 'fileWrite').length, 0);
});

test('Markdown, preview and rich text preserve content and wiki links', async t => {
  const {page, frame} = await open(t);
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#edit-page').click();
  const draft = '# Editing\n\nA **bold** word, [[Guide]], and `code`.\n\n- One\n- Two';
  await editBody(page, frame, draft);
  await frame.locator('#editor-host [data-mode="preview"]').click();
  await frame.locator('.wiki-editor-preview strong').filter({hasText: 'bold'}).waitFor();
  assert.equal(await editorValue(frame), draft);
  await frame.locator('#editor-host [data-mode="rich"]').click();
  await frame.locator('.wiki-editor-rich[contenteditable="true"]').waitFor({state: 'visible', timeout: 12000});
  assert.equal(await editorValue(frame), draft);
  await screenshot(page, 'desktop-rich-editor');
  await frame.locator('#editor-host [data-mode="markdown"]').click();
  assert.equal(await editorValue(frame), draft);
  await screenshot(page, 'desktop-markdown-editor');
});

test('reader and editor remain usable at a narrow mobile width', async t => {
  const {page, frame} = await open(t);
  await page.setViewportSize({width: 390, height: 844});
  await content(frame, 'Welcome to our wiki');
  await screenshot(page, 'mobile-home');
  const overflow = () => frame.locator('html').evaluate(element => element.scrollWidth > element.clientWidth + 1);
  assert.equal(await overflow(), false, 'Reading layout fits the viewport');
  await frame.locator('#edit-page').click();
  await frame.locator('#editor-host .CodeMirror').waitFor({state: 'visible'});
  assert.equal(await overflow(), false, 'Editing layout fits the viewport');
  assert.equal(await frame.locator('#save-page').isVisible(), true);
  await screenshot(page, 'mobile-editor');
});

test('save writes an EDX signed revision and retains the draft when publishing fails', async t => {
  const {page, frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#edit-page').click();
  const draft = '# Updated home\n\nWritten through EDX. Unicode: café 🪴.';
  await editBody(page, frame, draft);
  await frame.locator('#edit-summary').fill('Expand the introduction');
  scenario.publishError = 'No peers available';
  await frame.locator('#save-page').click();
  await frame.locator('#status').filter({hasText: /publish|peer/i}).waitFor();
  assert.equal(await editorValue(frame), draft);
  assert.equal(await frame.locator('#edit-panel').isVisible(), true);
  const signed = scenario.commands.filter(command => command.cmd === 'recordSign');
  assert.equal(signed.length, 1);
  const revision = Array.isArray(signed[0].params) ? signed[0].params[0] : signed[0].params;
  assert.equal(revision.body, draft);
  assert.match(revision.key, /^revision:/);
  assert.equal(revision.summary, 'Expand the introduction');
  assert.equal(scenario.records.filter(row => row.id === revision.id).length, 1);
  scenario.publishError = null;
  await frame.locator('#save-page').click();
  await content(frame, 'Written through EDX');
  assert.equal(scenario.commands.filter(command => command.cmd === 'recordSign').length, 1, 'Retry publishes the already signed revision');
  assert.equal(scenario.records.filter(row => row.id === revision.id).length, 1);
  assert.equal(scenario.commands.filter(command => command.cmd === 'fileWrite' && !command.params[0].endsWith('/pages.json')).length, 0);
});

for (const failure of ['signError', 'writeError']) {
  test('a ' + failure + ' preserves editable draft content', async t => {
    const {page, frame, scenario} = await open(t);
    await content(frame, 'Welcome to our wiki');
    await frame.locator('#edit-page').click();
    const draft = 'A draft retained after a failed save.';
    await editBody(page, frame, draft);
    scenario[failure] = 'Injected save failure';
    await frame.locator('#save-page').click();
    await frame.locator('#status').filter({hasText: /Injected save failure/i}).waitFor();
    assert.equal(await editorValue(frame), draft);
    assert.equal(await frame.locator('#save-page').isEnabled(), true);
    assert.equal(scenario.commands.filter(command => command.cmd === 'sitePublish').length, 0);
    scenario[failure] = null;
    await frame.locator('#save-page').click();
    await content(frame, draft);
  });
}

test('create, search and Recent show a new signed page', async t => {
  const {page, frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#new-page').click();
  await frame.locator('#edit-title').fill('New community guide');
  await editBody(page, frame, '# A new page\n\nDistinctive searchable content about pelicans.');
  await frame.locator('#edit-summary').fill('Write the first draft');
  await frame.locator('#save-page').click();
  await content(frame, 'Distinctive searchable content about pelicans.');
  assert.equal(await frame.locator('#page-title').innerText(), 'New community guide');
  assert.equal(scenario.records.filter(row => row.slug === 'new-community-guide').length, 1);
  await frame.locator('#search-input').fill('pelicans');
  await frame.locator('#search-form button').click();
  await content(frame, 'New community guide');
  assert.equal(await frame.locator('#page-content .page-card').count(), 1);
  await frame.locator('#search-input').fill('nothing-matches-this-query');
  await frame.locator('#search-form button').click();
  await content(frame, 'No matching pages');
  await frame.locator('[data-nav="recent"]').click();
  await frame.locator('#page-content .revision-list a').first().filter({hasText: 'New community guide'}).waitFor();
  await frame.locator('#page-content .revision-list a').first().click();
  await content(frame, 'Distinctive searchable content about pelicans.');
});

test('missing wiki links lead to a usable creation flow', async t => {
  const {page, frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  const missing = frame.locator('#page-content a[href="?Page:missing-page"]');
  await missing.locator('xpath=self::*[contains(@class,"missing-page")]').waitFor();
  await missing.click();
  await content(frame, 'This page has not been written yet');
  await frame.locator('#edit-page').click();
  await editBody(page, frame, 'The missing page now exists.');
  await frame.locator('#save-page').click();
  await content(frame, 'The missing page now exists.');
  assert.equal(scenario.records.filter(row => row.slug === 'missing-page').length, 1);
  await navigate(frame, '?Page:home');
  await content(frame, 'Welcome to our wiki');
  assert.equal(await frame.locator('#page-content .missing-page[href="?Page:missing-page"]').count(), 0);
});

test('restoring an old revision publishes a new revision and preserves history', async t => {
  const {page, frame, scenario} = await open(t, {route: '?Page:home&Rev:home-old'});
  await content(frame, 'Original home text');
  await frame.locator('#restore-page').click();
  assert.match(await frame.locator('#edit-summary').inputValue(), /^Restore revision/);
  await page.evaluate(() => confirmations.push(true));
  await frame.locator('#save-page').click();
  await content(frame, 'Original home text');
  const revisions = scenario.records.filter(row => row.slug === 'home');
  assert.equal(revisions.length, 3);
  assert.equal(revisions.at(-1).body, revisions[0].body);
  assert.notEqual(revisions.at(-1).id, 'home-old');
  await frame.locator('#page-history').click();
  await frame.locator('#page-content .revision-list li').nth(2).waitFor();
  assert.equal(await frame.locator('#page-content .revision-list li').count(), 3);
});

test('a conflicting edit requires confirmation before it creates a signed revision', async t => {
  const {page, frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#edit-page').click();
  const draft = 'My concurrent edit';
  await editBody(page, frame, draft);
  scenario.addRecord(record('concurrent-home', 'home', 'Home', 'A different concurrent edit', 100));
  await event(page, {...scenario.info, event: ['file_done', 'data/users/alice/pages.json']});
  await frame.locator('#update-notice').waitFor({state: 'visible'});
  await frame.locator('#save-page').click();
  await frame.locator('#save-page:not(:disabled)').waitFor();
  assert.equal(scenario.commands.filter(command => command.cmd === 'recordSign').length, 0);
  assert.equal(await editorValue(frame), draft);
  await page.evaluate(() => confirmations.push(true));
  await frame.locator('#save-page').click();
  await content(frame, draft);
  assert.equal(scenario.commands.filter(command => command.cmd === 'recordSign').length, 1);
  assert.equal(scenario.records.some(row => row.id === 'concurrent-home'), true);
});

test('reviewing an incoming change and canceling edits respect confirmation results', async t => {
  const {page, frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#edit-page').click();
  await editBody(page, frame, 'Draft to keep');
  scenario.addRecord(record('incoming-home', 'home', 'Home', 'The incoming revision', 100));
  await event(page, {...scenario.info, event: ['file_done', 'data/users/alice/pages.json']});
  await frame.locator('#update-notice').waitFor({state: 'visible'});
  await frame.locator('#load-update').click();
  assert.equal(await editorValue(frame), 'Draft to keep');
  await page.evaluate(() => confirmations.push(true));
  await frame.locator('#load-update').click();
  await content(frame, 'The incoming revision');
  await frame.locator('#edit-page').click();
  await editBody(page, frame, 'A second draft');
  await frame.locator('#cancel-edit').click();
  assert.equal(await editorValue(frame), 'A second draft');
  await page.evaluate(() => confirmations.push(true));
  await frame.locator('#cancel-edit').click();
  await content(frame, 'The incoming revision');
  assert.equal(scenario.commands.filter(command => command.cmd === 'recordSign').length, 0);
});

test('xID login, switching identity and publishing preserve an in-progress draft', async t => {
  const {page, frame, scenario} = await open(t, {info: {address: 'wiki', auth_address: 'alice', cert_user_id: null, settings: {}, tasks: 0}});
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#edit-page').click();
  await editBody(page, frame, 'An anonymous draft ready to publish.');
  scenario.loginInfo = {auth_address: 'alice', cert_user_id: 'alice@xid'};
  await frame.locator('#login').click();
  await frame.locator('#login').filter({hasText: 'alice@xid'}).waitFor();
  assert.equal(await editorValue(frame), 'An anonymous draft ready to publish.');
  scenario.loginInfo = {auth_address: 'bob', cert_user_id: 'bob@xid', xid_directory: 'bob.epix'};
  await frame.locator('#login').click();
  await frame.locator('#login').filter({hasText: 'bob@xid'}).waitFor();
  assert.equal(await editorValue(frame), 'An anonymous draft ready to publish.');
  await frame.locator('#save-page').click();
  await content(frame, 'An anonymous draft ready to publish.');
  const write = scenario.commands.find(command => command.cmd === 'fileWrite');
  assert.equal(write.params[0], 'data/users/bob.epix/pages.json');
  const published = scenario.commands.find(command => command.cmd === 'sitePublish');
  assert.equal(published.params.inner_path, 'data/users/bob.epix/content.json');
  assert.equal(scenario.records.at(-1).author, 'bob');
});

test('navigation requested in the same turn selects the last destination', async t => {
  const {frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  scenario.queryDelay = (sql, values) => values?.includes('guide') ? 300 : 0;
  await frame.locator('body').evaluate(() => {
    window.Page.navigate('?Page:guide');
    window.Page.navigate('?Page:orphan');
  });
  await content(frame, 'A page without incoming links');
  await delay(400);
  assert.match(await frame.locator('#page-content').innerText(), /A page without incoming links/);
});

test('headings and anchor links cannot collide with application control IDs', async t => {
  const {page, frame} = await open(t, {records: [record('headings', 'home', 'Heading test', '# Heading test\n\n[Jump](#save-page)\n\n## editor-host\n\nText\n\n## save-page\n\nMore text\n\n## status-text\n\nFinal text')]});
  await content(frame, 'Final text');
  for (const id of ['editor-host', 'save-page', 'status-text']) {
    assert.equal(await frame.locator('#' + id).count(), 1);
    assert.equal(await frame.locator('#page-content #wiki-heading-' + id).count(), 1);
  }
  await frame.locator('#page-content a[href="#save-page"]').click();
  assert.equal(await frame.locator('#page-title').innerText(), 'Heading test');
  await frame.locator('#edit-page').click();
  await editBody(page, frame, 'The real editor still works.');
  assert.equal(await editorValue(frame), 'The real editor still works.');
});

test('a delayed login cannot save a draft after the user leaves its editor', async t => {
  const {page, frame, scenario} = await open(t, {info: {address: 'wiki', auth_address: 'alice', cert_user_id: null, settings: {}, tasks: 0}, loginDelay: 400, loginInfo: {cert_user_id: 'alice@xid'}});
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#edit-page').click();
  await editBody(page, frame, 'A draft the user is discarding.');
  await frame.locator('#save-page').click();
  await page.waitForFunction(() => commands.some(command => command.cmd === 'certXid'));
  await page.evaluate(() => confirmations.push(true));
  await navigate(frame, '?Index');
  await frame.locator('#page-content a[href="?Page:orphan"]').waitFor();
  await delay(600);
  assert.equal(scenario.commands.filter(command => command.cmd === 'recordSign').length, 0);
  assert.equal(await frame.locator('#page-title').innerText(), 'All pages');
});

test('the media iframe path keeps wrapper-aware navigation and modifier links valid', async t => {
  const {page, frame} = await open(t, {media: true});
  await content(frame, 'Welcome to our wiki');
  const guide = frame.locator('#page-content a[href="?Page:guide"]');
  assert.equal(await guide.evaluate(link => link.href), origin + '/test-site/?Page:guide');
  const popupPromise = page.context().waitForEvent('page');
  await guide.click({modifiers: ['Control']});
  const popup = await popupPromise;
  await popup.waitForURL(origin + '/test-site/?Page:guide');
  await popup.close();
  assert.equal(await frame.locator('#page-title').innerText(), 'Home');
  await guide.click();
  await content(frame, 'A guide to EDX');
  await page.goBack();
  await content(frame, 'Welcome to our wiki');
});

test('section deep links and cross-page section links scroll to the intended heading', async t => {
  const spacer = Array.from({length: 24}, (_, index) => 'Paragraph ' + index + ' before the details.').join('\n\n');
  const records = [record('anchor-home', 'home', 'Home', '[Read the details](?Page:guide#details)'),
    record('anchor-guide', 'guide', 'Guide', '# Guide\n\n' + spacer + '\n\n## Details\n\nThe target section.\n\n' + spacer, 2)];
  const {page, frame} = await open(t, {records, route: '?Page:guide#details', media: true});
  await content(frame, 'The target section');
  const anchor = frame.locator('#wiki-heading-details');
  assert.ok(await anchor.evaluate(element => Math.abs(element.getBoundingClientRect().top) < 10));
  await navigate(frame, '?Page:home');
  await frame.locator('#page-content a[href="?Page:guide#details"]').click();
  await content(frame, 'The target section');
  assert.ok(await anchor.evaluate(element => Math.abs(element.getBoundingClientRect().top) < 10));
  assert.match(page.url(), /#details$/);
});

test('browser Back protects unsaved changes and honors an accepted discard', async t => {
  const {page, frame} = await open(t);
  await content(frame, 'Welcome to our wiki');
  await frame.locator('#page-content a[href="?Page:guide"]').click();
  await content(frame, 'A guide to EDX');
  await frame.locator('#edit-page').click();
  await editBody(page, frame, 'Keep my guide changes');
  await page.goBack();
  await page.waitForFunction(() => commands.filter(command => command.cmd === 'wrapperConfirm').length === 1);
  await page.waitForURL(/\?Page:guide$/);
  assert.equal(await editorValue(frame), 'Keep my guide changes');
  await page.evaluate(() => confirmations.push(true));
  await page.goBack();
  await content(frame, 'Welcome to our wiki');
  assert.equal(await frame.locator('#edit-panel').isVisible(), false);
});

test('a nonexistent revision offers the current page and does not create an empty revision', async t => {
  const {frame, scenario} = await open(t, {route: '?Page:home&Rev:no-such-revision'});
  await content(frame, 'Revision not found');
  assert.equal(await frame.locator('#page-actions').isVisible(), false);
  await frame.locator('#page-content a[href="?Page:home"]').click();
  await content(frame, 'Welcome to our wiki');
  assert.equal(scenario.commands.filter(command => command.cmd === 'fileWrite').length, 0);
});

test('Recent keeps consecutive revisions of the same page and opens each version', async t => {
  const {page, frame, scenario} = await open(t);
  await content(frame, 'Welcome to our wiki');
  for (const [body, summary] of [['The first consecutive edit.', 'First consecutive edit'], ['The second consecutive edit.', 'Second consecutive edit']]) {
    await frame.locator('#edit-page').click();
    await editBody(page, frame, body);
    await frame.locator('#edit-summary').fill(summary);
    await frame.locator('#save-page').click();
    await content(frame, body);
  }
  const [first, second] = scenario.records.slice(-2);
  await frame.locator('[data-nav="recent"]').click();
  await frame.locator('#page-content .revision-list li').first().filter({hasText: 'Second consecutive edit'}).waitFor();
  assert.match(await frame.locator('#page-content .revision-list li').nth(1).innerText(), /First consecutive edit/);
  await frame.locator('#page-content a[href="?Page:home&Rev:' + first.id + '"]').click();
  await content(frame, 'The first consecutive edit.');
  await frame.locator('#current-version').click();
  await content(frame, 'The second consecutive edit.');
  assert.notEqual(first.id, second.id);
});

test('a failed initial identity request recovers without refresh and quota errors do not block editing', async t => {
  const {page, frame, scenario} = await open(t, {siteInfoError: 'Node is starting', quotaError: 'Quota is unavailable'});
  await frame.locator('#status').filter({hasText: 'Node is starting'}).waitFor();
  assert.equal(await frame.locator('#retry-load').isVisible(), true);
  scenario.siteInfoError = null;
  await page.evaluate(() => sendEvent('wrapperOpenedWebsocket', {}));
  await content(frame, 'Welcome to our wiki');
  await event(page, {event: null});
  assert.equal(await frame.locator('#login').innerText(), 'alice@xid');
  assert.equal(await frame.locator('#user-quota').innerText(), '');
  await frame.locator('#edit-page').click();
  await editBody(page, frame, 'Quota display is optional.');
  assert.equal(await editorValue(frame), 'Quota display is optional.');
});

module.exports = {Scenario, record};
