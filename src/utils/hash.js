// ============================================================================
// FILE: src/utils/hash.js
// PURPOSE: 
// 1. Creates a SHA-256 fingerprint of question text to block duplicates.
// 2. Embeds invisible zero-width watermarks to catch question paper leaks.
// ============================================================================

/**
 * Normalizes a question string and returns a unique SHA-256 hex hash.
 * Example: "What is  2 + 2?" and "what is 2+2" produce the EXACT same hash!
 */
export async function generateQuestionHash(questionText) {
  // Guard against empty or non-string input (Bug Prevention)
  if (!questionText || typeof questionText !== 'string') {
    throw new Error('Invalid question text provided for hashing.');
  }

  // Step 1: Convert to lowercase
  // Step 2: Remove all spaces and punctuation so minor typos don't bypass check
  const cleanedText = questionText
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  // Convert string to bytes for Cloudflare's built-in Web Crypto API
  const encoder = new TextEncoder();
  const data = encoder.encode(cleanedText);

  // Generate SHA-256 digest
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert buffer to hexadecimal string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

/**
 * Generates a secure, unguessable ID (Prevents IDOR bugs where users guess ID=1, 2, 3)
 * @param {string} prefix - e.g., 'q', 'exam', 'res'
 */
export function generateSecureId(prefix = 'id') {
  // crypto.randomUUID() is built into Cloudflare Workers and is cryptographically secure
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * ANTI-CHEAT: Injects an invisible binary watermark (using zero-width characters)
 * into the question text tied to the student's session ID.
 * Humans cannot see it, but if copied to Telegram/Google, we can decode the session ID.
 */
export function watermarkQuestionText(text, sessionId) {
  if (!text || !sessionId) return text;

  // Convert first 6 chars of sessionId into binary (0s and 1s)
  const shortId = sessionId.slice(-6);
  const binary = shortId
    .split('')
    .map((char) => char.charCodeAt(0).toString(2).padStart(8, '0'))
    .join('');

  // Map '0' to Zero-Width Space (\u200B) and '1' to Zero-Width Non-Joiner (\u200C)
  const invisibleSignature = binary
    .split('')
    .map((bit) => (bit === '0' ? '\u200B' : '\u200C'))
    .join('');

  // Insert invisible signature right after the first word
  const firstSpaceIndex = text.indexOf(' ');
  if (firstSpaceIndex === -1) {
    return text + invisibleSignature;
  }
  return (
    text.slice(0, firstSpaceIndex) +
    invisibleSignature +
    text.slice(firstSpaceIndex)
  );
}
