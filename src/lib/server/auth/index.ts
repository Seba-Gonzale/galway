import { dev } from '$app/environment';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '../db';
import * as schema from '../db/schema';
import type { RequestEvent } from '@sveltejs/kit';

/** Instancia de Drizzle (`getDb()`) o el binding D1 crudo; ambas variantes son aceptadas. */
export type DbSource = D1Database | ReturnType<typeof getDb>;

/**
 * Resuelve la instancia de Drizzle a usar. Si el llamador ya tiene una (los
 * servicios la reciben en `ctx.db`), se reutiliza: una sola instancia por request.
 */
function resolveDb(source: DbSource): ReturnType<typeof getDb> {
	return typeof (source as ReturnType<typeof getDb>).select === 'function'
		? (source as ReturnType<typeof getDb>)
		: getDb(source as D1Database);
}

const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const ALGORITHM = 'PBKDF2';
const HASH = 'SHA-256';
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const SESSION_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax',
	secure: !dev,
	maxAge: 60 * 60 * 24 * 7 // 7 days
} as const;

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		ALGORITHM,
		false,
		['deriveBits']
	);
	const derived = await crypto.subtle.deriveBits(
		{ name: ALGORITHM, hash: HASH, salt, iterations: ITERATIONS },
		key,
		KEY_LENGTH * 8
	);
	return `${toHex(salt.buffer as ArrayBuffer)}:${toHex(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltHex, hashHex] = stored.split(':');
	if (!saltHex || !hashHex) return false;
	const salt = fromHex(saltHex).buffer as ArrayBuffer;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		ALGORITHM,
		false,
		['deriveBits']
	);
	const derived = await crypto.subtle.deriveBits(
		{ name: ALGORITHM, hash: HASH, salt, iterations: ITERATIONS },
		key,
		KEY_LENGTH * 8
	);
	return timingSafeEqual(new Uint8Array(derived), fromHex(hashHex));
}

export async function createSession(source: DbSource, accountId: string): Promise<string> {
	const db = resolveDb(source);
	const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
	const token = toHex(tokenBytes.buffer as ArrayBuffer);
	const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();
	await db
		.insert(schema.sessions)
		.values({ id: token, account_id: accountId, expires_at: expiresAt });
	return token;
}

export async function deleteSession(source: DbSource, token: string): Promise<void> {
	const db = resolveDb(source);
	await db.delete(schema.sessions).where(eq(schema.sessions.id, token));
}

export async function deleteAllSessionsForAccount(
	source: DbSource,
	accountId: string
): Promise<void> {
	const db = resolveDb(source);
	await db.delete(schema.sessions).where(eq(schema.sessions.account_id, accountId));
}

export async function getSession(event: RequestEvent) {
	const token = event.cookies.get('session');
	if (!token || token.length !== 64) return null;

	const db = getDb(event.platform!.env.DB);
	const now = new Date().toISOString();
	const result = await db
		.select({ account: schema.accounts })
		.from(schema.sessions)
		.innerJoin(schema.accounts, eq(schema.sessions.account_id, schema.accounts.id))
		.where(and(eq(schema.sessions.id, token), gt(schema.sessions.expires_at, now)))
		.limit(1);
	return result[0]?.account ?? null;
}

// -----------------------------------------------
// Login: rate limit por IP + autenticación
// -----------------------------------------------

export const MAX_LOGIN_ATTEMPTS = 5;
export const LOGIN_LOCK_MINUTES = 15;

async function findRateLimit(db: ReturnType<typeof getDb>, ip: string) {
	return db.query.loginRateLimits.findFirst({
		where: eq(schema.loginRateLimits.ip, ip)
	});
}

/**
 * Devuelve el mensaje de error si la IP está bloqueada, o `null` si puede intentar.
 */
export async function checkRateLimit(source: DbSource, ip: string): Promise<string | null> {
	const db = resolveDb(source);
	const rateLimit = await findRateLimit(db, ip);
	const now = new Date().toISOString();

	if (rateLimit?.locked_until && rateLimit.locked_until > now) {
		const mins = Math.ceil((new Date(rateLimit.locked_until).getTime() - Date.now()) / 60000);
		return `Too many login attempts. Please try again in ${mins} minute(s).`;
	}
	return null;
}

/**
 * Suma un intento fallido y bloquea la IP al alcanzar `MAX_LOGIN_ATTEMPTS`.
 */
export async function recordFailedAttempt(source: DbSource, ip: string): Promise<void> {
	const db = resolveDb(source);
	const rateLimit = await findRateLimit(db, ip);
	const now = new Date().toISOString();
	const attempts = (rateLimit?.attempts ?? 0) + 1;
	const locked_until =
		attempts >= MAX_LOGIN_ATTEMPTS
			? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000).toISOString()
			: null;

	await db
		.insert(schema.loginRateLimits)
		.values({ ip, attempts, locked_until, last_attempt_at: now })
		.onConflictDoUpdate({
			target: schema.loginRateLimits.ip,
			set: { attempts, locked_until, last_attempt_at: now }
		});
}

/** Login correcto: limpia el contador de la IP. */
export async function resetRateLimit(source: DbSource, ip: string): Promise<void> {
	const db = resolveDb(source);
	await db.delete(schema.loginRateLimits).where(eq(schema.loginRateLimits.ip, ip));
}

/**
 * Busca la cuenta por email y verifica el password (PBKDF2 con comparación
 * timing-safe). Devuelve `null` si no existe o no coincide.
 */
export async function authenticateAccount(
	source: DbSource,
	email: string,
	password: string
): Promise<typeof schema.accounts.$inferSelect | null> {
	const db = resolveDb(source);
	const account = await db.query.accounts.findFirst({
		where: eq(schema.accounts.email, email)
	});
	if (!account) return null;
	return (await verifyPassword(password, account.password_hash)) ? account : null;
}
