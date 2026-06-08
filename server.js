const dns = require('dns');
// Override system DNS with Google's public resolvers to fix querySrv ECONNREFUSED
// on networks where the local DNS server blocks or misroutes SRV lookups.
try { dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']); } catch (_) {}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
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

  // Typing indicators — broadcast to everyone else in the channel room
  socket.on('typing_start', ({ channelId, userName }) => {
    if (!channelId || !userName) return;
    socket.to(channelId).emit('user_typing', { channelId, userName });
  });

  socket.on('typing_stop', ({ channelId, userName }) => {
    if (!channelId || !userName) return;
    socket.to(channelId).emit('user_stopped_typing', { channelId, userName });
  });

  // ── Direct Message rooms ──────────────────────────────────────────────
  // Each DM conversation gets a room named dm:emailA::emailB (sorted)
  socket.on('join_dm', ({ myEmail, partnerEmail }) => {
    if (!myEmail || !partnerEmail) return;
    const room = 'dm:' + [myEmail.toLowerCase(), partnerEmail.toLowerCase()].sort().join('::');
    socket.join(room);
  });

  socket.on('leave_dm', ({ myEmail, partnerEmail }) => {
    if (!myEmail || !partnerEmail) return;
    const room = 'dm:' + [myEmail.toLowerCase(), partnerEmail.toLowerCase()].sort().join('::');
    socket.leave(room);
  });

  socket.on('dm_typing_start', ({ myEmail, partnerEmail }) => {
    if (!myEmail || !partnerEmail) return;
    const room = 'dm:' + [myEmail.toLowerCase(), partnerEmail.toLowerCase()].sort().join('::');
    socket.to(room).emit('dm_user_typing', { fromEmail: myEmail });
  });

  socket.on('dm_typing_stop', ({ myEmail, partnerEmail }) => {
    if (!myEmail || !partnerEmail) return;
    const room = 'dm:' + [myEmail.toLowerCase(), partnerEmail.toLowerCase()].sort().join('::');
    socket.to(room).emit('dm_user_stopped_typing', { fromEmail: myEmail });
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

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// Auth endpoints: strict limit to prevent brute-force / credential stuffing
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please wait 15 minutes before trying again.' },
});

// Message/API endpoints: generous limit for normal usage
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// Global fallback
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/', authLimiter);
app.use('/api/access-requests', authLimiter);
app.use('/api/messages', apiLimiter);
app.use('/api/kanban', apiLimiter);
app.use('/api/', globalLimiter);

// --- 1. MongoDB Connection ---
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.warn('WARNING: MONGODB_URI environment variable is missing. DB routes will fail.');
}

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Successfully connected to MongoDB Atlas');
    // ── Drop any accidental TTL indexes on accessrequests ─────────────
    // If MongoDB Atlas created a TTL on requestedAt, users vanish after
    // that window. We remove it at startup so accounts are permanent.
    mongoose.connection.collection('accessrequests').indexes()
      .then((idxs) => {
        idxs.forEach((idx) => {
          if (idx.expireAfterSeconds !== undefined) {
            mongoose.connection.collection('accessrequests')
              .dropIndex(idx.name)
              .then(() => console.log('[startup] Removed TTL index on accessrequests:', idx.name))
              .catch((e) => console.warn('[startup] Could not drop TTL index:', e.message));
          }
        });
      })
      .catch(() => {});
  })
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
  channelId:   { type: String },
  channelIds:  [{ type: String }],
});
const AccessRequest = mongoose.model('AccessRequest', AccessRequestSchema);

// ── Direct Messages ──────────────────────────────────────────────────────────
const DirectMessageSchema = new mongoose.Schema({
  fromEmail:  { type: String, required: true, index: true },
  fromName:   { type: String, required: true },
  toEmail:    { type: String, required: true, index: true },
  text:       { type: String, default: '' },
  audioUrl:   { type: String },
  files:      [{ name: String, url: String, type: String }],
  timestamp:  { type: Date, default: Date.now },
  read:       { type: Boolean, default: false },
}, { strict: false });
// Compound index so conversation queries are fast
DirectMessageSchema.index({ fromEmail: 1, toEmail: 1, timestamp: -1 });
const DirectMessage = mongoose.model('DirectMessage', DirectMessageSchema);

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

// ── Webhook schema ────────────────────────────────────────────────────────────
const WebhookSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  channelId: { type: String, required: true },
  type:      { type: String, enum: ['github', 'generic'], required: true },
  token:     { type: String, required: true, unique: true, index: true },
  secret:    { type: String, default: '' },    // GitHub HMAC secret (optional)
  active:    { type: Boolean, default: true },
  lastUsed:  { type: Date },
  createdAt: { type: Date, default: Date.now },
});
const Webhook = mongoose.model('Webhook', WebhookSchema);

// ── LoginEvent schema — tracks real login timestamps per user ─────────────────
const LoginEventSchema = new mongoose.Schema({
  email:    { type: String, required: true, index: true },
  name:     { type: String, default: '' },
  loginAt:  { type: Date, default: Date.now, index: true },
  dateStr:  { type: String, required: true, index: true }, // YYYY-MM-DD (IST)
});
LoginEventSchema.index({ email: 1, dateStr: 1 });
const LoginEvent = mongoose.model('LoginEvent', LoginEventSchema);

// ── MediaFile schema — separate storage for audio/video with access control ───
const MediaFileSchema = new mongoose.Schema({
  ownerEmail:  { type: String, required: true, index: true },
  channelId:   { type: String, required: true, index: true },
  messageId:   { type: String, index: true },
  kind:        { type: String, enum: ['audio', 'video', 'screen'], required: true },
  url:         { type: String, required: true },
  mimeType:    { type: String, default: '' },
  sizeBytes:   { type: Number, default: 0 },
  uploadedAt:  { type: Date, default: Date.now },
});
const MediaFile = mongoose.model('MediaFile', MediaFileSchema);

// ── UserSettings schema — stores per-user preferences synced across devices ─────
const UserSettingsSchema = new mongoose.Schema({
  email:                { type: String, required: true, unique: true, index: true },
  displayName:          { type: String, default: '' },
  avatarEmoji:          { type: String, default: '' },
  status:               { type: String, enum: ['online', 'away', 'busy', 'offline'], default: 'online' },
  meetLink:             { type: String, default: '' },
  emailNotifications:   { type: Boolean, default: true },
  desktopNotifications: { type: Boolean, default: false },
  soundNotifications:   { type: Boolean, default: true },
  compactChat:          { type: Boolean, default: false },
  fontSize:             { type: String, enum: ['normal', 'large'], default: 'normal' },
  enterToSend:          { type: Boolean, default: false },
  darkMode:             { type: Boolean, default: false },
}, { timestamps: true });
const UserSettings = mongoose.model('UserSettings', UserSettingsSchema);

// ── PinnedMessage schema — team-shared pins per channel ───────────────────────
const PinnedMessageSchema = new mongoose.Schema({
  channelId: { type: String, required: true, index: true },
  messageId: { type: String, required: true },
  pinnedBy:  { type: String, required: true },
  pinnedAt:  { type: Date, default: Date.now },
});
PinnedMessageSchema.index({ channelId: 1, messageId: 1 }, { unique: true });
const PinnedMessage = mongoose.model('PinnedMessage', PinnedMessageSchema);

// ── WorkspaceChannel schema — replaces hardcoded channel list ─────────────────
const WorkspaceChannelSchema = new mongoose.Schema({
  _id:         { type: String, required: true },
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  isDefault:   { type: Boolean, default: false },
  createdBy:   { type: String, default: '' },
  order:       { type: Number, default: 0 },
}, { timestamps: true });
const WorkspaceChannel = mongoose.model('WorkspaceChannel', WorkspaceChannelSchema);

const DEFAULT_WORKSPACE_CHANNELS = [
  { _id: 'general',          name: 'general',          description: 'Team-wide announcements and updates',              isDefault: true, order: 0 },
  { _id: 'skillnaav',        name: 'skillnaav',        description: 'Career navigation & skill gap analysis product',   isDefault: true, order: 1 },
  { _id: 'edutechexassessa', name: 'edutechexassessa', description: 'Assessment platform & adaptive question engine',   isDefault: true, order: 2 },
  { _id: 'edutechex',        name: 'edutechex',        description: 'Core platform — Cambridge, IB, teacher training', isDefault: true, order: 3 },
];

// ── MeetingAccess schema — tracks who has access to a specific scheduled meeting
const MeetingAccessSchema = new mongoose.Schema({
  messageId:       { type: String, required: true, index: true },
  channelId:       { type: String, required: true },
  hostEmail:       { type: String, required: true },
  allowedEmails:   [{ type: String }],  // from "Mentioned people" + host
  grantedEmails:   [{ type: String }],  // extra grants by host at runtime
  createdAt:       { type: Date, default: Date.now },
});
MeetingAccessSchema.index({ messageId: 1, channelId: 1 }, { unique: true });
const MeetingAccess = mongoose.model('MeetingAccess', MeetingAccessSchema);

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

// PATCH /api/access-requests/:id — admin approves, rejects or updates user role/channel
app.patch('/api/access-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, channelId, channelIds, role } = req.body;

    const updateFields = {};
    if (status !== undefined) updateFields.status = status;
    if (channelId !== undefined) updateFields.channelId = channelId;
    if (channelIds !== undefined) updateFields.channelIds = Array.isArray(channelIds) ? channelIds : [];
    if (role !== undefined) updateFields.role = role;

    const updated = await AccessRequest.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ success: false, error: 'Request not found' });
    const { _id, __v, ...rest } = updated;

    // Broadcast member change so all connected clients refresh their member list
    if (status === 'approved' || role !== undefined || channelId !== undefined || channelIds !== undefined) {
      io.emit('member_updated', {
        memberId: `member-${_id.toString()}`,
        email: rest.email,
        role: rest.role,
        channelId: rest.channelId,
        channelIds: rest.channelIds || [],
        status: rest.status,
      });
    }

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

// GET /api/members — returns all members (hardcoded + approved requests)
app.get('/api/members', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized. Please log in first.' });
    }

    const hardcoded = [
      { id: 'member-ac', name: 'Aditya Cherikuri', email: 'aditya@edutechex.in', role: 'Manager', initials: 'AC', status: 'online', color: '#2563eb' },
      { id: 'member-rk', name: 'Ram K Aluru', email: 'dev.rk@edutechex.in', role: 'Developer', initials: 'RK', status: 'online', color: '#7c3aed' },
      { id: 'member-sa', name: 'Sneha Agarwal', email: 'design.sa@edutechex.in', role: 'Designer', initials: 'SA', status: 'away', color: '#0891b2' },
      { id: 'member-tm', name: 'Tarun Mehta', email: 'tarun@edutechex.in', role: 'Lead', initials: 'TM', status: 'offline', color: '#059669' },
      { id: 'member-mk', name: 'Mohan Kumar', email: 'mohan.kumar@edutechex.in', role: 'Developer', initials: 'MK', status: 'online', color: '#dc2626' },
      { id: 'member-mr', name: 'Mohan Reddy', email: 'mohan.reddy@edutechex.in', role: 'Developer', initials: 'MR', status: 'online', color: '#eab308' },
      { id: 'member-ms', name: 'Mohan Sen', email: 'mohan.sen@edutechex.in', role: 'Developer', initials: 'MS', status: 'online', color: '#0891b2' },
    ];

    const approvedRequests = await AccessRequest.find({ status: 'approved' }).lean();

    const colors = ['#2d6a4f', '#52b788', '#7c3aed', '#a78bfa', '#1b4332', '#c4b5fd'];
    const getDeterministicColor = (email) => {
      let hash = 0;
      for (let i = 0; i < email.length; i++) {
        hash = email.charCodeAt(i) + ((hash << 5) - hash);
      }
      const index = Math.abs(hash) % colors.length;
      return colors[index];
    };

    const dbMembers = approvedRequests.map((r) => {
      const initials = r.name
        .split(' ')
        .map((p) => p[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
      // Normalise: channelIds is authoritative; fall back to legacy channelId
      const ids = r.channelIds && r.channelIds.length > 0
        ? r.channelIds
        : (r.channelId ? [r.channelId] : []);
      return {
        id: `member-${r._id.toString()}`,
        name: r.name,
        email: r.email,
        role: r.role,
        status: 'online',
        color: getDeterministicColor(r.email),
        initials,
        channelId: r.channelId,
        channelIds: ids,
      };
    });

    const allMembers = [...hardcoded];
    dbMembers.forEach((dbm) => {
      if (!allMembers.some((m) => m.email.toLowerCase() === dbm.email.toLowerCase())) {
        allMembers.push(dbm);
      }
    });

    res.json({ success: true, members: allMembers });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/members — admin directly creates a new approved user
app.post('/api/members', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Only admins can add members directly.' });
    }

    const { name, email, role, channelId } = req.body;
    const emailClean = String(email).trim().toLowerCase();

    const VALID_EMAILS = [
      'admin@edutechex.in', 'aditya@edutechex.in', 'dev.rk@edutechex.in',
      'design.sa@edutechex.in', 'tarun@edutechex.in', 'mohan.kumar@edutechex.in',
      'mohan.reddy@edutechex.in', 'mohan.sen@edutechex.in'
    ];
    if (VALID_EMAILS.includes(emailClean)) {
      return res.status(409).json({ success: false, error: 'This email belongs to a system account.' });
    }

    const existing = await AccessRequest.findOne({ email: emailClean }).lean();
    if (existing) {
      return res.status(409).json({ success: false, error: 'A user request/account with this email already exists.' });
    }

    const request = new AccessRequest({
      name,
      email: emailClean,
      password: 'Welcome@2026', // default password
      role,
      status: 'approved',
      channelId,
    });

    const saved = await request.save();
    const { _id, __v, ...rest } = saved.toObject();

    res.json({
      success: true,
      member: {
        id: `member-${_id.toString()}`,
        name: rest.name,
        email: rest.email,
        role: rest.role,
        status: 'online',
        color: '#4f46e5',
        initials: rest.name.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 2),
        channelId: rest.channelId,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});


// GET /api/login-status — returns who logged in today (for calendar green/red dots)
app.get('/api/login-status', authMiddleware, async (req, res) => {
  try {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const events = await LoginEvent.find({ dateStr }).lean();
    const loggedInEmails = events.map((e) => e.email);
    res.json({ success: true, dateStr, loggedInEmails });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/login-history — returns 30-day login history per user (for calendar heatmap)
app.get('/api/login-history', authMiddleware, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const events = await LoginEvent.find({ loginAt: { $gte: thirtyDaysAgo } }).lean();
    const history = {};
    events.forEach((e) => {
      if (!history[e.email]) history[e.email] = [];
      if (!history[e.email].includes(e.dateStr)) history[e.email].push(e.dateStr);
    });
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/members/:id/promote-admin — admin promotes a user to admin (max 3 admins)
app.post('/api/members/:id/promote-admin', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Only admins can promote users.' });
    }

    // Count current admins (hardcoded + DB)
    const HARDCODED_ADMINS = VALID_ACCOUNTS.filter((a) => a.role === 'Admin').length;
    const dbAdmins = await AccessRequest.countDocuments({ status: 'approved', role: 'Admin' });
    const totalAdmins = HARDCODED_ADMINS + dbAdmins;

    if (totalAdmins >= 3) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 3 admins allowed. Remove an existing admin first.',
      });
    }

    const { id } = req.params;
    const updated = await AccessRequest.findByIdAndUpdate(
      id,
      { $set: { role: 'Admin' } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ success: false, error: 'User not found.' });

    io.emit('member_updated', {
      memberId: `member-${id}`,
      email: updated.email,
      role: 'Admin',
      channelId: updated.channelId,
    });

    res.json({ success: true, message: `${updated.name} is now an Admin.` });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/meeting-access — create/get meeting access record
app.post('/api/meeting-access', authMiddleware, async (req, res) => {
  try {
    const { messageId, channelId, hostEmail, allowedEmails } = req.body;
    if (!messageId || !channelId || !hostEmail) {
      return res.status(400).json({ success: false, error: 'messageId, channelId, and hostEmail are required.' });
    }
    const doc = await MeetingAccess.findOneAndUpdate(
      { messageId, channelId },
      { $setOnInsert: { hostEmail, allowedEmails: allowedEmails || [], grantedEmails: [] } },
      { upsert: true, new: true }
    ).lean();
    res.json({ success: true, access: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/meeting-access/:messageId — check if current user can join meeting
app.get('/api/meeting-access/:messageId', authMiddleware, async (req, res) => {
  try {
    const doc = await MeetingAccess.findOne({ messageId: req.params.messageId }).lean();
    if (!doc) return res.json({ success: true, canJoin: true, exists: false });

    const userEmail = req.user?.email?.toLowerCase() || '';
    const allowed = doc.allowedEmails.map((e) => e.toLowerCase());
    const granted = doc.grantedEmails.map((e) => e.toLowerCase());
    const canJoin = userEmail === doc.hostEmail.toLowerCase()
      || allowed.includes(userEmail)
      || granted.includes(userEmail);

    res.json({ success: true, canJoin, hostEmail: doc.hostEmail, exists: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PATCH /api/meeting-access/:messageId/grant — host grants access to an email
app.patch('/api/meeting-access/:messageId/grant', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'email is required.' });

    const doc = await MeetingAccess.findOne({ messageId: req.params.messageId }).lean();
    if (!doc) return res.status(404).json({ success: false, error: 'Meeting access record not found.' });

    if (req.user?.email?.toLowerCase() !== doc.hostEmail.toLowerCase() && req.user?.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Only the meeting host or admin can grant access.' });
    }

    await MeetingAccess.findByIdAndUpdate(doc._id, { $addToSet: { grantedEmails: email.toLowerCase() } });

    // Notify the specific user that they've been granted access
    io.emit('meeting_access_granted', { messageId: req.params.messageId, email: email.toLowerCase() });

    res.json({ success: true, message: `Access granted to ${email}.` });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Direct Message Routes ──────────────────────────────────────────────────────

// GET /api/dm/conversations — list all unique DM partners for the current user
app.get('/api/dm/conversations', authMiddleware, async (req, res) => {
  try {
    const myEmail = req.user.email.toLowerCase();

    // Pull latest message per conversation partner
    const msgs = await DirectMessage.find({
      $or: [{ fromEmail: myEmail }, { toEmail: myEmail }],
    }).sort({ timestamp: -1 }).lean();

    const convMap = new Map();
    for (const msg of msgs) {
      const partner = msg.fromEmail === myEmail ? msg.toEmail : msg.fromEmail;
      const partnerName = msg.fromEmail === myEmail ? null : msg.fromName;
      if (!convMap.has(partner)) {
        convMap.set(partner, {
          partnerEmail: partner,
          partnerName: partnerName || partner,
          lastMessage: msg.text || (msg.audioUrl ? '[Voice message]' : '[File]'),
          lastTimestamp: msg.timestamp,
          unread: 0,
        });
      }
      if (msg.toEmail === myEmail && !msg.read) {
        convMap.get(partner).unread = (convMap.get(partner).unread || 0) + 1;
      }
    }

    // Enrich partner names from AccessRequest if missing
    const convList = Array.from(convMap.values());
    for (const conv of convList) {
      if (!conv.partnerName || conv.partnerName === conv.partnerEmail) {
        const u = await AccessRequest.findOne({ email: conv.partnerEmail }).lean().catch(() => null);
        if (u) conv.partnerName = u.name;
      }
    }

    res.json({ success: true, conversations: convList });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/dm/:partnerEmail — fetch message thread with one user
app.get('/api/dm/:partnerEmail', authMiddleware, async (req, res) => {
  try {
    const myEmail = req.user.email.toLowerCase();
    const partnerEmail = decodeURIComponent(req.params.partnerEmail).toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const msgs = await DirectMessage.find({
      $or: [
        { fromEmail: myEmail,      toEmail: partnerEmail },
        { fromEmail: partnerEmail, toEmail: myEmail      },
      ],
    }).sort({ timestamp: 1 }).limit(limit).lean();

    // Mark incoming messages as read
    await DirectMessage.updateMany(
      { fromEmail: partnerEmail, toEmail: myEmail, read: false },
      { $set: { read: true } }
    ).catch(() => {});

    const formatted = msgs.map(({ _id, __v, ...m }) => ({ id: _id.toString(), ...m }));
    res.json({ success: true, messages: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/dm/:partnerEmail — send a direct message
app.post('/api/dm/:partnerEmail', authMiddleware, async (req, res) => {
  try {
    const myEmail    = req.user.email.toLowerCase();
    const myName     = req.user.name || req.user.email;
    const partnerEmail = decodeURIComponent(req.params.partnerEmail).toLowerCase();
    const { text, audioUrl, files } = req.body;

    if (!text && !audioUrl && (!files || files.length === 0)) {
      return res.status(400).json({ success: false, error: 'Message content is required.' });
    }

    const saved = await new DirectMessage({
      fromEmail:  myEmail,
      fromName:   myName,
      toEmail:    partnerEmail,
      text:       text || '',
      audioUrl:   audioUrl || undefined,
      files:      files   || [],
      timestamp:  new Date(),
      read:       false,
    }).save();

    const formatted = { id: saved._id.toString(), ...saved.toObject() };
    delete formatted._id; delete formatted.__v;

    // Push real-time to both sides of the conversation
    const room = 'dm:' + [myEmail, partnerEmail].sort().join('::');
    io.to(room).emit('dm_message', formatted);

    res.json({ success: true, message: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE /api/dm/:id — soft-delete a single DM (only sender can delete)
app.delete('/api/dm/:id', authMiddleware, async (req, res) => {
  try {
    const msg = await DirectMessage.findById(req.params.id).lean();
    if (!msg) return res.status(404).json({ success: false, error: 'Message not found.' });
    if (msg.fromEmail !== req.user.email.toLowerCase() && req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Only the sender can delete this message.' });
    }
    await DirectMessage.findByIdAndUpdate(req.params.id, { $set: { text: 'Message deleted.', deleted: true } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/dm/unread-count — total unread DMs for current user
app.get('/api/dm/unread-count', authMiddleware, async (req, res) => {
  try {
    const count = await DirectMessage.countDocuments({
      toEmail: req.user.email.toLowerCase(),
      read: false,
    });
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Meeting Invite Email ───────────────────────────────────────────────────────

// POST /api/meetings/invite — send a meeting invite email to all team members
app.post('/api/meetings/invite', authMiddleware, async (req, res) => {
  try {
    const { title, time, joinLink, channelId } = req.body;
    if (!title || !joinLink) {
      return res.status(400).json({ success: false, error: 'title and joinLink are required.' });
    }

    // Collect ALL team members (hardcoded + approved DB users)
    const toMap = new Map(VALID_ACCOUNTS.map(a => [a.email, { email: a.email, name: a.name }]));
    try {
      const dbUsers = await AccessRequest.find({ status: 'approved' }).lean();
      for (const u of dbUsers) {
        if (!toMap.has(u.email)) toMap.set(u.email, { email: u.email, name: u.name });
      }
    } catch (_) { /* non-fatal */ }

    const to = Array.from(toMap.values());
    const hostName = req.user?.name || req.user?.email || 'A team member';

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:32px;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#0A1128,#1E2E5C);padding:24px 28px;">
            <p style="margin:0;color:rgba(212,175,55,0.7);font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">EduTechExOS · Meeting Invite</p>
            <h1 style="margin:8px 0 0;font-size:22px;color:#fff;">${title}</h1>
          </div>
          <div style="padding:28px;">
            <p style="margin:0 0 20px;color:#334155;font-size:14px;line-height:1.7;">
              <strong>${hostName}</strong> has scheduled a meeting and invited your team.
            </p>
            ${time ? `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:14px 16px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;">
              <span style="font-size:20px;">📅</span>
              <div>
                <p style="margin:0;font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Scheduled Time</p>
                <p style="margin:4px 0 0;font-size:14px;font-weight:600;color:#1e293b;">${time}</p>
              </div>
            </div>` : ''}
            <div style="margin-bottom:28px;padding:14px 16px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;">
              <p style="margin:0;font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Channel</p>
              <p style="margin:4px 0 0;font-size:14px;font-weight:600;color:#1e293b;">#${channelId || 'general'}</p>
            </div>
            <a href="${joinLink}" style="display:inline-block;padding:14px 32px;background:#D4AF37;color:#0A1128;font-weight:800;font-size:13px;text-decoration:none;border-radius:8px;">
              Join Meeting →
            </a>
            <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;word-break:break-all;">
              Or copy this link:<br/>
              <a href="${joinLink}" style="color:#3E4A89;">${joinLink}</a>
            </p>
          </div>
          <div style="background:#f8fafc;padding:14px 28px;border-top:1px solid #f1f5f9;text-align:center;font-size:11px;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">
            &copy; 2026 EduTechExOS &middot; Institutional Team OS
          </div>
        </div>
      </div>`;

    const subject = `Meeting Invite: ${title}${time ? ' · ' + time : ''}`;
    const { ok } = await sendBrevoEmail({ to, subject, html });
    console.log(`[meeting-invite] ${ok ? 'OK' : 'FAILED'} → ${to.length} recipients`);
    res.json({ success: true, sent: to.length, ok });
  } catch (err) {
    console.error('[meeting-invite]', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/media — register a media file (audio/video/screen) with access control
app.post('/api/media', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized.' });
    const { channelId, messageId, kind, url, mimeType, sizeBytes } = req.body;
    if (!channelId || !kind || !url) {
      return res.status(400).json({ success: false, error: 'channelId, kind, and url are required.' });
    }
    const file = new MediaFile({
      ownerEmail: req.user.email,
      channelId,
      messageId: messageId || null,
      kind: ['audio', 'video', 'screen'].includes(kind) ? kind : 'audio',
      url,
      mimeType: mimeType || '',
      sizeBytes: sizeBytes || 0,
    });
    const saved = await file.save();
    res.json({ success: true, mediaId: saved._id.toString() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/media/:id — verify access before returning media URL
app.get('/api/media/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized.' });
    const file = await MediaFile.findById(req.params.id).lean();
    if (!file) return res.status(404).json({ success: false, error: 'Media file not found.' });

    const isOwner = file.ownerEmail.toLowerCase() === req.user.email.toLowerCase();
    const isAdmin = req.user.role === 'Admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, error: 'Access denied. Only the sender and admin can access this recording.' });
    }

    res.json({ success: true, url: file.url, kind: file.kind, mimeType: file.mimeType });
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
      // Record login event for hardcoded accounts too
      try {
        const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        await LoginEvent.findOneAndUpdate(
          { email: emailClean, dateStr },
          { $set: { name: hardcoded.name, loginAt: new Date() } },
          { upsert: true }
        );
        io.emit('login_status_updated', { email: emailClean, dateStr, loggedIn: true });
      } catch (_) {}
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

    // Record login event
    try {
      const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      await LoginEvent.findOneAndUpdate(
        { email: emailClean, dateStr },
        { $set: { name: request.name, loginAt: new Date() } },
        { upsert: true }
      );
      io.emit('login_status_updated', { email: emailClean, dateStr, loggedIn: true });
    } catch (_) {}

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

    await sendResetEmail(emailClean, request.name, code);

    res.json({ success: true, message: GENERIC_OK });
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

  // ── Build recipient list: hardcoded + ALL approved DB users ──────────
  // Previously only VALID_ACCOUNTS got the digest — new users were excluded.
  const toMap = new Map(VALID_ACCOUNTS.map((a) => [a.email, { email: a.email, name: a.name }]));
  try {
    const dbUsers = await AccessRequest.find({ status: 'approved' }).lean();
    for (const u of dbUsers) {
      if (!toMap.has(u.email)) toMap.set(u.email, { email: u.email, name: u.name });
    }
  } catch (e) {
    console.warn('[digest] Could not fetch DB users for digest:', e.message);
  }
  const to = Array.from(toMap.values());

  const subject = `EduTechExOS: Daily Team Digest — ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  const { ok } = await sendBrevoEmail({ to, subject, html });
  const recipients = to.map((r) => r.email).join(', ');
  console.log(`[digest] Brevo send ${ok ? 'OK' : 'FAILED'} → ${to.length} recipients: ${recipients}`);
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
// Uses node-cron for reliable scheduling that survives restarts and doesn't
// drift like the old setTimeout approach.
const cron = require('node-cron');

cron.schedule('30 3 * * *', async () => {
  console.log('[digest-cron] Firing daily digest at 03:30 UTC (09:00 IST)');
  try {
    const result = await sendDigestEmails();
    console.log(`[digest-cron] Digest sent → ${result.recipients}`);
    if (result.testUrl) console.log(`[digest-cron] Preview: ${result.testUrl}`);
  } catch (err) {
    console.error('[digest-cron] Failed:', err);
  }
}, {
  timezone: 'UTC',
});

console.log('[digest-cron] Scheduled daily digest at 03:30 UTC (09:00 IST) via node-cron');

// ─── Message Routes ────────────────────────────────────────────────────────────

// ── Message formatter helper ──────────────────────────────────────────────────
function formatMessage(msg, requestingUser) {
  const { _id, __v, ...rest } = msg;
  // Skip messages hidden for this specific user
  if (requestingUser && (rest.deletedForUsers || []).includes(requestingUser)) return null;
  // Soft-deleted for everyone — return placeholder (WhatsApp style)
  if (rest.deletedForEveryone) {
    return {
      id: _id.toString(),
      channelId: rest.channelId,
      sender: rest.sender,
      initials: rest.initials,
      color: rest.color,
      timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
      parentId: rest.parentId,
      isDeleted: true,
      text: '',
    };
  }
  return {
    ...rest,
    id: _id.toString(),
    timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
    ...(rest.editedAt ? { editedAt: rest.editedAt instanceof Date ? rest.editedAt.toISOString() : rest.editedAt } : {}),
  };
}

// GET Messages — supports two modes:
//   1. ?channelId=X[&before=ISO_TIMESTAMP][&limit=N]  → paginated single-channel
//   2. (no channelId) → last PAGE_SIZE messages per channel for initial load
const PAGE_SIZE = 50;

app.get('/api/messages', async (req, res) => {
  try {
    const requestingUser = getUserEmail(req);
    const { channelId, before, limit } = req.query;
    const pageSize = Math.min(parseInt(limit) || PAGE_SIZE, 100);

    if (channelId) {
      // ── Paginated single-channel load ───────────────────────────────────────
      const filter = { channelId: String(channelId) };
      if (before) filter.timestamp = { $lt: new Date(before) };

      const msgs = await Message.find(filter)
        .sort({ timestamp: -1 })
        .limit(pageSize + 1)   // fetch one extra to detect hasMore
        .lean();

      const hasMore = msgs.length > pageSize;
      const page = msgs.slice(0, pageSize).reverse(); // oldest-first for the client

      const formatted = page.map((m) => formatMessage(m, requestingUser)).filter(Boolean);
      return res.json({ success: true, messages: formatted, hasMore, channelId });
    }

    // ── Initial load: last PAGE_SIZE per channel ────────────────────────────
    const allChannelIds = await Message.distinct('channelId');
    const grouped  = {};
    const hasMoreMap = {};

    for (const chId of allChannelIds) {
      const msgs = await Message.find({ channelId: chId })
        .sort({ timestamp: -1 })
        .limit(pageSize + 1)
        .lean();

      hasMoreMap[chId] = msgs.length > pageSize;
      const page = msgs.slice(0, pageSize).reverse();
      grouped[chId] = page.map((m) => formatMessage(m, requestingUser)).filter(Boolean);
    }

    res.json({ success: true, messages: grouped, hasMore: hasMoreMap });
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

// ─── Webhook CRUD ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

function generateWebhookToken() {
  return crypto.randomBytes(24).toString('hex'); // 48-char hex token
}

// Helper: post a bot message to a channel via Socket.IO + MongoDB
async function postBotMessage(channelId, text) {
  const msg = new Message({
    channelId,
    sender:   'EduTechExOS Bot',
    initials: 'EB',
    color:    '#4f46e5',
    text,
    timestamp: new Date(),
  });
  const saved = await msg.save();
  const { _id, __v, ...rest } = saved.toObject();
  const payload = {
    ...rest,
    id: _id.toString(),
    timestamp: rest.timestamp instanceof Date ? rest.timestamp.toISOString() : rest.timestamp,
  };
  io.to(channelId).emit('new_message', { channelId, message: payload });
  return payload;
}

// GET /api/webhooks — list all webhooks
app.get('/api/webhooks', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const hooks = await Webhook.find({}).sort({ createdAt: -1 }).lean();
    const formatted = hooks.map(({ _id, __v, ...rest }) => ({
      ...rest,
      id: _id.toString(),
      createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
      lastUsed:  rest.lastUsed  instanceof Date ? rest.lastUsed.toISOString()  : rest.lastUsed,
    }));
    res.json({ success: true, webhooks: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/webhooks — create a new webhook
app.post('/api/webhooks', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { name, channelId, type, secret } = req.body;
    if (!name || !channelId || !type) {
      return res.status(400).json({ success: false, error: 'name, channelId, and type are required' });
    }
    const token = generateWebhookToken();
    const hook = new Webhook({ name, channelId, type, token, secret: secret || '' });
    const saved = await hook.save();
    const { _id, __v, ...rest } = saved.toObject();
    res.json({
      success: true,
      webhook: {
        ...rest,
        id: _id.toString(),
        createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PATCH /api/webhooks/:id — toggle active / update name
app.patch('/api/webhooks/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { id } = req.params;
    const updates = {};
    if (req.body.active  !== undefined) updates.active  = req.body.active;
    if (req.body.name    !== undefined) updates.name    = req.body.name;
    if (req.body.secret  !== undefined) updates.secret  = req.body.secret;
    const updated = await Webhook.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();
    if (!updated) return res.status(404).json({ success: false, error: 'Webhook not found' });
    const { _id, __v, ...rest } = updated;
    res.json({
      success: true,
      webhook: {
        ...rest,
        id: _id.toString(),
        createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
        lastUsed:  rest.lastUsed  instanceof Date ? rest.lastUsed.toISOString()  : rest.lastUsed,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE /api/webhooks/:id
app.delete('/api/webhooks/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    await Webhook.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Webhook Receivers ────────────────────────────────────────────────────────

// POST /webhook/github/:token  — receives GitHub events
app.post('/webhook/github/:token', express.json({ type: '*/*' }), async (req, res) => {
  try {
    const hook = await Webhook.findOne({ token: req.params.token, type: 'github', active: true }).lean();
    if (!hook) return res.status(404).json({ error: 'Webhook not found or inactive' });

    // Optionally verify HMAC signature
    if (hook.secret) {
      const sig = req.headers['x-hub-signature-256'];
      const expected = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(JSON.stringify(req.body)).digest('hex');
      if (sig !== expected) return res.status(401).json({ error: 'Invalid signature' });
    }

    const event   = req.headers['x-github-event'] || 'push';
    const payload = req.body;
    let text = '';

    if (event === 'push') {
      const repo    = payload.repository?.full_name ?? 'repo';
      const branch  = (payload.ref || '').replace('refs/heads/', '');
      const pusher  = payload.pusher?.name ?? 'someone';
      const commits = (payload.commits || []).length;
      const msg     = payload.head_commit?.message?.split('\n')[0] ?? '';
      text = `🔀 **[${repo}]** ${pusher} pushed ${commits} commit${commits !== 1 ? 's' : ''} to \`${branch}\`${msg ? `: "${msg}"` : ''}`;
    } else if (event === 'pull_request') {
      const pr     = payload.pull_request;
      const action = payload.action;
      const repo   = payload.repository?.full_name ?? 'repo';
      text = `🔁 **[${repo}]** PR #${pr?.number} **${action}**: "${pr?.title}" by ${pr?.user?.login ?? 'someone'} → ${pr?.html_url}`;
    } else if (event === 'issues') {
      const issue  = payload.issue;
      const action = payload.action;
      const repo   = payload.repository?.full_name ?? 'repo';
      text = `🐛 **[${repo}]** Issue #${issue?.number} **${action}**: "${issue?.title}" → ${issue?.html_url}`;
    } else if (event === 'release') {
      const release = payload.release;
      const repo    = payload.repository?.full_name ?? 'repo';
      text = `🚀 **[${repo}]** Release **${release?.tag_name}** published: "${release?.name}" → ${release?.html_url}`;
    } else {
      text = `⚡ **GitHub** event \`${event}\` received from ${payload.repository?.full_name ?? 'unknown repo'}`;
    }

    await Webhook.findByIdAndUpdate(hook._id, { lastUsed: new Date() });
    await postBotMessage(hook.channelId, text);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[webhook/github]', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /webhook/incoming/:token  — generic receiver (Zapier, Make, IFTTT, etc.)
// Expects JSON body: { text: string, title?: string, color?: string }
app.post('/webhook/incoming/:token', express.json({ type: '*/*' }), async (req, res) => {
  try {
    const hook = await Webhook.findOne({ token: req.params.token, type: 'generic', active: true }).lean();
    if (!hook) return res.status(404).json({ error: 'Webhook not found or inactive' });

    const { text, title } = req.body;
    if (!text) return res.status(400).json({ error: '`text` field is required in payload' });

    const message = title ? `**${title}**\n${text}` : text;
    await Webhook.findByIdAndUpdate(hook._id, { lastUsed: new Date() });
    await postBotMessage(hook.channelId, message);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[webhook/incoming]', err);
    res.status(500).json({ error: String(err) });
  }
});

// ─── User Settings ────────────────────────────────────────────────────────────

const SETTINGS_FIELDS = [
  'displayName', 'avatarEmoji', 'status', 'meetLink',
  'emailNotifications', 'desktopNotifications', 'soundNotifications',
  'compactChat', 'fontSize', 'enterToSend', 'darkMode',
];

// GET /api/settings — load current user's settings
app.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized.' });
    const doc = await UserSettings.findOne({ email: req.user.email.toLowerCase() }).lean();
    res.json({ success: true, settings: doc || null });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PUT /api/settings — upsert current user's settings
app.put('/api/settings', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized.' });
    const email = req.user.email.toLowerCase();
    const updateFields = {};
    SETTINGS_FIELDS.forEach((key) => { if (req.body[key] !== undefined) updateFields[key] = req.body[key]; });
    const doc = await UserSettings.findOneAndUpdate(
      { email },
      { $set: updateFields },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({ success: true, settings: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Pinned Messages ──────────────────────────────────────────────────────────

// GET /api/pinned — all pinned message IDs grouped by channel
app.get('/api/pinned', authMiddleware, async (req, res) => {
  try {
    const pins = await PinnedMessage.find({}).sort({ pinnedAt: 1 }).lean();
    const grouped = {};
    pins.forEach((p) => {
      if (!grouped[p.channelId]) grouped[p.channelId] = [];
      if (!grouped[p.channelId].includes(p.messageId)) grouped[p.channelId].push(p.messageId);
    });
    res.json({ success: true, pinnedMessageIds: grouped });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/pinned — pin a message
app.post('/api/pinned', authMiddleware, async (req, res) => {
  try {
    const { channelId, messageId } = req.body;
    if (!channelId || !messageId) {
      return res.status(400).json({ success: false, error: 'channelId and messageId are required.' });
    }
    const pinnedBy = req.user?.email || 'unknown';
    await PinnedMessage.findOneAndUpdate(
      { channelId, messageId },
      { $setOnInsert: { channelId, messageId, pinnedBy, pinnedAt: new Date() } },
      { upsert: true }
    );
    // Broadcast so all clients show the pin in real-time
    io.emit('message_pinned', { channelId, messageId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE /api/pinned/:channelId/:messageId — unpin a message
app.delete('/api/pinned/:channelId/:messageId', authMiddleware, async (req, res) => {
  try {
    const { channelId, messageId } = req.params;
    await PinnedMessage.deleteOne({ channelId, messageId });
    io.emit('message_unpinned', { channelId, messageId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Workspace Channels ───────────────────────────────────────────────────────

// GET /api/channels — returns all workspace channels (seeds defaults if empty)
app.get('/api/channels', authMiddleware, async (req, res) => {
  try {
    let channels = await WorkspaceChannel.find({}).sort({ order: 1 }).lean();
    if (channels.length === 0) {
      await WorkspaceChannel.insertMany(DEFAULT_WORKSPACE_CHANNELS);
      channels = DEFAULT_WORKSPACE_CHANNELS;
    }
    const formatted = channels.map(({ _id, __v, createdAt, updatedAt, ...rest }) => ({
      ...rest,
      id: _id,
      createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    }));
    res.json({ success: true, channels: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/channels — admin creates a new workspace channel
app.post('/api/channels', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized.' });
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required.' });
    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const exists = await WorkspaceChannel.findById(id).lean();
    if (exists) return res.status(409).json({ success: false, error: 'A channel with this name already exists.' });
    const count = await WorkspaceChannel.countDocuments();
    const channel = new WorkspaceChannel({
      _id: id, name: id, description: description || '',
      isDefault: false, createdBy: req.user.email, order: count,
    });
    const saved = await channel.save();
    const { _id, __v, ...rest } = saved.toObject();
    io.emit('channel_created', { ...rest, id: _id });
    res.json({ success: true, channel: { ...rest, id: _id } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PATCH /api/channels/:id — update channel name/description (admin only)
app.patch('/api/channels/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Only admins can edit channels.' });
    }
    const updates = {};
    if (req.body.name)        updates.name        = req.body.name;
    if (req.body.description !== undefined) updates.description = req.body.description;
    const updated = await WorkspaceChannel.findByIdAndUpdate(
      req.params.id, { $set: updates }, { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ success: false, error: 'Channel not found.' });
    const { _id, __v, ...rest } = updated;
    res.json({ success: true, channel: { ...rest, id: _id } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE /api/channels/:id — delete a non-default channel (admin only)
app.delete('/api/channels/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Only admins can delete channels.' });
    }
    const channel = await WorkspaceChannel.findById(req.params.id).lean();
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found.' });
    if (channel.isDefault) return res.status(400).json({ success: false, error: 'Default channels cannot be deleted.' });
    await WorkspaceChannel.findByIdAndDelete(req.params.id);
    io.emit('channel_deleted', { channelId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Global error handler (logs to console + Sentry if configured) ─────────────
app.use((err, req, res, next) => {
  console.error('[server error]', err);
  // Forward to Sentry if DSN is configured
  if (process.env.SENTRY_DSN) {
    try {
      const Sentry = require('@sentry/node');
      Sentry.captureException(err, { extra: { url: req.url, method: req.method } });
    } catch (_) {}
  }
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
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
