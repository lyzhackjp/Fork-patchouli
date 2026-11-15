/* Synthetic responses only. This is a contract fixture, not a translation engine. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PatchouliFixture = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const doc = '11111111-1111-4111-8111-111111111111';
  const revision = '22222222-2222-4222-8222-222222222222';
  const box = '33333333-3333-4333-8333-333333333333';
  const run = '44444444-4444-4444-8444-444444444444';
  const textUri = 'patchouli://texts/' + doc + '/';
  const sourceUri = textUri + 'page-1.xml';
  const translationUri = 'patchouli://translations/' + doc + '/page-1.xml';
  const statusUri = 'patchouli://runs/translation/' + run + '/status';
  const control = 'patchouli://runs/translation/control';
  const source = '教育は知識を伝えるだけではない。人が社会の一員として、自ら考え、行動するための基礎をつくる。';
  const translated = '教育不仅传授知识，也为人作为社会的一员独立思考、采取行动奠定基础。';
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const boxXml = (text, isTranslated) => '<box id="' + box + '" type="text" sub_type="" heading_level="" code_language="" suppressed="false" readonly="false" translated="' + isTranslated + '"><payload format="markdown">' + escape(text) + '</payload></box>';
  function envelope(entries, error, meta = {}) {
    if (error) {
      const codes = { UNAVAILABLE: 8, NOT_FOUND: 3, INVALID_ARGUMENT: 2, REVISION_CONFLICT: 5, RESPONSE_TRUNCATED: 7 };
      error = error.replace(/^([A-Z_]+):/, (full, name) => name + ' [code ' + codes[name] + ']:');
    }
    const body = { meta: { library_revision: 'lib:1', outcome: error ? 'error' : 'success', summary: error || 'Fixture response', ...meta }, continuation: null, entries };
    if (error) body.message = { error, warnings: [] };
    return { isError: !!error, content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
  function create() {
    let imported = false, started = false, polls = 0, version = 0, savedBox = '', fault = null, libraryRevision = 1;
    const reply = (entries, error, meta = {}) => envelope(entries, error, { library_revision: 'lib:' + libraryRevision, ...meta });
    const utf8Bytes = text => new TextEncoder().encode(text).length;
    const page = translatedPage => '<page profile="patchouli-page-2" document_id="' + doc + '" page_index="1" source_revision="' + revision + '" translation_version="' + (translatedPage ? version : 0) + '" complete="true">' + (translatedPage && version ? savedBox || boxXml(translated, true) : boxXml(source, false)) + '</page>';
    const resource = (uri, content) => ({ uri, resource_type: uri === sourceUri ? 'text_page' : uri === translationUri ? 'translation_page' : uri === statusUri ? 'run_status' : 'endpoint', item_uri: null, content, complete: true, truncated: false, returned_bytes: utf8Bytes(content), limit_bytes: 100000, continuation: null, next_range: null, error: null });
    return {
      setFault(next) { fault = next; },
      async callTool({ name, arguments: args }) {
        if (fault === 'unavailable') { fault = null; return reply([], 'UNAVAILABLE: 演示连接暂不可用。'); }
        if (name === 'patchouli.add') {
          const reused = imported;
          if (!imported) libraryRevision += 1;
          imported = true;
          return reply([{ kind: 'pdf', reused, moved: false, text_uri: textUri, page_count: 1, body_status: 'ingested', issues: [] }]);
        }
        if (name === 'patchouli.fetch') {
          const uri = args.uris[0];
          if (uri === control) return reply([resource(uri, JSON.stringify({ endpoint: control, domain: 'translation', messages: [{ action: 'start' }, { action: 'cancel' }], implementations: [] }))]);
          if (uri === statusUri && started) {
            polls += 1;
            const done = polls >= 2;
            if (done && version === 0) { version = 1; libraryRevision += 1; }
            return reply([resource(uri, JSON.stringify({ task_id: run, document_id: doc, state: done ? 'completed' : 'running', total: 1, completed: done ? 1 : 0, succeeded: done ? 1 : 0, partial: 0, failed: 0, skipped: 0, cancelled: 0, pages: done ? [{ page_index: 1, state: 'committed', committed_box_count: 1 }] : [] }))]);
          }
          if (imported && [sourceUri, translationUri].includes(uri)) {
            const entry = resource(uri, page(uri === translationUri));
            if (fault === 'truncated') { fault = null; entry.truncated = true; entry.complete = false; entry.error = 'RESPONSE_TRUNCATED [code 7]: 演示内容不完整。'; return reply([entry], 'RESPONSE_TRUNCATED: 演示内容不完整。'); }
            return reply([entry]);
          }
          return reply([], 'NOT_FOUND: 未找到演示资源。');
        }
        if (name === 'patchouli.send' && args.endpoint === control && args.action === 'start' && imported) {
          started = true; polls = 0;
          return reply([{ state: 'started', result: { task_id: run, status_uri: statusUri, state: 'running', total_pages: 1, reused: false }, run_uri: statusUri.replace('/status', '/') }], null, { endpoint: control, action: 'start', state: 'started' });
        }
        if (name === 'patchouli.put' && args.uri === translationUri) {
          if (fault === 'conflict') { fault = null; version += 1; libraryRevision += 1; return reply([], 'REVISION_CONFLICT: 译文版本已变化，请重新读取后核对。'); }
          if (args.source_revision !== revision || args.translation_version !== version) return reply([], 'REVISION_CONFLICT: 源修订或译文版本不同。');
          if (args.boxes?.length !== 1 || args.boxes[0].box_id !== box || !args.boxes[0].content.includes('<payload')) return reply([], 'INVALID_ARGUMENT: 需要完整 box XML。');
          savedBox = args.boxes[0].content; version += 1; libraryRevision += 1;
          return reply([{ uri: args.uri, resource_type: 'translation_page', committed: true, content_bytes: utf8Bytes(savedBox), source_revision: revision, translation_version: version, modified_box_ids: [box] }]);
        }
        return reply([], 'INVALID_ARGUMENT: 该演示未实现此请求。');
      }
    };
  }
  return { create, envelope, doc, revision, box, textUri, sourceUri, translationUri, statusUri, boxXml };
});
