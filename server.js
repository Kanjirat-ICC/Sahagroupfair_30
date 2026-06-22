const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Data storage ── */
const DATA_DIR   = path.join(__dirname, 'data');
const DATA_FILE  = path.join(DATA_DIR, 'members.json');
const ADMIN_PASS = process.env.ADMIN_PASS || 'sahagroup30';

if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

/* ── Stock management ── */
const STOCK_FILE   = path.join(DATA_DIR, 'stock.json');
const PRODUCT_NAMES = [
    'SHEENE Airy Powder 3.5 กรัม',
    'SHEENE Airy Powder 6 กรัม',
    'SHEENE Airy Matte Lip',
    'SHEENE Airy Lip Tint Gloss',
    'SHEENE Lip Gloss',
    'SHEENE Oil Free Cake Powder',
    'HONEI V BSC Age Defence Sunscreen',
    'HONEI V BSC HYA Royal Honey Serum',
    'HONEI V BSC Honey Yuzu Whip Foam',
    'ENFANT Extra Mild Face & Body Wipes',
    'GoodAge กู๊ดเอจ Adult Diapers',
];
function defaultStock(){ const s={}; PRODUCT_NAMES.forEach(n=>s[n]=50); return s; }
function readStock(){
    try { return JSON.parse(fs.readFileSync(STOCK_FILE,'utf8')); }
    catch { return defaultStock(); }
}
function writeStock(obj){ fs.writeFileSync(STOCK_FILE, JSON.stringify(obj,null,2),'utf8'); }
if(!fs.existsSync(STOCK_FILE)) writeStock(defaultStock());

function readMembers() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return []; }
}
function writeMembers(arr) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), 'utf8');
}
function thaiTime() {
    return new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

/* ── Middleware ── */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

/* ────────────────────────────────────────────────
   API: save complete game record
   Body: { memberId, product }
   Called from game.html after spin result
──────────────────────────────────────────────── */
app.post('/api/save', (req, res) => {
    const id      = (req.body.memberId || '').trim();
    const product = (req.body.product  || '-').trim();

    if (!id) return res.status(400).json({ error: 'กรุณากรอกรหัสสมาชิก' });

    /* หักสต๊อกสินค้าที่ได้รับ */
    if (product !== '-') {
        const stock = readStock();
        if (typeof stock[product] === 'number')
            stock[product] = Math.max(0, stock[product] - 1);
        writeStock(stock);
    }

    const members = readMembers();
    members.push({
        id,
        product,
        timestamp: new Date().toISOString(),
        time_th:   thaiTime(),
    });
    writeMembers(members);
    res.json({ success: true });
});

/* ────────────────────────────────────────────────
   API: stock levels (used by game.html on load)
──────────────────────────────────────────────── */
app.get('/api/stock', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(readStock());
});

/* ────────────────────────────────────────────────
   Admin: update stock
   POST /admin/stock  Body: { productName: qty, ... }
──────────────────────────────────────────────── */
app.post('/admin/stock', (req, res) => {
    const stock = readStock();
    Object.entries(req.body).forEach(([name, qty]) => {
        const n = parseInt(qty);
        if (!isNaN(n) && n >= 0) stock[name] = n;
    });
    writeStock(stock);
    res.json({ success: true, stock });
});

/* ────────────────────────────────────────────────
   API: check if member has already played
   GET /api/check/:id  →  { played: bool, product? }
──────────────────────────────────────────────── */
app.get('/api/check/:id', (req, res) => {
    const id = (req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'กรุณากรอกรหัสสมาชิก' });
    const members = readMembers();
    const found = members.find(m => m.id === id && m.product && m.product !== '-');
    if (found) return res.json({ played: true, product: found.product });
    return res.json({ played: false });
});

/* ── (legacy) register without product ── */
app.post('/api/register', (req, res) => {
    const id = (req.body.memberId || '').trim();
    if (!id) return res.status(400).json({ error: 'กรุณากรอกรหัสสมาชิก' });
    const members = readMembers();
    members.push({ id, product: '-', timestamp: new Date().toISOString(), time_th: thaiTime() });
    writeMembers(members);
    res.json({ success: true });
});

/* ────────────────────────────────────────────────
   Admin: JSON list (no password required)
──────────────────────────────────────────────── */
app.get('/admin/members', (req, res) => {
    const members = readMembers();
    res.json({ count: members.length, members });
});

/* ────────────────────────────────────────────────
   Admin: CSV export (no password required)
──────────────────────────────────────────────── */
app.get('/admin/export', (req, res) => {
    const members = readMembers();
    const csv = '﻿' +
        'ลำดับ,รหัสสมาชิก,สินค้าที่ได้รับ,วันที่-เวลา\n' +
        members.map((m, i) =>
            `${i + 1},"${m.id}","${m.product || '-'}","${m.time_th}"`
        ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
        `attachment; filename="sahagroup30_members_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
});

/* ────────────────────────────────────────────────
   Admin: HTML dashboard (no password required)
──────────────────────────────────────────────── */
app.get('/admin', (req, res) => {
    const pass = '';
    const members = readMembers();
    const stock   = readStock();

    /* stats */
    const total      = members.length;
    const played     = members.filter(m => m.product && m.product !== '-').length;
    const pending    = total - played;
    const totalStock = Object.values(stock).reduce((a,b)=>a+b, 0);

    /* stock cards */
    const stockCards = Object.entries(stock).map(([name, qty]) => {
        const border = qty === 0 ? '#dc3545' : qty <= 10 ? '#e67e22' : '#28a745';
        const label  = qty === 0 ? '⛔ หมด' : qty <= 10 ? '⚠️ น้อย' : '✅ พร้อม';
        return `<div style="background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 2px 8px rgba(0,0,0,.08);border-left:4px solid ${border}">
            <div style="font-size:.8em;color:#555;margin-bottom:8px;font-weight:700;line-height:1.3">${name}</div>
            <div style="display:flex;align-items:center;gap:8px">
                <input type="number" class="stock-input" data-name="${name.replace(/"/g,'&quot;')}" value="${qty}" min="0"
                       style="width:72px;padding:6px 4px;border:2px solid #ddd;border-radius:8px;font-family:'Kanit',sans-serif;font-weight:700;font-size:1.05em;text-align:center">
                <span style="font-size:.82em;font-weight:700;color:${border}">${label}</span>
            </div>
        </div>`;
    }).join('');

    /* product frequency */
    const freq = {};
    members.forEach(m => {
        if (m.product && m.product !== '-')
            freq[m.product] = (freq[m.product] || 0) + 1;
    });
    const topProduct = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0];

    const rows = [...members].reverse().map((m, i) => {
        const idx  = total - i;
        const hasProd = m.product && m.product !== '-';
        return `<tr>
            <td style="text-align:center">${idx}</td>
            <td><strong>${m.id}</strong></td>
            <td style="color:${hasProd?'#155d2f':'#aaa'}">
                ${hasProd ? '✅ ' + m.product : '⏳ ยังไม่เล่น'}
            </td>
            <td style="color:#888;font-size:.88em">${m.time_th}</td>
        </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin – สหกรุ๊ปแฟร์ 30</title>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;700;900&display=swap" rel="stylesheet">
<style>
  html{filter:saturate(0.7)}/* ช่วงไว้อาลัย */
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Kanit',sans-serif;background:#f0f6ff;padding:24px}
  header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px}
  h1{color:#C9200A;font-size:1.7em}
  .stat-row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:20px}
  .stat{background:#fff;border-radius:16px;padding:16px 24px;text-align:center;
        box-shadow:0 4px 12px rgba(0,0,0,.08);min-width:120px;flex:1}
  .stat .num{font-size:2em;font-weight:900;line-height:1}
  .stat .lbl{font-size:.78em;color:#666;margin-top:4px}
  .stat.red  .num{color:#C9200A}
  .stat.blue .num{color:#00349E}
  .stat.pink .num{color:#EC008C}
  .stat.green .num{color:#155d2f}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 22px;border-radius:30px;
       text-decoration:none;font-weight:700;font-size:.9em;cursor:pointer;border:none}
  .btn-green{background:linear-gradient(135deg,#28a745,#1e7e34);color:#fff}
  .btn-red  {background:linear-gradient(135deg,#ff5030,#C9200A);color:#fff}
  .btn-gray {background:#eee;color:#333}
  .search{padding:10px 18px;font-family:'Kanit',sans-serif;font-size:.95em;
          border:2px solid #ddd;border-radius:30px;width:260px;outline:none}
  .search:focus{border-color:#C9200A}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:16px;
        overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.09)}
  th{background:#C9200A;color:#fff;padding:13px 16px;text-align:left;font-size:.92em}
  td{padding:11px 16px;border-bottom:1px solid #f0f0f0;font-size:.92em}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fff8f8}
  .empty{text-align:center;color:#aaa;padding:32px}
  @media(max-width:600px){td:nth-child(4){display:none}th:nth-child(4){display:none}}
</style>
</head>
<body>

<header>
  <h1>📋 ระบบหลังบ้าน – Lucky Spin</h1>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <a class="btn btn-green" href="/admin/export?pass=${pass}">⬇ Export CSV</a>
    <a class="btn btn-red"   href="/admin?pass=${pass}">🔄 Refresh</a>
    <a class="btn btn-gray"  href="/">🏠 หน้าแรก</a>
  </div>
</header>

<!-- Stats -->
<div class="stat-row">
  <div class="stat red">  <div class="num">${total}</div>     <div class="lbl">สมาชิกทั้งหมด</div></div>
  <div class="stat green"><div class="num">${played}</div>    <div class="lbl">เล่นแล้ว</div></div>
  <div class="stat blue"> <div class="num">${pending}</div>   <div class="lbl">ยังไม่เล่น</div></div>
  <div class="stat pink"> <div class="num">${totalStock}</div><div class="lbl">สต๊อกรวม</div></div>
</div>

<!-- Stock Management -->
<div style="margin-bottom:20px">
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
    <h2 style="color:#C9200A;font-size:1.1em;font-weight:900">📦 จัดการสต๊อกสินค้า</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-gray" onclick="resetStock()">↺ รีเซ็ต 50 ทุกรายการ</button>
      <button class="btn btn-green" onclick="saveStock()">💾 บันทึกสต๊อก</button>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
    ${stockCards}
  </div>
</div>

<!-- Search -->
<div style="margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
  <input class="search" id="searchInput" type="text"
         placeholder="🔍 ค้นหารหัสสมาชิก หรือชื่อสินค้า..."
         oninput="filterTable()">
  <span id="countLabel" style="color:#666;font-size:.88em"></span>
</div>

<!-- Table -->
<table id="dataTable">
  <thead>
    <tr>
      <th style="width:50px">#</th>
      <th>รหัสสมาชิก</th>
      <th>สินค้าที่ได้รับ</th>
      <th>วันที่-เวลา</th>
    </tr>
  </thead>
  <tbody id="tbody">
    ${rows || '<tr><td colspan="4" class="empty">ยังไม่มีข้อมูล</td></tr>'}
  </tbody>
</table>

<p style="margin-top:14px;color:#aaa;font-size:.8em">
  แสดงรายการล่าสุดก่อน &nbsp;|&nbsp; Admin pass ตั้งค่าได้ผ่าน Railway env: <code>ADMIN_PASS</code>
</p>

<script>
async function saveStock(){
    const inputs = document.querySelectorAll('.stock-input');
    const body = {};
    inputs.forEach(inp => body[inp.dataset.name] = parseInt(inp.value)||0);
    const r = await fetch('/admin/stock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if((await r.json()).success){ location.reload(); }
}
function resetStock(){
    if(!confirm('รีเซ็ตสต๊อกทุกรายการเป็น 50?')) return;
    document.querySelectorAll('.stock-input').forEach(inp=>inp.value=50);
    saveStock();
}
function filterTable(){
    const q   = document.getElementById('searchInput').value.toLowerCase();
    const rows = document.querySelectorAll('#tbody tr');
    let shown = 0;
    rows.forEach(r => {
        const txt = r.textContent.toLowerCase();
        const ok  = !q || txt.includes(q);
        r.style.display = ok ? '' : 'none';
        if (ok) shown++;
    });
    document.getElementById('countLabel').textContent =
        q ? \`พบ \${shown} รายการ\` : '';
}
// update count on load
document.getElementById('countLabel').textContent = '';
</script>
</body></html>`);
});

app.listen(PORT, () => console.log(`✅  Server running on port ${PORT}`));
