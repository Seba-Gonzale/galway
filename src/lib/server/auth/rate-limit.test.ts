/**
 * Tests del rate limit de login y de la autenticación (TASK-026).
 *
 * Antes este código vivía inline en `src/routes/login/+page.server.ts`:
 * 5 intentos → bloqueo de 15 minutos por IP, reset en login correcto.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { hashPassword } from './index';
import {
	checkRateLimit,
	recordFailedAttempt,
	resetRateLimit,
	authenticateAccount,
	MAX_LOGIN_ATTEMPTS
} from './index';

describe('Login rate limit', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let db: ReturnType<typeof getDb>;
	const ip = '203.0.113.99';

	async function attemptsForTestIp(): Promise<number> {
		const [row] = await db
			.select({ attempts: schema.loginRateLimits.attempts })
			.from(schema.loginRateLimits)
			.where(eq(schema.loginRateLimits.ip, ip));
		return row?.attempts ?? 0;
	}

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		db = getDb(proxy.env.DB);
		await db.delete(schema.loginRateLimits).where(eq(schema.loginRateLimits.ip, ip));
	});

	afterAll(async () => {
		await db.delete(schema.loginRateLimits).where(eq(schema.loginRateLimits.ip, ip));
		await proxy.dispose();
	});

	it('sin intentos previos no bloquea', async () => {
		expect(await checkRateLimit(db, ip)).toBeNull();
	});

	it(`registra intentos y bloquea al llegar a ${MAX_LOGIN_ATTEMPTS}`, async () => {
		for (let i = 1; i < MAX_LOGIN_ATTEMPTS; i++) {
			await recordFailedAttempt(db, ip);
			expect(await attemptsForTestIp()).toBe(i);
			expect(await checkRateLimit(db, ip)).toBeNull();
		}

		await recordFailedAttempt(db, ip);
		const message = await checkRateLimit(db, ip);

		expect(message).toMatch(/^Too many login attempts\. Please try again in \d+ minute\(s\)\.$/);
		const mins = Number(/in (\d+) minute/.exec(message ?? '')?.[1]);
		expect(mins).toBeGreaterThan(14);
		expect(mins).toBeLessThanOrEqual(15);
	});

	it('resetRateLimit limpia la IP (login correcto)', async () => {
		expect(await checkRateLimit(db, ip)).not.toBeNull();

		await resetRateLimit(db, ip);

		expect(await attemptsForTestIp()).toBe(0);
		expect(await checkRateLimit(db, ip)).toBeNull();
	});

	it('acepta el binding D1 crudo además de la instancia de drizzle', async () => {
		await expect(checkRateLimit(proxy.env.DB, ip)).resolves.toBeNull();
	});
});

describe('authenticateAccount', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let db: ReturnType<typeof getDb>;
	let accountId = '';
	const email = `auth-rl-${Date.now()}@example.com`;

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		db = getDb(proxy.env.DB);
		const pw = await hashPassword('test123');
		const [account] = await db
			.insert(schema.accounts)
			.values({ email, password_hash: pw, name: 'Auth RL Test', role: 'general' })
			.returning();
		accountId = account.id;
	});

	afterAll(async () => {
		await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
		await proxy.dispose();
	});

	it('devuelve la cuenta con credenciales correctas', async () => {
		const account = await authenticateAccount(db, email, 'test123');
		expect(account?.email).toBe(email);
	});

	it('devuelve null con password incorrecto', async () => {
		expect(await authenticateAccount(db, email, 'wrong')).toBeNull();
	});

	it('devuelve null si el email no existe', async () => {
		expect(await authenticateAccount(db, 'nope@example.com', 'test123')).toBeNull();
	});
});
