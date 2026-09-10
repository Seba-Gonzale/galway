/**
 * Tests de `importInventory` (TASK-032).
 *
 * Verifican contra D1 local que el import sigue fijando exactamente las mismas
 * cantidades ahora que los upserts se envían con `runBatches()` (TASK-027 dejó
 * este N+1 fuera de su allowed_scope).
 *
 * No se usa mode 'replace' porque borra toda la tabla inventory.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { importInventory } from './inventory';
import type { ServiceCtx } from '$lib/services';

describe('importInventory', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let ctx: ServiceCtx;
	let accountId = '';
	const productIds: string[] = [];
	const stamp = Date.now();

	async function makeProduct(code: string, initialStock: number | null): Promise<string> {
		const [product] = await ctx.db
			.insert(schema.products)
			.values({ code, name: `Import Test ${code}`, unit: 'kg', min_quantity: 0 })
			.returning();
		productIds.push(product.id);
		if (initialStock !== null) {
			await ctx.db.insert(schema.inventory).values({
				product_id: product.id,
				quantity: initialStock,
				updated_at: new Date().toISOString()
			});
		}
		return product.id;
	}

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		const db = getDb(proxy.env.DB);

		const [account] = await db
			.insert(schema.accounts)
			.values({
				email: `import-inv-${stamp}@example.com`,
				password_hash: 'not-a-real-hash',
				name: 'Import Inventory Test',
				role: 'admin'
			})
			.returning();
		accountId = account.id;

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
		for (const id of productIds) {
			await ctx.db.delete(schema.inventory).where(eq(schema.inventory.product_id, id));
			await ctx.db.delete(schema.products).where(eq(schema.products.id, id));
		}
		await ctx.db.delete(schema.auditLogs).where(eq(schema.auditLogs.user_id, accountId));
		await ctx.db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
		await proxy.dispose();
	});

	it('fija la cantidad de cada producto del CSV (append)', async () => {
		const a = await makeProduct(`TST-IMP-A-${stamp}`, null);
		const b = await makeProduct(`TST-IMP-B-${stamp}`, 99);
		const csv = ['Product Code,Quantity', `TST-IMP-A-${stamp},12`, `TST-IMP-B-${stamp},3`].join(
			'\n'
		);

		const result = await importInventory(ctx, csv, 'append');

		expect(result).toEqual({ success: true, count: 2 });
		const rows = await ctx.db
			.select({
				product_id: schema.inventory.product_id,
				quantity: schema.inventory.quantity
			})
			.from(schema.inventory)
			.where(inArray(schema.inventory.product_id, [a, b]))
			.orderBy(schema.inventory.product_id);
		expect(rows).toEqual(
			[
				{ product_id: a, quantity: 12 },
				{ product_id: b, quantity: 3 }
			].sort((x, y) => x.product_id.localeCompare(y.product_id))
		);
	});

	it('acepta el header alternativo Stock', async () => {
		const c = await makeProduct(`TST-IMP-C-${stamp}`, null);
		const csv = ['Product Code,Stock', `TST-IMP-C-${stamp},7`].join('\n');

		const result = await importInventory(ctx, csv, 'append');

		expect(result).toEqual({ success: true, count: 1 });
		const [row] = await ctx.db
			.select({ quantity: schema.inventory.quantity })
			.from(schema.inventory)
			.where(eq(schema.inventory.product_id, c));
		expect(row?.quantity).toBe(7);
	});

	it('sigue devolviendo fail(400) con CSV sin datos', async () => {
		const result = await importInventory(ctx, 'Product Code,Quantity', 'append');

		expect(result).toMatchObject({ status: 400 });
	});
});
