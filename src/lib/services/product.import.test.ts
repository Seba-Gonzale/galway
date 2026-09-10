/**
 * Tests de `importProducts` (TASK-032).
 *
 * Verifican contra D1 local que el import sigue creando producto + fila de
 * inventory (quantity 0) ahora que los inserts de inventory se envían con
 * `runBatches()`. No se usa mode 'replace' porque borra toda la tabla products.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { importProducts } from './product';
import type { ServiceCtx } from '$lib/services';

describe('importProducts', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let ctx: ServiceCtx;
	let accountId = '';
	const productIds: string[] = [];
	const stamp = Date.now();

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		const db = getDb(proxy.env.DB);

		const [account] = await db
			.insert(schema.accounts)
			.values({
				email: `import-prod-${stamp}@example.com`,
				password_hash: 'not-a-real-hash',
				name: 'Import Products Test',
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
		if (productIds.length > 0) {
			await ctx.db.delete(schema.inventory).where(inArray(schema.inventory.product_id, productIds));
			await ctx.db.delete(schema.products).where(inArray(schema.products.id, productIds));
		}
		await ctx.db.delete(schema.auditLogs).where(eq(schema.auditLogs.user_id, accountId));
		await ctx.db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
		await proxy.dispose();
	});

	it('crea los productos y su fila de inventory en 0', async () => {
		const csv = [
			'Product Code,Product Name,Unit',
			`TST-P1-${stamp},Product One,kg`,
			`TST-P2-${stamp},Product Two,pcs`
		].join('\n');

		const result = await importProducts(ctx, csv, 'append');

		expect(result).toEqual({ success: true, count: 2 });

		const created = await ctx.db
			.select({ id: schema.products.id, code: schema.products.code })
			.from(schema.products)
			.where(inArray(schema.products.code, [`TST-P1-${stamp}`, `TST-P2-${stamp}`]));
		expect(created).toHaveLength(2);
		productIds.push(...created.map((p) => p.id));

		const stock = await ctx.db
			.select({
				product_id: schema.inventory.product_id,
				quantity: schema.inventory.quantity
			})
			.from(schema.inventory)
			.where(inArray(schema.inventory.product_id, productIds));
		expect(stock).toHaveLength(2);
		expect(stock.every((s) => s.quantity === 0)).toBe(true);
	});

	it('sigue devolviendo fail(400) si el CSV no tiene columnas requeridas', async () => {
		const result = await importProducts(ctx, 'Product Code,Product Name\nA,One', 'append');

		expect(result).toMatchObject({ status: 400 });
	});
});
