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
const RSVP_SHEET = process.env.GOOGLE_RSVP_SHEET || 'RSVP';
const GUESTBOOK_SHEET = process.env.GOOGLE_GUESTBOOK_SHEET || 'Guestbook';

const hasGoogleConfig = Boolean(SHEET_ID && SERVICE_ACCOUNT_EMAIL && PRIVATE_KEY);
let useGoogleSheets = hasGoogleConfig;

const DATA_DIR = path.join(ROOT, 'data');
const RSVP_FILE = path.join(DATA_DIR, 'rsvp.json');
const GUESTBOOK_FILE = path.join(DATA_DIR, 'guestbook.json');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------
// Bộ hàm hỗ trợ lưu JSON cục bộ khi không dùng Google Sheets
// -------------------------
function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(RSVP_FILE)) fs.writeFileSync(RSVP_FILE, '[]', 'utf8');
  if (!fs.existsSync(GUESTBOOK_FILE)) fs.writeFileSync(GUESTBOOK_FILE, '[]', 'utf8');
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
  [RSVP_SHEET]: ['Thời gian', 'Tên', 'Bạn của', 'Số điện thoại', 'số người đi cùng', 'Ghi chú'],
  [GUESTBOOK_SHEET]: ['Thời gian', 'Tên', 'Bạn của', 'Liên hệ', 'Lời nhắn']
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

async function fetchGuestbookRows(limit = 10) {
  const sheets = await getSheetsClient();
  await ensureSheetExists(GUESTBOOK_SHEET);
  const range = `${GUESTBOOK_SHEET}!A2:D`;
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

// -------------------------
// Lớp trừu tượng để chọn nơi lưu: Sheets hoặc JSON
// -------------------------
function createGoogleStorage() {
  return {
    init: async () => {
      await Promise.all(Object.keys(SHEET_HEADERS).map((title) => ensureSheetExists(title)));
    },
    saveRsvp: async (entry) => {
      await appendRow(RSVP_SHEET, [entry.timestamp, entry.name, formatSideToVietnamese(entry.side), entry.phone, entry.guests, entry.note]);
    },
    saveGuestbook: async (entry) => {
      await appendRow(GUESTBOOK_SHEET, [entry.timestamp, entry.name, formatSideToVietnamese(entry.side), entry.contact, entry.message]);
    },
    getGuestbook: async (limit) => fetchGuestbookRows(limit)
  };
}

function createLocalStorage() {
  return {
    init: async () => {
      ensureDataFiles();
    },
    saveRsvp: async (entry) => {
      const list = safeReadJson(RSVP_FILE);
      list.unshift(entry);
      safeWriteJson(RSVP_FILE, list);
    },
    saveGuestbook: async (entry) => {
      const list = safeReadJson(GUESTBOOK_FILE);
      list.unshift(entry);
      safeWriteJson(GUESTBOOK_FILE, list);
    },
    getGuestbook: async (limit) => {
      const list = safeReadJson(GUESTBOOK_FILE);
      return list.slice(0, limit);
    }
  };
}

let storage = useGoogleSheets ? createGoogleStorage() : createLocalStorage();

async function initializeStorage() {
  try {
    await storage.init();
    if (useGoogleSheets) {
      console.log('Google Sheets storage ready');
    } else {
      console.log('Local JSON storage ready');
    }
  } catch (err) {
    console.error('Storage initialisation failed', err);
    if (useGoogleSheets) {
      console.warn('Falling back to local JSON storage. Data will be kept on disk.');
      useGoogleSheets = false;
      sheetsClientPromise = null;
      storage = createLocalStorage();
      try {
        await storage.init();
        console.log('Local JSON storage ready');
      } catch (fallbackErr) {
        console.error('Fallback storage initialisation failed', fallbackErr);
      }
    }
  }
}

initializeStorage();

// -------------------------
// Định nghĩa API phục vụ frontend
// -------------------------
app.post('/api/rsvp', async (req, res) => {
  const { name, side = '', phone = '', guests = 1, note = '', timestamp } = req.body || {};
  if (!name || String(name).trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Name is required' });
  }
  const formattedTimestamp = formatTimestampGMT7(timestamp);
  const entry = {
    name: String(name).trim(),
    side: String(side).trim(),
    phone: String(phone).trim(),
    guests: Number(guests) || 1,
    note: String(note).trim(),
    type: 'RSVP',
    timestamp: formattedTimestamp
  };
  try {
    await storage.saveRsvp(entry);
    res.json({ ok: true });
  } catch (error) {
    console.error('RSVP save failed', error);
    res.status(500).json({ ok: false, error: 'Unable to save RSVP' });
  }
});

app.post('/api/guestbook', async (req, res) => {
  const { name, side = '', contact = '', message, timestamp } = req.body || {};
  if (!name || !message || String(name).trim().length === 0 || String(message).trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Name and message are required' });
  }
  const formattedTimestamp = formatTimestampGMT7(timestamp);
  const entry = {
    name: String(name).trim(),
    side: String(side).trim(),
    contact: String(contact).trim(),
    message: String(message).trim(),
    type: 'GUESTBOOK',
    timestamp: formattedTimestamp
  };
  try {
    await storage.saveGuestbook(entry);
    res.json({ ok: true });
  } catch (error) {
    console.error('Guestbook save failed', error);
    res.status(500).json({ ok: false, error: 'Unable to save guestbook entry' });
  }
});

app.get('/api/guestbook', async (req, res) => {
  try {
    const items = await storage.getGuestbook(10);
    res.json({ ok: true, items });
  } catch (error) {
    console.error('Guestbook fetch failed', error);
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
