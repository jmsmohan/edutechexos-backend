const dns = require('dns');
// Override system DNS with Google's public resolvers to fix querySrv ECONNREFUSED
// on networks where the local DNS server blocks or misroutes SRV lookups.
try { dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']); } catch (_) {}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
// nodemailer replaced by Brevo HTTP API (no IP-whitelist issues)
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const JWT_SECRET = process.env.JWT_SECRET || 'edutechexos-jwt-secret-2026';
const JWT_EXPIRY = '7d';

// ── Brevo HTTP API helper (no SMTP / no IP whitelist needed) ─────────────────
async function sendBrevoEmail({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.error('[Brevo] BREVO_API_KEY not set'); return { ok: false }; }

  const fromRaw  = process.env.SMTP_FROM || 'EduTechExOS <edutechexos121@gmail.com>';
  const fromEmail = (fromRaw.match(/<(.+)>/) || [])[1] || fromRaw.trim();
  const fromName  = fromRaw.replace(/<.*>/, '').trim() || 'EduTechExOS';

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: fromName, email: fromEmail }, to, subject, htmlContent: html }),
  });
  if (!res.ok) { const b = await res.text(); console.error('[Brevo]', res.status, b); return { ok: false }; }
  return { ok: true };
}

const app = express();
const httpServer = http.createServer(app);

// Allow requests from the Vercel frontend and local dev
const ALLOWED_ORIGINS = [
  'https://edutechexos.vercel.app',

  /\.vercel\.app$/,           // any Vercel preview deploy
  /^http:\/\/localhost(:\d+)?$/,  // any localhost port (dev)
];

// Socket.IO server — same CORS rules as Express
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = ALLOWED_ORIGINS.some((o) =>
        typeof o === 'string' ? o === origin : o.test(origin)
      );
      if (allowed) return callback(null, true);
      callback(new Error(`CORS policy: origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

io.on('connection', (socket) => {
  // Client joins a channel room so it only receives messages for that channel
  socket.on('join_channel', (channelId) => {
    socket.join(channelId);
  });

  socket.on('leave_channel', (channelId) => {
    socket.leave(channelId);
  });

  socket.on('disconnect', () => {
    // rooms are automatically cleaned up on disconnect
  });
});

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, Render health-check)
    if (!origin) return callback(null, true);
    const allowed = ALLOWED_ORIGINS.some((o) =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (allowed) return callback(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// Handle OPTIONS preflight for all routes (required for requests with
// Content-Type: application/json or Authorization headers)
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());

// --- 1. MongoDB Connection ---
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.warn('WARNING: MONGODB_URI environment variable is missing. DB routes will fail.');
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas'))
  .catch((err) => {
    console.error('Failed to connect to MongoDB Atlas (non-fatal):', err);
    // Continue without exiting; DB-dependent routes may fail gracefully
  });

// --- 2. Schemas & Models ---
const MessageSchema = new mongoose.Schema(
  {
    clientId:    { type: String },
    channelId:   { type: String, required: true, index: true },
    sender:      { type: String, required: true },
    senderEmail: { type: String, index: true },
    initials:    { type: String, required: true },
    color:       { type: String, required: true },
    text:        { type: String, required: true },
    timestamp:   { type: Date, default: Date.now },
    // ── optional message payload fields ──────────────────────────────
    audioUrl:    { type: String },
    videoUrl:    { type: String },
    files:       [{ name: String, url: String, type: String }],
    editedAt:    { type: Date },
    parentId:    { type: String },
    reactions:   { type: mongoose.Schema.Types.Mixed, default: {} },
    poll:        { type: mongoose.Schema.Types.Mixed },
    linkPreview: { type: mongoose.Schema.Types.Mixed },
  },
  // strict: false → any extra fields the client sends are stored as-is
  // so future message types never get silently dropped
  { strict: false }
);
const Message = mongoose.model('Message', MessageSchema);

// ── Hardcoded accounts (never touch the DB) ──────────────────────────────────
const VALID_ACCOUNTS = [
  { email: 'admin@edutechex.in',     password: 'Admin@2026',    name: 'Admin',            role: 'Admin'    },
  { email: 'aditya@edutechex.in',    password: 'TeamOS@2026',   name: 'Aditya Cherikuri', role: 'Manager'  },
  { email: 'dev.rk@edutechex.in',    password: 'DevAccess#26',  name: 'Developer RK',     role: 'Developer'},
  { email: 'design.sa@edutechex.in', password: 'Design$2026',   name: 'Designer SA',      role: 'Designer' },
  { email: 'mohan.kumar@edutechex.in',  password: 'MohanK@2026', name: 'Mohan K.', role: 'Member' },
  { email: 'mohan.reddy@edutechex.in',  password: 'MohanR@2026', name: 'Mohan R.', role: 'Member' },
  { email: 'mohan.sen@edutechex.in',    password: 'MohanS@2026', name: 'Mohan S.', role: 'Member' },
];

const AccessRequestSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  email:       { type: String, required: true, index: true },
  password:    { type: String, required: true },
  role:        { type: String, required: true },
  status:      { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedAt: { type: Date, default: Date.now },
});
const AccessRequest = mongoose.model('AccessRequest', AccessRequestSchema);

// ── Password reset codes (TTL: 15 min) ──────────────────────────────────────
const ResetCodeSchema = new mongoose.Schema({
  email:     { type: String, required: true, index: true },
  code:      { type: String, required: true },
  expiresAt: { type: Date,   required: true },
  used:      { type: Boolean, default: false },
});
const ResetCode = mongoose.model('ResetCode', ResetCodeSchema);

const KanbanTaskSchema = new mongoose.Schema(
  {
    text:             { type: String, required: true },
    assignee:         { type: String, required: true },
    assigneeEmail:    { type: String, index: true },
    assigneeInitials: { type: String, required: true },
    sourceChannel:    { type: String, required: true },
    status:           { type: String, enum: ['todo', 'inprogress', 'done'], default: 'todo' },
    createdAt:        { type: Date, default: Date.now },
  },
  { strict: false }
);
const KanbanTask = mongoose.model('KanbanTask', KanbanTaskSchema);

const WikiPageSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  channelId: { type: String, required: true, index: true },
  title: { type: String, required: true },
  content: { type: String, required: true },
  createdBy: { type: String, index: true },
}, {
  timestamps: true
});
const WikiPage = mongoose.model('WikiPage', WikiPageSchema);

// Bookmark schema — persisted per-user on backend
const BookmarkSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, index: true },
  messageId: { type: String, required: true },
  channelId: { type: String, required: true },
  text:      { type: String, default: '' },
  sender:    { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
}, { timestamps: true });
BookmarkSchema.index({ userEmail: 1, messageId: 1 }, { unique: true });
const Bookmark = mongoose.model('Bookmark', BookmarkSchema);

const NotificationSchema = new mongoose.Schema({
  type: { type: String, default: 'mention' },
  actor: { type: String, required: true },
  actorInitials: { type: String, default: '' },
  actorColor: { type: String, default: '#4f46e5' },
  message: { type: String, required: true },
  channel: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  recipientEmails: [{ type: String }],
});
const Notification = mongoose.model('Notification', NotificationSchema);

// ── Auth middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded; // { email, name, role }
    } catch (err) {
      // Token invalid — continue without auth, will fall back to query params
    }
  }
  next();
}

function getUserEmail(req) {
  // Prefer JWT-authenticated user, fall back to query/body param
  if (req.user && req.user.email) return req.user.email.toLowerCase();
  if (req.query.userEmail) return String(req.query.userEmail).toLowerCase();
  if (req.body && req.body.userEmail) return String(req.body.userEmail).toLowerCase();
  return null;
}

// --- 3. API Endpoints ---

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Apply auth middleware to all /api/* routes except auth endpoints
app.use(/^\/api\/(?!auth\/|access-requests|digest|health).*/, authMiddleware);

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// POST /api/access-requests — user submits signup request
app.post('/api/access-requests', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const emailClean = String(email).trim().toLowerCase();

    // Don't let someone shadow a hardcoded account
    if (VALID_ACCOUNTS.some((a) => a.email === emailClean)) {
      return res.status(409).json({ success: false, error: 'This email is already registered as a system account.' });
    }

    const existing = await AccessRequest.findOne({ email: emailClean }).lean();
    if (existing) {
      return res.json({
        success: true,
        exists: true,
        status: existing.status,
        message:
          existing.status === 'approved'
            ? 'Your access is approved. You can sign in now.'
            : existing.status === 'rejected'
            ? 'Your previous request was declined. Please contact admin.'
            : 'Your access request is already waiting for admin approval.',
      });
    }

    const request = new AccessRequest({ name, email: emailClean, password, role });
    const saved = await request.save();
    const { _id, __v, ...rest } = saved.toObject();
    res.json({
      success: true,
      request: {
        ...rest,
        id: _id.toString(),
        requestedAt: rest.requestedAt instanceof Date ? rest.requestedAt.toISOString() : rest.requestedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/access-requests — admin fetches all requests
app.get('/api/access-requests', async (req, res) => {
  try {
    const requests = await AccessRequest.find({}).sort({ requestedAt: -1 }).lean();
    const formatted = requests.map(({ _id, __v, ...rest }) => ({
      ...rest,
      id: _id.toString(),
      requestedAt: rest.requestedAt instanceof Date ? rest.requestedAt.toISOString() : rest.requestedAt,
    }));
    res.json({ success: true, requests: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PATCH /api/access-requests/:id — admin approves or rejects
app.patch('/api/access-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'approved' | 'rejected'
    const updated = await AccessRequest.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ success: false, error: 'Request not found' });
    const { _id, __v, ...rest } = updated;
    res.json({
      success: true,
      request: {
        ...rest,
        id: _id.toString(),
        requestedAt: rest.requestedAt instanceof Date ? rest.requestedAt.toISOString() : rest.requestedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE /api/access-requests/:id — admin removes a request
app.delete('/api/access-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await AccessRequest.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/auth/login — validate credentials, returns user object
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'invalid', message: 'Email and password are required.' });
    }
    const emailClean = String(email).trim().toLowerCase();

    // 1. Check hardcoded accounts first
    const hardcoded = VALID_ACCOUNTS.find((a) => a.email === emailClean && a.password === password);
    if (hardcoded) {
      const token = jwt.sign(
        { email: hardcoded.email, name: hardcoded.name, role: hardcoded.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      );
      return res.json({ success: true, user: hardcoded, token });
    }

    // 2. Check DB access requests
    const request = await AccessRequest.findOne({ email: emailClean }).lean();

    if (!request) {
      return res.status(401).json({ success: false, error: 'invalid', message: 'Invalid credentials. Use an approved user account.' });
    }
    if (request.password !== password) {
      return res.status(401).json({ success: false, error: 'invalid', message: 'Invalid credentials. Use an approved user account.' });
    }
    if (request.status === 'pending') {
      return res.status(401).json({ success: false, error: 'pending', message: 'Your request is waiting for admin approval.' });
    }
    if (request.status === 'rejected') {
      return res.status(401).json({ success: false, error: 'rejected', message: 'Your access request was declined. Contact admin.' });
    }

    // Approved ✓
    const token = jwt.sign(
      { email: request.email, name: request.name, role: request.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );
    return res.json({
      success: true,
      user: { email: request.email, name: request.name, role: request.role },
      token,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Helper: send password-reset email via Brevo API ──────────────────────────
async function sendResetEmail(toEmail, toName, code) {
  const html = `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:32px;">
      <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#4f46e5,#3b82f6);color:#fff;padding:24px 28px;">
          <h1 style="margin:0;font-size:22px;">EduTechEx<span style="color:#93c5fd;">OS</span></h1>
          <p style="margin:6px 0 0;color:#e0e7ff;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Password Reset</p>
        </div>
        <div style="padding:28px;">
          <p style="margin:0 0 16px;color:#334155;font-size:15px;">Hello ${toName},</p>
          <p style="margin:0 0 20px;color:#334155;font-size:15px;">Use the code below to reset your password — it expires in <strong>15 minutes</strong>.</p>
          <div style="letter-spacing:8px;font-size:32px;font-weight:800;color:#4f46e5;background:#eef2ff;border-radius:14px;padding:18px;text-align:center;margin-bottom:24px;">${code}</div>
          <p style="margin:0;color:#64748b;font-size:13px;">If you didn't request this, ignore this email.</p>
        </div>
        <div style="background:#f8fafc;padding:16px 28px;border-top:1px solid #f1f5f9;text-align:center;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">&copy; 2026 EduTechExOS</div>
      </div>
    </div>`;

  const { ok } = await sendBrevoEmail({ to: [{ email: toEmail, name: toName }], subject: `EduTechExOS: Password reset code ${code}`, html });
  return { ok };
}

// POST /api/auth/forgot-password — generate + email a 6-digit reset code
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required.' });
    const emailClean = String(email).trim().toLowerCase();

    // Hardcoded system accounts cannot self-reset
    if (VALID_ACCOUNTS.some((a) => a.email === emailClean)) {
      return res.status(400).json({
        success: false,
        error: 'System accounts cannot reset their password via this form. Contact admin directly.',
      });
    }

    // Use same generic message regardless of whether email is registered (prevents enumeration)
    const GENERIC_OK = 'If this email is registered, a reset code has been sent.';
    const request = await AccessRequest.findOne({ email: emailClean }).lean();
    if (!request) return res.json({ success: true, message: GENERIC_OK });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Remove any old unused codes for this email
    await ResetCode.deleteMany({ email: emailClean });
    await new ResetCode({ email: emailClean, code, expiresAt }).save();

    const { testUrl } = await sendResetEmail(emailClean, request.name, code);

    res.json({
      success: true,
      message: GENERIC_OK,
      ...(testUrl ? { previewUrl: testUrl } : {}),
    });
  } catch (err) {
    console.error('[forgot-password]', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/auth/reset-password — validate code + update password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ success: false, error: 'Email, code, and new password are required.' });
    }
    const emailClean = String(email).trim().toLowerCase();

    const resetCode = await ResetCode.findOne({ email: emailClean, code: String(code), used: false }).lean();
    if (!resetCode) {
      return res.status(400).json({ success: false, error: 'Invalid or expired reset code.' });
    }
    if (new Date(resetCode.expiresAt) < new Date()) {
      await ResetCode.findByIdAndDelete(resetCode._id);
      return res.status(400).json({ success: false, error: 'Reset code has expired. Please request a new one.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }

    await AccessRequest.findOneAndUpdate({ email: emailClean }, { $set: { password: newPassword } });
    await ResetCode.findByIdAndUpdate(resetCode._id, { $set: { used: true } });

    res.json({ success: true, message: 'Password reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('[reset-password]', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/auth/change-password — verify current password then set a new one
app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;
    if (!email || !currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Email, current password, and new password are required.' });
    }
    const emailClean = String(email).trim().toLowerCase();

    // Hardcoded system accounts cannot self-change password
    if (VALID_ACCOUNTS.some((a) => a.email === emailClean)) {
      return res.status(400).json({
        success: false,
        error: 'System accounts cannot change their password here. Ask the admin to update it directly.',
      });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters.' });
    }

    const request = await AccessRequest.findOne({ email: emailClean }).lean();
    if (!request) {
      return res.status(404).json({ success: false, error: 'Account not found.' });
    }
    if (request.password !== currentPassword) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect.' });
    }

    await AccessRequest.findOneAndUpdate({ email: emailClean }, { $set: { password: newPassword } });
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    console.error('[change-password]', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Email Digest ─────────────────────────────────────────────────────────────
//
// Builds and sends a daily digest email to all team members covering:
//  • Message count per channel (last 24 h)
//  • Open Kanban tasks
//  • Upcoming scheduled meetings
//
// POST /api/digest  — trigger manually (admin use / testing)
// Cron             — fires automatically every day at 09:00 IST (03:30 UTC)

async function buildDigestHtml(since) {
  const sinceDate = since || new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Recent messages grouped by channel
  const recentMsgs = await Message.find({ timestamp: { $gte: sinceDate } }).lean();
  const byChannel = {};
  recentMsgs.forEach((m) => {
    byChannel[m.channelId] = (byChannel[m.channelId] || 0) + 1;
  });
  const channelRows = Object.entries(byChannel)
    .sort(([, a], [, b]) => b - a)
    .map(([ch, cnt]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;">#${ch}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-weight:700;color:#4f46e5;">${cnt}</td></tr>`)
    .join('');

  // Open Kanban tasks
  const openTasks = await KanbanTask.find({ status: { $ne: 'done' } }).lean();
  const taskRows = openTasks.slice(0, 10)
    .map((t) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;">${t.text.slice(0, 80)}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;">${t.assignee}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;"><span style="background:${t.status==='inprogress'?'#dbeafe':'#fef9c3'};color:${t.status==='inprogress'?'#1d4ed8':'#854d0e'};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">${t.status}</span></td></tr>`)
    .join('');

  // Upcoming meetings (messages starting with "Meeting Scheduled:")
  const upcomingMeetings = await Message.find({ text: /^Meeting Scheduled:/, timestamp: { $gte: sinceDate } }).lean();
  const meetingRows = upcomingMeetings
    .map((m) => {
      const title = (m.text.match(/Meeting Scheduled:\s*(.+)/) || [])[1] || 'Meeting';
      const time  = (m.text.match(/Time:\s*(.+)/)             || [])[1] || '';
      const link  = (m.text.match(/Join Link:\s*(https?:\/\/\S+)/) || [])[1] || '#';
      return `<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;">${title}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;">${time}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;"><a href="${link}" style="color:#4f46e5;font-weight:700;">Join →</a></td></tr>`;
    })
    .join('');

  const dateLabel = sinceDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  return `
  <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:32px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden;">
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#1a3a2a,#4f46e5);padding:24px 28px;">
        <p style="margin:0;color:#a5f3fc;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">EduTechExOS</p>
        <h1 style="margin:6px 0 0;font-size:22px;color:#fff;">Daily Digest</h1>
        <p style="margin:4px 0 0;color:#c7d2fe;font-size:13px;">${dateLabel}</p>
      </div>

      <!-- Channel activity -->
      <div style="padding:24px 28px 0;">
        <h2 style="margin:0 0 12px;font-size:14px;font-weight:800;color:#1e293b;text-transform:uppercase;letter-spacing:1px;">📣 Channel Activity (last 24 h)</h2>
        ${channelRows ? `<table style="width:100%;border-collapse:collapse;font-size:13px;"><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Channel</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Messages</th></tr>${channelRows}</table>` : '<p style="font-size:13px;color:#94a3b8;">No messages in the last 24 hours.</p>'}
      </div>

      <!-- Open tasks -->
      <div style="padding:24px 28px 0;">
        <h2 style="margin:0 0 12px;font-size:14px;font-weight:800;color:#1e293b;text-transform:uppercase;letter-spacing:1px;">📋 Open Tasks (${openTasks.length})</h2>
        ${taskRows ? `<table style="width:100%;border-collapse:collapse;font-size:13px;"><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Task</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;">Assignee</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;">Status</th></tr>${taskRows}</table>` : '<p style="font-size:13px;color:#94a3b8;">No open tasks right now 🎉</p>'}
      </div>

      <!-- Meetings -->
      <div style="padding:24px 28px;">
        <h2 style="margin:0 0 12px;font-size:14px;font-weight:800;color:#1e293b;text-transform:uppercase;letter-spacing:1px;">📅 Meetings Scheduled</h2>
        ${meetingRows ? `<table style="width:100%;border-collapse:collapse;font-size:13px;"><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;">Title</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;">Time</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;">Link</th></tr>${meetingRows}</table>` : '<p style="font-size:13px;color:#94a3b8;">No meetings scheduled recently.</p>'}
      </div>

      <!-- Footer -->
      <div style="background:#f8fafc;padding:16px 28px;border-top:1px solid #f1f5f9;text-align:center;font-size:11px;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">&copy; 2026 EduTechExOS &middot; Internal Team OS</div>
    </div>
  </div>`;
}

async function sendDigestEmails(since) {
  const html = await buildDigestHtml(since);
  const to = VALID_ACCOUNTS.map((a) => ({ email: a.email, name: a.name }));
  const subject = `EduTechExOS: Daily Team Digest — ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  const { ok } = await sendBrevoEmail({ to, subject, html });
  const recipients = to.map((r) => r.email).join(', ');
  console.log(`[digest] Brevo send ${ok ? 'OK' : 'FAILED'} → ${recipients}`);
  return { recipients };
}

// POST /api/digest — manual trigger (admin / testing)
app.post('/api/digest', async (req, res) => {
  try {
    const since = req.body.since ? new Date(req.body.since) : undefined;
    const result = await sendDigestEmails(since);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[digest]', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Cron: send digest daily at 09:00 IST = 03:30 UTC ─────────────────────────
// Uses a simple setInterval (≈ 24 h) so we don't need an extra npm package.
// For precise scheduling install node-cron and replace this block.
(function scheduleDailyDigest() {
  function msUntilNext0330UTC() {
    const now  = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 30, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function arm() {
    const delay = msUntilNext0330UTC();
    console.log(`[digest-cron] Next digest in ${Math.round(delay / 60000)} min`);
    setTimeout(async () => {
      try {
        const result = await sendDigestEmails();
        console.log(`[digest-cron] Digest sent → ${result.recipients}`);
        if (result.testUrl) console.log(`[digest-cron] Preview: ${result.testUrl}`);
      } catch (err) {
        console.error('[digest-cron] Failed:', err);
      }
      arm(); // schedule the next day
    }, delay);
  }

  arm();
})();

// ─── Message Routes ────────────────────────────────────────────────────────────

// GET Messages (grouped by channel — shared, not filtered per-user)
app.get('/api/messages', async (req, res) => {
  try {
    const requestingUser = getUserEmail(req);
    const messages = await Message.find({}).sort({ timestamp: 1 }).lean();
    const grouped = {};
    for (const msg of messages) {
      const channelId = msg.channelId;
      if (!grouped[channelId]) grouped[channelId] = [];
      const { _id, __v, ...rest } = msg;

      // Skip messages hidden for this specific user
      if (requestingUser && (rest.deletedForUsers || []).includes(requestingUser)) continue;

      // Soft-deleted for everyone — return placeholder (WhatsApp style)
      if (rest.deletedForEveryone) {
        grouped[channelId].push({
          id: _id.toString(),
          channelId,
          sender: rest.sender,
          initials: rest.initials,
          color: rest.color,
          timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
          parentId: rest.parentId,
          isDeleted: true,
          text: '',
        });
        continue;
      }

      grouped[channelId].push({
        ...rest,
        id: _id.toString(),
        timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
        ...(rest.editedAt ? { editedAt: rest.editedAt instanceof Date ? rest.editedAt.toISOString() : rest.editedAt } : {}),
      });
    }
    res.json({ success: true, messages: grouped });
  } catch (err) {
    console.error('[GET /api/messages] Error:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST Message
app.post('/api/messages', async (req, res) => {
  try {
    const { id, ...messageData } = req.body;
    const userEmail = getUserEmail(req);
    // Attach senderEmail from auth if not already provided
    if (userEmail && !messageData.senderEmail) {
      messageData.senderEmail = userEmail;
    }
    const newMessage = new Message({
      ...messageData,
      clientId: id,
    });
    const savedMsg = await newMessage.save();
    const { _id, __v, ...rest } = savedMsg.toObject();
    const payload = {
      ...rest,
      id: _id.toString(),
      timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
      ...(rest.editedAt ? { editedAt: rest.editedAt instanceof Date ? rest.editedAt.toISOString() : rest.editedAt } : {}),
    };

    // Broadcast to all clients subscribed to this channel room (including sender)
    io.to(payload.channelId).emit('new_message', { channelId: payload.channelId, message: payload });

    res.json({ success: true, message: payload });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE Message — soft-delete by default; ?hard=true for admin permanent delete
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { scope, userEmail, hard } = req.query;

    if (hard === 'true') {
      const msg = await Message.findByIdAndDelete(id).lean();
      if (msg) io.to(msg.channelId).emit('message_deleted', { channelId: msg.channelId, messageId: id });
      return res.json({ success: true, deleted: 'permanent' });
    }

    if (scope === 'me' && userEmail) {
      await Message.findByIdAndUpdate(id, { $addToSet: { deletedForUsers: userEmail } });
      return res.json({ success: true, deleted: 'for-me' });
    }

    // Default: soft-delete for everyone
    const updated = await Message.findByIdAndUpdate(
      id,
      { deletedAt: new Date(), deletedForEveryone: true, deletedBy: userEmail || 'unknown' },
      { new: true }
    ).lean();

    if (updated) {
      // Broadcast so other clients immediately show the "deleted" placeholder
      io.to(updated.channelId).emit('message_deleted', { channelId: updated.channelId, messageId: id });
    }

    res.json({ success: true, deleted: 'for-everyone' });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PATCH Message — partial update: text edit, reactions, poll votes
app.patch('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body; // { text, editedAt } | { reactions } | { poll }

    const updated = await Message.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    const { _id, __v, ...rest } = updated;
    const payload = {
      ...rest,
      id: _id.toString(),
      timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
      ...(rest.editedAt ? { editedAt: rest.editedAt instanceof Date ? rest.editedAt.toISOString() : rest.editedAt } : {}),
    };

    // Real-time broadcast so other clients see the change immediately
    io.to(payload.channelId).emit('message_updated', { channelId: payload.channelId, message: payload });

    res.json({ success: true, message: payload });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET Kanban Tasks (filtered by user)
app.get('/api/kanban', async (req, res) => {
  try {
    const requestingUser = getUserEmail(req);
    const filter = requestingUser
      ? { $or: [{ assigneeEmail: requestingUser }, { assigneeEmail: { $exists: false } }, { assigneeEmail: null }] }
      : {};
    const tasks = await KanbanTask.find(filter).sort({ createdAt: 1 }).lean();
    const formatted = tasks.map(({ _id, __v, ...rest }) => ({
      ...rest,
      id: _id.toString(),
      createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
    }));
    res.json({ success: true, tasks: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST Kanban Task
app.post('/api/kanban', async (req, res) => {
  try {
    const userEmail = getUserEmail(req);
    const body = { ...req.body };
    if (userEmail && !body.assigneeEmail) {
      body.assigneeEmail = userEmail;
    }
    const task = new KanbanTask(body);
    const saved = await task.save();
    const { _id, __v, ...rest } = saved.toObject();
    res.json({
      success: true,
      task: {
        ...rest,
        id: _id.toString(),
        createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PATCH Kanban Task (update status or other fields)
app.patch('/api/kanban/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await KanbanTask.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ success: false, error: 'Task not found' });
    const { _id, __v, ...rest } = updated;
    res.json({
      success: true,
      task: {
        ...rest,
        id: _id.toString(),
        createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE Kanban Task
app.delete('/api/kanban/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await KanbanTask.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET Wiki Pages (filtered by user)
app.get('/api/wikipages', async (req, res) => {
  try {
    const requestingUser = getUserEmail(req);
    const filter = requestingUser
      ? { $or: [{ createdBy: requestingUser }, { createdBy: { $exists: false } }, { createdBy: null }] }
      : {};
    const pages = await WikiPage.find(filter).sort({ updatedAt: -1 }).lean();
    const formatted = pages.map((p) => {
      return {
        id: p._id,
        channelId: p.channelId,
        title: p.title,
        content: p.content,
        createdAt: p.createdAt ? p.createdAt.toISOString() : new Date().toISOString(),
        updatedAt: p.updatedAt ? p.updatedAt.toISOString() : new Date().toISOString(),
      };
    });
    res.json({ success: true, pages: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST/UPSERT Wiki Page
app.post('/api/wikipages', async (req, res) => {
  try {
    const { id, channelId, title, content } = req.body;
    const userEmail = getUserEmail(req);
    const updateFields = { 
      channelId, 
      title, 
      content,
      updatedAt: new Date()
    };
    // Only set createdBy on insert (not on update)
    if (userEmail) {
      updateFields.createdBy = userEmail;
    }
    const updated = await WikiPage.findOneAndUpdate(
      { _id: id },
      updateFields,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    
    const { _id, ...rest } = updated;
    res.json({
      success: true,
      page: {
        ...rest,
        id: _id,
        createdAt: updated.createdAt ? updated.createdAt.toISOString() : new Date().toISOString(),
        updatedAt: updated.updatedAt ? updated.updatedAt.toISOString() : new Date().toISOString(),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE Wiki Page
app.delete('/api/wikipages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await WikiPage.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Bookmarks ────────────────────────────────────────────────────────────────

// GET Bookmarks for the authenticated user
app.get('/api/bookmarks', async (req, res) => {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'userEmail required' });
    }
    const bookmarks = await Bookmark.find({ userEmail }).sort({ timestamp: -1 }).lean();
    const formatted = bookmarks.map(({ _id, __v, ...rest }) => ({
      ...rest,
      id: _id.toString(),
      timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
    }));
    res.json({ success: true, bookmarks: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST Bookmark (toggle — if exists, remove; otherwise add)
app.post('/api/bookmarks/toggle', async (req, res) => {
  try {
    const userEmail = getUserEmail(req);
    const { messageId, channelId, text, sender, timestamp } = req.body;
    if (!userEmail || !messageId) {
      return res.status(400).json({ success: false, error: 'userEmail and messageId required' });
    }
    const existing = await Bookmark.findOne({ userEmail, messageId }).lean();
    if (existing) {
      await Bookmark.deleteOne({ userEmail, messageId });
      return res.json({ success: true, bookmarked: false });
    }
    const bookmark = new Bookmark({ userEmail, messageId, channelId, text, sender, timestamp });
    await bookmark.save();
    res.json({ success: true, bookmarked: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE Bookmark
app.delete('/api/bookmarks/:id', async (req, res) => {
  try {
    const userEmail = getUserEmail(req);
    const { id } = req.params;
    const bookmark = await Bookmark.findOneAndDelete({ _id: id, userEmail });
    if (!bookmark) {
      return res.status(404).json({ success: false, error: 'Bookmark not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Notifications ────────────────────────────────────────────────────────────

// GET Notifications (for a specific recipient email)
app.get('/api/notifications', async (req, res) => {
  try {
    const email = getUserEmail(req) || req.query.email;
    const query = email
      ? { $or: [{ recipientEmails: { $size: 0 } }, { recipientEmails: email.toLowerCase() }] }
      : {};
    const notifs = await Notification.find(query).sort({ timestamp: -1 }).limit(60).lean();
    const formatted = notifs.map(({ _id, __v, ...rest }) => ({
      ...rest,
      id: _id.toString(),
      timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
    }));
    res.json({ success: true, notifications: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST Notification
app.post('/api/notifications', async (req, res) => {
  try {
    // Normalise recipientEmails to lowercase so the GET query matches correctly
    const body = {
      ...req.body,
      recipientEmails: (req.body.recipientEmails ?? []).map((e) => String(e).toLowerCase()),
    };
    const notif = new Notification(body);
    const saved = await notif.save();
    const { _id, __v, ...rest } = saved.toObject();
    res.json({
      success: true,
      notification: {
        ...rest,
        id: _id.toString(),
        timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Generic email relay endpoint ─────────────────────────────────────────────
// Called by Vercel server actions so ALL emails go through Render's stable IP.
// POST /api/email  { to, subject, htmlContent }
app.post('/api/email', async (req, res) => {
  try {
    const { to, subject, htmlContent } = req.body;
    if (!to || !subject || !htmlContent) {
      return res.status(400).json({ success: false, error: 'to, subject, htmlContent are required' });
    }
    const recipients = Array.isArray(to) ? to : [{ email: String(to) }];
    const { ok } = await sendBrevoEmail({ to: recipients, subject, html: htmlContent });
    if (!ok) return res.status(502).json({ success: false, error: 'Brevo send failed' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Start Server
const PORT = process.env.PORT || 10002;
httpServer.listen(PORT, () => {
  console.log(`Backend Server running on port ${PORT}`);

  // Ping /health every 14 min to prevent Render free tier from sleeping.
  // Uses https.get (Node 16 safe) rather than the global fetch (Node 18+).
  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  if (SELF_URL) {
    const pinger = require('https');
    setInterval(() => {
      pinger.get(`${SELF_URL}/health`, (res) => res.resume()).on('error', () => {});
    }, 14 * 60 * 1000);
  }
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Waiting 3 seconds before retry...`);
    setTimeout(() => {
      httpServer.close();
      httpServer.listen(PORT);
    }, 3000);
  } else {
    throw err;
  }
});
