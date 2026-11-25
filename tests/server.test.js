// Chạy thử apps-script/Code.gs với Google Sheet giả (không đụng Sheet thật)
// Chạy: node tests/server.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

function makeSheet(rows) {
  const data = rows.map(r => r.slice());
  const stats = { reads: 0, writes: 0, cellsWritten: 0 };
  return {
    stats, data,
    getLastRow: () => data.length,
    getRange: (row, col, nr = 1, nc = 1) => ({
      getValues() { stats.reads++; return data.slice(row - 1, row - 1 + nr).map(r => r.slice(col - 1, col - 1 + nc)); },
      setValues(v) {
        stats.writes++; stats.cellsWritten += nr * nc;
        if (v.length !== nr || v.some(x => x.length !== nc)) throw new Error('kích thước sai');
        v.forEach((r, i) => r.forEach((c, j) => { data[row - 1 + i][col - 1 + j] = c; }));
      }
    })
  };
}

const header = ['進倉單號', '貨主單號', '料號', '數量', '儲位', '人員', '時間'];
const sheet = makeSheet([header,
  ['IN1', 'BOX1', 'S1', 5, '', '', ''],
  ['IN1', 'BOX1', 'S2', 2, '', '', ''],
  ['IN2', 'BOX2', 'S3', 1, 'S10111111', 'OLD', '2026-10-01 01:00:00'],
  ['IN3', 'BOX3', 'S4', 1, '', '', ''],
  ['IN1', 'BOX1', 'S5', 1, '', '', ''],   // BOX1 không liền nhau
  ['IN4', 'BOX4', 'S6', 1, 'S15000001', 'A', '2026-10-01 02:00:00'],
]);
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) },
  Utilities: { formatDate: (d, tz, f) => f.length > 12 ? '2026-10-29 10:00:00' : '10:00 29/10' },
  console
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

let fails = 0;
const check = (n, ok, x = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x !== '' ? '  ' + x : '')); if (!ok) fails++; };
const j = JSON.stringify;
const save = (it) => ctx.updateLocations([it])[0];

// ---- Lưu cơ bản ----
let r = ctx.updateLocation('box1', 's15222222', 'SON', false);
check('lưu 1 thùng (không liền dòng)', r.success && r.count === 3, j(r));
check('ghi đúng 3 dòng của BOX1', [1, 2, 5].every(i => sheet.data[i][4] === 'S15222222' && sheet.data[i][5] === 'SON'));
check('không đụng dòng khác', sheet.data[3][4] === 'S10111111' && sheet.data[4][4] === '');
check('chỉ ghi 3 cột x 3 dòng', sheet.stats.cellsWritten === 9, sheet.stats.cellsWritten);

r = ctx.updateLocation('BOX2', 'S15333333', 'SON', false);
check('máy cũ, không force: báo trùng', !r.success && r.isAlreadySaved && r.existingBin === 'S10111111' && r.existingUser === 'OLD', j(r));
r = ctx.updateLocation('BOX2', 'S15333333', 'SON', true);
check('máy cũ, force: ghi đè (giữ tương thích)', r.success && sheet.data[3][4] === 'S15333333');
r = ctx.updateLocation('NOPE', 'S15333333', 'SON', false);
check('không có mã thùng', !r.success && /Không tìm thấy/.test(r.message));

// ---- Chống ghi đè bằng expectBin ----
r = save({ boxId: 'BOX3', bin: 'S15444444', operator: 'A', expectBin: '' });
check('expectBin rỗng + thùng trống: lưu', r.success && sheet.data[4][4] === 'S15444444');
r = save({ boxId: 'BOX3', bin: 'S15555555', operator: 'B', expectBin: '' });
check('expectBin rỗng nhưng đã có người lưu: báo trùng', r.isAlreadySaved && r.existingBin === 'S15444444' && r.existingUser === 'A', j(r));
r = save({ boxId: 'BOX4', bin: 'S15000002', operator: 'B', forceOverwrite: true, expectBin: 'S15000001' });
check('chuyển kệ, vị trí cũ khớp: ghi', r.success && sheet.data[6][4] === 'S15000002');
r = save({ boxId: 'BOX4', bin: 'S15000003', operator: 'C', forceOverwrite: true, expectBin: 'S15000001' });
check('chuyển kệ, người khác đã đổi trước: KHÔNG ghi đè', r.isAlreadySaved && r.existingBin === 'S15000002' && sheet.data[6][4] === 'S15000002', j(r));
sheet.data[6][4] = ''; sheet.data[6][5] = '';
r = save({ boxId: 'BOX4', bin: 'S15000004', operator: 'C', forceOverwrite: true, expectBin: 'S15000002' });
check('chuyển kệ, kệ cũ vừa bị xoá tay: báo', r.isAlreadySaved && r.existingBin === '' && /xoá/.test(r.message), j(r));

// ---- Lô ----
const res = ctx.updateLocations([
  { boxId: 'BOX4', bin: 'S15666666', operator: 'A', expectBin: '' },
  { boxId: 'BOX4', bin: 'S15777777', operator: 'B', expectBin: '' },
  { boxId: 'BOX4', bin: 'S15888888', operator: 'C', expectBin: 'S15666666' },
  { boxId: '', bin: 'S15', operator: 'C' }
]);
check('lô: thùng đầu lưu được', res[0].success);
check('lô: cùng thùng lần 2 thấy trùng', res[1].isAlreadySaved && res[1].existingBin === 'S15666666', j(res[1]));
check('lô: lần 3 khớp vị trí cũ thì ghi', res[2].success && sheet.data[6][4] === 'S15888888' && sheet.data[6][5] === 'C');
check('lô: dữ liệu rỗng báo lỗi', !res[3].success);

// ---- Đọc nhanh vị trí kệ ----
const snap = ctx.getBinsSnapshot();
const box = (id) => snap.boxes.find(b => b[0] === id);
check('bins: mỗi thùng 1 dòng', snap.success && snap.rows === 6 && snap.boxes.length === 4, j(snap));
check('bins: đúng kệ/người/giờ', j(box('BOX1')) === j(['BOX1', 'S15222222', 'SON', '10:00 29/10']) && box('BOX4')[1] === 'S15888888');
let c = ctx.checkBox('box3');
check('checkBox: thùng đã lên kệ', c.success && c.found && c.bin === 'S15444444' && c.operator === 'A' && c.updatedTime === '10:00 29/10', j(c));
c = ctx.checkBox('NOPE');
check('checkBox: không có thùng', c.success && c.found === false);

console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
