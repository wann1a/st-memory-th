// Memory TH - ส่วนขยายสรุปความจำสำหรับ SillyTavern
(() => {
  'use strict';

  const MODULE = 'memory_th';

  const DEFAULT_PROMPT =
    'สรุปเหตุการณ์ในข้อความต่อไปนี้เป็นภาษาไทย กระชับ เรียงตามลำดับเวลา ' +
    'เก็บวันที่ เวลา สถานที่ ชื่อตัวละคร การตัดสินใจ ความสัมพันธ์ที่เปลี่ยนไป ' +
    'และข้อมูลสำคัญที่ต้องจำ ห้ามแต่งเพิ่ม ห้ามใส่ความเห็น ตอบเฉพาะเนื้อหาสรุป ไม่ต้องมีคำนำ';

  const MERGE_PROMPT =
    'รวมเรื่องย่อเดิมกับความจำที่ให้มาเป็นเรื่องย่อเดียว เป็นภาษาไทย กระชับ เรียงตามลำดับเวลา ' +
    'เก็บเฉพาะข้อมูลสำคัญที่ต้องใช้ต่อเนื่อง ห้ามแต่งเพิ่ม ตอบเฉพาะเนื้อหาสรุป';

  const defaults = {
    enabled: true,
    mode: 'auto',       // auto | manual
    interval: 25,
    keepRecent: 4,
    skipSummarized: true,
    maxChunks: 8,
    prompt: DEFAULT_PROMPT,
    pendingCarry: null,
  };

  let busy = false;
  let statusLine = { text: '', kind: '' };

  const C = () => SillyTavern.getContext();

  function settings() {
    const c = C();
    if (!c.extensionSettings[MODULE]) c.extensionSettings[MODULE] = {};
    const s = c.extensionSettings[MODULE];
    for (const [k, v] of Object.entries(defaults)) {
      if (s[k] === undefined) s[k] = v;
    }
    return s;
  }

  function data() {
    const md = C().chatMetadata;
    if (!md[MODULE]) md[MODULE] = { rollup: '', memories: [], last: -1, lastSent: null };
    return md[MODULE];
  }

  function saveSettings() {
    C().saveSettingsDebounced();
  }

  async function countTokens(text) {
    if (!text) return 0;
    try {
      return await C().getTokenCountAsync(text);
    } catch {
      return Math.ceil(text.length / 3);
    }
  }

  // ---------- สร้างข้อความที่ฉีดเข้า prompt ----------
  function buildInjection() {
    const d = data();
    const parts = [];
    if (d.rollup) parts.push(`[เรื่องย่อที่ผ่านมา]\n${d.rollup}`);
    if (d.memories.length) {
      parts.push('[ความจำล่าสุด]\n' + d.memories.map((m, i) => `(${i + 1}) ${m.text}`).join('\n'));
    }
    if (!parts.length) return '';
    return '[สรุปเนื้อเรื่องก่อนหน้า ใช้เป็นข้อมูลอ้างอิงเพื่อความต่อเนื่อง]\n' + parts.join('\n\n');
  }

  async function refreshInjection() {
    const c = C();
    const s = settings();
    const d = data();
    const text = s.enabled ? buildInjection() : '';
    const T = c.extension_prompt_types || { IN_PROMPT: 0 };
    c.setExtensionPrompt(MODULE, text, T.IN_PROMPT ?? 0, 0, false);
    const tokens = await countTokens(text);
    d.lastSent = { rollup: d.rollup ? 1 : 0, chunks: d.memories.length, tokens, text };
    updateUI();
  }

  // ---------- เรียกโมเดลสรุป ----------
  async function generate(prompt) {
    const c = C();
    const sys = 'คุณเป็นผู้ช่วยสรุปเนื้อเรื่องนิยายโรลเพลย์ ตอบเป็นภาษาไทยเท่านั้น';
    let r;
    try {
      r = await c.generateRaw({ prompt, systemPrompt: sys });
    } catch (e) {
      // รองรับ ST เวอร์ชันเก่าที่ใช้พารามิเตอร์แบบเรียงตำแหน่ง
      r = await c.generateRaw(prompt, null, false, false, sys);
    }
    return typeof r === 'string' ? r.trim() : '';
  }

  const eligible = (m) => m && m.mes && (!m.is_system || (m.extra && m.extra.mth_hidden));

  function hideRange(from, to) {
    const c = C();
    for (let i = from; i <= to; i++) {
      const m = c.chat[i];
      if (m && !m.is_system) {
        m.is_system = true;
        m.extra = m.extra || {};
        m.extra.mth_hidden = true;
        $(`#chat .mes[mesid="${i}"]`).attr('is_system', 'true');
      }
    }
    c.saveChat();
  }

  async function consolidate() {
    const s = settings();
    const d = data();
    if (d.memories.length <= s.maxChunks) return;
    const n = Math.max(1, Math.floor(d.memories.length / 2));
    const old = d.memories.slice(0, n);
    const prompt =
      `${MERGE_PROMPT}\n\n[เรื่องย่อเดิม]\n${d.rollup || '(ไม่มี)'}\n\n[ความจำที่ต้องรวม]\n` +
      old.map((m, i) => `(${i + 1}) ${m.text}`).join('\n') +
      '\n\n[เรื่องย่อรวม]';
    const out = await generate(prompt);
    if (out) {
      d.rollup = out;
      d.memories.splice(0, n);
    }
  }

  async function summarizeRange(from, to) {
    if (busy) return;
    const c = C();
    const s = settings();
    const d = data();
    from = Math.max(0, from);
    to = Math.min(c.chat.length - 1, to);

    const lines = [];
    for (let i = from; i <= to; i++) {
      const m = c.chat[i];
      if (eligible(m)) lines.push(`${m.name}: ${m.mes}`);
    }
    if (!lines.length) {
      toastr.info('ไม่มีข้อความให้สรุปในช่วงนี้');
      return;
    }

    busy = true;
    setStatusLine('กำลังสรุป...', 'busy');
    try {
      const prev = buildInjection();
      const prompt =
        `${s.prompt}` +
        (prev ? `\n\n[ความจำก่อนหน้า (อ้างอิงเท่านั้น ห้ามสรุปซ้ำ)]\n${prev}` : '') +
        `\n\n[ข้อความที่ต้องสรุป]\n${lines.join('\n\n')}\n\n[สรุป]`;
      const out = await generate(prompt);
      if (!out) throw new Error('ได้ผลสรุปว่างเปล่า');

      d.memories.push({ id: Date.now(), from, to, text: out, time: new Date().toISOString() });
      d.last = Math.max(d.last, to);
      if (s.skipSummarized) hideRange(from, to);
      await consolidate();
      await c.saveMetadata();
      setStatusLine('✓ สรุปล่าสุดด้วย API หลัก', 'ok');
    } catch (e) {
      console.error('[memory-th]', e);
      setStatusLine('✗ สรุปไม่สำเร็จ: ' + (e.message || e), 'err');
      toastr.error('สรุปไม่สำเร็จ: ' + (e.message || e));
    } finally {
      busy = false;
      await refreshInjection();
    }
  }

  async function summarizeNow() {
    const c = C();
    const s = settings();
    const d = data();
    const from = d.last + 1;
    const to = c.chat.length - 1 - s.keepRecent;
    if (to < from) {
      toastr.info(`ยังไม่มีข้อความให้สรุป (เก็บข้อความล่าสุดไว้ ${s.keepRecent} ข้อความ)`);
      return;
    }
    await summarizeRange(from, to);
  }

  async function onMessage() {
    const s = settings();
    if (!s.enabled || s.mode !== 'auto' || busy) return;
    const c = C();
    const d = data();
    const pending = c.chat.length - 1 - d.last;
    if (pending >= s.interval) {
      setTimeout(() => summarizeNow(), 500);
    } else {
      updateUI();
    }
  }

  // ---------- UI ----------
  function setStatusLine(text, kind) {
    statusLine = { text, kind };
    updateUI();
  }

  function updateUI() {
    const box = document.getElementById('mth_status');
    if (!box) return;
    const c = C();
    const d = data();
    const pending = Math.max(0, c.chat.length - 1 - d.last);
    const ls = d.lastSent || { rollup: 0, chunks: 0, tokens: 0 };
    const cls = statusLine.kind ? `mth-line-${statusLine.kind}` : '';
    box.innerHTML =
      `ความจำ ${d.memories.length} ก้อน · สรุปแล้วถึงข้อความ <b>#${d.last}</b> · ยังไม่สรุป <b>${pending}</b> ข้อความ<br>` +
      `ครั้งล่าสุด: ส่งเรื่องย่อ ${ls.rollup} + ความจำ ${ls.chunks} ก้อน ${ls.tokens} โทเคน` +
      (statusLine.text ? `<br><span class="${cls}">${statusLine.text}</span>` : '');
    document.querySelectorAll('.mth-root .mth-btn').forEach((b) => (b.disabled = busy));
  }

  function openModal(title, body, buttons) {
    const bg = document.createElement('div');
    bg.className = 'mth-modal-bg';
    const modal = document.createElement('div');
    modal.className = 'mth-modal mth-root';
    const h = document.createElement('h3');
    h.textContent = title;
    modal.appendChild(h);
    modal.appendChild(body);
    const act = document.createElement('div');
    act.className = 'mth-actions';
    const close = () => bg.remove();
    (buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'menu_button';
      btn.textContent = b.label;
      btn.onclick = async () => {
        if (b.onClick) await b.onClick();
        if (b.close !== false) close();
      };
      act.appendChild(btn);
    });
    const cl = document.createElement('button');
    cl.className = 'menu_button';
    cl.textContent = 'ปิด';
    cl.onclick = close;
    act.appendChild(cl);
    modal.appendChild(act);
    bg.appendChild(modal);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    document.body.appendChild(bg);
  }

  function openVault() {
    const d = data();
    const body = document.createElement('div');

    const rl = document.createElement('div');
    rl.className = 'mth-item';
    rl.innerHTML = '<small>เรื่องย่อรวม (rollup)</small>';
    const rta = document.createElement('textarea');
    rta.value = d.rollup || '';
    rl.appendChild(rta);
    body.appendChild(rl);

    const tas = [];
    d.memories.forEach((m, i) => {
      const item = document.createElement('div');
      item.className = 'mth-item';
      const small = document.createElement('small');
      small.textContent = `ก้อนที่ ${i + 1} · ข้อความ #${m.from}-#${m.to} · ${new Date(m.time).toLocaleString('th-TH')}`;
      const ta = document.createElement('textarea');
      ta.value = m.text;
      const del = document.createElement('button');
      del.className = 'menu_button';
      del.textContent = 'ลบก้อนนี้';
      del.onclick = () => { item.remove(); m._deleted = true; };
      item.append(small, ta, del);
      body.appendChild(item);
      tas.push({ m, ta });
    });
    if (!d.memories.length) {
      const p = document.createElement('p');
      p.textContent = 'ยังไม่มีความจำ';
      body.appendChild(p);
    }

    openModal('คลังความจำ', body, [
      {
        label: 'บันทึก',
        onClick: async () => {
          d.rollup = rta.value.trim();
          tas.forEach(({ m, ta }) => { m.text = ta.value.trim(); });
          d.memories = d.memories.filter((m) => !m._deleted);
          await C().saveMetadata();
          await refreshInjection();
          toastr.success('บันทึกคลังความจำแล้ว');
        },
      },
    ]);
  }

  function openRangePicker() {
    const c = C();
    const d = data();
    const body = document.createElement('div');
    body.innerHTML =
      '<div class="mth-row"><span>จากข้อความ #</span><input id="mth_from" type="number" class="text_pole" min="0"></div>' +
      '<div class="mth-row"><span>ถึงข้อความ #</span><input id="mth_to" type="number" class="text_pole" min="0"></div>';
    body.querySelector('#mth_from').value = Math.max(0, d.last + 1);
    body.querySelector('#mth_to').value = Math.max(0, c.chat.length - 1);
    openModal('สรุปช่วงที่เลือก', body, [
      {
        label: 'สรุป',
        onClick: async () => {
          const f = parseInt(body.querySelector('#mth_from').value, 10);
          const t = parseInt(body.querySelector('#mth_to').value, 10);
          if (Number.isNaN(f) || Number.isNaN(t) || f > t) {
            toastr.warning('ช่วงข้อความไม่ถูกต้อง');
            return;
          }
          summarizeRange(f, t);
        },
      },
    ]);
  }

  function openLastSent() {
    const d = data();
    const body = document.createElement('div');
    const pre = document.createElement('pre');
    pre.textContent = (d.lastSent && d.lastSent.text) || '(ไม่มีข้อความที่ส่ง)';
    body.appendChild(pre);
    openModal('สิ่งที่ส่งล่าสุด', body);
  }

  async function newChatCarry() {
    const c = C();
    const s = settings();
    const d = data();
    s.pendingCarry = {
      fromChat: c.getCurrentChatId ? c.getCurrentChatId() : null,
      rollup: d.rollup,
      memories: d.memories,
    };
    saveSettings();
    try {
      await c.executeSlashCommandsWithOptions('/newchat');
      toastr.success('เริ่มแชทใหม่แล้ว กำลังย้ายความจำมาให้');
    } catch (e) {
      toastr.info('กรุณากดเริ่มแชทใหม่ด้วยตัวเอง ระบบจะย้ายความจำให้อัตโนมัติ');
    }
  }

  async function onChatChanged() {
    const c = C();
    const s = settings();
    statusLine = { text: '', kind: '' };
    if (s.pendingCarry) {
      const curId = c.getCurrentChatId ? c.getCurrentChatId() : null;
      if (curId !== s.pendingCarry.fromChat) {
        const d = data();
        d.rollup = s.pendingCarry.rollup || '';
        d.memories = s.pendingCarry.memories || [];
        d.last = -1;
        s.pendingCarry = null;
        saveSettings();
        await c.saveMetadata();
      }
    }
    await refreshInjection();
  }

  function buildSettingsHtml() {
    return `
<div id="mth_settings" class="mth-root">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🧠 ความจำสรุปเรื่อง</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="mth-status" id="mth_status"></div>

      <div class="mth-grid">
        <button class="mth-btn" id="mth_vault">✨ เปิดคลังความจำ</button>
        <button class="mth-btn mth-primary" id="mth_now">🪄 สรุปตอนนี้</button>
        <button class="mth-btn" id="mth_range">↔ สรุปช่วงที่เลือก</button>
        <button class="mth-btn" id="mth_view">👁 ดูสิ่งที่ส่งล่าสุด</button>
        <button class="mth-btn mth-wide" id="mth_newchat">⏩ เริ่มแชทใหม่ต่อเรื่อง</button>
      </div>

      <label class="checkbox_label"><input type="checkbox" id="mth_enabled"><span>เปิดใช้งาน</span></label>

      <div class="mth-row">
        <span>การสรุป</span>
        <select id="mth_mode" class="text_pole">
          <option value="auto">อัตโนมัติ (Automatic)</option>
          <option value="manual">กดเอง (Manual)</option>
        </select>
      </div>
      <div class="mth-row">
        <span>สรุปเองทุก ๆ (ข้อความ)</span>
        <input type="number" id="mth_interval" class="text_pole" min="5" max="500">
      </div>
      <div class="mth-row">
        <span>เก็บข้อความล่าสุดไว้ (ไม่สรุป)</span>
        <input type="number" id="mth_keep" class="text_pole" min="0" max="50">
      </div>
      <div class="mth-row">
        <span>รวมความจำเมื่อเกิน (ก้อน)</span>
        <input type="number" id="mth_maxchunks" class="text_pole" min="2" max="50">
      </div>
      <label class="checkbox_label"><input type="checkbox" id="mth_skip"><span>ไม่ส่งข้อความที่สรุปแล้ว (ประหยัดโทเคนมากที่สุด)</span></label>

      <div class="mth-row"><span>Prompt สำหรับสรุป</span>
        <button class="menu_button" id="mth_reset_prompt">คืนค่าเริ่มต้น</button></div>
      <textarea id="mth_prompt" class="text_pole mth-prompt"></textarea>
    </div>
  </div>
</div>`;
  }

  function bindSettings() {
    const s = settings();
    const $q = (id) => $(`#${id}`);

    $q('mth_enabled').prop('checked', s.enabled).on('change', function () {
      s.enabled = this.checked; saveSettings(); refreshInjection();
    });
    $q('mth_mode').val(s.mode).on('change', function () { s.mode = this.value; saveSettings(); });
    $q('mth_interval').val(s.interval).on('input', function () {
      s.interval = Math.max(5, parseInt(this.value, 10) || 25); saveSettings();
    });
    $q('mth_keep').val(s.keepRecent).on('input', function () {
      s.keepRecent = Math.max(0, parseInt(this.value, 10) || 0); saveSettings();
    });
    $q('mth_maxchunks').val(s.maxChunks).on('input', function () {
      s.maxChunks = Math.max(2, parseInt(this.value, 10) || 8); saveSettings();
    });
    $q('mth_skip').prop('checked', s.skipSummarized).on('change', function () {
      s.skipSummarized = this.checked; saveSettings();
    });
    $q('mth_prompt').val(s.prompt).on('input', function () { s.prompt = this.value; saveSettings(); });
    $q('mth_reset_prompt').on('click', () => {
      s.prompt = DEFAULT_PROMPT; $q('mth_prompt').val(DEFAULT_PROMPT); saveSettings();
    });

    $q('mth_vault').on('click', openVault);
    $q('mth_now').on('click', summarizeNow);
    $q('mth_range').on('click', openRangePicker);
    $q('mth_view').on('click', openLastSent);
    $q('mth_newchat').on('click', newChatCarry);
  }

  jQuery(async () => {
    const c = C();
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) { console.error('[memory-th] ไม่พบพื้นที่ตั้งค่าส่วนขยาย'); return; }
    host.insertAdjacentHTML('beforeend', buildSettingsHtml());
    bindSettings();

    const ET = c.eventTypes || c.event_types;
    c.eventSource.on(ET.MESSAGE_RECEIVED, onMessage);
    c.eventSource.on(ET.CHAT_CHANGED, onChatChanged);

    await refreshInjection();
  });
})();
