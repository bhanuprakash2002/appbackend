

// server.js
// Full backend file — only translation logic updated to use Deepgram for STT, translation and TTS.
// Everything else in your working file is preserved.

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const twilio = require("twilio");
const admin = require("firebase-admin");
const { Pool } = require("pg");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();




const BASE_URL = process.env.BASE_URL;

const streamMap = new Map(); // identity -> { ws, streamSid }


const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));


// === MediaStreams: WebSocket ===
// === Google Cloud Setup ===
const speech = require("@google-cloud/speech");
const { Translate } = require('@google-cloud/translate').v2;
const textToSpeech = require('@google-cloud/text-to-speech');
const { GoogleAuth } = require("google-auth-library");

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON env var");
    serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS || "./firebase-service-account.json");
  }
} else {
  serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS || "./firebase-service-account.json");
}

const clientConfig = { credentials: serviceAccount };

const speechClient = new speech.SpeechClient(clientConfig);
const gTranslate = new Translate(clientConfig);
const ttsClient = new textToSpeech.TextToSpeechClient(clientConfig);

// === MediaStreams: WebSocket ===
const http = require("http");
const WebSocket = require("ws");

// ================= LANGUAGE MAPS =================

// Google Streaming STT language codes
const STT_LANG_MAP = {
  en: "en-IN",
  hi: "hi-IN",
  te: "te-IN",
  ta: "ta-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  mr: "mr-IN",
  bn: "bn-IN",
  gu: "gu-IN",
  pa: "pa-IN",
  ur: "ur-IN",

  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-PT",
  ar: "ar-SA",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN"
};

// Google TTS language codes
const TTS_LANG_MAP = {
  en: "en-IN",
  hi: "hi-IN",
  te: "te-IN",
  ta: "ta-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  mr: "mr-IN",
  bn: "bn-IN",
  gu: "gu-IN",
  pa: "pa-IN",
  ur: "ur-IN",

  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-PT",
  ar: "ar-SA",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN"
};


// ================= G.711 μ-law encoder (PURE JS, TWILIO SAFE) =================

const MULAW_MAX = 0x1FFF;
const MULAW_BIAS = 33;

function linear16ToMuLaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;

  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function pcm16ToMulawBase64(pcm16Buffer) {
  const out = Buffer.alloc(pcm16Buffer.length / 2);

  for (let i = 0; i < out.length; i++) {
    const sample = pcm16Buffer.readInt16LE(i * 2);
    out[i] = linear16ToMuLaw(sample);
  }

  return out.toString("base64");
}




// Clients already initialized above




// 🧠 Track recent END_CALL requests to avoid duplicates
const recentEndCalls = new Map();
const END_CALL_DEDUPE_WINDOW_MS = 3000; // 3 seconds window

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// --- Twilio ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID;
const TWILIO_VOICE_CALLER_ID = process.env.TWILIO_VOICE_CALLER_ID;
const TWILIO_PUSH_CREDENTIAL_SID = process.env.TWILIO_PUSH_CREDENTIAL_SID;

// --- Firebase ---



const axios = require("axios");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const googleAuth = new GoogleAuth({
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key,
  },
  scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
});

async function getAccessToken() {
  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

async function sendFcmNotification(token, data) {
  try {
    const payload = { message: { token, data } };
    const res = await axios.post(
      "https://fcm.googleapis.com/v1/projects/fir-adb3f/messages:send",
      payload,
      {
        headers: {
          Authorization: `Bearer ${await getAccessToken()}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ FCM sent successfully:", res.status);
    return res.data;
  } catch (err) {
    console.error("❌ sendFcmNotification failed:");
    if (err.response?.status === 404) {
      console.log("⚠️ Removing invalid FCM token");

      await pg.query(
        "DELETE FROM fcm_registry WHERE fcm_token=$1",
        [token]
      );
    }
    console.error("Status:", err.response?.status);
    console.error("Data:", err.response?.data);
    console.error("Message:", err.message);
    throw err;
  }
}

// --- JWT ---
const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TTL_MINUTES = 60;
const REFRESH_TTL_DAYS = 90;

// --- PostgreSQL ---
const pg = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:
    process.env.DB_SSL === "true"
      ? { rejectUnauthorized: false }
      : false,
});

// Load all FCM tokens from DB into memory at startup
async function preloadFCM() {
  try {
    const { rows } = await pg.query("SELECT phone_e164, identity, fcm_token FROM fcm_registry");
    for (const r of rows) {
      const idDigits = canonicalIdentity(r.identity || r.phone_e164);
      fcmByIdentity.set(idDigits, r.fcm_token);
    }
    console.log(`✅ Preloaded ${rows.length} FCM registrations`);
  } catch (err) {
    console.error("❌ Failed to preload FCM tokens:", err.message);
  }
}

pg.connect()
  .then(() => {
    console.log("✅ Connected to PostgreSQL");
    preloadFCM();
  })
  .catch((err) => console.error("❌ DB connection failed:", err.message));

// --- Init ---
const app = express();
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);


const fcmByIdentity = new Map(); // phone -> FCM token

/* Helpers */
const toE164 = (phone) => {
  if (!phone || !phone.startsWith("+")) {
    throw new Error("Phone must be in E.164 format, e.g. +9198XXXXXXXX");
  }
  return phone;
};

function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function signAccessToken(user, deviceId, jti) {
  return jwt.sign(
    { uid: user.id, phone: user.phone_e164, device_id: deviceId, jti },
    JWT_SECRET,
    { expiresIn: `${ACCESS_TTL_MINUTES}m` }
  );
}

function canonicalIdentity(value) {
  if (!value) return "";
  value = value.toString().replace(/^client:/i, "");
  const digits = value.replace(/\D/g, "");
  return digits;
}

function canonicalizePhoneAndIdentity(phoneOrIdentity) {
  const e164 = normalizePhone(phoneOrIdentity) || phoneOrIdentity;
  const twilioId = canonicalIdentity(e164);
  return { e164, twilioId };
}

/* ============================
   HEALTH, AUTH, REGISTER, CALL logic
   (NOT changed — same as you provided)
   ============================ */

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  validate: false,
  keyGenerator: (req) => {
    // Azure App Service includes the port in the IP, which breaks express-rate-limit
    const rawIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    return rawIp.split(',')[0].replace(/:\d+[^:]*$/, '').trim();
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/auth/request-otp", otpLimiter, async (req, res) => {
  try {
    const phone = toE164(req.body.phone);
    await twilioClient.verify.v2
      .services(TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: phone, channel: "sms" });
    res.json({ ok: true, message: "OTP sent" });
  } catch (err) {
    console.error("request-otp error:", err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/auth/verify-otp", async (req, res) => {
  try {
    const phone = toE164(req.body.phone);
    const code = `${req.body.code}`.trim();
    const deviceId = `${req.body.device_id}`.trim();
    const fcmToken = req.body.fcm_token || null;
    const identity = phone;

    if (!code) throw new Error("OTP code is required");

    const check = await twilioClient.verify.v2
      .services(TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== "approved")
      return res.status(401).json({ ok: false, error: "Invalid or expired code" });

    const { rows } = await pg.query(
      "INSERT INTO app_user (phone_e164, is_verified) VALUES ($1, true) ON CONFLICT (phone_e164) DO UPDATE SET is_verified=true RETURNING *",
      [phone]
    );
    const user = rows[0];

    const refresh = randomToken(48);
    const refreshHash = sha256(refresh);
    const refreshExpires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);
    const jti = uuidv4();
    const accessToken = signAccessToken(user, deviceId, jti);

    await pg.query("UPDATE session SET revoked=true WHERE user_id=$1", [user.id]);
    await pg.query(
      `INSERT INTO session (user_id, device_id, jti, refresh_token_hash, expires_at, revoked)
       VALUES ($1,$2,$3,$4,$5,false)
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET jti=EXCLUDED.jti, refresh_token_hash=EXCLUDED.refresh_token_hash,
       expires_at=EXCLUDED.expires_at, revoked=false`,
      [user.id, deviceId, jti, refreshHash, refreshExpires]
    );

    if (fcmToken) {
      const fcmIdentity = canonicalIdentity(req.body.identity || phone);
      const fcmPhone = phone;

      await pg.query(
        `INSERT INTO fcm_registry (phone_e164, identity, fcm_token, last_updated)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (phone_e164)
         DO UPDATE SET identity = EXCLUDED.identity, fcm_token = EXCLUDED.fcm_token, last_updated = NOW()`,
        [fcmPhone, fcmIdentity, fcmToken]
      );

      fcmByIdentity.set(fcmIdentity, fcmToken);
      console.log(`🔄 FCM updated for ${fcmPhone} (identity=${fcmIdentity})`);
    }

    res.json({
      ok: true,
      access_token: accessToken,
      refresh_token: refresh,
      refresh_expires_at: refreshExpires.toISOString(),
      identity,
      phone_e164: phone
    });
  } catch (err) {
    console.error("verify-otp error:", err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/auth/refresh", async (req, res) => {
  try {
    const { device_id, refresh_token } = req.body;
    const refreshHash = sha256(refresh_token);
    const { rows } = await pg.query(
      `SELECT s.id, s.user_id, s.device_id, s.revoked, s.expires_at, u.phone_e164
       FROM session s JOIN app_user u ON u.id=s.user_id
       WHERE s.refresh_token_hash=$1 LIMIT 1`,
      [refreshHash]
    );
    if (!rows.length) return res.status(401).json({ ok: false, error: "Invalid refresh token" });

    const s = rows[0];
    if (s.revoked) return res.status(401).json({ ok: false, error: "Session revoked" });

    const newAccess = signAccessToken(
      { id: s.user_id, phone_e164: s.phone_e164 },
      s.device_id,
      uuidv4()
    );

    res.json({ ok: true, access_token: newAccess });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/auth/logout", async (req, res) => {
  const { device_id, refresh_token } = req.body;
  const refreshHash = sha256(refresh_token);
  await pg.query(
    "UPDATE session SET revoked=true WHERE refresh_token_hash=$1 AND device_id=$2",
    [refreshHash, device_id]
  );
  res.json({ ok: true });
});


// ================= CHAT SEND =================
app.post("/chat/send", async (req, res) => {
  try {
    const { messageId, from, to, original } = req.body;

    const decryptedText = original;

    if (!messageId || !from || !to || !original) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }
    console.log("📩 CHAT SEND:", messageId, from, "→", to);

    // 1) Save to DB
    await pg.query(
      `INSERT INTO chat_messages
   (id, from_identity, to_identity, original_text,created_at)
   VALUES ($1,$2,$3,$4,NOW())
   ON CONFLICT (id) DO NOTHING`,
      [messageId, from, to, encryptMessage(original)]
    );


    // 2) Send FCM to receiver
    const { rows } = await pg.query(
      "SELECT fcm_token FROM fcm_registry WHERE identity=$1 OR phone_e164=$1 LIMIT 1",
      [to]
    );

    let delivered = false;

    if (rows.length > 0) {
      try {

        await sendFcmNotification(rows[0].fcm_token, {
          type: "CHAT_MESSAGE",
          sender: from,
          messageId: messageId,
          original: original
        });

        console.log("✅ FCM SENT:", messageId);
        delivered = true;

      } catch (e) {

        console.log("❌ FCM FAILED:", messageId, e.message);
        delivered = false;

      }
    }

    res.json({ ok: true, delivered });
  } catch (err) {
    console.error("❌ /chat/send error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ================= MESSAGE DELIVERED =================
app.post("/chat/delivered", async (req, res) => {
  try {

    const { messageId } = req.body;

    if (!messageId)
      return res.status(400).json({ ok: false });

    const { rows } = await pg.query(
      "SELECT from_identity FROM chat_messages WHERE id=$1 LIMIT 1",
      [messageId]
    );

    if (!rows.length)
      return res.json({ ok: true });

    const sender = rows[0].from_identity;

    const { rows: tokenRows } = await pg.query(
      "SELECT fcm_token FROM fcm_registry WHERE identity=$1 LIMIT 1",
      [sender]
    );

    if (tokenRows.length) {

      await sendFcmNotification(tokenRows[0].fcm_token, {
        type: "MESSAGE_DELIVERED",
        messageId
      });

    }

    res.json({ ok: true });

  } catch (err) {
    console.error("❌ delivered error", err);
    res.status(500).json({ ok: false });
  }
});


// ================= MESSAGE READ =================
app.post("/chat/read", async (req, res) => {

  try {

    const { messageId } = req.body;

    if (!messageId) {
      return res.status(400).json({ ok: false });
    }

    // 🔥 get sender of that message
    const { rows } = await pg.query(
      "SELECT from_identity FROM chat_messages WHERE id=$1 LIMIT 1",
      [messageId]
    );

    if (!rows.length) {
      return res.json({ ok: true });
    }

    const sender = rows[0].from_identity;

    const { rows: tokenRows } = await pg.query(
      "SELECT fcm_token FROM fcm_registry WHERE identity=$1 LIMIT 1",
      [sender]
    );

    if (tokenRows.length) {

      await sendFcmNotification(tokenRows[0].fcm_token, {
        type: "MESSAGE_READ",
        messageId: messageId   // ✅ IMPORTANT
      });

    }

    res.json({ ok: true });

  } catch (e) {
    res.status(500).json({ ok: false });
  }

});

// ================= CHAT TRANSLATE =================
app.post("/chat/translate", async (req, res) => {
  try {
    const { text, targetLang } = req.body;

    const decryptedText = text;

    if (!text || !targetLang) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    let translated = text;

    try {
      const [translation] = await gTranslate.translate(text, targetLang);
      translated = translation;
    } catch (err) {
      console.error("❌ Chat translate error:", err.message);
    }

    res.json({
      ok: true,
      translated: translated
    });

  } catch (err) {
    console.error("❌ /chat/translate error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ================= CHAT TTS =================
app.post("/chat/tts", async (req, res) => {
  try {
    const { text, lang, gender } = req.body;

    if (!text || !lang) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: {
        languageCode: TTS_LANG_MAP[lang] || "en-IN",
        ssmlGender: gender === "male" ? "MALE" : "FEMALE"
      },
      audioConfig: {
        audioEncoding: "MP3"
      }
    });

    res.json({
      ok: true,
      audio: response.audioContent.toString("base64")
    });

  } catch (err) {
    console.error("❌ /chat/tts error:", err.message);
    res.status(500).json({ ok: false });
  }
});


// ================= MESSAGE ENCRYPTION =================

const CHAT_SECRET = crypto
  .createHash("sha256")
  .update(process.env.JWT_SECRET)
  .digest(); // 32 bytes key

function encryptMessage(text) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    CHAT_SECRET,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptMessage(payload) {
  const buffer = Buffer.from(payload, "base64");

  const iv = buffer.slice(0, 12);
  const tag = buffer.slice(12, 28);
  const text = buffer.slice(28);

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    CHAT_SECRET,
    iv
  );

  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(text),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}


// ================= CHAT HISTORY =================
app.get("/chat/history", async (req, res) => {
  try {

    const identity = canonicalIdentity(req.query.identity);

    if (!identity)
      return res.status(400).json({ ok: false });

    const { rows } = await pg.query(
      `
      SELECT
  id,
  from_identity,
  to_identity,
  original_text,
  created_at
FROM chat_messages
WHERE
 (from_identity = $1 OR to_identity = $1)
 AND deleted = FALSE
AND id NOT IN (
   SELECT message_id FROM deleted_messages
)
ORDER BY created_at ASC;
      `,
      [identity]
    );

    const cleanRows = rows.map(r => {

      let text = r.original_text;

      try {
        text = decryptMessage(text);
      } catch (e) {
        // already plain text → ignore
      }

      return {
        id: r.id,
        from_identity: r.from_identity,
        to_identity: r.to_identity,
        original_text: text,
        timestamp: new Date(r.created_at).getTime()
      };
    });

    res.json({ ok: true, messages: cleanRows });

  } catch (err) {
    console.error("chat history error", err);
    res.status(500).json({ ok: false });
  }
});

// ================= CHAT DELETE =================
app.post("/chat/delete", async (req, res) => {
  try {

    const { messageId } = req.body;

    await pg.query(
      `INSERT INTO deleted_messages(message_id)
 VALUES($1)
 ON CONFLICT DO NOTHING`,
      [messageId]
    );

    res.json({ ok: true });

  } catch (e) {
    console.error("delete error", e);
    res.status(500).json({ ok: false });
  }
});

app.post("/chat/deleteConversation", async (req, res) => {

  const { me, peer } = req.body;

  await pg.query(
    `UPDATE chat_messages
     SET deleted = TRUE
     WHERE (from_identity=$1 AND to_identity=$2)
        OR (from_identity=$2 AND to_identity=$1)`,
    [me, peer]
  );

  res.json({ ok: true });
});


/* FCM register */
app.post("/register", async (req, res) => {
  try {
    const { identity, phone, fcm_token } = req.body || {};
    if (!phone || !fcm_token)
      return res.status(400).json({ error: "phone and fcm_token required" });

    let cleanPhone = String(phone || "").trim();
    if (!cleanPhone.startsWith("+")) {
      cleanPhone = "+" + cleanPhone.replace(/\D/g, "");
    }
    const cleanIdentity = canonicalIdentity(identity || cleanPhone);

    await pg.query(
      `INSERT INTO fcm_registry (phone_e164, identity, fcm_token, last_updated)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (phone_e164)
       DO UPDATE SET identity = EXCLUDED.identity, fcm_token = EXCLUDED.fcm_token, last_updated = NOW()`,
      [cleanPhone, cleanIdentity, fcm_token]
    );

    fcmByIdentity.set(cleanIdentity, fcm_token);
    console.log(`✅ Registered identity=${cleanIdentity}, phone=${cleanPhone}`);

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /register error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* Twilio helper to generate token */
function generateVoiceToken(identity) {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    { identity, ttl: 3600 }
  );

  const grant = new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: true,
    pushCredentialSid: TWILIO_PUSH_CREDENTIAL_SID,
  });

  token.addGrant(grant);
  return token.toJwt();
}



/* Voice token endpoint */
app.get("/voice-token", (req, res) => {
  let identity = String(req.query.identity || "anonymous").trim();
  identity = canonicalIdentity(identity);

  console.log("🎫 Issued Twilio Voice token for identity:", identity);

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    { identity, ttl: 3600 }
  );

  const grant = new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: true,
    pushCredentialSid: TWILIO_PUSH_CREDENTIAL_SID,
  });

  token.addGrant(grant);

  res.json({ token: token.toJwt() });
});








/* Video token unchanged (same as your file) */
app.post("/video-token", async (req, res) => {
  try {
    const { identity, room } = req.body || {};
    if (!identity || !room) {
      return res.status(400).json({ ok: false, error: "identity and room required" });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VideoGrant = AccessToken.VideoGrant;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity }
    );
    token.addGrant(new VideoGrant({ room }));

    return res.json({ ok: true, token: token.toJwt(), room });
  } catch (err) {
    console.error("/video-token error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* Universal phone normalization */
function normalizePhone(phone) {
  if (!phone) return null;
  let p = phone.trim();
  if (/^\+\d{6,15}$/.test(p)) return p;
  if (/^\d{6,15}$/.test(p)) {
    console.warn(`⚠️ Received non-E.164 number: ${p}. You should pass full international number (+countrycode).`);
    return `+${p}`;
  }
  return p;
}



/* --- video-invite (same logic) --- */
app.post("/video-invite", async (req, res) => {
  try {
    let { fromIdentity, toIdentity } = req.body;


    if (!fromIdentity || !toIdentity) {
      return res.status(400).json({ error: "Missing fromIdentity or toIdentity" });
    }
    // ✅ Normalize identities first
    const fromDigits = canonicalIdentity(fromIdentity);
    const toDigits = canonicalIdentity(toIdentity);

    // ✅ CHECK IF USER EXISTS (REGISTERED)
    const checkUser = await pg.query(
      "SELECT 1 FROM fcm_registry WHERE identity=$1 LIMIT 1",
      [toDigits]
    );

    if (checkUser.rows.length === 0) {
      return res.json({ status: "not_registered" });
    }

    fromIdentity = normalizePhone(fromIdentity) || fromIdentity;
    toIdentity = normalizePhone(toIdentity);

    console.log(`🎥 Video invite: ${fromIdentity} ➡️ ${toIdentity}`);

    const roomName = `room_${Date.now()}`;

    const AccessToken = twilio.jwt.AccessToken;
    const VideoGrant = AccessToken.VideoGrant;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity: fromIdentity }
    );
    token.addGrant(new VideoGrant({ room: roomName }));

    if (toIdentity.startsWith("+")) {
      const { rows: mapRows } = await pg.query(
        "SELECT identity FROM fcm_registry WHERE phone_e164=$1 LIMIT 1",
        [toIdentity]
      );
      if (mapRows.length > 0) {
        console.log(`🔄 Normalized phone ${toIdentity} -> identity ${mapRows[0].identity}`);
        toIdentity = mapRows[0].identity;
      }
    }

    const { rows } = await pg.query(
      "SELECT fcm_token FROM fcm_registry WHERE identity=$1 OR phone_e164=$1 LIMIT 1",
      [toIdentity]
    );

    if (rows.length && rows[0].fcm_token) {
      const fcmToken = rows[0].fcm_token;
      console.log(`📤 Sending VIDEO_INVITE push: caller_id=${fromIdentity}, callee_id=${toIdentity}, room=${roomName}`);

      await sendFcmNotification(fcmToken, {
        type: "VIDEO_INVITE",
        caller_id: fromIdentity,
        callee_id: toIdentity,
        room: roomName,
        caller_display: fromIdentity.startsWith("+")
          ? fromIdentity
          : "+91XXXX" + fromIdentity.slice(-4)
      });

      console.log(`📲 Sent FCM Video invite to ${toIdentity}`);
    } else {
      console.log(`⚠️ No FCM token found for ${toIdentity}, skipping push`);
    }

    // 🔥 Save call history (VIDEO)
    await pg.query(
      `INSERT INTO call_history
   (id, caller_identity, callee_identity, call_type)
   VALUES ($1,$2,$3,$4)`,
      [uuidv4(), fromDigits, toDigits, "VIDEO"]
    );

    res.json({
      ok: true,
      token: token.toJwt(),
      room: roomName,
    });
  } catch (err) {
    console.error("❌ /video-invite error:", err);
    res.status(500).json({ error: err.message });
  }
});



/* ============================
   Universal TwiML /twiml/voice route
   (unchanged except passes target param from query)
   ============================ */
async function getUserPrefs(identity) {
  const { rows } = await pg.query(
    "SELECT preferred_lang, voice_gender FROM user_language_prefs WHERE identity=$1 LIMIT 1",
    [identity]
  );

  return rows.length
    ? rows[0]
    : { preferred_lang: "en", voice_gender: "female" };
}





app.all("/twiml/voice", async (req, res) => {
  const from = canonicalIdentity(req.query.from || req.body.From);
  const to = canonicalIdentity(req.query.to || req.body.To);

  const fromPrefs = await getUserPrefs(from);
  const toPrefs = await getUserPrefs(to);

  const fromLang = fromPrefs.preferred_lang;
  const toLang = toPrefs.preferred_lang;

  const fromGender = fromPrefs.voice_gender;
  const toGender = toPrefs.voice_gender;



  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect({ mute: true });


  const stream = connect.stream({
    url: `${BASE_URL.replace("https", "wss")}/twilio-media`
  });

  await pg.query(`
UPDATE active_calls
SET status='RINGING'
WHERE caller_identity=$1
AND callee_identity=$2
`, [to, from])

  stream.parameter({ name: "from", value: from });
  stream.parameter({ name: "to", value: to });
  stream.parameter({ name: "speakLang", value: fromLang });
  stream.parameter({ name: "listenLang", value: toLang });
  stream.parameter({ name: "speakGender", value: fromGender });
  stream.parameter({ name: "listenGender", value: toGender });
  twiml.pause({ length: 600 });
  res.type("text/xml").send(twiml.toString());
  console.log(
    `📞 TWIML LANG | from=${from} speak=${fromLang} | to=${to} listen=${toLang}`
  );

});


app.post("/set-preferred-language", async (req, res) => {
  const { identity, preferredLang, voiceGender } = req.body;
  const id = canonicalIdentity(identity);

  await pg.query(
    `INSERT INTO user_language_prefs (identity, preferred_lang, voice_gender)
     VALUES ($1,$2,$3)
     ON CONFLICT (identity)
     DO UPDATE SET preferred_lang=$2,
                   voice_gender=$3,
                   updated_at=NOW()`,
    [id, preferredLang, voiceGender || 'female']
  );

  res.json({ ok: true });
});






/* ============================
   /call-user endpoint (unchanged except accepts optional targetLang)
   ============================ */
app.post("/call-user", async (req, res) => {
  try {
    let { fromIdentity, toIdentity } = req.body;

    const fromDigits = canonicalIdentity(fromIdentity);
    const toDigits = canonicalIdentity(toIdentity);

    // ✅ CHECK IF USER EXISTS (REGISTERED)
    const checkUser = await pg.query(
      "SELECT 1 FROM fcm_registry WHERE identity=$1 LIMIT 1",
      [toDigits]
    );

    if (checkUser.rows.length === 0) {
      return res.json({ status: "not_registered" });
    }

    // 🚨 Detect ANY call between these two users
    const pairCheck = await pg.query(`
SELECT 1
FROM active_calls
WHERE
(
  (caller_identity=$1 AND callee_identity=$2)
  OR
  (caller_identity=$2 AND callee_identity=$1)
)
AND status IN ('INITIATED','RINGING','ANSWERED')
LIMIT 1
`, [fromDigits, toDigits]);

    if (pairCheck.rows.length > 0) {

      console.log(`⚠️ CROSS CALL DETECTED`);

      // 🔥 find existing active call
      const active = await pg.query(`
    SELECT call_sid
    FROM active_calls
    WHERE
    (
      (caller_identity=$1 AND callee_identity=$2)
      OR
      (caller_identity=$2 AND callee_identity=$1)
    )
    LIMIT 1
  `, [fromDigits, toDigits]);

      if (active.rows.length) {

        const sid = active.rows[0].call_sid;

        try {
          await twilioClient.calls(sid).update({ status: "completed" });
          console.log("📴 Force ended existing call:", sid);
        } catch (e) { }

      }

      const users = [fromDigits, toDigits];

      for (const u of users) {

        const { rows } = await pg.query(
          "SELECT fcm_token FROM fcm_registry WHERE identity=$1 LIMIT 1",
          [u]
        );

        if (rows.length) {

          await sendFcmNotification(rows[0].fcm_token, {
            type: "USER_BUSY"
          });

        }

      }

      return res.json({ status: "busy" });

    }

    if (fromDigits === toDigits) {
      return res.json({ status: "busy" });
    }
    // (incoming call)
    const call = await twilioClient.calls.create({
      to: `client:${toDigits}`,
      from: TWILIO_VOICE_CALLER_ID,
      url: `${BASE_URL}/twiml/voice?from=${toDigits}&to=${fromDigits}`,
      customParameters: {
        caller: fromDigits,
      }
    });

    // 3️⃣ Register active call
    try {

      await pg.query(`
  INSERT INTO active_calls
  (caller_identity, callee_identity, call_sid, status)
  VALUES ($1,$2,$3,'INITIATED')
  `, [fromDigits, toDigits, call.sid])

    } catch (err) {

      // 🚨 CROSS CALL DETECTED BY DB
      if (err.code === "23505") {

        console.log("⚠️ DB blocked cross-call");

        // kill the call Twilio just created
        try {
          await twilioClient.calls(call.sid).update({ status: "completed" });
        } catch (e) { }

        const users = [fromDigits, toDigits];

        for (const u of users) {

          const { rows } = await pg.query(
            "SELECT fcm_token FROM fcm_registry WHERE identity=$1 LIMIT 1",
            [u]
          );

          if (rows.length) {

            await sendFcmNotification(rows[0].fcm_token, {
              type: "USER_BUSY"
            });

          }

        }

        return res.json({ status: "busy" });

      }

      throw err;
    }


    // Auto end call if not answered in 30 seconds
    const timeoutId = setTimeout(async () => {

      try {

        const result = await pg.query(
          `SELECT call_sid,status
       FROM active_calls
       WHERE caller_identity=$1
       AND callee_identity=$2`,
          [fromDigits, toDigits]
        );

        if (!result.rows.length) return;

        const call = result.rows[0];

        // ✅ DO NOT END if call already answered
        if (call.status === "ANSWERED") {
          console.log("✅ Call already answered — skipping timeout");
          return;
        }

        const callSid = call.call_sid;

        console.log("⏰ Ending unanswered call:", callSid);

        try {
          await twilioClient.calls(callSid).update({ status: "completed" });
        } catch (err) { }

        await pg.query(
          `DELETE FROM active_calls
       WHERE caller_identity=$1
       AND callee_identity=$2`,
          [fromDigits, toDigits]
        );

      } catch (err) {
        console.error("timeout error:", err.message);
      }

    }, 30000);

    // 🔥 SEND REAL CALLER TO CALLEE VIA FCM (SOURCE OF TRUTH)
    const { rows } = await pg.query(
      "SELECT fcm_token FROM fcm_registry WHERE identity=$1 OR phone_e164=$1 LIMIT 1",
      [toDigits]
    );

    if (rows.length) {
      await sendFcmNotification(rows[0].fcm_token, {
        type: "VOICE_INVITE",
        caller_display: `+${fromDigits}`, // 👈 REAL DIALED NUMBER
        caller_id: fromDigits
      });
    }

    // 🔥 Save call history (AUDIO)
    await pg.query(
      `INSERT INTO call_history
   (id, caller_identity, callee_identity, call_type)
   VALUES ($1,$2,$3,$4)`,
      [uuidv4(), fromDigits, toDigits, "AUDIO"]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("/call-user error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


/* callee-answered, end-call, cleanup (unchanged) */
app.post("/callee-answered", async (req, res) => {
  try {
    let { fromIdentity, toIdentity } = req.body;
    if (!fromIdentity || !toIdentity)
      return res.status(400).json({ ok: false, error: "Missing fromIdentity or toIdentity" });

    fromIdentity = canonicalIdentity(fromIdentity);
    toIdentity = canonicalIdentity(toIdentity);

    console.log(`📞 Callee answered: from=${fromIdentity}, to=${toIdentity}`);

    const { rows } = await pg.query(
      "SELECT fcm_token FROM fcm_registry WHERE identity=$1 OR phone_e164=$1 LIMIT 1",
      [toIdentity]
    );

    if (!rows.length) {
      console.warn(`⚠️ No FCM token found for caller ${toIdentity}`);
      return res.json({ ok: false });
    }

    const callerFcm = rows[0].fcm_token;
    await sendFcmNotification(callerFcm, {
      type: "CALLEE_ANSWERED",
      fromIdentity
    });

    await pg.query(`
UPDATE active_calls
SET status='ANSWERED'
WHERE caller_identity=$1
AND callee_identity=$2
`, [fromIdentity, toIdentity])

    console.log(`✅ Sent CALLEE_ANSWERED push to caller (${toIdentity})`);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /callee-answered error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/end-call", async (req, res) => {
  try {
    const { fromIdentity, toIdentity } = req.body;
    if (!fromIdentity || !toIdentity)
      return res.status(400).json({ error: "Missing fromIdentity or toIdentity" });

    const key = `${fromIdentity}->${toIdentity}`;
    const now = Date.now();
    const last = recentEndCalls.get(key) || 0;

    if (now - last < END_CALL_DEDUPE_WINDOW_MS) {
      console.log(`🚫 Duplicate END_CALL skipped for ${key}`);
      return res.json({ ok: true, deduped: true });
    }

    await pg.query(
      `
  DELETE FROM active_calls
  WHERE caller_identity = $1
     OR callee_identity = $1
     OR caller_identity = $2
     OR callee_identity = $2
  `,
      [fromIdentity, toIdentity]
    );
    // 🔥 Update call end time + duration
    await pg.query(
      `
  UPDATE call_history
  SET ended_at = NOW(),
      duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))
  WHERE (caller_identity=$1 AND callee_identity=$2
     OR  caller_identity=$2 AND callee_identity=$1)
  AND ended_at IS NULL
  `,
      [fromIdentity, toIdentity]
    );
    recentEndCalls.set(key, now);

    console.log(`📴 Call ended by ${fromIdentity} ➡ notifying ${toIdentity}`);

    const { rows } = await pg.query(
      "SELECT fcm_token FROM fcm_registry WHERE identity=$1 OR phone_e164=$1 LIMIT 1",
      [toIdentity]
    );
    if (!rows.length) {
      console.log(`⚠️ No FCM token found for ${toIdentity}`);
      return res.json({ ok: false, error: "No FCM token" });
    }

    const fcmToken = rows[0].fcm_token;

    await sendFcmNotification(fcmToken, {
      type: "END_CALL",
      fromIdentity,
    });

    console.log(`✅ Sent END_CALL push to ${toIdentity}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /end-call error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }


});

async function cleanupOldFCMTokens() {
  try {
    const { rowCount } = await pg.query(`
      DELETE FROM fcm_registry WHERE last_updated < NOW() - INTERVAL '90 days'
    `);
    if (rowCount > 0) console.log(`🧹 Cleaned up ${rowCount} stale FCM tokens`);
  } catch (err) {
    console.error("❌ Cleanup error:", err.message);
  }
}
setInterval(cleanupOldFCMTokens, 24 * 60 * 60 * 1000);

/* ============================
   START SERVER + WebSocket upgrade (unchanged)
   ============================ */
// ================= CALL HISTORY =================
app.get("/call-history", async (req, res) => {
  try {
    const identity = canonicalIdentity(req.query.identity);

    const { rows } = await pg.query(
      `
      SELECT
  peer,
  COUNT(*) AS total_calls,
  MAX(started_at) AS last_called,
  (
    SELECT
      CASE
        WHEN ch2.caller_identity = $1 THEN 'outgoing'
        ELSE 'incoming'
      END
    FROM call_history ch2
    WHERE (
      ch2.caller_identity = $1 AND ch2.callee_identity = peer
    ) OR (
      ch2.caller_identity = peer AND ch2.callee_identity = $1
    )
    ORDER BY ch2.started_at DESC
    LIMIT 1
  ) AS last_direction
FROM (
  SELECT
    CASE
      WHEN caller_identity = $1 THEN callee_identity
      ELSE caller_identity
    END AS peer,
    started_at,
    caller_identity,
    callee_identity
  FROM call_history
 WHERE
(
  caller_identity = $1
  OR
  callee_identity = $1
)
AND NOT ($1 = ANY(deleted_by))
) ch
GROUP BY peer
ORDER BY last_called DESC
      `,
      [identity]
    );

    res.json({ ok: true, history: rows });
  } catch (err) {
    console.error("❌ call-history error:", err.message);
    res.status(500).json({ ok: false });
  }
});

app.post("/delete-call-history", async (req, res) => {
  try {
    let { identity, peer } = req.body;

    identity = canonicalIdentity(identity);
    peer = canonicalIdentity(peer);

    if (!identity || !peer)
      return res.status(400).json({ ok: false });

    await pg.query(
      `
      UPDATE call_history
      SET deleted_by = array_append(deleted_by, $1)
      WHERE (
        (caller_identity=$1 AND callee_identity=$2)
        OR
        (caller_identity=$2 AND callee_identity=$1)
      )
      AND NOT ($1 = ANY(deleted_by))
      `,
      [identity, peer]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("delete-call-history error:", err.message);
    res.status(500).json({ ok: false });
  }
});


const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`🚀 Server running at http://${HOST}:${PORT}`);
  console.log(`✅ Twilio OTP + Voice + Video + Firebase integrated`);
});

const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/twilio-media")) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

/* ==========================================================
   TWILIO MEDIA STREAM → (live STT) → TRANSLATE → TTS → FCM
   ========================================================== */

function decodeHtml(str) {
  return str.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d));
}

function chunkPcm(buffer, chunkSize = 320) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.slice(i, i + chunkSize));
  }
  return chunks;
}

// 🔒 Per-speaker audio queue (prevents overlap)
const ttsQueueByUser = new Map();

function enqueueTTS(payload) {
  const { fromId } = payload;

  const prev = ttsQueueByUser.get(fromId) || Promise.resolve();

  const next = prev
    .then(() => handleTranslationAndTTS(payload))
    .catch(() => { }); // never break chain

  ttsQueueByUser.set(fromId, next);
  return next;
}


async function handleTranslationAndTTS({ transcript, fromId, toId, targetLang }) {
  const targetStream = streamMap.get(toId);
  const gender = targetStream?.listenGender || "female";

  if (!targetStream || targetStream.ws.readyState !== WebSocket.OPEN) {
    console.warn(`⚠️ Target stream not ready | ${fromId} → ${toId}`);
    return;
  }



  console.log(`🔁 TRANSLATE | ${fromId} → ${toId} | "${transcript}"`);

  const translateTo = targetLang;
  // 1️⃣ Translate to listener language
  let translatedText = transcript;
  try {
    const [translation] = await gTranslate.translate(transcript, targetLang);
    translatedText = translation;
  } catch (err) {
    console.error("❌ Translate error:", err.message);
  }

  // 2️⃣ Translate to English (ALWAYS)
  let englishText = transcript;
  try {
    const [englishTranslation] = await gTranslate.translate(transcript, "en");
    englishText = englishTranslation;
  } catch (err) {
    console.error("❌ English translate error:", err.message);
  }

  console.log(`📝 TRANSLATED | ${fromId} → ${toId} | "${translatedText}"`);
  await sendLiveCaption(fromId, toId, transcript, translatedText, englishText);



  const ttsPromise = ttsClient.synthesizeSpeech({
    input: { text: translatedText },
    voice: {
      languageCode: TTS_LANG_MAP[translateTo] || "en-IN",
      ssmlGender: gender === "male" ? "MALE" : "FEMALE"
    },


    audioConfig: {
      audioEncoding: "LINEAR16",
      sampleRateHertz: 8000
    }
  });

  const [ttsResponse] = await ttsPromise;


  const pcmBuffer = Buffer.from(ttsResponse.audioContent, "base64");
  const chunks = chunkPcm(pcmBuffer, 160);

  for (const chunk of chunks) {
    const mulawBase64 = pcm16ToMulawBase64(chunk);
    targetStream.ws.send(JSON.stringify({
      event: "media",
      streamSid: targetStream.streamSid,
      media: { payload: mulawBase64 }
    }));
    await new Promise(r => setTimeout(r, 10));
  }

  console.log(
    `🔊 AUDIO DELIVERED | speaker=${fromId} | listener=${toId} | lang=${translateTo}`
  );

}

async function sendLiveCaption(fromId, toId, original, translated, english) {

  const users = [fromId, toId];

  for (const user of users) {
    const { rows } = await pg.query(
      "SELECT fcm_token FROM fcm_registry WHERE identity=$1 LIMIT 1",
      [user]
    );

    if (rows.length && rows[0].fcm_token) {
      await sendFcmNotification(rows[0].fcm_token, {
        type: "LIVE_CAPTION",
        sender: fromId,
        original,
        translated,
        english
      });

    }
  }
}



wss.on("connection", async (ws, req) => {
  let streamActive = true;

  let recognizeStream = null;


  let silenceChecker = null;


  let lastSpeechTime = Date.now();
  let currentUtterance = "";
  let lastCommittedFullText = "";



  let lastUtteranceChangeTime = Date.now();


  let speakLang = "en";   // 🔥 DEFAULT
  let listenLang = "en";
  let SILENCE_FLUSH_MS = 900;



  let fromId = null;
  let toId = null;



  console.log("🎧 Twilio Media Stream connected");




  // Twilio -> Deepgram audio forward
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);


      if (data.event === "start") {
        const params = data.start?.customParameters || {};

        fromId = params.from;
        toId = params.to;

        // (Removed premature ANSWERED status update. The /callee-answered endpoint handles this.)


        speakLang = params.speakLang || "en";   // 🔥 ASSIGN (not const)
        listenLang = params.listenLang || "en";

        let speakGender = params.speakGender || "female";
        let listenGender = params.listenGender || "female";

        SILENCE_FLUSH_MS = speakLang === "te" ? 700 : 900;

        console.log(
          `🎯 STREAM START | ${fromId} → ${toId} | speak=${speakLang} listen=${listenLang}`
        );



        if (!fromId || !toId) {
          ws.close();
          return;
        }

        recognizeStream = speechClient.streamingRecognize({
          config: {
            encoding: "MULAW",
            sampleRateHertz: 8000,

            languageCode: STT_LANG_MAP[speakLang] || "en-IN",

            enableAutomaticPunctuation: false,
            model: "telephony",
            useEnhanced: true,
          },
          interimResults: true,
        })


          .on("data", async (data) => {
            if (!streamActive) return;

            const result = data.results?.[0];
            if (!result) return;

            const transcript = result.alternatives?.[0]?.transcript?.trim();
            if (!transcript) return;

            lastSpeechTime = Date.now();

            if (transcript !== currentUtterance) {
              currentUtterance = transcript;
              lastUtteranceChangeTime = Date.now();
            }
          })

          .on("error", (err) => {
            console.warn("⚠️ STT reset:", err.message);

            try {
              recognizeStream?.destroy();
            } catch { }

            recognizeStream = speechClient.streamingRecognize({
              config: {
                encoding: "MULAW",
                sampleRateHertz: 8000,
                languageCode: STT_LANG_MAP[speakLang] || "en-IN",
                enableAutomaticPunctuation: false,
                model: "telephony",
                useEnhanced: true,
              },
              interimResults: true,
            })

              .on("data", async (data) => {
                if (!streamActive) return;

                const result = data.results?.[0];
                if (!result) return;

                const transcript = result.alternatives?.[0]?.transcript?.trim();
                if (!transcript) return;

                lastSpeechTime = Date.now();

                if (transcript !== currentUtterance) {
                  currentUtterance = transcript;
                  lastUtteranceChangeTime = Date.now();
                }
              })

              .on("error", (e) => {
                console.warn("⚠️ STT inner error:", e.message);
              });
          });

        silenceChecker = setInterval(async () => {
          const now = Date.now();

          if (
            currentUtterance &&
            now - lastSpeechTime > SILENCE_FLUSH_MS &&
            now - lastUtteranceChangeTime > (speakLang === "te" ? 300 : 400)

          ) {
            let fullText = currentUtterance.trim();

            // 🚫 DROP SUSPICIOUS LARGE JUMPS (TELUGU SAFETY)
            if (fullText.length > 120 && fullText.split(" ").length > 8) {
              currentUtterance = "";
              return;
            }

            if (!fullText) return;

            // 🧠 DELTA EXTRACTION (TELUGU FIX)
            let deltaText = fullText;

            if (lastCommittedFullText && fullText.startsWith(lastCommittedFullText)) {
              deltaText = fullText.slice(lastCommittedFullText.length).trim();
            }

            // Nothing new → do nothing
            if (!deltaText) {
              currentUtterance = "";
              return;
            }

            console.log(`🗣 STT COMMIT | ${fromId} → ${toId} | "${deltaText}"`);

            lastCommittedFullText = fullText;
            currentUtterance = "";

            // 🔥 FORCE STT CONTEXT RESET (TELUGU FIX)
            try {
              recognizeStream.end();
            } catch { }

            recognizeStream = speechClient.streamingRecognize({
              config: {
                encoding: "MULAW",
                sampleRateHertz: 8000,
                languageCode: STT_LANG_MAP[speakLang] || "en-IN",
                enableAutomaticPunctuation: false,
                model: "telephony",
                useEnhanced: true,
              },
              interimResults: true,
            })
              .on("data", async (data) => {
                if (!streamActive) return;

                const result = data.results?.[0];
                if (!result) return;

                const transcript = result.alternatives?.[0]?.transcript?.trim();
                if (!transcript) return;

                lastSpeechTime = Date.now();

                if (transcript !== currentUtterance) {
                  currentUtterance = transcript;
                  lastUtteranceChangeTime = Date.now();
                }
              })
              .on("error", (e) => {
                console.warn("⚠️ STT reset:", e.message);
              });


            await enqueueTTS({
              transcript: deltaText,
              fromId,
              toId,
              targetLang: listenLang
            });
          }
        }, 150);



        streamMap.set(fromId, {
          ws,
          streamSid: data.streamSid,
          fromId,
          toId,
          speakLang,
          listenLang,
          speakGender,
          listenGender,
          lastSeen: Date.now()
        });


        return;


      }

      if (data.event === "media") {
        if (!fromId || !toId) return;

        // 🚫 Ignore injected audio (prevents feedback)
        if (data.media.track === "outbound") return;

        const audio = Buffer.from(data.media.payload, "base64");

        if (recognizeStream && !recognizeStream.destroyed) {
          recognizeStream.write(audio);
        }

        return;

      }


      if (data.event === "stop") {
        streamActive = false;

        if (recognizeStream) {
          recognizeStream.end();
          recognizeStream = null;
        }

        console.log("🛑 Twilio stream stopped");
        return;
      }

    } catch (err) {
      console.error("❌ WS parse error:", err);
    }
  });


  ws.on("close", () => {
    if (fromId && streamMap.get(fromId)?.ws === ws) {
      streamMap.delete(fromId);
    }

    clearInterval(silenceChecker);


    if (recognizeStream) {
      recognizeStream.destroy();
      recognizeStream = null;
    }
    console.log(`🔌 STREAM CLOSED | ${fromId} → ${toId}`);

    console.log("🔌 Twilio WebSocket closed for", fromId);


  });


  ws.on("error", (err) => console.error("❌ Twilio WS Error:", err));
});

setInterval(async () => {
  try {
    await pg.query(`
      DELETE FROM active_calls
      WHERE created_at < NOW() - INTERVAL '2 hours'
    `);
  } catch (err) {
    console.error("active_calls cleanup error", err.message);
  }
}, 60000);


