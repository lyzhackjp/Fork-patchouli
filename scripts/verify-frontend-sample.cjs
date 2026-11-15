// Run with Node.js. These are adapter/state tests, not browser or real-host tests.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'samples/conversation-workspace');
const api = require(path.join(folder, 'core.js'));
const fixture = require(path.join(folder, 'fixture.js'));
const newClient = () => { const mock = fixture.create(); return { mock, client: new api.Client(mock.callTool) }; };

test('import → source → discover → start → running → complete → translation → conditional put', async () => {
  const { client } = newClient();
  const item = await client.importPdf('/sample/education.pdf');
  assert.equal(item.text_uri, fixture.textUri);
  const source = await client.fetch(api.pageUris(item.text_uri).source);
  assert.match(source.content, /profile="patchouli-page-2"/);
  assert.match(source.content, /type="text"/);
  const receipt = await client.startTranslation(item.text_uri, 'stable-request-id');
  assert.equal(api.completion(await client.status(receipt.status_uri)), 'running');
  assert.equal(api.completion(await client.status(receipt.status_uri)), 'ready');
  const translated = await client.fetch(fixture.translationUri);
  assert.match(translated.content, /translation_version="1"/);
  const xml = fixture.boxXml('核对后的译文 < & >', true);
  const saved = await client.saveBox(fixture.translationUri, fixture.revision, 1, fixture.box, xml);
  assert.equal(saved.translation_version, 2);
  assert.match((await client.fetch(fixture.translationUri)).content, /核对后的译文 &lt; &amp; &gt;/);
  const requests = client.trace.map(record => record.request);
  assert.deepEqual(requests[0], { name: 'patchouli.add', arguments: { path: '/sample/education.pdf', kind: 'pdf', format: 'json' } });
  assert.deepEqual(requests[3], { name: 'patchouli.send', arguments: { endpoint: api.CONTROL, action: 'start', target: fixture.textUri, args: { pages: '1', target_language: 'zh-CN', force: false }, request_id: 'stable-request-id', format: 'json' } });
  assert.deepEqual(requests[7].arguments, { uri: fixture.translationUri, source_revision: fixture.revision, translation_version: 1, boxes: [{ box_id: fixture.box, content: xml }], format: 'json' });
  assert.ok(client.trace.every(record => record.state === 'success'));
});

test('errors with usable retained entries never count as success', () => {
  assert.throws(() => api.unwrap(fixture.envelope([{ committed: true }], 'UNAVAILABLE: offline')), /UNAVAILABLE/);
});
test('structured-content and native text JSON responses both work', () => {
  const result = fixture.envelope([]);
  const envelope = api.unwrap(result);
  assert.equal(envelope.meta.library_revision, 'lib:1');
  assert.deepEqual(api.unwrap({ structuredContent: envelope }), envelope);
});
test('malformed tool response is rejected', () => {
  assert.throws(() => api.unwrap({ content: [{ type: 'text', text: 'not JSON' }] }), /INVALID_RESPONSE/);
  assert.throws(() => api.unwrap({ structuredContent: { entries: [] } }), /INVALID_RESPONSE/);
});
test('partial import cannot advance to a ready document', async () => {
  const client = new api.Client(async () => fixture.envelope([{ text_uri: fixture.textUri, body_status: 'ingested', issues: [{ code: 'incomplete' }] }]));
  await assert.rejects(client.importPdf('/sample/x.pdf'), /导入含未完成项/);
});
test('truncated responses block page editing', async () => {
  const { client, mock } = newClient(); await client.importPdf('/sample/x.pdf'); mock.setFault('truncated');
  await assert.rejects(client.fetch(fixture.sourceUri), /RESPONSE_TRUNCATED/);
  assert.equal(client.trace.at(-1).state, 'error');
});
test('even a malformed success envelope cannot bypass completeness check', async () => {
  const client = new api.Client(async () => fixture.envelope([{ uri: fixture.sourceUri, complete: false, truncated: true, content: '<page/>' }]));
  await assert.rejects(client.fetch(fixture.sourceUri), /INCOMPLETE/);
});
test('fetch verifies the returned resource identity', async () => {
  const client = new api.Client(async () => fixture.envelope([{ uri: 'wrong', complete: true, truncated: false, content: 'x' }]));
  await assert.rejects(client.fetch(fixture.sourceUri), /NOT_FOUND/);
});
test('missing discovered start action prevents send', async () => {
  const client = new api.Client(async () => fixture.envelope([{ uri: api.CONTROL, complete: true, truncated: false, content: JSON.stringify({ endpoint: api.CONTROL, messages: [] }) }]));
  await assert.rejects(client.startTranslation(fixture.textUri, 'x'), /UNAVAILABLE/);
  assert.equal(client.trace.length, 1);
});
test('completed run containing failed or partial pages is not success', () => {
  assert.equal(api.completion({ state: 'completed', failed: 1, pages: [{ page_index: 1, state: 'failed' }] }), 'partial');
  assert.equal(api.completion({ state: 'completed', partial: 1, pages: [{ page_index: 1, state: 'partial' }] }), 'partial');
  assert.equal(api.completion({ state: 'completed', pages: [] }), 'partial');
  assert.equal(api.completion({ state: 'failed' }), 'failed');
  assert.equal(api.completion({ state: 'cancelled' }), 'cancelled');
});
test('canonical, one-based page URIs only', () => {
  assert.deepEqual(api.pageUris(fixture.textUri), { source: fixture.sourceUri, translation: fixture.translationUri });
  assert.throws(() => api.pageUris(fixture.textUri, 0), /INVALID_ARGUMENT/);
  assert.throws(() => api.pageUris(fixture.textUri + '?rev=x'), /INVALID_ARGUMENT/);
});
test('versioned read selectors cannot become write targets', async () => {
  const { client } = newClient();
  await assert.rejects(client.saveBox(fixture.translationUri + '?rev=' + fixture.revision, fixture.revision, 0, fixture.box, '<box/>'), /规范译文/);
  assert.equal(client.trace.length, 0);
});
test('conditional writes require source and translation version', async () => {
  const { client } = newClient();
  await assert.rejects(client.saveBox(fixture.translationUri, fixture.revision, undefined, fixture.box, '<box/>'), /缺少源修订/);
  await assert.rejects(client.saveBox(fixture.translationUri, 'not-a-revision', 0, fixture.box, '<box/>'), /缺少源修订/);
});
test('conflict stays an error and is never automatically retried', async () => {
  const { client, mock } = newClient(); await client.importPdf('/sample/x.pdf'); mock.setFault('conflict');
  await assert.rejects(client.saveBox(fixture.translationUri, fixture.revision, 0, fixture.box, fixture.boxXml('draft', true)), /REVISION_CONFLICT/);
  assert.equal(client.trace.filter(record => record.request.name === 'patchouli.put').length, 1);
  assert.equal(client.trace.at(-1).state, 'error');
});
test('uncommitted write receipt cannot report saved', async () => {
  const client = new api.Client(async () => fixture.envelope([{ uri: fixture.translationUri, committed: false }]));
  await assert.rejects(client.saveBox(fixture.translationUri, fixture.revision, 1, fixture.box, '<box/>'), /NOT_COMMITTED/);
});
test('network rejection is retained in trace', async () => {
  const client = new api.Client(async () => { throw new Error('offline'); });
  await assert.rejects(client.fetch(fixture.sourceUri), /offline/);
  assert.equal(client.trace[0].error, 'offline');
});
test('attention is FIFO five; duplicates do not change order', () => {
  const queue = new api.AttentionQueue();
  for (const key of ['a', 'b', 'c', 'd', 'e']) queue.add({ key, context: 'v1' });
  queue.add({ key: 'a', context: 'v1' }); queue.add({ key: 'f', context: 'v1' });
  assert.deepEqual(queue.items.map(item => item.key), ['b', 'c', 'd', 'e', 'f']);
});
test('old context tags do not silently target the new page version', () => {
  const queue = new api.AttentionQueue(); const tag = { key: 'save', context: 'v1' }; queue.add(tag);
  assert.equal(queue.valid(tag, 'v2'), false); queue.add({ key: 'save', context: 'v2' }); assert.equal(queue.items.length, 2);
});
test('ghost completion preserves incompatible drafts, selection and IME', () => {
  assert.equal(api.canComplete('', '开始翻译', 0, 0, false), true);
  assert.equal(api.canComplete('开始', '开始翻译', 2, 2, false), true);
  assert.equal(api.canComplete('我的草稿', '开始翻译', 4, 4, false), false);
  assert.equal(api.canComplete('开始', '开始翻译', 0, 2, false), false);
  assert.equal(api.canComplete('开始', '开始翻译', 1, 1, false), false);
  assert.equal(api.canComplete('开始', '开始翻译', 2, 2, true), false);
});
test('all scripts parse and static UI IDs resolve (not a browser test)', () => {
  for (const name of ['core.js', 'fixture.js', 'ui.js']) new vm.Script(fs.readFileSync(path.join(folder, name), 'utf8'), { filename: name });
  const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const ui = fs.readFileSync(path.join(folder, 'ui.js'), 'utf8');
  for (const match of ui.matchAll(/\$\('#([^']+)'\)/g)) assert.ok(ids.includes(match[1]), match[1]);
  assert.equal(/https?:\/\//.test(html), false);
});
