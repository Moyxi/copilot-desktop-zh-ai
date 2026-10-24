// GitHub Copilot 桌面端中文汉化注入器 v7 (WebView2 CDP)
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const DICT_PATH = path.join(__dirname, 'dictionary.json');
const AUTO_CACHE_DIR = process.env.COPILOT_ZH_CACHE_DIR || path.join(__dirname, 'cache');
const AUTO_TRANSLATIONS_PATH = path.join(AUTO_CACHE_DIR, 'auto-translations.jsonl');
const LOG_PATH = path.join(AUTO_CACHE_DIR, 'injector.log');
const UPSTREAM_REFRESH_MS = 6 * 60 * 60 * 1000;
let upstreamDictionary = null;
let lastUpstreamRefresh = 0;
let upstreamRefresh = null;
let autoTranslations = {};
const pendingTranslations = new Set();
let missingDeepLKeyWarningLogged = false;
let lastCDPWarningAt = 0;

fs.mkdirSync(AUTO_CACHE_DIR, { recursive: true });

for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...values) => {
    const line = new Date().toISOString() + ' [' + level.toUpperCase() + '] ' +
      values.map((value) => value instanceof Error ? (value.stack || value.message) : String(value)).join(' ');
    try {
      fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
    } catch (error) {
      process.stderr.write('[copilot-zh] 日志写入失败：' + error.message + '\n');
    }
    original(...values);
  };
}

function loadAutoTranslations() {
  try {
    return fs.readFileSync(AUTO_TRANSLATIONS_PATH, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((result, line) => Object.assign(result, JSON.parse(line)), {});
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[copilot-zh] 自动翻译缓存读取失败：' + error.message);
    }
    return {};
  }
}

autoTranslations = loadAutoTranslations();

function mergeDictionaries(local, upstream) {
  const merged = { ...(upstream || {}), ...local };
  merged.texts = { ...autoTranslations, ...((upstream && upstream.texts) || {}), ...(local.texts || {}) };
  for (const section of ['attrs', 'wholeElements']) {
    merged[section] = { ...((upstream && upstream[section]) || {}), ...(local[section] || {}) };
  }
  for (const section of ['textPatterns', 'attrPatterns']) {
    merged[section] = [...(local[section] || []), ...((upstream && upstream[section]) || [])];
  }
  return merged;
}

function refreshUpstreamDictionary() {
  if (upstreamRefresh) return upstreamRefresh;
  lastUpstreamRefresh = Date.now();
  upstreamRefresh = new Promise((resolve) => {
    execFile(
      'gh',
      ['api', 'repos/zhao818/copilot-desktop-zh/contents/dictionary.json', '--jq', '.content'],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          console.warn('[copilot-zh] 上游词典同步失败，将继续使用本地词典：' + (stderr.trim() || error.message));
          resolve(false);
          return;
        }
        try {
          const decoded = Buffer.from(stdout.trim(), 'base64').toString('utf8');
          const parsed = JSON.parse(decoded);
          if (!parsed || typeof parsed.texts !== 'object') throw new Error('上游词典结构无效');
          upstreamDictionary = parsed;
          lastUpstreamRefresh = Date.now();
          console.log('[copilot-zh] 已同步上游词典');
          resolve(true);
        } catch (parseError) {
          console.warn('[copilot-zh] 上游词典解析失败，将继续使用本地词典：' + parseError.message);
          resolve(false);
        }
      }
    );
  }).finally(() => {
    upstreamRefresh = null;
  });
  return upstreamRefresh;
}

function translateWithDeepL(texts, authKey) {
  return new Promise((resolve, reject) => {
    const form = new URLSearchParams();
    form.set('auth_key', authKey);
    form.set('source_lang', 'EN');
    form.set('target_lang', 'ZH');
    form.set('preserve_formatting', '1');
    for (const text of texts) form.append('text', text);
    const body = form.toString();
    const hostname = authKey.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    const request = https.request({
      hostname,
      path: '/v2/translate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 20000
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('DeepL 返回 HTTP ' + response.statusCode + ': ' + data.slice(0, 300)));
          return;
        }
        try {
          const result = JSON.parse(data);
          if (!Array.isArray(result.translations) || result.translations.length !== texts.length) {
            throw new Error('DeepL 返回的译文数量不匹配');
          }
          resolve(result.translations.map((item) => item.text));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('DeepL 请求超时')));
    request.on('error', reject);
    request.end(body);
  });
}

async function translateUnknownSettings(values) {
  const authKey = process.env.DEEPL_AUTH_KEY;
  if (!authKey) {
    if (values.length && !missingDeepLKeyWarningLogged) {
      console.warn('[copilot-zh] 设置页发现未收录英文选项；配置本机环境变量 DEEPL_AUTH_KEY 后可自动翻译。未发送任何文本。');
      missingDeepLKeyWarningLogged = true;
    }
    return;
  }
  const texts = [...new Set(values)]
    .map((text) => text.trim())
    .filter((text) => text.length >= 4 && text.length <= 400 && /[A-Za-z]{3}/.test(text) &&
      !/(?:https?:\/\/|www\.|[A-Za-z]:\\|\\\\)/i.test(text) &&
      !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(text) &&
      !pendingTranslations.has(text) && !Object.hasOwn(autoTranslations, text));
  if (!texts.length) return;
  texts.forEach((text) => pendingTranslations.add(text));
  try {
    for (let i = 0; i < texts.length; i += 30) {
      const batch = texts.slice(i, i + 30);
      const translations = await translateWithDeepL(batch, authKey);
      const additions = {};
      batch.forEach((source, index) => {
        const translated = translations[index]?.trim();
        if (translated && /[\u3400-\u9fff]/.test(translated)) additions[source] = translated;
      });
      if (Object.keys(additions).length) {
        fs.appendFileSync(AUTO_TRANSLATIONS_PATH, Object.entries(additions).map(([source, translated]) => JSON.stringify({ [source]: translated })).join('\n') + '\n', 'utf8');
        autoTranslations = { ...autoTranslations, ...additions };
        console.log('[copilot-zh] DeepL 已翻译并缓存 ' + Object.keys(additions).length + ' 条设置选项');
      }
    }
  } catch (error) {
    console.warn('[copilot-zh] DeepL 自动翻译失败：' + error.message);
  } finally {
    texts.forEach((text) => pendingTranslations.delete(text));
  }
}

function buildPayload() {
  const localDictionary = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
  const DICT = mergeDictionaries(localDictionary, upstreamDictionary);
  return "(() => {" +
    "const DICT = " + JSON.stringify(DICT) + ";" +
    "const textRes = (DICT.textPatterns || []).map(([p, r, f]) => [new RegExp(p, f), r]);" +
    "const attrRes = (DICT.attrPatterns || []).map(([p, r, f]) => [new RegExp(p, f), r]);" +
    "const wholeEls = DICT.wholeElements || {};" +
    "const SAMPLE_RE = /^(.+)\\. Creates a sample project\\.$/;" +
    "const CHAT_RE = /^Chat: (.+)$/" + ";" +
    "const apply = () => {" +
    "  try {" +
    "    let replaced = 0;" +
    "    const untranslatedSettings = new Set();" +
    "    const settingsTextNodes = new Set();" +
    "    const collectSettingsTextNodes = root => {" +
    "      root.querySelectorAll('[role=\"switch\"],input[type=\"checkbox\"]').forEach(control => {" +
    "        let row = control.parentElement;" +
    "        for (let depth = 0; row && depth < 6; depth++, row = row.parentElement) {" +
    "          const controls = row.querySelectorAll('[role=\"switch\"],input[type=\"checkbox\"]').length;" +
    "          const rowText = (row.innerText || '').trim();" +
    "          if (controls === 1 && rowText.length >= 12 && rowText.length <= 1200) {" +
    "            const rowWalker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);" +
    "            let rowNode;" +
    "            while (rowNode = rowWalker.nextNode()) {" +
    "              if (!rowNode.parentElement || !rowNode.parentElement.closest('pre, code, script, style, textarea, input, [contenteditable=\"true\"]')) settingsTextNodes.add(rowNode);" +
    "            }" +
    "            break;" +
    "          }" +
    "        }" +
    "      });" +
    "    };" +
    "    collectSettingsTextNodes(document);" +
    "    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);" +
    "    let n;" +
    "    while (n = walker.nextNode()) {" +
    "      const parent = n.parentElement;" +
    "      if (!parent || parent.closest('pre, code, script, style, textarea, [contenteditable=\"true\"]')) continue;" +
    "      const t = n.textContent.trim();" +
    "      if (!t || t.length > 400 || t.length < 2) continue;" +
    "      if (DICT.texts[t] !== undefined) {" +
    "        if (n.nodeValue.trim() !== DICT.texts[t]) { n.nodeValue = DICT.texts[t]; replaced++; }" +
    "        continue;" +
    "      }" +
    "      let patternMatched = false;" +
    "      let tcount = 0, s = parent.firstChild;" +
    "      while (s) { if (s.nodeType === 3 && s.textContent.trim()) tcount++; s = s.nextSibling; }" +
    "      for (let i = 0; i < textRes.length; i++) {" +
    "        textRes[i][0].lastIndex = 0;" +
    "        if (textRes[i][0].test(t)) {" +
    "          const v = t.replace(textRes[i][0], textRes[i][1]);" +
    "          if (n.nodeValue !== v) { n.nodeValue = v; replaced++; }" +
    "          patternMatched = true;" +
    "          break;" +
    "        }" +
    "      }" +
    "      if (!patternMatched && settingsTextNodes.has(n) && /[A-Za-z]{3}/.test(t) && !/^[A-Z0-9_./:-]+$/.test(t)) untranslatedSettings.add(t);" +
    "    }" +
    "    [...document.querySelectorAll('body *')].reverse().forEach(el => {" +
    "      if (el.closest('pre, code, script, style, textarea, [contenteditable=\"true\"]')) return;" +
    "      const full = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();" +
    "      if (!full || full.length > 500) return;" +
    "      let v = DICT.texts[full];" +
    "      if (v === undefined) {" +
    "        for (let i = 0; i < textRes.length; i++) {" +
    "          textRes[i][0].lastIndex = 0;" +
    "          if (textRes[i][0].test(full)) { v = full.replace(textRes[i][0], textRes[i][1]); break; }" +
    "        }" +
    "      }" +
    "      if (v !== undefined && (el.innerText || el.textContent).replace(/\\s+/g, ' ').trim() !== v) { el.textContent = v; replaced++; }" +
    "    });" +
    "    document.querySelectorAll('body *').forEach(el => {" +
    "      if (el.children.length > 0) return;" +
    "const tn = [...el.childNodes].filter(c => c.nodeType === 3 && c.textContent.trim());" +
    "const full = el.textContent.trim();" +
    "      if (wholeEls[full] !== undefined && el.textContent !== wholeEls[full]) { el.textContent = wholeEls[full]; replaced++; return; }" +
    "      const cm = CHAT_RE.exec(full);" +
    "      if (cm) { const title = DICT.texts[cm[1]] !== undefined ? DICT.texts[cm[1]] : cm[1]; const target = '聊天: ' + title; if (el.textContent !== target) { el.textContent = target; replaced++; } return; }" +
    "    });" +
    "    document.querySelectorAll('[placeholder],[data-placeholder],[aria-label],[title],[alt]').forEach(el => {" +
    "      ['placeholder','data-placeholder','aria-label','title','alt'].forEach(a => {" +
    "        const v = el.getAttribute(a);" +
    "        if (!v) return;" +
    "        if (DICT.attrs[v] !== undefined) { el.setAttribute(a, DICT.attrs[v]); return; }" +
    "        if (DICT.texts[v] !== undefined) { el.setAttribute(a, DICT.texts[v]); return; }" +
    "        const sm = SAMPLE_RE.exec(v);" +
    "        if (sm && DICT.texts[sm[1]] !== undefined) { el.setAttribute(a, DICT.texts[sm[1]] + '。创建示例项目。'); return; }" +
    "            for (let i = 0; i < attrRes.length; i++) { attrRes[i][0].lastIndex = 0; if (attrRes[i][0].test(v)) { attrRes[i][0].lastIndex = 0; el.setAttribute(a, v.replace(attrRes[i][0], attrRes[i][1])); break; } }" +
    "      });" +
    "    });" +
    "    document.querySelectorAll('[role=\"tooltip\"],[data-base-ui-tooltip-content],[data-base-ui-tooltip-popup]').forEach(el => {" +
    "      const full = el.textContent.trim();" +
    "      if (!full || full.length > 500) return;" +
    "      if (wholeEls[full] !== undefined) { el.textContent = wholeEls[full]; replaced++; return; }" +
    "      if (DICT.texts[full] !== undefined) { el.textContent = DICT.texts[full]; replaced++; return; }" +
    "          for (let i = 0; i < textRes.length; i++) { textRes[i][0].lastIndex = 0; if (textRes[i][0].test(full)) { textRes[i][0].lastIndex = 0; el.textContent = full.replace(textRes[i][0], textRes[i][1]); replaced++; break; } }" +
    "    });" +
    "    const shadowRoots = [];" +
    "    const collectShadowRoots = root => {" +
    "      root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) { shadowRoots.push(el.shadowRoot); collectShadowRoots(el.shadowRoot); } });" +
    "    };" +
    "    collectShadowRoots(document);" +
    "    shadowRoots.forEach(root => {" +
    "      collectSettingsTextNodes(root);" +
    "      const sw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);" +
    "      let sn;" +
    "      while (sn = sw.nextNode()) {" +
    "        const st = sn.textContent.trim();" +
    "        if (!st || st.length > 500) continue;" +
    "        let sv = DICT.texts[st];" +
    "        if (sv === undefined) { for (let i = 0; i < textRes.length; i++) { textRes[i][0].lastIndex = 0; if (textRes[i][0].test(st)) { textRes[i][0].lastIndex = 0; sv = st.replace(textRes[i][0], textRes[i][1]); break; } } }" +
    "        if (sv !== undefined && sn.nodeValue !== sv) { sn.nodeValue = sv; replaced++; }" +
    "        if (sv === undefined && settingsTextNodes.has(sn) && /[A-Za-z]{3}/.test(st) && !/^[A-Z0-9_./:-]+$/.test(st)) untranslatedSettings.add(st);" +
    "      }" +
    "      root.querySelectorAll('[placeholder],[data-placeholder],[aria-label],[title],[alt]').forEach(el => {" +
    "        ['placeholder','data-placeholder','aria-label','title','alt'].forEach(a => { const av = el.getAttribute(a); if (!av) return; if (DICT.attrs[av] !== undefined) { el.setAttribute(a, DICT.attrs[av]); return; } if (DICT.texts[av] !== undefined) { el.setAttribute(a, DICT.texts[av]); return; } for (let i = 0; i < attrRes.length; i++) { attrRes[i][0].lastIndex = 0; if (attrRes[i][0].test(av)) { attrRes[i][0].lastIndex = 0; el.setAttribute(a, av.replace(attrRes[i][0], attrRes[i][1])); break; } } });" +
    "      });" +
    "    });" +
    "    if (document.title === 'GitHub Copilot') document.title = 'GitHub Copilot 中文版';" +
    "    return { replaced, untranslatedSettings: [...untranslatedSettings].slice(0, 100) };" +
    "  } catch (e) { return 'ERR:' + e.message; }" +
    "};" +
    "const res = apply();" +
    "if (window.__copilotZhObs) { try { window.__copilotZhObs.disconnect(); } catch (e) {} }" +
    "if (window.__copilotZhTimer) { clearInterval(window.__copilotZhTimer); }" +
    "const mo = new MutationObserver(() => { clearTimeout(window.__copilotZhDbt); window.__copilotZhDbt = setTimeout(apply, 200); });" +
    "    mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label','placeholder','data-placeholder','title','alt'] });" +
    "window.__copilotZhObs = mo;" +
    "window.__copilotZhTimer = setInterval(apply, 1200);" +
    "window.__copilotZhInstalled = true;" +
    "return res;" +
    "})()";
}

function getTargets() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve([]);
          return;
        }
        try {
          const targets = JSON.parse(data);
          if (!Array.isArray(targets)) throw new Error('CDP 返回的目标列表格式无效');
          if (!targets.some((target) => target.type === 'page') && Date.now() - lastCDPWarningAt > 10000) {
            console.warn('[copilot-zh] CDP 端口已连接，但没有可注入的页面目标。');
            lastCDPWarningAt = Date.now();
          }
          resolve(targets);
        } catch (error) {
          console.warn('[copilot-zh] 无法解析 CDP 目标列表：' + error.message);
          resolve([]);
        }
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error('CDP 连接超时')));
    request.on('error', (error) => {
      if (Date.now() - lastCDPWarningAt > 10000) {
        console.warn('[copilot-zh] 无法连接 CDP 端口 9222：' + (error.code || error.message));
        lastCDPWarningAt = Date.now();
      }
      resolve([]);
    });
  });
}

function injectOnce(wsUrl, payload) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { resolve('wserr'); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} resolve('timeout'); }, 8000);
    ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: payload, returnByValue: true } })); };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.id === 1) {
          const v = m.result && m.result.result && m.result.result.value;
          clearTimeout(timer); ws.close();
          resolve(v || 'no-return');
        }
      } catch (err) { }
    };
    ws.onerror = () => { clearTimeout(timer); try { ws.close(); } catch (e) {} resolve('wserror'); };
    ws.onclose = () => { clearTimeout(timer); resolve('wsclosed'); };
  });
}

async function loop() {
  let lastLog = 0;
  while (true) {
    if (Date.now() - lastUpstreamRefresh >= UPSTREAM_REFRESH_MS) {
      refreshUpstreamDictionary();
    }
    const payload = buildPayload();
    const targets = await getTargets();
    const page = targets.find(t => t.type === 'page');
    if (page && page.webSocketDebuggerUrl) {
      const r = await injectOnce(page.webSocketDebuggerUrl, payload);
      if (r && typeof r === 'object') {
        if (Array.isArray(r.untranslatedSettings) && r.untranslatedSettings.length) {
          translateUnknownSettings(r.untranslatedSettings);
        }
      }
      const now = Date.now();
      if (now - lastLog > 10000) {
        const result = r && typeof r === 'object' ? 'replaced:' + r.replaced : r;
        console.log('[copilot-zh] ' + new Date().toLocaleTimeString() + ' apply: ' + result);
        lastLog = now;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}
console.log('[copilot-zh] 汉化注入器 v7 已启动');
loop().catch(e => { console.error(e); process.exit(1); });