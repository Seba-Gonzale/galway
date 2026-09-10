/**
 * Tests del servicio de dashboard (TASK-024).
 *
 * loadDashboard() encapsula las 8 queries que antes estaban inline en
 * `src/routes/(app)/+page.server.ts`. Estos tests verifican contra D1 local que
 * el shape devuelto es el mismo que la ruta retornaba.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq, count } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { hashPassword } from '$lib/server/auth';
import { loadDashboard } from './dashboard';
import type { ServiceCtx } from '$lib/services';

describe('Dashboard service', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let ctx: ServiceCtx;
	let testAccountId: string;

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		const db = getDb(proxy.env.DB);

		const pw = await hashPassword('test123');
		const [account] = await db
			.insert(schema.accounts)
			.values({
				email: 'dashboard-svc-test@example.com',
				password_hash: pw,
				name: 'Dashboard Test',
				role: 'admin'
			})
			.returning();
		testAccountId = account.id;

		ctx = {
			db,
			env: proxy.env as Env,
			user: {
				id: account.id,
				name: account.name,
				email: account.email,
				role: account.role,
				created_at: account.created_at
			}
		};
	});

	afterAll(async () => {
		await ctx.db.delete(schema.accounts).where(eq(schema.accounts.id, testAccountId));
		await proxy.dispose();
	});

	it('devuelve el mismo shape que la ruta retornaba', async () => {
		const dashboard = await loadDashboard(ctx);

		expect(Object.keys(dashboard)).toEqual([
			'supplierCount',
			'productCount',
			'receivingCountThisMonth',
			'shippingCountThisMonth',
			'lowStockItems',
			'todayReceiving',
			'todayShipping'
		]);
	});

	it('los contadores coinciden con la base', async () => {
		const dashboard = await loadDashboard(ctx);
		const [products] = await ctx.db.select({ count: count() }).from(schema.products);
		const [suppliers] = await ctx.db.select({ count: count() }).from(schema.suppliers);

		expect(dashboard.productCount).toBe(products.count);
		expect(dashboard.supplierCount).toBe(suppliers.count);
	});

	it('lowStockItems, todayReceiving y todayShipping son arrays', async () => {
		const dashboard = await loadDashboard(ctx);

		expect(Array.isArray(dashboard.lowStockItems)).toBe(true);
		expect(Array.isArray(dashboard.todayReceiving)).toBe(true);
		expect(Array.isArray(dashboard.todayShipping)).toBe(true);
	});

	it('filtra lowStockItems por min_quantity > 0 y quantity < min_quantity', async () => {
		const dashboard = await loadDashboard(ctx);

		for (const item of dashboard.lowStockItems) {
			expect(item.min_quantity).toBeGreaterThan(0);
			expect(item.quantity).toBeLessThan(item.min_quantity);
		}
	});
});
