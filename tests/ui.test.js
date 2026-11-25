// Chạy thử index.html trong jsdom với server giả (không gọi Apps Script thật)
// Chạy: cd tests && npm install && node ui.test.js
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const ITEMS = () => [
  { inboundNo: 'IN1', boxId: 'IDAF261015A4', sku: 'S1', qty: 5, bin: 'S10111111', operator: 'OLD', updatedTime: '01:00 01/10' },
  { inboundNo: 'IN1', boxId: 'IDAF261015A4', sku: 'S1b', qty: 2, bin: 'S10111111', operator: 'OLD', updatedTime: '01:00 01/10' },
  { inboundNo: 'IN2', boxId: 'IDAF261015A40', sku: 'S2', qty: 3, bin: '', operator: '', updatedTime: '' },
  { inboundNo: 'IN3', boxId: 'IDAF261015B7', sku: 'S3', qty: 1, bin: '', operator: '', updatedTime: '' },
  { inboundNo: 'IN4', boxId: 'IDAF261015C9', sku: 'S4', qty: 1, bin: '', operator: '', updatedTime: '' }
];

// Server giả có trạng thái, xử lý chống ghi đè giống apps-script/Code.gs.
// down = mất mạng; legacy = Apps Script bản cũ (chưa có updateBatch/bins/checkBox/expectBin);
// noRealtime = có updateBatch nhưng chưa có bins/checkBox; hold(action) = giữ phản hồi lại để thử tình huống chạy đua
function makeServer() {
  const st = { calls: [], down: false, legacy: false, noRealtime: false, fail: null, held: {}, items: ITEMS() };
  st.current = (id) => {
    const rows = st.items.filter(i => i.boxId === id);
    const r = rows.find(x => x.bin) || rows[0];
    return r ? { bin: r.bin, operator: r.operator, updatedTime: r.updatedTime } : null;
  };
  st.set = (id, bin, op) => st.items.filter(i => i.boxId === id).forEach(i => { i.bin = bin; i.operator = op; i.updatedTime = '10:00 29/10'; });
  st.one = (it) => {
    if (st.fail) return st.fail(it);
    const cur = st.current(it.boxId);
    if (!cur) return { success: false, message: 'Không tìm thấy mã thùng để cập nhật!' };
    const hasExpect = !st.legacy && it.expectBin !== undefined && it.expectBin !== null;
    if (hasExpect || !it.forceOverwrite) {
      if (cur.bin !== (hasExpect ? it.expectBin : '')) return { success: false, isAlreadySaved: true, existingBin: cur.bin, existingUser: cur.operator };
    }
    st.set(it.boxId, it.bin, it.operator);
    return { success: true, count: 1, nowStr: '10:00 29/10' };
  };
  st.answer = (req) => {
    const nope = { success: false, message: 'Action không hợp lệ: ' + req.action };
    switch (req.action) {
      case 'load': return { success: true, items: st.items.map(x => ({ ...x })) };
      case 'verifyPin': return { success: req.pin === '9999' };
      case 'updateBatch': return st.legacy ? nope : { success: true, results: req.items.map(st.one) };
      case 'updateLocation': return st.one(req);
      case 'checkBox': {
        if (st.legacy || st.noRealtime) return nope;
        const c = st.current(req.boxId);
        return c ? { success: true, found: true, ...c } : { success: true, found: false };
      }
      case 'bins': {
        if (st.legacy || st.noRealtime) return nope;
        const ids = [...new Set(st.items.map(i => i.boxId))];
        return { success: true, rows: st.items.length, boxes: ids.map(id => { const c = st.current(id); return [id, c.bin, c.operator, c.updatedTime]; }) };
      }
    }
  };
  st.fetch = async (url, opts) => {
    const req = JSON.parse(opts.body);
    st.calls.push(req);
    if (st.down) throw new Error('Failed to fetch');
    if (st.held[req.action]) {
      // Server đọc dữ liệu ngay lúc nhận, nhưng phản hồi về máy chậm
      const body = st.answer(req);
      await new Promise(r => { st.held[req.action] = r; });
      return { ok: true, status: 200, json: async () => body };
    }
    const body = st.answer(req);
    return { ok: true, status: 200, json: async () => body };
  };
  st.hold = (action) => { st.held[action] = true; };
  st.release = (action) => { const r = st.held[action]; delete st.held[action]; if (typeof r === 'function') r(); };
  return st;
}

function makeDom({ seed = true, floor = '2', outbox = null, server }) {
  return new JSDOM(html, {
    url: 'https://example.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      if (seed) {
        win.localStorage.setItem('WAREHOUSE_OPERATOR', 'TEST');
        win.localStorage.setItem('WAREHOUSE_FLOOR', floor);
      }
      if (outbox) win.localStorage.setItem('WAREHOUSE_OUTBOX', JSON.stringify(outbox));
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = function() {};
      win.fetch = server.fetch;
    }
  });
}

let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  ' + extra : '')); if (!ok) fails++; };
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

function helpers(dom) {
  const w = dom.window, d = w.document;
  const $ = (id) => d.getElementById(id);
  return {
    w, d, $,
    g: (e) => w.eval(e),
    modalOpen: () => !$('dlg').hidden,
    dlgBtn: (label) => [...$('dlgActions').querySelectorAll('button')].find(b => b.textContent === label),
    key: (k) => d.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true })),
    typeBox: (v) => { $('boxInput').value = v; $('boxInput').dispatchEvent(new w.Event('input')); },
    enterBox: () => $('boxInput').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    typeBin: (s) => { $('binInput').value = s; $('binInput').dispatchEvent(new w.Event('input')); },
    binEnter: () => $('binInput').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    stored: () => JSON.parse(w.localStorage.getItem('WAREHOUSE_OUTBOX') || '[]'),
    recentStatus: (id) => { const r = w.eval('recent').find(x => x.boxId === id); return r && r.status; }
  };
}

(async () => {
  // ================= Lần đầu mở =================
  {
    const server = makeServer();
    const dom = makeDom({ seed: false, server }); const { d, g, $ } = helpers(dom);
    await tick(50);
    check('lần đầu: hiện màn thiết lập', !$('setup').hidden && $('setupGo').disabled);
    $('setupName').value = 'hoang'; $('setupName').dispatchEvent(new dom.window.Event('input'));
    g('pickFloor(2)'); g('saveSetup()');
    check('lưu thiết lập + đổi màu tầng', $('setup').hidden && $('hdrOp').textContent === 'HOANG' && d.body.dataset.floor === '2'
      && $('themeColor').getAttribute('content') === '#7c3aed');
    dom.window.close();
  }

  // ================= Luồng chính =================
  const server = makeServer();
  const dom = makeDom({ server });
  const { d, g, $, modalOpen, dlgBtn, key, typeBox, enterBox, typeBin, binEnter, stored, recentStatus } = helpers(dom);
  await tick(60);
  check('tải dữ liệu: 4 thùng, tiến độ 1/4', Object.keys(g('BOX_MAP')).length === 4 && /1<\/b> \/ 4/.test($('progText').innerHTML));

  // ---- Tìm thùng ----
  typeBox('zz');
  check('gõ sai: báo dưới ô, không bật hộp thoại', !$('scanHint').hidden && !modalOpen());
  typeBox('A4');
  const rows = [...$('results').querySelectorAll('.row')];
  check('gõ A4: A4 (khớp đuôi) lên đầu + nhãn Enter', rows.length === 2 && rows[0].dataset.id === 'IDAF261015A4' && rows[0].classList.contains('row-best'));
  enterBox();
  check('gõ đuôi "A4" + Enter: chọn luôn A4', !$('viewBox').hidden && $('bxId').textContent === 'IDAF261015A4');
  check('mã hàng hiện sẵn', $('bxSkus').querySelectorAll('.sku').length === 2 && $('bxSkuCount').textContent === '2');
  g('backToScan()');
  typeBox('IDAF2610'); enterBox();
  check('Enter khi nhiều kết quả không rõ: chưa chọn', $('viewBox').hidden);

  // ---- Lưu thùng chưa lên kệ: xong ngay, không chờ server ----
  server.hold('updateBatch');
  typeBox('B7'); enterBox();
  check('chọn thùng: con trỏ vào ô kệ (bàn phím tự bật)', d.activeElement === $('binInput'));
  typeBin('12a3-456');
  check('lọc ký tự lạ, đủ 6 số: nút Lưu sáng', g('digits') === '123456' && !$('btnSave').disabled);
  $('btnSave').click();
  check('lưu: về bước 1 ngay, không chờ server', !$('viewScan').hidden && d.activeElement === $('boxInput'));
  check('lưu: bộ nhớ + tiến độ cập nhật ngay', g(`BOX_MAP['IDAF261015B7'].bin`) === 'S15123456' && /2<\/b> \/ 4/.test($('progText').innerHTML));
  check('lưu: hàng chờ lưu trong máy, vị trí cũ = trống', stored().length === 1 && stored()[0].prevBin === '');
  check('lưu: thanh trạng thái "đang lưu"', /Đang lưu 1 thùng/.test($('syncText').textContent));
  await tick(20);
  const sentB7 = server.calls.filter(c => c.action === 'updateBatch').pop();
  check('lưu: gửi expectBin = "" (chỉ ghi khi Sheet còn trống)', sentB7 && sentB7.items[0].expectBin === '');
  server.release('updateBatch'); await tick(60);
  check('server xong: hàng chờ rỗng, ✓', stored().length === 0 && recentStatus('IDAF261015B7') === 'saved');
  check('server xong: Sheet có vị trí mới', server.current('IDAF261015B7').bin === 'S15123456');

  // ---- Mở thùng: hỏi Sheet vị trí mới nhất ----
  server.set('IDAF261015C9', 'S15999999', 'KHAC');   // người khác vừa lưu, máy này chưa biết
  check('trước khi mở: máy chưa biết', g(`BOX_MAP['IDAF261015C9'].bin`) === '');
  typeBox('C9'); enterBox();
  check('mở thùng: gọi checkBox', server.calls.some(c => c.action === 'checkBox' && c.boxId === 'IDAF261015C9'));
  await tick(40);
  check('mở thùng: thẻ tự đổi sang "Đã lên kệ" + cảnh báo', $('bxState').textContent.includes('S15999999') && $('bxState').textContent.includes('Vừa có người khác'));
  check('mở thùng: ẩn ô nhập kệ, phải bấm chuyển', $('binPanel').hidden && !$('btnMove').hidden);
  g('backToScan()');

  // ---- Tự cập nhật định kỳ ----
  server.set('IDAF261015A40', 'S15777000', 'KHAC');
  typeBox('A4');   // đang xem danh sách
  g('pollBins()'); await tick(40);
  check('cập nhật định kỳ: thấy người khác vừa lưu', g(`BOX_MAP['IDAF261015A40'].bin`) === 'S15777000');
  check('cập nhật định kỳ: tiến độ + danh sách tự đổi', /4<\/b> \/ 4/.test($('progText').innerHTML) && $('results').textContent.includes('S15777000'));
  check('cập nhật định kỳ: giờ cập nhật trên thanh trạng thái', /cập nhật/.test($('syncText').textContent));
  g('backToScan()');

  // ---- Dữ liệu cũ về muộn không đè lên vị trí vừa lưu ----
  server.hold('bins');
  g('pollBins()'); await tick(20);        // server đọc ngay: B7 = S15123456
  typeBox('B7'); enterBox(); $('btnMove').click(); typeBin('654321'); binEnter(); await tick(60);
  check('lưu lại B7 xong trước khi dữ liệu định kỳ về', server.current('IDAF261015B7').bin === 'S15654321' && stored().length === 0);
  server.release('bins'); await tick(40);
  check('dữ liệu định kỳ cũ hơn bị bỏ qua', g(`BOX_MAP['IDAF261015B7'].bin`) === 'S15654321');

  // ---- Chuyển kệ: người khác đổi trước thì không ghi đè ----
  typeBox('A4'); enterBox(); await tick(40);
  check('đã lên kệ: ẩn ô nhập kệ, hiện vị trí cũ', $('binPanel').hidden && $('bxState').textContent.includes('S10111111'));
  key('1');
  check('chưa bấm chuyển: phím bị bỏ qua', g('digits') === '');
  $('btnMove').click();
  check('bấm chuyển kệ: con trỏ vào ô kệ', d.activeElement === $('binInput'));
  server.set('IDAF261015A4', 'S10999999', 'KHAC');   // người khác đổi trong lúc mình đang gõ
  typeBin('222222'); binEnter(); await tick(60);
  const moveCall = server.calls.filter(c => c.action === 'updateBatch').pop();
  check('chuyển kệ: gửi expectBin = vị trí cũ mình thấy', moveCall.items[0].expectBin === 'S10111111');
  check('chuyển kệ: KHÔNG ghi đè người khác', server.current('IDAF261015A4').bin === 'S10999999');
  check('chuyển kệ: máy lấy lại vị trí server + hỏi đổi', g(`BOX_MAP['IDAF261015A4'].bin`) === 'S10999999' && modalOpen() && $('dlgBody').textContent.includes('S10999999'));
  check('chuyển kệ: vừa lưu đánh dấu !', recentStatus('IDAF261015A4') === 'conflict');
  dlgBtn('Đổi kệ').click(); await tick(60);
  const resaveCall = server.calls.filter(c => c.action === 'updateBatch').pop();
  check('Đổi kệ: gửi lại với vị trí mới nhất', resaveCall.items[0].expectBin === 'S10999999' && server.current('IDAF261015A4').bin === 'S15222222');

  // ---- Mất mạng, lưu lại cùng thùng 2 lần khi chưa gửi được ----
  server.down = true;
  typeBox('C9'); enterBox(); await tick(30);
  $('btnMove').click(); typeBin('111111'); binEnter(); await tick(40);
  check('mất mạng: không bật hộp thoại, hàng chờ giữ trong máy', !modalOpen() && stored().length === 1);
  check('mất mạng: báo trên thanh trạng thái', $('sync').dataset.s === 'err' && /1 thùng chờ lưu/.test($('syncText').textContent));
  typeBox('C9'); enterBox(); await tick(30);
  $('btnMove').click(); typeBin('333333'); binEnter(); await tick(40);
  check('lưu lại khi chưa gửi: giữ vị trí cũ thật trên Sheet', stored().length === 1 && stored()[0].bin === 'S15333333' && stored()[0].prevBin === 'S15999999', JSON.stringify(stored()[0]));
  server.down = false;
  dom.window.dispatchEvent(new dom.window.Event('online')); await tick(80);
  check('có mạng lại: tự gửi, Sheet đúng vị trí mới nhất', stored().length === 0 && server.current('IDAF261015C9').bin === 'S15333333');

  // ---- Lỗi server thật (không phải mất mạng): hoàn lại vị trí cũ ----
  server.fail = () => ({ success: false, message: 'Không tìm thấy mã thùng để cập nhật!' });
  typeBox('C9'); enterBox(); await tick(30);
  $('btnMove').click(); typeBin('888888'); binEnter(); await tick(60);
  check('lỗi server: hoàn lại vị trí cũ + báo lỗi', g(`BOX_MAP['IDAF261015C9'].bin`) === 'S15333333' && modalOpen() && recentStatus('IDAF261015C9') === 'failed');
  dlgBtn('Đã hiểu').click();
  server.fail = null;

  // ---- Súng quét mã kệ ----
  typeBox('A40'); enterBox(); await tick(30); $('btnMove').click(); $('binInput').blur();
  for (const c of 'S10123456') key(c);
  check('quét mã kệ sai tầng: cảnh báo', modalOpen() && $('dlgTitle').textContent === 'Sai khu vực');
  dlgBtn('Đã hiểu').click();
  $('binInput').blur();
  for (const c of 'S15123456') key(c);
  check('quét mã kệ đúng tầng: lấy 6 số', g('digits') === '123456');
  g('backToScan()');

  // ---- Nạp file mới trên Sheet: tự tải lại ----
  server.items.push({ inboundNo: 'IN9', boxId: 'IDAF261015Z1', sku: 'S9', qty: 1, bin: '', operator: '', updatedTime: '' });
  g('pollBins()'); await tick(80);
  check('có thùng mới trên Sheet: tự tải lại toàn bộ', !!g(`BOX_MAP['IDAF261015Z1']`) && server.calls.filter(c => c.action === 'load').length === 2);

  // ---- Menu + PIN ----
  g('openMenu()');
  [...$('menuBody').querySelectorAll('.menu-item')].find(b => b.textContent.includes('Mở quản trị')).click();
  $('dlgInput').value = '1111'; dlgBtn('Mở khoá').click(); await tick();
  check('PIN sai: báo lỗi', modalOpen() && $('dlgTitle').textContent === 'Sai mã PIN');
  dlgBtn('Đã hiểu').click();
  g('askPin()'); $('dlgInput').value = '9999'; dlgBtn('Mở khoá').click(); await tick();
  check('PIN đúng: hiện nạp/xuất file', $('menuBody').textContent.includes('Nạp file') && $('menuBody').textContent.includes('Xuất file'));
  g('closeMenu()');

  // ---- Chống chèn HTML ----
  g(`buildCache([{inboundNo:'<img src=x onerror=alert(1)>', boxId:'XSS1', sku:'<b>x</b>', qty:1, bin:'', operator:'', updatedTime:''}])`);
  typeBox('XSS');
  check('dữ liệu có thẻ HTML hiển thị dạng chữ', !$('results').querySelector('img') && $('results').innerHTML.includes('&lt;img'));
  dom.window.close();

  // ================= Mở lại app khi hàng chờ còn sót =================
  {
    const server2 = makeServer(); server2.down = true;
    const left = [{ boxId: 'IDAF261015A40', bin: 'S15444444', operator: 'TEST', force: false, prevBin: '', prevOperator: '', prevTime: '', at: Date.now() }];
    const dom2 = makeDom({ outbox: left, server: server2 });
    const h = helpers(dom2);
    await tick(60);
    check('mở lại: hiện thùng chờ lưu trong vừa lưu', h.recentStatus('IDAF261015A40') === 'pending' && !h.$('recentWrap').hidden);
    server2.down = false;
    h.g('syncTap()'); await tick(100);
    check('mở lại: dữ liệu tải về vẫn giữ vị trí chờ lưu', h.g(`BOX_MAP['IDAF261015A40'].bin`) === 'S15444444');
    check('mở lại: gửi xong hàng chờ', h.stored().length === 0 && server2.current('IDAF261015A40').bin === 'S15444444');
    dom2.window.close();
  }

  // ================= Khu L10 =================
  {
    const server4 = makeServer();
    const dom4 = makeDom({ seed: false, server: server4 }); const h = helpers(dom4);
    await tick(60);
    check('L10: có lựa chọn trong màn thiết lập', !!h.$('setup').querySelector('.floor-card[data-f="3"]'));
    h.$('setupName').value = 'an'; h.$('setupName').dispatchEvent(new dom4.window.Event('input'));
    h.g('pickFloor(3)'); h.g('saveSetup()');
    check('L10: lưu khu + đổi màu', h.d.body.dataset.floor === '3' && h.$('themeColor').getAttribute('content') === '#0f766e'
      && h.w.localStorage.getItem('WAREHOUSE_FLOOR') === '3');
    check('L10: header hiện tên + tiền tố', h.$('floorNum').textContent === 'Khu L10' && h.$('floorPre').textContent === 'L10');
    h.typeBox('B7'); h.enterBox(); await tick(30);
    check('L10: ô kệ có tiền tố L10', h.$('slotPre').textContent === 'L10');
    h.$('binInput').blur();
    for (const c of 'S15123456') h.key(c);
    check('L10: quét mã kệ S15 bị chặn', h.modalOpen() && h.$('dlgTitle').textContent === 'Sai khu vực' && h.$('dlgBody').textContent.includes('Khu L10'));
    h.dlgBtn('Đã hiểu').click();
    h.typeBin('l10123456');
    check('L10: quét/dán mã kệ L10 đầy đủ: lấy 6 số', h.g('digits') === '123456' && h.$('binHelp').textContent.includes('L10123456'));
    h.binEnter(); await tick(60);
    check('L10: lưu lên Sheet với tiền tố L10', server4.current('IDAF261015B7').bin === 'L10123456');
    h.typeBox('A4'); h.enterBox(); await tick(30);
    check('L10: thùng ở kệ S10 báo khác khu', h.$('bxState').textContent.includes('không thuộc khu bạn đang chọn (Khu L10 · L10)'));
    dom4.window.close();
    // máy đã chọn L10 từ trước: mở lại vẫn nhớ
    const dom5 = makeDom({ floor: '3', server: makeServer() }); const h5 = helpers(dom5);
    await tick(40);
    check('L10: mở lại app vẫn nhớ khu L10', h5.$('setup').hidden && h5.g('prefix()') === 'L10');
    dom5.window.close();
  }

  // ================= Apps Script bản cũ =================
  {
    const server3 = makeServer(); server3.legacy = true;
    const dom3 = makeDom({ server: server3 }); const h = helpers(dom3);
    await tick(60);
    h.typeBox('B7'); h.enterBox(); await tick(30);
    h.typeBin('121212'); h.binEnter(); await tick(80);
    check('bản cũ: tự chuyển sang lưu từng thùng', server3.calls.some(c => c.action === 'updateLocation' && c.bin === 'S15121212') && h.stored().length === 0);
    h.g('pollBins()'); await tick(40); h.g('pollBins()'); await tick(40);
    check('bản cũ: chưa có cập nhật định kỳ thì ngừng gọi, không báo lỗi', server3.calls.filter(c => c.action === 'bins').length === 1 && !h.modalOpen());
    dom3.window.close();
  }

  console.log(fails ? `${fails} FAIL` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
