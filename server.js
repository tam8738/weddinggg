const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { google } = require('googleapis');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// cấu hình Google Sheets lấy từ biến môi trường
const SHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '';
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Sheet names cho nhà trai và nhà gái
const RSVP_GROOM_SHEET = 'RSVP - Nhà Trai';
const RSVP_BRIDE_SHEET = 'RSVP - Nhà Gái';
const GUESTBOOK_GROOM_SHEET = 'Lời chúc - Nhà Trai';
const GUESTBOOK_BRIDE_SHEET = 'Lời chúc - Nhà Gái';

const hasGoogleConfig = Boolean(SHEET_ID && SERVICE_ACCOUNT_EMAIL && PRIVATE_KEY);
let useGoogleSheets = hasGoogleConfig;

const DATA_DIR = path.join(ROOT, 'data');
const RSVP_GROOM_FILE = path.join(DATA_DIR, 'rsvp_groom.json');
const RSVP_BRIDE_FILE = path.join(DATA_DIR, 'rsvp_bride.json');
const GUESTBOOK_GROOM_FILE = path.join(DATA_DIR, 'guestbook_groom.json');
const GUESTBOOK_BRIDE_FILE = path.join(DATA_DIR, 'guestbook_bride.json');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------
// Bộ hàm hỗ trợ lưu JSON cục bộ khi không dùng Google Sheets
// -------------------------
function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(RSVP_GROOM_FILE)) fs.writeFileSync(RSVP_GROOM_FILE, '[]', 'utf8');
  if (!fs.existsSync(RSVP_BRIDE_FILE)) fs.writeFileSync(RSVP_BRIDE_FILE, '[]', 'utf8');
  if (!fs.existsSync(GUESTBOOK_GROOM_FILE)) fs.writeFileSync(GUESTBOOK_GROOM_FILE, '[]', 'utf8');
  if (!fs.existsSync(GUESTBOOK_BRIDE_FILE)) fs.writeFileSync(GUESTBOOK_BRIDE_FILE, '[]', 'utf8');
}

function safeReadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function safeWriteJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function formatTimestampGMT7(value) {
  const parsed = value ? new Date(value) : new Date();
  const baseDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const offsetMinutes = 7 * 60;
  const local = new Date(baseDate.getTime() + offsetMinutes * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  const seconds = String(local.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} GMT+7`;
}

function formatSideToVietnamese(side) {
  const sideMap = {
    'groom': 'Chú rể (Trung Hiếu)',
    'bride': 'Cô dâu (Thanh Phương)'
  };
  return sideMap[side] || side;
}

// -------------------------
// Các hàm thao tác với Google Sheets
// -------------------------
const SHEET_HEADERS = {
  [RSVP_GROOM_SHEET]: ['Thời gian', 'Họ tên', 'Số điện thoại', 'Số người', 'Ghi chú'],
  [RSVP_BRIDE_SHEET]: ['Thời gian', 'Họ tên', 'Số điện thoại', 'Số người', 'Ghi chú'],
  [GUESTBOOK_GROOM_SHEET]: ['Thời gian', 'Họ tên', 'Liên hệ', 'Lời chúc'],
  [GUESTBOOK_BRIDE_SHEET]: ['Thời gian', 'Họ tên', 'Liên hệ', 'Lời chúc']
};

let sheetsClientPromise = null;
const ensuredSheetTitles = new Set();

async function getSheetsClient() {
  if (!useGoogleSheets) {
    throw new Error('Google Sheets is not configured');
  }
  if (!sheetsClientPromise) {
    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    sheetsClientPromise = auth.authorize().then(() => google.sheets({ version: 'v4', auth }));
  }
  return sheetsClientPromise;
}

async function ensureSheetExists(title) {
  if (!useGoogleSheets || ensuredSheetTitles.has(title)) return;
  const sheets = await getSheetsClient();
  const info = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = (info.data.sheets || []).some((sheet) => sheet.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }]
      }
    });
  }

  const headerRange = `${title}!1:1`;
  const currentHeader = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: headerRange
  }).catch(() => ({ data: {} }));
  const hasHeader = Boolean(currentHeader.data?.values && currentHeader.data.values.length > 0);
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: headerRange,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS[title] || []] }
    });
  }

  ensuredSheetTitles.add(title);
}

async function appendRow(title, values) {
  const sheets = await getSheetsClient();
  await ensureSheetExists(title);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${title}!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [values]
    }
  });
}

async function fetchGuestbookRows(sheetName, limit = 10) {
  const sheets = await getSheetsClient();
  await ensureSheetExists(sheetName);
  const range = `${sheetName}!A2:D`;
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });
  const rows = result.data.values || [];
  const mapped = rows.map((row) => ({
    timestamp: row[0] || '',
    name: row[1] || '',
    contact: row[2] || '',
    message: row[3] || ''
  }));
  return mapped.slice(-limit).reverse();
}

// Initialize sheets hoặc local files
async function initializeSheets() {
  try {
    if (useGoogleSheets) {
      const sheetNames = [RSVP_GROOM_SHEET, RSVP_BRIDE_SHEET, GUESTBOOK_GROOM_SHEET, GUESTBOOK_BRIDE_SHEET];
      for (const name of sheetNames) {
        await ensureSheetExists(name);
      }
      console.log('Google Sheets initialized with 4 sheets');
    } else {
      ensureDataFiles();
      console.log('Local JSON storage ready');
    }
  } catch (err) {
    console.error('Initialization failed', err);
    if (useGoogleSheets) {
      console.warn('Falling back to local JSON storage.');
      useGoogleSheets = false;
      sheetsClientPromise = null;
      ensureDataFiles();
    }
  }
}

initializeSheets();

// -------------------------
// Định nghĩa API phục vụ frontend
// -------------------------
// RSVP - Nhà Trai
app.post('/api/rsvp/groom', async (req, res) => {
  const { name, phone = '', guests = 1, note = '', timestamp } = req.body || {};
  if (!name || String(name).trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Name is required' });
  }
  const formattedTimestamp = formatTimestampGMT7(timestamp);
  const entry = {
    name: String(name).trim(),
    phone: String(phone).trim(),
    guests: Number(guests) || 1,
    note: String(note).trim(),
    type: 'RSVP',
    timestamp: formattedTimestamp
  };
  try {
    if (useGoogleSheets) {
      await appendRow(RSVP_GROOM_SHEET, [entry.timestamp, entry.name, entry.phone, entry.guests, entry.note]);
    } else {
      const list = safeReadJson(RSVP_GROOM_FILE);
      list.unshift(entry);
      safeWriteJson(RSVP_GROOM_FILE, list);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('RSVP groom save failed', error);
    res.status(500).json({ ok: false, error: 'Unable to save RSVP' });
  }
});

// RSVP - Nhà Gái
app.post('/api/rsvp/bride', async (req, res) => {
  const { name, phone = '', guests = 1, note = '', timestamp } = req.body || {};
  if (!name || String(name).trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Name is required' });
  }
  const formattedTimestamp = formatTimestampGMT7(timestamp);
  const entry = {
    name: String(name).trim(),
    phone: String(phone).trim(),
    guests: Number(guests) || 1,
    note: String(note).trim(),
    type: 'RSVP',
    timestamp: formattedTimestamp
  };
  try {
    if (useGoogleSheets) {
      await appendRow(RSVP_BRIDE_SHEET, [entry.timestamp, entry.name, entry.phone, entry.guests, entry.note]);
    } else {
      const list = safeReadJson(RSVP_BRIDE_FILE);
      list.unshift(entry);
      safeWriteJson(RSVP_BRIDE_FILE, list);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('RSVP bride save failed', error);
    res.status(500).json({ ok: false, error: 'Unable to save RSVP' });
  }
});

// Guestbook - Nhà Trai
app.post('/api/guestbook/groom', async (req, res) => {
  const { name, contact = '', message, timestamp } = req.body || {};
  if (!name || !message || String(name).trim().length === 0 || String(message).trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Name and message are required' });
  }
  const formattedTimestamp = formatTimestampGMT7(timestamp);
  const entry = {
    name: String(name).trim(),
    contact: String(contact).trim(),
    message: String(message).trim(),
    type: 'GUESTBOOK',
    timestamp: formattedTimestamp
  };
  try {
    if (useGoogleSheets) {
      await appendRow(GUESTBOOK_GROOM_SHEET, [entry.timestamp, entry.name, entry.contact, entry.message]);
    } else {
      const list = safeReadJson(GUESTBOOK_GROOM_FILE);
      list.unshift(entry);
      safeWriteJson(GUESTBOOK_GROOM_FILE, list);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Guestbook groom save failed', error);
    res.status(500).json({ ok: false, error: 'Unable to save guestbook entry' });
  }
});

// Guestbook - Nhà Gái
app.post('/api/guestbook/bride', async (req, res) => {
  const { name, contact = '', message, timestamp } = req.body || {};
  if (!name || !message || String(name).trim().length === 0 || String(message).trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Name and message are required' });
  }
  const formattedTimestamp = formatTimestampGMT7(timestamp);
  const entry = {
    name: String(name).trim(),
    contact: String(contact).trim(),
    message: String(message).trim(),
    type: 'GUESTBOOK',
    timestamp: formattedTimestamp
  };
  try {
    if (useGoogleSheets) {
      await appendRow(GUESTBOOK_BRIDE_SHEET, [entry.timestamp, entry.name, entry.contact, entry.message]);
    } else {
      const list = safeReadJson(GUESTBOOK_BRIDE_FILE);
      list.unshift(entry);
      safeWriteJson(GUESTBOOK_BRIDE_FILE, list);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Guestbook bride save failed', error);
    res.status(500).json({ ok: false, error: 'Unable to save guestbook entry' });
  }
});

// GET Guestbook - Nhà Trai
app.get('/api/guestbook/groom', async (req, res) => {
  try {
    let items = [];
    if (useGoogleSheets) {
      items = await fetchGuestbookRows(GUESTBOOK_GROOM_SHEET, 10);
    } else {
      items = safeReadJson(GUESTBOOK_GROOM_FILE).slice(0, 10);
    }
    res.json({ ok: true, items });
  } catch (error) {
    console.error('Guestbook groom fetch failed', error);
    res.status(500).json({ ok: false, error: 'Unable to load guestbook' });
  }
});

// GET Guestbook - Nhà Gái
app.get('/api/guestbook/bride', async (req, res) => {
  try {
    let items = [];
    if (useGoogleSheets) {
      items = await fetchGuestbookRows(GUESTBOOK_BRIDE_SHEET, 10);
    } else {
      items = safeReadJson(GUESTBOOK_BRIDE_FILE).slice(0, 10);
    }
    res.json({ ok: true, items });
  } catch (error) {
    console.error('Guestbook bride fetch failed', error);
    res.status(500).json({ ok: false, error: 'Unable to load guestbook' });
  }
});

// Phục vụ toàn bộ file tĩnh trong thư mục gốc
app.use(express.static(ROOT));

// Nếu không trùng route API thì trả về trang chủ
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Wedding site running at http://localhost:${PORT}`);
  if (!useGoogleSheets) {
    console.log('⚠️  Google Sheets môi trường chưa cấu hình, đang lưu tạm bằng file JSON.');
  }
});
