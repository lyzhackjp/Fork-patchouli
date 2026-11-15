/* Transport-independent adapter for Patchouli MCP v3. No host runtime or credentials. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PatchouliSample = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const CONTROL = 'patchouli://runs/translation/control';
  const UUID = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
  const documentPattern = new RegExp('^patchouli://texts/(' + UUID + ')/$');
  const translationPattern = new RegExp('^patchouli://translations/' + UUID + '/page-[1-9][0-9]*\\.xml$');
  const statusPattern = new RegExp('^patchouli://runs/translation/' + UUID + '/status$');
  function requireValue(test, message) { if (!test) throw new Error(message); }
  function unwrap(result) {
    let envelope = result?.structuredContent;
    if (!envelope) {
      const text = result?.content?.find(item => item.type === 'text')?.text;
      try { envelope = JSON.parse(text); } catch { throw new Error('INVALID_RESPONSE: 无法读取接口回执。'); }
    }
    requireValue(envelope?.meta && Array.isArray(envelope.entries), 'INVALID_RESPONSE: 回执格式不完整。');
    requireValue(!result.isError && envelope.meta.outcome === 'success' && !envelope.message?.error,
      envelope.message?.error || 'HOST_ERROR: 操作未成功。');
    return envelope;
  }
  class Client {
    constructor(callTool) { this.callTool = callTool; this.trace = []; }
    async call(name, args) {
      const request = { name, arguments: { ...args, format: 'json' } };
      const record = { request, at: new Date().toISOString(), state: 'pending' };
      this.trace.push(record);
      try {
        const result = await this.callTool(request);
        record.response = result;
        const envelope = unwrap(result);
        record.state = 'success';
        return envelope;
      } catch (error) { record.state = 'error'; record.error = error.message; throw error; }
    }
    async importPdf(path) {
      requireValue(typeof path === 'string' && path.startsWith('/') && path.toLowerCase().endsWith('.pdf'), '请选择宿主本地 PDF 路径。');
      const envelope = await this.call('patchouli.add', { path, kind: 'pdf' });
      const item = envelope.entries[0];
      requireValue(documentPattern.test(item?.text_uri || ''), '导入回执中没有可读取的文档地址。');
      requireValue(item.body_status === 'ingested' && !item.issues?.length, '导入含未完成项，请检查回执后重试。');
      return item;
    }
    async fetch(uri) {
      const envelope = await this.call('patchouli.fetch', { uris: [uri] });
      const entry = envelope.entries.find(item => item.uri === uri);
      requireValue(entry && !entry.error, entry?.error || 'NOT_FOUND: 未返回请求的资源。');
      requireValue(entry.complete === true && !entry.truncated && typeof entry.content === 'string', 'INCOMPLETE: 内容未完整返回，不能继续编辑。');
      return entry;
    }
    async discoverTranslation() {
      const entry = await this.fetch(CONTROL);
      const descriptor = JSON.parse(entry.content);
      requireValue(descriptor.endpoint === CONTROL && descriptor.messages?.some(message => message.action === 'start'), 'UNAVAILABLE: 当前连接未开放翻译。');
      return descriptor;
    }
    async startTranslation(documentUri, requestId) {
      requireValue(documentPattern.test(documentUri), 'INVALID_ARGUMENT: 文档地址无效。');
      await this.discoverTranslation();
      const envelope = await this.call('patchouli.send', {
        endpoint: CONTROL, action: 'start', target: documentUri,
        args: { pages: '1', target_language: 'zh-CN', force: false }, request_id: requestId
      });
      const receipt = envelope.entries[0]?.result;
      requireValue(statusPattern.test(receipt?.status_uri || ''), 'INVALID_RESPONSE: 缺少运行状态地址。');
      return receipt;
    }
    async status(uri) {
      requireValue(statusPattern.test(uri), 'INVALID_ARGUMENT: 运行地址无效。');
      const status = JSON.parse((await this.fetch(uri)).content);
      requireValue(['running', 'completed', 'failed', 'cancelled'].includes(status.state), 'INVALID_RESPONSE: 未知任务状态。');
      return status;
    }
    async saveBox(uri, revision, version, boxId, boxXml) {
      requireValue(translationPattern.test(uri), 'INVALID_ARGUMENT: 只能写入规范译文页面地址。');
      requireValue(new RegExp('^' + UUID + '$').test(revision) && Number.isInteger(version) && version >= 0,
        'INVALID_ARGUMENT: 缺少源修订或译文版本。');
      const envelope = await this.call('patchouli.put', { uri, source_revision: revision,
        translation_version: version, boxes: [{ box_id: boxId, content: boxXml }] });
      const entry = envelope.entries.find(item => item.uri === uri);
      requireValue(entry?.committed === true && !entry.box_errors?.length && !entry.translation_errors?.length,
        'NOT_COMMITTED: 修改尚未保存。');
      requireValue(Number.isInteger(entry.translation_version), 'INVALID_RESPONSE: 保存回执缺少版本。');
      return entry;
    }
  }
  function pageUris(documentUri, page = 1) {
    const match = documentPattern.exec(documentUri);
    requireValue(match && Number.isInteger(page) && page > 0, 'INVALID_ARGUMENT: 页面地址无效。');
    return { source: documentUri + 'page-' + page + '.xml', translation: 'patchouli://translations/' + match[1] + '/page-' + page + '.xml' };
  }
  function completion(status) {
    if (status.state === 'running') return 'running';
    if (status.state !== 'completed') return status.state;
    const page = status.pages?.find(item => item.page_index === 1);
    return page && ['committed', 'skipped'].includes(page.state) && !status.failed && !status.partial && !status.cancelled ? 'ready' : 'partial';
  }
  class AttentionQueue {
    constructor() { this.items = []; }
    add(tag) {
      if (!this.items.some(item => item.key === tag.key && item.context === tag.context)) {
        this.items.push({ ...tag });
        if (this.items.length > 5) this.items.shift();
      }
      return this.items;
    }
    valid(tag, context) { return tag.context === context; }
  }
  function canComplete(value, suggestion, start, end, composing) {
    return !composing && !!suggestion && start === end && end === value.length && suggestion.startsWith(value) && suggestion !== value;
  }
  return { Client, AttentionQueue, pageUris, completion, canComplete, unwrap, CONTROL };
});
