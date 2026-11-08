/**
 * Password hashing for the unlock gate.
 *
 * Only a salted PBKDF2 hash is stored in `data.json`; the plaintext password
 * is never persisted. This is a UI gate, not encryption: a user with filesystem
 * access can still edit the vault or plugin data directly.
 */

const ITERATIONS = 120_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
export const MIN_PASSWORD_LENGTH = 4;

function getCrypto(): Crypto {
	if (typeof crypto === 'undefined' || !crypto.subtle) {
		throw new Error('Web Crypto is not available');
	}
	return crypto;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function createSalt(): string {
	const bytes = new Uint8Array(SALT_BYTES);
	getCrypto().getRandomValues(bytes);
	return bytesToBase64(bytes);
}

export async function hashPassword(password: string, saltBase64: string): Promise<string> {
	const cryptoApi = getCrypto();
	const key = await cryptoApi.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await cryptoApi.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: base64ToBytes(saltBase64) as BufferSource,
			iterations: ITERATIONS,
			hash: 'SHA-256'
		},
		key,
		KEY_BITS
	);
	return bytesToBase64(new Uint8Array(bits));
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function verifyPassword(
	password: string,
	hash: string,
	saltBase64: string
): Promise<boolean> {
	if (!hash || !saltBase64) return false;
	const candidate = await hashPassword(password, saltBase64);
	return constantTimeEqual(candidate, hash);
}
