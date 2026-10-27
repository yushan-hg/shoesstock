// =====================================================================
// API cho web app trên GitHub Pages.
// Giao diện (index.html) nằm trên GitHub, file này chỉ làm backend:
// nhận request JSON từ fetch() và đọc/ghi Google Sheet.
//
// PIN Admin được kiểm tra ở server. Đổi PIN tại:
// Project Settings > Script Properties > thêm ADMIN_PIN
// =====================================================================

var SHEET_NAME = '工作表1';

// GET: trả về toàn bộ dữ liệu (dùng để test nhanh trên trình duyệt)
function doGet(e) {
  return jsonOut(loadAllWarehouseData());
}

// POST: body là JSON dạng { action: "...", ... }
function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ success: false, message: "Request không hợp lệ!" });
  }

  switch (req.action) {
    case 'load':
      return jsonOut(loadAllWarehouseData());

    case 'updateLocation':
      return jsonOut(withLock(function() {
        return updateLocation(req.boxId, req.bin, req.operator, req.forceOverwrite);
      }));

    case 'verifyPin':
      return jsonOut({ success: isValidPin(req.pin) });

    case 'import':
      if (!isValidPin(req.pin)) return jsonOut({ success: false, message: "Sai mã PIN Admin!" });
      return jsonOut(withLock(function() {
        return importDataWithStyles(req.payload);
      }));

    case 'exportUrl':
      if (!isValidPin(req.pin)) return jsonOut({ success: false, message: "Sai mã PIN Admin!" });
      return jsonOut({ success: true, url: getExportDownloadUrl() });

    default:
      return jsonOut({ success: false, message: "Action không hợp lệ: " + req.action });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function isValidPin(pin) {
  var adminPin = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || '1234';
  return String(pin || '') === adminPin;
}

// Tránh 2 người lưu cùng lúc ghi đè dữ liệu của nhau
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { success: false, message: "Hệ thống đang bận, vui lòng thử lại!" };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// 1. Tải toàn bộ dữ liệu vào RAM máy khách (Mọi hàng đều cho phép lên kệ)
function loadAllWarehouseData() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) return { success: false, message: "Chưa có dữ liệu!" };

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return { success: true, items: [] };
    }

    var data = sheet.getRange(1, 1, lastRow, 7).getValues();

    var items = [];
    for (var i = 1; i < data.length; i++) {
      if (!data[i] || !data[i][1]) continue;

      var updatedTimeStr = "";
      if (data[i][6]) {
        try {
          updatedTimeStr = Utilities.formatDate(new Date(data[i][6]), "Asia/Taipei", "HH:mm dd/MM");
        } catch(e) {
          updatedTimeStr = String(data[i][6]);
        }
      }

      items.push({
        inboundNo: String(data[i][0] || "").trim(),
        boxId: String(data[i][1] || "").trim().toUpperCase(),
        sku: String(data[i][2] || "").trim(),
        qty: Number(data[i][3]) || 0,
        bin: String(data[i][4] || "").trim(),
        operator: String(data[i][5] || "").trim(),
        updatedTime: updatedTimeStr,
        isError: false // Cho phép lên kệ bình thường
      });
    }

    return { success: true, items: items };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// 2. Ghi nhận vị trí kệ siêu tốc (chỉ đọc & ghi 1 lần duy nhất)
function updateLocation(boxId, binLocation, operatorName, forceOverwrite) {
  try {
    var cleanBoxId = String(boxId || "").trim().toUpperCase();
    var cleanBin = String(binLocation || "").trim().toUpperCase();
    var cleanOperator = String(operatorName || "").trim();

    if (!cleanBoxId || !cleanBin) {
      return { success: false, message: "Mã thùng hoặc vị trí kệ không hợp lệ!" };
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) return { success: false, message: "Không tìm thấy sheet " + SHEET_NAME + "!" };

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { success: false, message: "Bảng tính không có dữ liệu!" };

    var range = sheet.getRange(2, 1, lastRow - 1, 7);
    var rangeData = range.getValues();

    // Kiểm tra trùng lặp vị trí đã có người lên kệ trước
    var existingBin = "";
    var existingUser = "";
    for (var k = 0; k < rangeData.length; k++) {
      if (String(rangeData[k][1]).trim().toUpperCase() === cleanBoxId) {
        if (rangeData[k][4]) {
          existingBin = String(rangeData[k][4]).trim();
          existingUser = String(rangeData[k][5] || "").trim();
          break;
        }
      }
    }

    if (existingBin && !forceOverwrite) {
      return {
        success: false,
        isAlreadySaved: true,
        existingBin: existingBin,
        existingUser: existingUser,
        message: "Thùng này đã được lên kệ trước đó!"
      };
    }

    var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    var updatedCount = 0;
    for (var i = 0; i < rangeData.length; i++) {
      if (String(rangeData[i][1]).trim().toUpperCase() === cleanBoxId) {
        rangeData[i][4] = cleanBin;
        rangeData[i][5] = cleanOperator;
        rangeData[i][6] = nowStr;
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      range.setValues(rangeData);
      return {
        success: true,
        count: updatedCount,
        nowStr: Utilities.formatDate(new Date(), "Asia/Taipei", "HH:mm dd/MM")
      };
    } else {
      return { success: false, message: "Không tìm thấy mã thùng để cập nhật!" };
    }

  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// 3. Nạp dữ liệu Excel giữ nguyên định dạng và màu sắc
function importDataWithStyles(payload) {
  try {
    payload = payload || {};
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
    sheet.clear();

    var rows = payload.values || [];
    var bgColors = payload.bgColors || [];
    var fontColors = payload.fontColors || [];

    sheet.appendRow(['進倉單號', '貨主單號', '料號', '數量', '儲位', '操作人員', '上架時間']);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold');

    if (rows.length > 0) {
      var numRows = rows.length;
      var range = sheet.getRange(2, 1, numRows, 5);
      range.setValues(rows);

      if (bgColors.length === numRows) range.setBackgrounds(bgColors);
      if (fontColors.length === numRows) range.setFontColors(fontColors);
    }
    return { success: true, count: rows.length };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// 4. Lấy link xuất file trực tiếp từ Google Sheets
function getExportDownloadUrl() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return "https://docs.google.com/spreadsheets/d/" + ss.getId() + "/export?format=xlsx";
}
