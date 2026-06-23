const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cookieParser = require('cookie-parser');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

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

const MEMBERS_SHEET = 'Members';
const STOCK_SHEET = 'Stock';
const MEMBERS_HEADER = ['timestamp_iso', 'time_th', 'member_id', 'product', 'spin_id'];
const STOCK_HEADER = ['product', 'qty', 'updated_at'];
const ADMIN_COOKIE = 'sahagroup_admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || 'sahagroup30';
const SESSION_SECRET = process.env.SESSION_SECRET || 'local-development-session-secret';
const ALLOW_LEGACY_SAVE = process.env.ALLOW_LEGACY_SAVE === 'true';
const USE_MOCK_SHEETS = process.env.SHEETS_MOCK === 'true';

const staticDir = fs.existsSync(path.join(__dirname, 'static'))
    ? path.join(__dirname, 'static')
    : __dirname;

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));
app.use(cookieParser(SESSION_SECRET));

const publicApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(express.static(staticDir));

function defaultStock() {
    return PRODUCT_NAMES.reduce((stock, product) => {
        stock[product] = 50;
        return stock;
    }, {});
}

function thaiTime(date = new Date()) {
    return date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function csvEscape(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function normalizeMemberId(value) {
    return String(value || '').trim();
}

function jsonCell(value) {
    if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
    return { userEnteredValue: { stringValue: String(value ?? '') } };
}

function parseMembers(rows = []) {
    const body = rows[0]?.[0] === MEMBERS_HEADER[0] ? rows.slice(1) : rows;
    return body
        .filter(row => row && row.some(Boolean))
        .map(row => ({
            timestamp: row[0] || '',
            time_th: row[1] || '',
            id: normalizeMemberId(row[2]),
            product: row[3] || '-',
            spin_id: row[4] || '',
        }))
        .filter(row => row.id);
}

function parseStock(rows = []) {
    const body = rows[0]?.[0] === STOCK_HEADER[0] ? rows.slice(1) : rows;
    const stock = {};
    const rowIndexByProduct = {};

    body.forEach((row, offset) => {
        const product = String(row[0] || '').trim();
        if (!product) return;
        const qty = Number.parseInt(row[1], 10);
        stock[product] = Number.isFinite(qty) && qty >= 0 ? qty : 0;
        rowIndexByProduct[product] = offset + 1;
    });

    PRODUCT_NAMES.forEach((product, index) => {
        if (stock[product] === undefined) stock[product] = 50;
        if (rowIndexByProduct[product] === undefined) rowIndexByProduct[product] = index + 1;
    });

    return { stock, rowIndexByProduct };
}

function activeProductsFromStock(stock) {
    return PRODUCT_NAMES.filter(product => (stock[product] ?? 0) > 0);
}

function createMutex() {
    let current = Promise.resolve();
    return async function withLock(fn) {
        const previous = current;
        let release;
        current = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    };
}

class MinuteLimiter {
    constructor(limit) {
        this.limit = limit;
        this.timestamps = [];
    }

    async take() {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(ts => now - ts < 60_000);
        if (this.timestamps.length >= this.limit) {
            const waitMs = 60_000 - (now - this.timestamps[0]) + 25;
            await sleep(waitMs);
            return this.take();
        }
        this.timestamps.push(Date.now());
    }
}

class GoogleSheetsStore {
    constructor() {
        this.spreadsheetId = process.env.GOOGLE_SHEET_ID;
        this.clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
        this.privateKey = process.env.GOOGLE_PRIVATE_KEY
            ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
            : '';

        this.sheets = null;
        this.sheetIds = null;
        this.setupPromise = null;
        this.statePromise = null;
        this.stockPromise = null;
        this.membersPromise = null;
        this.stockCache = { value: null, rows: null, expiresAt: 0 };
        this.membersCache = { value: null, expiresAt: 0 };
        this.readLimiter = new MinuteLimiter(240);
        this.writeLimiter = new MinuteLimiter(45);
        this.withMutationLock = createMutex();
    }

    requireConfig() {
        const missing = [];
        if (!this.spreadsheetId) missing.push('GOOGLE_SHEET_ID');
        if (!this.clientEmail) missing.push('GOOGLE_CLIENT_EMAIL');
        if (!this.privateKey) missing.push('GOOGLE_PRIVATE_KEY');
        if (missing.length) {
            const err = new Error(`Missing Google Sheets configuration: ${missing.join(', ')}`);
            err.statusCode = 503;
            err.code = 'sheets_not_configured';
            throw err;
        }
    }

    getClient() {
        this.requireConfig();
        if (!this.sheets) {
            const auth = new google.auth.JWT({
                email: this.clientEmail,
                key: this.privateKey,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            this.sheets = google.sheets({ version: 'v4', auth });
        }
        return this.sheets;
    }

    async call(kind, fn) {
        const limiter = kind === 'write' ? this.writeLimiter : this.readLimiter;
        const retryDelays = [1000, 2000, 4000];
        let lastError;

        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
            await limiter.take();
            try {
                return await fn(this.getClient());
            } catch (err) {
                if (err.code === 'sheets_not_configured') throw err;
                lastError = err;
                const status = err.code || err.response?.status;
                const retryable = [429, 500, 503].includes(Number(status));
                if (!retryable || attempt === retryDelays.length) break;
                const jitter = Math.floor(Math.random() * 300);
                await sleep(retryDelays[attempt] + jitter);
            }
        }

        const wrapped = new Error('Google Sheets is busy');
        wrapped.statusCode = 503;
        wrapped.code = 'sheets_busy';
        wrapped.cause = lastError;
        throw wrapped;
    }

    async ensureSetup() {
        if (this.setupPromise) return this.setupPromise;
        this.setupPromise = this.ensureSetupInner().finally(() => {
            this.setupPromise = null;
        });
        return this.setupPromise;
    }

    async ensureSetupInner() {
        const metadata = await this.call('read', sheets => sheets.spreadsheets.get({
            spreadsheetId: this.spreadsheetId,
            fields: 'sheets(properties(sheetId,title))',
        }));

        const sheetIds = {};
        for (const sheet of metadata.data.sheets || []) {
            sheetIds[sheet.properties.title] = sheet.properties.sheetId;
        }

        const addRequests = [];
        if (sheetIds[MEMBERS_SHEET] === undefined) {
            addRequests.push({ addSheet: { properties: { title: MEMBERS_SHEET } } });
        }
        if (sheetIds[STOCK_SHEET] === undefined) {
            addRequests.push({ addSheet: { properties: { title: STOCK_SHEET } } });
        }

        if (addRequests.length) {
            await this.call('write', sheets => sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                requestBody: { requests: addRequests },
            }));
            return this.ensureSetupInner();
        }

        this.sheetIds = {
            members: sheetIds[MEMBERS_SHEET],
            stock: sheetIds[STOCK_SHEET],
        };

        const headerResult = await this.call('read', sheets => sheets.spreadsheets.values.batchGet({
            spreadsheetId: this.spreadsheetId,
            ranges: [`${MEMBERS_SHEET}!A1:E1`, `${STOCK_SHEET}!A1:C1`, `${STOCK_SHEET}!A2:C12`],
        }));
        const [membersHeader, stockHeader, stockRows] = headerResult.data.valueRanges || [];
        const requests = [];

        if ((membersHeader?.values?.[0]?.[0] || '') !== MEMBERS_HEADER[0]) {
            requests.push(this.updateCellsRequest(this.sheetIds.members, 0, 0, [MEMBERS_HEADER]));
        }

        if ((stockHeader?.values?.[0]?.[0] || '') !== STOCK_HEADER[0]) {
            const now = new Date().toISOString();
            requests.push(this.updateCellsRequest(
                this.sheetIds.stock,
                0,
                0,
                [
                    STOCK_HEADER,
                    ...PRODUCT_NAMES.map(product => [product, 50, now]),
                ],
            ));
        } else if (!(stockRows?.values || []).some(row => row?.[0])) {
            const now = new Date().toISOString();
            requests.push(this.updateCellsRequest(
                this.sheetIds.stock,
                1,
                0,
                PRODUCT_NAMES.map(product => [product, 50, now]),
            ));
        }

        if (requests.length) {
            await this.call('write', sheets => sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                requestBody: { requests },
            }));
        }
    }

    updateCellsRequest(sheetId, rowIndex, columnIndex, values) {
        return {
            updateCells: {
                range: {
                    sheetId,
                    startRowIndex: rowIndex,
                    endRowIndex: rowIndex + values.length,
                    startColumnIndex: columnIndex,
                    endColumnIndex: columnIndex + Math.max(...values.map(row => row.length)),
                },
                rows: values.map(row => ({ values: row.map(jsonCell) })),
                fields: 'userEnteredValue',
            },
        };
    }

    appendMemberRequest(member) {
        return {
            appendCells: {
                sheetId: this.sheetIds.members,
                rows: [{
                    values: [
                        member.timestamp,
                        member.time_th,
                        member.id,
                        member.product,
                        member.spin_id,
                    ].map(jsonCell),
                }],
                fields: 'userEnteredValue',
            },
        };
    }

    async getState(force = false) {
        const now = Date.now();
        const stockFresh = this.stockCache.value && this.stockCache.expiresAt > now;
        const membersFresh = this.membersCache.value && this.membersCache.expiresAt > now;
        if (!force && stockFresh && membersFresh) {
            return {
                stock: this.stockCache.value,
                stockRows: this.stockCache.rows,
                members: this.membersCache.value,
            };
        }

        if (this.statePromise) return this.statePromise;
        this.statePromise = this.fetchState().finally(() => {
            this.statePromise = null;
        });
        return this.statePromise;
    }

    async getStock(force = false) {
        const now = Date.now();
        if (!force && this.stockCache.value && this.stockCache.expiresAt > now) {
            return this.stockCache.value;
        }
        if (this.stockPromise) return this.stockPromise;
        this.stockPromise = this.fetchStock().finally(() => {
            this.stockPromise = null;
        });
        return this.stockPromise;
    }

    async getMembers(force = false) {
        const now = Date.now();
        if (!force && this.membersCache.value && this.membersCache.expiresAt > now) {
            return this.membersCache.value;
        }
        if (this.membersPromise) return this.membersPromise;
        this.membersPromise = this.fetchMembers().finally(() => {
            this.membersPromise = null;
        });
        return this.membersPromise;
    }

    async fetchState() {
        await this.ensureSetup();
        const response = await this.call('read', sheets => sheets.spreadsheets.values.batchGet({
            spreadsheetId: this.spreadsheetId,
            ranges: [`${MEMBERS_SHEET}!A:E`, `${STOCK_SHEET}!A:C`],
        }));
        const [membersRange, stockRange] = response.data.valueRanges || [];
        const members = parseMembers(membersRange?.values || []);
        const { stock, rowIndexByProduct } = parseStock(stockRange?.values || []);

        this.membersCache = { value: members, expiresAt: Date.now() + 15_000 };
        this.stockCache = { value: stock, rows: rowIndexByProduct, expiresAt: Date.now() + 5_000 };
        return { members, stock, stockRows: rowIndexByProduct };
    }

    async fetchStock() {
        await this.ensureSetup();
        const response = await this.call('read', sheets => sheets.spreadsheets.values.batchGet({
            spreadsheetId: this.spreadsheetId,
            ranges: [`${STOCK_SHEET}!A:C`],
        }));
        const { stock, rowIndexByProduct } = parseStock(response.data.valueRanges?.[0]?.values || []);
        this.stockCache = { value: stock, rows: rowIndexByProduct, expiresAt: Date.now() + 5_000 };
        return stock;
    }

    async fetchMembers() {
        await this.ensureSetup();
        const response = await this.call('read', sheets => sheets.spreadsheets.values.batchGet({
            spreadsheetId: this.spreadsheetId,
            ranges: [`${MEMBERS_SHEET}!A:E`],
        }));
        const members = parseMembers(response.data.valueRanges?.[0]?.values || []);
        this.membersCache = { value: members, expiresAt: Date.now() + 15_000 };
        return members;
    }

    async checkMember(id) {
        const members = await this.getMembers(false);
        return members.find(member => member.id === id && member.product && member.product !== '-');
    }

    async spin(id) {
        return this.withMutationLock(async () => {
            const state = await this.getState(true);
            const found = state.members.find(member => member.id === id && member.product && member.product !== '-');
            if (found) return { status: 'played', product: found.product };

            const activeProducts = activeProductsFromStock(state.stock);
            if (!activeProducts.length) return { status: 'out_of_stock' };

            const product = activeProducts[Math.floor(Math.random() * activeProducts.length)];
            const nextQty = Math.max(0, (state.stock[product] || 0) - 1);
            const now = new Date();
            const member = {
                timestamp: now.toISOString(),
                time_th: thaiTime(now),
                id,
                product,
                spin_id: crypto.randomUUID(),
            };
            const stockRowIndex = state.stockRows[product] ?? (PRODUCT_NAMES.indexOf(product) + 1);

            await this.call('write', sheets => sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                requestBody: {
                    requests: [
                        this.updateCellsRequest(
                            this.sheetIds.stock,
                            stockRowIndex,
                            0,
                            [[product, nextQty, now.toISOString()]],
                        ),
                        this.appendMemberRequest(member),
                    ],
                },
            }));

            const nextStock = { ...state.stock, [product]: nextQty };
            this.stockCache = {
                value: nextStock,
                rows: state.stockRows,
                expiresAt: Date.now() + 5_000,
            };
            this.membersCache = {
                value: [...state.members, member],
                expiresAt: Date.now() + 15_000,
            };

            return { status: 'ok', product, activeProducts };
        });
    }

    async register(id) {
        return this.withMutationLock(async () => {
            await this.ensureSetup();
            const now = new Date();
            const member = {
                timestamp: now.toISOString(),
                time_th: thaiTime(now),
                id,
                product: '-',
                spin_id: crypto.randomUUID(),
            };
            await this.call('write', sheets => sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                requestBody: { requests: [this.appendMemberRequest(member)] },
            }));
            this.membersCache.expiresAt = 0;
            return member;
        });
    }

    async legacySave(id, product) {
        return this.withMutationLock(async () => {
            const state = await this.getState(true);
            const found = state.members.find(member => member.id === id && member.product && member.product !== '-');
            if (found) return { status: 'played', product: found.product };

            const now = new Date();
            const member = {
                timestamp: now.toISOString(),
                time_th: thaiTime(now),
                id,
                product: product || '-',
                spin_id: crypto.randomUUID(),
            };
            const requests = [this.appendMemberRequest(member)];
            const nextStock = { ...state.stock };

            if (product && product !== '-' && state.stock[product] !== undefined) {
                nextStock[product] = Math.max(0, (state.stock[product] || 0) - 1);
                requests.unshift(this.updateCellsRequest(
                    this.sheetIds.stock,
                    state.stockRows[product] ?? (PRODUCT_NAMES.indexOf(product) + 1),
                    0,
                    [[product, nextStock[product], now.toISOString()]],
                ));
            }

            await this.call('write', sheets => sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                requestBody: { requests },
            }));

            this.stockCache = {
                value: nextStock,
                rows: state.stockRows,
                expiresAt: Date.now() + 5_000,
            };
            this.membersCache = {
                value: [...state.members, member],
                expiresAt: Date.now() + 15_000,
            };
            return { status: 'ok', product };
        });
    }

    async updateStock(patch) {
        return this.withMutationLock(async () => {
            const state = await this.getState(true);
            const now = new Date().toISOString();
            const nextStock = { ...state.stock };

            for (const [name, qty] of Object.entries(patch)) {
                const n = Number.parseInt(qty, 10);
                if (Number.isFinite(n) && n >= 0) nextStock[name] = n;
            }

            const orderedProducts = [
                ...PRODUCT_NAMES,
                ...Object.keys(nextStock).filter(product => !PRODUCT_NAMES.includes(product)).sort(),
            ];

            const rows = [
                STOCK_HEADER,
                ...orderedProducts.map(product => [product, nextStock[product] ?? 0, now]),
            ];

            await this.call('write', sheets => sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                requestBody: {
                    requests: [this.updateCellsRequest(this.sheetIds.stock, 0, 0, rows)],
                },
            }));

            const rowIndexByProduct = {};
            orderedProducts.forEach((product, index) => {
                rowIndexByProduct[product] = index + 1;
            });
            this.stockCache = {
                value: nextStock,
                rows: rowIndexByProduct,
                expiresAt: Date.now() + 5_000,
            };
            return nextStock;
        });
    }
}

class MockSheetsStore {
    constructor() {
        this.members = [];
        this.stock = defaultStock();
        this.withMutationLock = createMutex();
    }

    async getStock() {
        return { ...this.stock };
    }

    async getMembers() {
        return [...this.members];
    }

    async checkMember(id) {
        return this.members.find(member => member.id === id && member.product && member.product !== '-');
    }

    async spin(id) {
        return this.withMutationLock(async () => {
            const found = this.members.find(member => member.id === id && member.product && member.product !== '-');
            if (found) return { status: 'played', product: found.product };

            const activeProducts = activeProductsFromStock(this.stock);
            if (!activeProducts.length) return { status: 'out_of_stock' };

            const product = activeProducts[Math.floor(Math.random() * activeProducts.length)];
            this.stock[product] = Math.max(0, this.stock[product] - 1);
            const now = new Date();
            const member = {
                timestamp: now.toISOString(),
                time_th: thaiTime(now),
                id,
                product,
                spin_id: crypto.randomUUID(),
            };
            this.members.push(member);
            return { status: 'ok', product, activeProducts };
        });
    }

    async register(id) {
        const now = new Date();
        const member = {
            timestamp: now.toISOString(),
            time_th: thaiTime(now),
            id,
            product: '-',
            spin_id: crypto.randomUUID(),
        };
        this.members.push(member);
        return member;
    }

    async legacySave(id, product) {
        return this.withMutationLock(async () => {
            const found = this.members.find(member => member.id === id && member.product && member.product !== '-');
            if (found) return { status: 'played', product: found.product };
            if (product && product !== '-' && this.stock[product] !== undefined) {
                this.stock[product] = Math.max(0, this.stock[product] - 1);
            }
            const now = new Date();
            const member = {
                timestamp: now.toISOString(),
                time_th: thaiTime(now),
                id,
                product: product || '-',
                spin_id: crypto.randomUUID(),
            };
            this.members.push(member);
            return { status: 'ok', product };
        });
    }

    async updateStock(patch) {
        for (const [name, qty] of Object.entries(patch)) {
            const n = Number.parseInt(qty, 10);
            if (Number.isFinite(n) && n >= 0) this.stock[name] = n;
        }
        return { ...this.stock };
    }
}

const store = USE_MOCK_SHEETS ? new MockSheetsStore() : new GoogleSheetsStore();

function requireAdmin(req, res, next) {
    if (req.signedCookies?.[ADMIN_COOKIE] === 'ok') return next();
    if (req.accepts('html')) return res.redirect('/admin/login');
    return res.status(401).json({ error: 'unauthorized' });
}

function asyncRoute(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

app.get('/api/health', (req, res) => {
    res.json({ ok: true, storage: USE_MOCK_SHEETS ? 'mock' : 'google_sheets' });
});

app.get('/api/stock', publicApiLimiter, asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await store.getStock(false));
}));

app.get('/api/check/:id', publicApiLimiter, asyncRoute(async (req, res) => {
    const id = normalizeMemberId(req.params.id);
    if (!id) return res.status(400).json({ error: 'กรุณากรอกรหัสสมาชิก' });
    const found = await store.checkMember(id);
    if (found) return res.json({ played: true, product: found.product });
    return res.json({ played: false });
}));

app.post('/api/spin', publicApiLimiter, asyncRoute(async (req, res) => {
    const id = normalizeMemberId(req.body.memberId);
    if (!id) return res.status(400).json({ error: 'กรุณากรอกรหัสสมาชิก' });

    const result = await store.spin(id);
    if (result.status === 'played') {
        return res.status(409).json({ played: true, product: result.product });
    }
    if (result.status === 'out_of_stock') {
        return res.status(409).json({ error: 'out_of_stock' });
    }

    return res.json({
        success: true,
        product: result.product,
        activeProducts: result.activeProducts,
    });
}));

app.post('/api/save', publicApiLimiter, asyncRoute(async (req, res) => {
    if (!ALLOW_LEGACY_SAVE) {
        return res.status(410).json({
            error: 'legacy_save_disabled',
            message: 'Please reload and use the current spin flow.',
        });
    }

    const id = normalizeMemberId(req.body.memberId);
    const product = String(req.body.product || '-').trim();
    if (!id) return res.status(400).json({ error: 'กรุณากรอกรหัสสมาชิก' });

    const result = await store.legacySave(id, product);
    if (result.status === 'played') {
        return res.status(409).json({ played: true, product: result.product });
    }
    return res.json({ success: true });
}));

app.post('/api/register', publicApiLimiter, asyncRoute(async (req, res) => {
    const id = normalizeMemberId(req.body.memberId);
    if (!id) return res.status(400).json({ error: 'กรุณากรอกรหัสสมาชิก' });
    await store.register(id);
    res.json({ success: true });
}));

app.get('/admin/login', (req, res) => {
    if (req.signedCookies?.[ADMIN_COOKIE] === 'ok') return res.redirect('/admin');
    res.send(renderLogin());
});

app.post('/admin/login', adminLoginLimiter, (req, res) => {
    const pass = String(req.body.password || '');
    if (pass !== ADMIN_PASSWORD) {
        return res.status(401).send(renderLogin('รหัสผ่านไม่ถูกต้อง'));
    }
    res.cookie(ADMIN_COOKIE, 'ok', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        signed: true,
        maxAge: 12 * 60 * 60 * 1000,
    });
    return res.redirect('/admin');
});

app.post('/admin/logout', requireAdmin, (req, res) => {
    res.clearCookie(ADMIN_COOKIE);
    res.redirect('/admin/login');
});

app.get('/admin/members', requireAdmin, asyncRoute(async (req, res) => {
    const members = await store.getMembers(false);
    res.json({ count: members.length, members });
}));

app.get('/admin/export', requireAdmin, asyncRoute(async (req, res) => {
    const members = await store.getMembers(false);
    const csv = '\uFEFF' +
        'ลำดับ,รหัสสมาชิก,สินค้าที่ได้รับ,วันที่-เวลา,spin_id\n' +
        members.map((member, index) => [
            index + 1,
            member.id,
            member.product || '-',
            member.time_th,
            member.spin_id || '',
        ].map(csvEscape).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="sahagroup30_members_${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
}));

app.post('/admin/stock', requireAdmin, asyncRoute(async (req, res) => {
    const stock = await store.updateStock(req.body);
    res.json({ success: true, stock });
}));

app.get('/admin', requireAdmin, asyncRoute(async (req, res) => {
    const [members, stock] = await Promise.all([
        store.getMembers(false),
        store.getStock(false),
    ]);
    res.send(renderAdmin({ members, stock }));
}));

function renderLogin(error = '') {
    return `<!DOCTYPE html><html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login - Sahagroup Fair 30</title>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;700;900&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f0f6ff;font-family:'Kanit',sans-serif;padding:24px}
  .box{width:min(420px,100%);background:#fff;border-radius:16px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.12)}
  h1{margin:0 0 18px;color:#C9200A;font-size:1.5em}
  label{display:block;font-weight:700;margin-bottom:8px;color:#333}
  input{width:100%;padding:12px 14px;border:2px solid #ddd;border-radius:10px;font-family:'Kanit',sans-serif;font-size:1em}
  input:focus{outline:none;border-color:#C9200A}
  button{width:100%;margin-top:16px;border:0;border-radius:30px;padding:12px 18px;background:linear-gradient(135deg,#ff5030,#C9200A);color:#fff;font-family:'Kanit',sans-serif;font-weight:900;font-size:1em;cursor:pointer}
  .err{min-height:22px;color:#C9200A;font-weight:700;margin-top:10px}
</style>
</head>
<body>
  <form class="box" method="post" action="/admin/login">
    <h1>ระบบหลังบ้าน Lucky Spin</h1>
    <label for="password">รหัสผ่าน</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <div class="err">${escapeHtml(error)}</div>
    <button type="submit">เข้าสู่ระบบ</button>
  </form>
</body></html>`;
}

function renderAdmin({ members, stock }) {
    const total = members.length;
    const played = members.filter(member => member.product && member.product !== '-').length;
    const pending = total - played;
    const totalStock = Object.values(stock).reduce((sum, qty) => sum + (Number(qty) || 0), 0);

    const orderedProducts = [
        ...PRODUCT_NAMES,
        ...Object.keys(stock).filter(product => !PRODUCT_NAMES.includes(product)).sort(),
    ];

    const stockCards = orderedProducts.map(name => {
        const qty = Number(stock[name] || 0);
        const border = qty === 0 ? '#dc3545' : qty <= 10 ? '#e67e22' : '#28a745';
        const label = qty === 0 ? 'หมด' : qty <= 10 ? 'น้อย' : 'พร้อม';
        return `<div style="background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 2px 8px rgba(0,0,0,.08);border-left:4px solid ${border}">
            <div style="font-size:.8em;color:#555;margin-bottom:8px;font-weight:700;line-height:1.3">${escapeHtml(name)}</div>
            <div style="display:flex;align-items:center;gap:8px">
                <input type="number" class="stock-input" data-name="${escapeAttr(name)}" value="${qty}" min="0"
                       style="width:72px;padding:6px 4px;border:2px solid #ddd;border-radius:8px;font-family:'Kanit',sans-serif;font-weight:700;font-size:1.05em;text-align:center">
                <span style="font-size:.82em;font-weight:700;color:${border}">${label}</span>
            </div>
        </div>`;
    }).join('');

    const rows = [...members].reverse().map((member, index) => {
        const rowNumber = total - index;
        const hasProduct = member.product && member.product !== '-';
        return `<tr>
            <td style="text-align:center">${rowNumber}</td>
            <td><strong>${escapeHtml(member.id)}</strong></td>
            <td style="color:${hasProduct ? '#155d2f' : '#aaa'}">${hasProduct ? escapeHtml(member.product) : 'ยังไม่เล่น'}</td>
            <td style="color:#888;font-size:.88em">${escapeHtml(member.time_th)}</td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html><html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin - สหกรุ๊ปแฟร์ 30</title>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;700;900&display=swap" rel="stylesheet">
<style>
  html{filter:saturate(0.7)}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Kanit',sans-serif;background:#f0f6ff;padding:24px}
  header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px}
  h1{color:#C9200A;font-size:1.7em}
  .stat-row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:20px}
  .stat{background:#fff;border-radius:16px;padding:16px 24px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.08);min-width:120px;flex:1}
  .stat .num{font-size:2em;font-weight:900;line-height:1}
  .stat .lbl{font-size:.78em;color:#666;margin-top:4px}
  .stat.red .num{color:#C9200A}.stat.blue .num{color:#00349E}.stat.pink .num{color:#EC008C}.stat.green .num{color:#155d2f}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 22px;border-radius:30px;text-decoration:none;font-weight:700;font-size:.9em;cursor:pointer;border:none;font-family:'Kanit',sans-serif}
  .btn-green{background:linear-gradient(135deg,#28a745,#1e7e34);color:#fff}.btn-red{background:linear-gradient(135deg,#ff5030,#C9200A);color:#fff}.btn-gray{background:#eee;color:#333}
  .search{padding:10px 18px;font-family:'Kanit',sans-serif;font-size:.95em;border:2px solid #ddd;border-radius:30px;width:260px;outline:none}
  .search:focus{border-color:#C9200A}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.09)}
  th{background:#C9200A;color:#fff;padding:13px 16px;text-align:left;font-size:.92em}
  td{padding:11px 16px;border-bottom:1px solid #f0f0f0;font-size:.92em}
  tr:last-child td{border-bottom:none}tr:hover td{background:#fff8f8}
  .empty{text-align:center;color:#aaa;padding:32px}
  @media(max-width:600px){td:nth-child(4),th:nth-child(4){display:none}}
</style>
</head>
<body>
<header>
  <h1>ระบบหลังบ้าน - Lucky Spin</h1>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <a class="btn btn-green" href="/admin/export">Export CSV</a>
    <a class="btn btn-red" href="/admin">Refresh</a>
    <a class="btn btn-gray" href="/">หน้าแรก</a>
    <form method="post" action="/admin/logout" style="display:inline"><button class="btn btn-gray" type="submit">ออกจากระบบ</button></form>
  </div>
</header>

<div class="stat-row">
  <div class="stat red"><div class="num">${total}</div><div class="lbl">สมาชิกทั้งหมด</div></div>
  <div class="stat green"><div class="num">${played}</div><div class="lbl">เล่นแล้ว</div></div>
  <div class="stat blue"><div class="num">${pending}</div><div class="lbl">ยังไม่เล่น</div></div>
  <div class="stat pink"><div class="num">${totalStock}</div><div class="lbl">สต๊อกรวม</div></div>
</div>

<div style="margin-bottom:20px">
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
    <h2 style="color:#C9200A;font-size:1.1em;font-weight:900">จัดการสต๊อกสินค้า</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-gray" onclick="resetStock()">รีเซ็ต 50 ทุกรายการ</button>
      <button class="btn btn-green" onclick="saveStock()">บันทึกสต๊อก</button>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">${stockCards}</div>
</div>

<div style="margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
  <input class="search" id="searchInput" type="text" placeholder="ค้นหารหัสสมาชิก หรือชื่อสินค้า..." oninput="filterTable()">
  <span id="countLabel" style="color:#666;font-size:.88em"></span>
</div>

<table id="dataTable">
  <thead><tr><th style="width:50px">#</th><th>รหัสสมาชิก</th><th>สินค้าที่ได้รับ</th><th>วันที่-เวลา</th></tr></thead>
  <tbody id="tbody">${rows || '<tr><td colspan="4" class="empty">ยังไม่มีข้อมูล</td></tr>'}</tbody>
</table>

<p style="margin-top:14px;color:#aaa;font-size:.8em">ข้อมูลอ่าน/เขียนจาก Google Sheets</p>

<script>
async function saveStock(){
    const inputs = document.querySelectorAll('.stock-input');
    const body = {};
    inputs.forEach(input => body[input.dataset.name] = parseInt(input.value, 10) || 0);
    const response = await fetch('/admin/stock', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    if(response.ok){ location.reload(); return; }
    alert('บันทึกสต๊อกไม่สำเร็จ กรุณาลองใหม่');
}
function resetStock(){
    if(!confirm('รีเซ็ตสต๊อกทุกรายการเป็น 50?')) return;
    document.querySelectorAll('.stock-input').forEach(input => input.value = 50);
    saveStock();
}
function filterTable(){
    const query = document.getElementById('searchInput').value.toLowerCase();
    const rows = document.querySelectorAll('#tbody tr');
    let shown = 0;
    rows.forEach(row => {
        const ok = !query || row.textContent.toLowerCase().includes(query);
        row.style.display = ok ? '' : 'none';
        if (ok) shown++;
    });
    document.getElementById('countLabel').textContent = query ? \`พบ \${shown} รายการ\` : '';
}
</script>
</body></html>`;
}

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.statusCode || err.status || 500;
    const code = err.code || (status === 503 ? 'busy' : 'server_error');
    console.error(err);

    if (req.accepts('html') && !req.path.startsWith('/api/')) {
        return res.status(status).send(`<!DOCTYPE html><html lang="th"><meta charset="UTF-8"><body style="font-family:sans-serif;padding:24px"><h1>ไม่สามารถโหลดข้อมูลได้</h1><p>${escapeHtml(code)}</p><p><a href="/">กลับหน้าแรก</a></p></body></html>`);
    }

    const publicCode = code === 'sheets_not_configured'
        ? 'sheets_not_configured'
        : status === 503 ? 'busy' : code;
    return res.status(status === 503 ? 503 : status).json({
        error: publicCode,
    });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        if (USE_MOCK_SHEETS) console.log('Using in-memory mock Sheets store');
    });
}

module.exports = { app, PRODUCT_NAMES, defaultStock, parseMembers, parseStock };
