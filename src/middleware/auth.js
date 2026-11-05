
// ============================================================================
// FILE: src/middleware/auth.js
// PURPOSE:
// Provides Zero-Trust HMAC-SHA256 JWT signing and verification using native
// Web Crypto API. Protects Admin routes and Student Exam session routes.
// ============================================================================

/**
 * Helper: Encodes an object or string into Base64URL format for JWT
 */
function base64UrlEncode(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Helper: Decodes a Base64URL string back into normal text
 */
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

/**
 * Helper: Creates an HMAC-SHA256 signature for JWT verification
 */
async function createSignature(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const binaryString = String.fromCharCode(...signatureArray);
  return base64UrlEncode(binaryString);
}

/**
 * Signs a payload (like { role: 'admin' } or { sessionId: '...', examId: '...' })
 * and returns a tamper-proof JWT token.
 */
export async function signToken(payload, secret, expiresInSeconds = 21600) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64UrlEncode(
    JSON.stringify({
      ...payload,
      iat: now,
      exp: now + expiresInSeconds,
    })
  );

  const signature = await createSignature(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

/**
 * Verifies a JWT token. Returns the decoded payload if valid, or null if tampered/expired.
 */
export async function verifyToken(token, secret) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const expectedSignature = await createSignature(`${header}.${body}`, secret);

    // Constant-time check to prevent timing attacks
    if (signature !== expectedSignature) return null;

    const payload = JSON.parse(base64UrlDecode(body));
    const now = Math.floor(Date.now() / 1000);

    // Check if token is expired
    if (payload.exp && now > payload.exp) return null;

    return payload;
  } catch (err) {
    return null;
  }
}

/**
 * MIDDLEWARE 1: Protects all /api/admin/* routes.
 * Checks the 'Authorization: Bearer <token>' header.
 */
export async function requireAdminAuth(c, next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized: Missing Admin Token' }, 401);
  }

  const token = authHeader.split(' ')[1];
  const payload = await verifyToken(token, c.env.JWT_SECRET);

  if (!payload || payload.role !== 'admin') {
    return c.json({ success: false, error: 'Forbidden: Invalid or Expired Admin Token' }, 403);
  }

  // Token is valid! Proceed to the route handler
  await next();
}

/**
 * MIDDLEWARE 2: Protects /api/exam/submit and student test routes.
 * Ensures a student legitimately started the exam after the countdown finished.
 */
export async function requireStudentSession(c, next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized: Missing Exam Session Token' }, 401);
  }

  const token = authHeader.split(' ')[1];
  const payload = await verifyToken(token, c.env.JWT_SECRET);

  if (!payload || payload.role !== 'student' || !payload.examId) {
    return c.json({ success: false, error: 'Forbidden: Invalid Exam Session' }, 403);
  }

  // Attach student info to context so the route can read it safely (Never trust frontend body!)
  c.set('studentSession', payload);
  await next();
}
