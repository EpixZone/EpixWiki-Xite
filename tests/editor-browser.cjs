// Run with EPIX_BROWSER_TEST_TOOLS=/path/to/node_modules node tests/editor-browser.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || (process.env.EPIX_BROWSER_TEST_TOOLS ? path.join(process.env.EPIX_BROWSER_TEST_TOOLS, 'playwright') : 'playwright'));
const root = path.resolve(__dirname, '..');
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/editor.css"></head><body style="margin:24px"><main id="editor"></main><script src="/js/lib/marked.min.js"></script><script src="/js/WikiEditor.js"></script><script>
window.changes=[]; window.saved=0;
window.editor = new WikiEditor(document.getElementById('editor'), {render: function(value) {
  const html = typeof marked === 'function' ? marked(value, {gfm:true}) : marked.parse(value, {gfm:true});
  return html.replace(/\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]/g, (_,page,label) => '<a data-wiki-page="'+page+'" href="?Page:'+encodeURIComponent(page)+'">'+(label||page)+'</a>');
}, onChange:value=>changes.push(value), onSave:()=>saved++});
</script></body></html>`;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
  const filename = path.resolve(root, '.' + pathname);
  if (!filename.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
  try {
    const type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.setHeader('Content-Type', type); res.end(fs.readFileSync(filename));
  } catch (_) { res.writeHead(404).end(); }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const errors=[];
  page.on('pageerror', error => errors.push(String(error)));
  const url='http://127.0.0.1:'+server.address().port;
  const value=()=>page.evaluate(()=>editor.getValue());
  const button=action=>page.locator('.wiki-editor-toolbar [data-action="'+action+'"]');
  async function select(mode, text='alpha beta gamma', start=6, end=10) {
    await page.evaluate(async ({mode,text,start,end})=>{
      editor.setValue(text);
      if (mode==='markdown') {
        const cm=editor.mde.codemirror;
        cm.focus(); cm.setSelection(cm.posFromIndex(start),cm.posFromIndex(end));
      } else {
        await editor.setMode('rich');
        const native=editor.native;
        native.focus();
        const walker=document.createTreeWalker(editor.richPanel,NodeFilter.SHOW_TEXT);
        let node,offset=0,first,last;
        while ((node=walker.nextNode())) {
          const next=offset+node.textContent.length;
          if (!first && start<=next) first=[node,start-offset];
          if (end<=next) { last=[node,end-offset]; break; }
          offset=next;
        }
        const range=new CKEDITOR.dom.range(native.document);
        range.setStart(new CKEDITOR.dom.node(first[0]),first[1]);
        range.setEnd(new CKEDITOR.dom.node(last[0]),last[1]);
        native.getSelection().selectRanges([range]); editor.rememberSelection();
      }
    },{mode,text,start,end});
  }
  async function insert(action, destination) {
    await button(action).click();
    await page.locator('.wiki-editor-link-form input').fill(destination);
    await page.locator('.wiki-editor-link-form [data-insert]').click();
  }
  try {
    await page.goto(url);
    await page.waitForFunction(()=>editor.mde);
    await page.evaluate(()=>editor.setMode('rich'));
    const richTextbox=page.getByRole('textbox',{name:'Page content in rich text',exact:true});
    assert.equal(await richTextbox.count(),1,'the initialized rich editor has an accessible name');
    assert.equal(await richTextbox.isVisible(),true);
    assert.equal(await richTextbox.getAttribute('aria-multiline'),'true');
    for (const readOnly of [true,false]) {
      await page.evaluate(readOnly=>editor.setReadOnly(readOnly),readOnly);
      assert.equal(await richTextbox.count(),1,'read-only changes preserve the rich editor accessible name');
      assert.equal(await richTextbox.getAttribute('aria-readonly'),String(readOnly));
    }
    await page.evaluate(async()=>{await editor.setMode('markdown');await editor.setMode('rich');});
    assert.equal(await richTextbox.count(),1,'returning to rich text preserves the accessible name');
    assert.equal(await richTextbox.isVisible(),true);
    await page.evaluate(()=>editor.setMode('markdown'));
    console.log('PASS rich text accessible name survives initialization, read-only changes and mode switches');
    const original='# Exact source\n\n1. first\n2. second\n\n[ref]: https://example.com\n\n[link][ref]\n\n[[Page name|Read this]]\n\n```js\nconst a = 1;\n```\n';
    await page.evaluate(async text=>{
      editor.setValue(text);
      await editor.setMode('rich');
      await editor.setMode('preview');
      await editor.setMode('markdown');
    },original);
    assert.equal(await value(),original,'no-op mode switches preserve Markdown byte for byte');
    assert.equal(await page.evaluate(()=>changes.length),0,'mode switches do not dirty the document');
    await page.evaluate(async ()=>{
      editor.setValue('# CRLF\r\n\r\nSource with Windows line endings.\r\n');
      await editor.setMode('rich'); await editor.setMode('markdown');
    });
    assert.equal(await value(),'# CRLF\r\n\r\nSource with Windows line endings.\r\n');
    console.log('PASS source fidelity through rich text and preview');
    for (const mode of ['markdown','rich']) {
      for (const [action,pattern] of [['bold',/alpha \*\*beta\*\* gamma/],['italic',/alpha (?:\*beta\*|_beta_) gamma/],['strikethrough',/alpha ~~beta~~ gamma/],['code',/alpha `beta` gamma/]]) {
        await select(mode); await button(action).click(); assert.match(await value(),pattern,mode+' '+action);
      }
      await select(mode); await insert('link','https://example.com/docs');
      assert.match(await value(),/alpha \[beta\]\(https:\/\/example.com\/docs\) gamma/);
      await select(mode); await insert('wiki-link','Getting started');
      assert.match(await value(),/alpha \[\[Getting started\|beta\]\] gamma/,mode+' wiki links');
      await select(mode); await insert('image','img/wiki.png');
      assert.match(await value(),/!\[beta\]\(img\/wiki.png\)/);
      for (const [action,pattern] of [['heading',/^#{1,6} alpha beta gamma/],['quote',/^> alpha beta gamma/],['unordered-list',/^\s*[-*+]\s+alpha beta gamma/],['ordered-list',/^\s*1\.\s+alpha beta gamma/],['code-block',/```\nalpha beta gamma\n```/]]) {
        await select(mode,'alpha beta gamma',0,16); await button(action).click(); assert.match(await value(),pattern,mode+' '+action);
      }
      await select(mode); await button('bold').focus(); await page.keyboard.press('Enter');
      assert.match(await value(),/alpha \*\*beta\*\* gamma/,mode+' keyboard formatting');
      await select(mode); await button('link').click(); await page.locator('.wiki-editor-link-form input').fill('javascript:alert(1)');
      await page.locator('.wiki-editor-link-form [data-insert]').click();
      assert.equal(await value(),'alpha beta gamma');
      assert.equal(await page.locator('.wiki-editor-link-form').isVisible(),true);
      await page.keyboard.press('Escape');
      await button('code').click(); assert.match(await value(),/alpha `beta` gamma/);
      console.log('PASS '+mode+' inline, block, links, keyboard selection and unsafe URL rejection');
    }
    await select('rich');
    await button('bold').click();
    await page.keyboard.press('Control+z');
    assert.equal(await value(),'alpha beta gamma','rich native undo');
    await select('rich');
    await page.evaluate(()=>{
      const dt=new DataTransfer(); dt.setData('text/html','<img src="x" onerror="window.pasteExecuted=true"><script>window.pasteExecuted=true</script><b>clipboard</b>'); dt.setData('text/plain','clipboard');
      editor.richPanel.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    });
    assert.equal(await value(),'alpha clipboard gamma');
    assert.equal(await page.evaluate(()=>!!window.pasteExecuted),false);
    assert.equal(await page.locator('.wiki-editor-rich img').count(),0);
    assert.equal(await page.evaluate(()=>editor.render('<a href="  javascript:alert(1)">Unsafe</a>').includes('javascript:')),false);
    console.log('PASS rich undo and safe plain-text paste');
    await select('rich','edit me\n\n[![Photo](img/wiki.png)](https://example.com)\n\n[`array[0]`](https://example.com/code)\n\n````js\nconst fence = "```";\n````\n\n[[Guide|Help]]',0,7);
    await button('bold').click();
    const preserved=await value();
    assert.match(preserved,/\*\*edit me\*\*/);
    assert.match(preserved,/\[!\[Photo\]\(img\/wiki.png\)\]\(https:\/\/example.com\)/);
    assert.match(preserved,/\[`array\[0\]`\]\(https:\/\/example.com\/code\)/);
    assert.match(preserved,/````js\nconst fence = "```";\n````/);
    assert.match(preserved,/\[\[Guide\|Help\]\]/);
    const embedded='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    await select('rich','edit me\n\n![Pixel]('+embedded+')',0,7);
    assert.equal(await page.locator('.wiki-editor-rich img').getAttribute('src'),embedded);
    await button('bold').click();
    assert.ok((await value()).includes('![Pixel]('+embedded+')'),'rich edits retain existing safe embedded images');
    console.log('PASS rich edits preserve linked images, linked code, wiki links and fenced code languages');
    await select('markdown');
    await page.evaluate(()=>editor.setReadOnly(true));
    assert.equal(await button('bold').isDisabled(),true);
    assert.equal(await page.evaluate(()=>editor.mde.codemirror.getOption('readOnly')),true);
    await page.evaluate(()=>editor.setReadOnly(false));
    await page.keyboard.press('Control+s');
    assert.equal(await page.evaluate(()=>saved),1);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    console.log('PASS read-only state, save shortcut and mobile layout');
    await page.evaluate(()=>editor.destroy());
    assert.equal(await page.locator('#editor').textContent(),'');
    const fallback=await browser.newPage();
    await fallback.route('**/editor/easymde.min.js',route=>route.abort());
    await fallback.goto(url);
    await fallback.locator('textarea').fill('plain editor');
    assert.equal(await fallback.evaluate(()=>editor.getValue()),'plain editor');
    await fallback.locator('[data-action="bold"]').click();
    assert.match(await fallback.evaluate(()=>editor.getValue()),/\*\*text\*\*/);
    await fallback.close();
    assert.deepEqual(errors,[],'browser errors');
    console.log('PASS usable Markdown fallback when enhanced editor fails');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error); process.exitCode=1;});
