const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const app = express();
const httpServer = http.createServer(app);

// Allow requests from the Vercel frontend and local dev
const ALLOWED_ORIGINS = [
  'https://edutechexos.vercel.app',

  /\.vercel\.app$/,           // any Vercel preview deploy
  'http://localhost:3000',
  'http://localhost:10006',
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
}, {
  timestamps: true
});
const WikiPage = mongoose.model('WikiPage', WikiPageSchema);

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

// --- 3. API Endpoints ---

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

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
      return res.json({ success: true, user: hardcoded });
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
    return res.json({
      success: true,
      user: { email: request.email, name: request.name, role: request.role },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Helper: send password-reset email (Ethereal fallback when SMTP not set) ──
async function sendResetEmail(toEmail, toName, code) {
  let host = process.env.SMTP_HOST;
  let port = Number(process.env.SMTP_PORT) || 587;
  let secure = process.env.SMTP_SECURE === 'true';
  let user = process.env.SMTP_USER;
  let pass = process.env.SMTP_PASS;
  let from = process.env.SMTP_FROM || '"EduTechExOS" <noreply@edutechex.in>';
  let testUrl = '';

  if (!host || !user || !pass) {
    const testAccount = await nodemailer.createTestAccount();
    host = 'smtp.ethereal.email';
    port = 587;
    secure = false;
    user = testAccount.user;
    pass = testAccount.pass;
    from = `"EduTechExOS" <${testAccount.user}>`;
  }

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });

  const info = await transporter.sendMail({
    from,
    to: toEmail,
    subject: `EduTechExOS: Password reset code ${code}`,
    html: `
      <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:32px;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#4f46e5,#3b82f6);color:#fff;padding:24px 28px;">
            <h1 style="margin:0;font-size:22px;">EduTechEx<span style="color:#93c5fd;">OS</span></h1>
            <p style="margin:6px 0 0;color:#e0e7ff;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Password Reset</p>
          </div>
          <div style="padding:28px;">
            <p style="margin:0 0 16px;color:#334155;font-size:15px;">Hello ${toName},</p>
            <p style="margin:0 0 20px;color:#334155;font-size:15px;">We received a request to reset your EduTechExOS password. Use the code below — it expires in <strong>15 minutes</strong>.</p>
            <div style="letter-spacing:8px;font-size:32px;font-weight:800;color:#4f46e5;background:#eef2ff;border-radius:14px;padding:18px;text-align:center;margin-bottom:24px;">${code}</div>
            <p style="margin:0;color:#64748b;font-size:13px;">If you didn't request a password reset, you can safely ignore this email.</p>
          </div>
          <div style="background:#f8fafc;padding:16px 28px;border-top:1px solid #f1f5f9;text-align:center;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">&copy; 2026 EduTechExOS &middot; Internal Team OS</div>
        </div>
      </div>
    `,
  });

  if (host === 'smtp.ethereal.email') {
    testUrl = nodemailer.getTestMessageUrl(info) || '';
    console.log(`[reset-email] Ethereal preview: ${testUrl}`);
  }
  return { testUrl };
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

// ─── Message Routes ────────────────────────────────────────────────────────────

// GET Messages (grouped by channel)
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await Message.find({}).lean();
    const grouped = {};
    for (const msg of messages) {
      const channelId = msg.channelId;
      if (!grouped[channelId]) grouped[channelId] = [];
      const { _id, __v, ...rest } = msg;
      grouped[channelId].push({
        ...rest,
        id: _id.toString(),
        // always return date fields as ISO strings
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

// DELETE Message
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await Message.findByIdAndDelete(id);
    res.json({ success: true });
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

// GET Kanban Tasks
app.get('/api/kanban', async (req, res) => {
  try {
    const tasks = await KanbanTask.find({}).sort({ createdAt: 1 }).lean();
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
    const task = new KanbanTask(req.body);
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

// GET Wiki Pages
app.get('/api/wikipages', async (req, res) => {
  try {
    const pages = await WikiPage.find({}).sort({ updatedAt: -1 }).lean();
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
    const updated = await WikiPage.findOneAndUpdate(
      { _id: id },
      { 
        channelId, 
        title, 
        content,
        updatedAt: new Date()
      },
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

// GET Notifications (for a specific recipient email)
app.get('/api/notifications', async (req, res) => {
  try {
    const { email } = req.query;
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
