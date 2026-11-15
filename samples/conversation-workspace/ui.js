(function () {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const api = window.PatchouliSample;
  const fixture = window.PatchouliFixture.create();
  const client = new api.Client(fixture.callTool);
  const attention = new api.AttentionQueue();
  const state = { item: null, page: null, dirty: false, blocked: false, busy: false, composing: false,
    suggestion: '导入示例文献', statusUri: null, focus: '开始工作', locked: false, context: 'welcome' };
  const suggestions = {
    import: ['导入文献', '导入示例文献'], source: ['阅读原文', '查看原文'],
    translate: ['翻译当前页', '开始翻译'], edit: ['保存修改', '保存修改'], reload: ['重新读取', '重新读取译文']
  };
  function say(text, user = false) {
    const node = document.createElement('div'); node.className = 'message' + (user ? ' user' : '');
    if (!user) { const label = document.createElement('small'); label.textContent = '工作助手 · 演示'; node.append(label); }
    node.append(document.createTextNode(text)); $('#messages').append(node); $('#messages').scrollTop = $('#messages').scrollHeight;
  }
  function ghost() {
    const input = $('#input'); $('#ghost').replaceChildren();
    if (!api.canComplete(input.value, state.suggestion, input.selectionStart, input.selectionEnd, state.composing)) return;
    const prefix = document.createElement('span'); prefix.className = 'prefix'; prefix.textContent = input.value;
    $('#ghost').append(prefix, document.createTextNode(state.suggestion.slice(input.value.length)));
  }
  function suggest(text) { state.suggestion = text; ghost(); }
  function setFocus(focus) {
    if (!state.locked) state.focus = focus;
    $('#focus').textContent = state.focus + (state.locked ? ' · 已锁定' : '');
  }
  function updateContext() { state.context = state.item ? state.item.text_uri + 'page-1:' + (state.page ? state.page.revision + ':' + state.page.version : 'source') : 'welcome'; renderTags(); }
  function remember(key) {
    if (!suggestions[key]) return;
    const [label, prompt] = suggestions[key]; attention.add({ key, label, prompt, context: state.context }); renderTags();
  }
  function renderTags() {
    $('#tags').replaceChildren();
    for (const tag of attention.items) {
      const valid = attention.valid(tag, state.context); const button = document.createElement('button');
      button.className = 'tag' + (valid ? '' : ' stale'); button.textContent = tag.label + (valid ? '' : ' · 旧上下文');
      button.title = valid ? tag.prompt : '此标签属于之前的页面版本';
      button.onclick = () => { if (!valid) { say('这个标签属于之前的页面版本。请重新关注右侧内容。'); return; } suggest(tag.prompt); $('#input').focus(); ghost(); };
      $('#tags').append(button);
    }
  }
  function showTrace() { $('#trace').textContent = client.trace.length ? JSON.stringify(client.trace, null, 2) : '尚无请求'; }
  function parsePage(entry) {
    const xml = new DOMParser().parseFromString(entry.content, 'application/xml'); const root = xml.documentElement;
    if (xml.querySelector('parsererror') || root.nodeName !== 'page' || root.getAttribute('complete') !== 'true' || root.getAttribute('profile') !== 'patchouli-page-2') throw new Error('INVALID_XML: 页面结构不受支持。');
    const revision = root.getAttribute('source_revision'), version = Number(root.getAttribute('translation_version'));
    const expectedDoc = state.item?.text_uri.split('/')[3];
    if (root.getAttribute('document_id') !== expectedDoc || root.getAttribute('page_index') !== '1') throw new Error('INVALID_XML: 页面身份与当前文献不一致。');
    if (!revision || !root.hasAttribute('translation_version') || !Number.isInteger(version) || version < 0) throw new Error('INVALID_XML: 缺少页面版本。');
    const leaves = [...root.querySelectorAll('box')].filter(box => !box.querySelector('box') && box.querySelector('payload'));
    // The first slice intentionally supports one plain payload leaf. Keep complex XML read-only.
    if (leaves.length !== 1 || leaves[0].getAttribute('type') !== 'text' || leaves[0].querySelector('payload').getAttribute('format') !== 'markdown' || leaves[0].querySelector('payload').children.length || leaves[0].getAttribute('suppressed') === 'true' || leaves[0].getAttribute('readonly') === 'true') throw new Error('UNSUPPORTED: 此样本仅支持单个可编辑正文框，请在原工作台处理复杂页面。');
    return { xml, box: leaves[0], revision, version, text: leaves[0].querySelector('payload').textContent };
  }
  async function importDocument() {
    if (state.item && $('#welcome').hidden) { say('示例文献已经打开，可以继续翻译与核对。'); return; }
    if (!state.item) state.item = await client.importPdf('/sample/education.pdf');
    await readSource();
    $('#welcome').hidden = true; $('#reading').hidden = false; $('#object').textContent = '教育与社会 · 第 1 页';
    $('#work-title').textContent = '教育与社会'; $('#page-label').textContent = '1 / 1';
    $('#status').textContent = '文献已就绪'; setFocus('阅读原文'); updateContext(); suggest('开始翻译');
    say('示例文献已导入。原文在右侧，可以接着说“开始翻译”。');
  }
  async function readSource() {
    if (!state.item) throw new Error('请先导入示例文献。');
    const page = parsePage(await client.fetch(api.pageUris(state.item.text_uri).source));
    $('#original-text').textContent = page.text;
    $('#revision').textContent = '原文修订 ' + page.revision.slice(0, 8);
  }
  async function readTranslation(preserve = false) {
    const page = parsePage(await client.fetch(api.pageUris(state.item.text_uri).translation));
    if (page.box.getAttribute('translated') !== 'true') throw new Error('当前页面还没有已提交的译文。');
    const draft = $('#translation-editor').value;
    state.page = page; state.blocked = false;
    $('#translation-empty').hidden = true; $('#translation-editor').hidden = false;
    $('#translation-editor').value = preserve ? draft : page.text;
    state.dirty = preserve && draft !== page.text;
    $('#translation-action').textContent = '保存'; $('#translation-action').dataset.prompt = '保存修改';
    $('#translation-pane').dataset.attention = 'edit'; updateContext(); editState();
    if (preserve) say('已读取最新版，保留了你的修改。请核对后再保存。\n当前已保存译文：' + page.text);
  }
  function editState() {
    if (!state.page) return;
    $('#translation-label').textContent = state.dirty ? '译文 · 人工修改中' : '译文 · 已保存';
    $('#edit-state').textContent = state.blocked ? '版本冲突 · 草稿保留，请重新读取译文' : state.dirty ? '修改尚未保存' : '译文版本 ' + state.page.version + ' · 可继续核对';
    $('#revision').textContent = '原文 ' + state.page.revision.slice(0, 8) + ' · 译文 v' + state.page.version;
  }
  async function checkTranslation() {
    if (!state.statusUri) throw new Error('当前没有翻译任务。');
    const status = await client.status(state.statusUri), result = api.completion(status);
    if (result === 'running') { $('#status').textContent = '正在翻译'; suggest('检查翻译进度'); return false; }
    if (result !== 'ready') throw new Error('翻译结果为 ' + result + '。请检查接口回执；不会把部分结果标为完成。');
    await readTranslation(); $('#status').textContent = '待核对'; setFocus('翻译核对'); suggest('保存修改');
    say('译文已经返回。你可以直接修改右侧文字，也可以说“把「独立思考」改为「自主思考」”。');
    return true;
  }
  async function translate() {
    if (!state.item) throw new Error('请先导入示例文献。');
    if (state.page || state.statusUri) { say('已有翻译任务或译文，请继续核对，或检查翻译进度。'); return; }
    const receipt = await client.startTranslation(state.item.text_uri, 'sample-' + Date.now());
    state.statusUri = receipt.status_uri; $('#status').textContent = '正在翻译'; setFocus('翻译');
    say('翻译任务已受理，正在等待页面结果。');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await checkTranslation()) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    say('任务仍在运行。稍后说“检查翻译进度”即可继续查看。');
  }
  async function save() {
    if (!state.page) throw new Error('还没有可保存的译文。');
    if (state.blocked) throw new Error('请先重新读取译文并核对；你的修改仍保留在右侧。');
    if (!state.dirty) { say('当前没有未保存的修改。'); return; }
    const box = state.page.box.cloneNode(true); box.setAttribute('translated', 'true');
    box.querySelector('payload').textContent = $('#translation-editor').value;
    try {
      const receipt = await client.saveBox(api.pageUris(state.item.text_uri).translation, state.page.revision, state.page.version,
        box.getAttribute('id'), new XMLSerializer().serializeToString(box));
      state.page.box = box; state.page.version = receipt.translation_version; state.page.text = $('#translation-editor').value;
      state.dirty = false; updateContext(); editState(); $('#status').textContent = '修改已保存';
      say('修改已保存为译文版本 ' + receipt.translation_version + '。原文保持独立。');
    } catch (error) { if (error.message.includes('REVISION_CONFLICT')) { state.blocked = true; editState(); suggest('重新读取译文'); } throw error; }
  }
  async function command(text) {
    if (state.busy || !text.trim()) return;
    say(text, true); state.busy = true; $('#send').disabled = true; $('#translation-editor').readOnly = true;
    try {
      if (/^导入示例文献[。！!]?$/u.test(text)) await importDocument();
      else if (/^(开始翻译|翻译当前页)[。！!]?$/u.test(text)) await translate();
      else if (/^检查翻译进度[。！!]?$/u.test(text)) await checkTranslation();
      else if (/^查看原文[。！!]?$/u.test(text)) { await readSource(); setFocus('阅读原文'); say('原文已重新读取，译文草稿保持在右侧。'); }
      else if (/^重新读取译文[。！!]?$/u.test(text)) { if (!state.page) throw new Error('请先完成翻译。'); await readTranslation(state.dirty); }
      else if (/^保存修改[。！!]?$/u.test(text)) await save();
      else {
        const replacement = /^把「(.+?)」改为「(.*?)」[。！!]?$/u.exec(text);
        if (replacement && state.page) {
          const editor = $('#translation-editor');
          if (!editor.value.includes(replacement[1])) throw new Error('当前译文中没有找到「' + replacement[1] + '」。');
          editor.value = editor.value.split(replacement[1]).join(replacement[2]); state.dirty = true; editState(); suggest('保存修改');
          say('已修改右侧草稿，请核对后说“保存修改”。');
        } else say('这一版支持：导入示例文献、查看原文、开始翻译、检查翻译进度、保存修改、重新读取译文。自由对话 Agent 尚未接入。');
      }
    } catch (error) { $('#status').textContent = '需要处理'; say(error.message); }
    finally { state.busy = false; $('#send').disabled = false; $('#translation-editor').readOnly = false; showTrace(); }
  }
  $('#form').onsubmit = event => { event.preventDefault(); if (state.busy) return; const text = $('#input').value.trim(); if (!text) return; $('#input').value = ''; ghost(); void command(text); };
  $('#input').addEventListener('input', ghost);
  $('#input').addEventListener('click', ghost);
  $('#input').addEventListener('keyup', ghost);
  $('#input').addEventListener('compositionstart', () => { state.composing = true; ghost(); });
  $('#input').addEventListener('compositionend', () => { state.composing = false; ghost(); });
  $('#input').addEventListener('keydown', event => {
    if (event.isComposing || state.composing) return;
    if (event.key === 'Escape') { suggest(''); return; }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && api.canComplete($('#input').value, state.suggestion, $('#input').selectionStart, $('#input').selectionEnd, false)) {
      event.preventDefault(); $('#input').value = state.suggestion; ghost();
    } else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#form').requestSubmit(); }
  });
  document.querySelectorAll('[data-attention]').forEach(region => {
    let timer;
    region.addEventListener('mouseenter', () => { timer = setTimeout(() => remember(region.dataset.attention), 400); });
    region.addEventListener('mouseleave', () => clearTimeout(timer));
    region.addEventListener('focusin', () => remember(region.dataset.attention));
    region.addEventListener('click', event => {
      if (event.target.closest('textarea,button')) return;
      remember(region.dataset.attention); suggest(suggestions[region.dataset.attention][1]);
    });
    region.addEventListener('keydown', event => {
      if (event.target !== region) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); suggest(suggestions[region.dataset.attention][1]); }
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && api.canComplete($('#input').value, state.suggestion, $('#input').selectionStart, $('#input').selectionEnd, state.composing)) {
        event.preventDefault(); $('#input').value = state.suggestion; $('#input').focus(); ghost();
      }
    });
  });
  document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { suggest(button.dataset.prompt); $('#input').focus(); ghost(); });
  $('#translation-editor').addEventListener('input', () => { state.dirty = $('#translation-editor').value !== state.page?.text; editState(); suggest('保存修改'); });
  $('#translation-editor').addEventListener('focus', () => remember('edit'));
  $('#focus').onclick = () => { const open = $('#focus-menu').hidden; $('#focus-menu').hidden = !open; $('#focus').setAttribute('aria-expanded', String(open)); };
  $('.focus-area').addEventListener('mouseenter', () => { $('#focus-menu').hidden = false; $('#focus').setAttribute('aria-expanded', 'true'); });
  $('.focus-area').addEventListener('mouseleave', () => { if (!$('.focus-area').contains(document.activeElement)) { $('#focus-menu').hidden = true; $('#focus').setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('click', event => { if (!event.target.closest('.focus-area')) { $('#focus-menu').hidden = true; $('#focus').setAttribute('aria-expanded', 'false'); } });
  $('#lock').onclick = () => { state.locked = !state.locked; $('#lock').textContent = state.locked ? '解除注意力锁定' : '锁定当前注意力'; setFocus(state.focus); };
  $('#inspect').onclick = () => { showTrace(); $('#inspector').showModal(); };
  $('#close-inspector').onclick = () => $('#inspector').close();
  document.querySelectorAll('[data-fault]').forEach(button => button.onclick = () => { fixture.setFault(button.dataset.fault); $('#inspector').close(); say('已设置一次错误演练。'); });
  window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  say('从一份文献开始。\n\n按 Tab 接受“导入示例文献”，再按 Enter。你也可以先看看右侧的工作区。');
  ghost();
})();
