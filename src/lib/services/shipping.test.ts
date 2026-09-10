/**
 * Tests del servicio de shipping (TASK-031).
 *
 * `getShippingSlipPrintData()` encapsula las 2 queries que antes estaban inline en
 * `src/routes/(app)/shipping/[id]/print/+page.server.ts`. Verifican contra D1 local
 * el shape, los joins (cliente / usuario), el orden por line_no y el 404.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { getShippingSlipPrintData } from './shipping';
import type { ServiceCtx } from '$lib/services';

describe('getShippingSlipPrintData', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let ctx: ServiceCtx;

	let accountId = '';
	let customerId = '';
	let productId = '';
	let slipId = '';
	const slipNumber = `SHP-TST-${Date.now()}`;

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		const db = getDb(proxy.env.DB);

		const [account] = await db
			.insert(schema.accounts)
			.values({
				email: `shipping-print-${Date.now()}@example.com`,
				password_hash: 'not-a-real-hash',
				name: 'Print Test User',
				role: 'general'
			})
			.returning();
		accountId = account.id;

		const [customer] = await db
			.insert(schema.customers)
			.values({ name: 'Print Test Customer' })
			.returning();
		customerId = customer.id;

		const [product] = await db
			.insert(schema.products)
			.values({ code: `TST-PRINT-${Date.now()}`, name: 'Print Test Product', unit: 'kg' })
			.returning();
		productId = product.id;

		const [slip] = await db
			.insert(schema.shippingSlips)
			.values({
				slip_number: slipNumber,
				shipped_at: '2026-01-15',
				customer_id: customerId,
				account_id: accountId,
				note: ' printed note '
			})
			.returning();
		slipId = slip.id;

		// Se insertan desordenados a propósito para verificar el orderBy por line_no
		await db.insert(schema.shippingSlipDetails).values([
			{ slip_id: slipId, product_id: productId, line_no: 2, quantity: 4 },
			{ slip_id: slipId, product_id: productId, line_no: 1, quantity: 2 }
		]);

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
		await ctx.db
			.delete(schema.shippingSlipDetails)
			.where(eq(schema.shippingSlipDetails.slip_id, slipId));
		await ctx.db.delete(schema.shippingSlips).where(eq(schema.shippingSlips.id, slipId));
		await ctx.db.delete(schema.inventory).where(eq(schema.inventory.product_id, productId));
		await ctx.db.delete(schema.products).where(eq(schema.products.id, productId));
		await ctx.db.delete(schema.customers).where(eq(schema.customers.id, customerId));
		await ctx.db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
		await proxy.dispose();
	});

	it('devuelve el mismo shape que la ruta retornaba', async () => {
		const result = await getShippingSlipPrintData(ctx, slipId);

		expect(Object.keys(result)).toEqual(['slip', 'details']);
		expect(Object.keys(result.slip)).toEqual([
			'id',
			'slip_number',
			'shipped_at',
			'customer_name',
			'user_name',
			'note'
		]);
	});

	it('trae los datos del remito con los joins de cliente y usuario', async () => {
		const { slip } = await getShippingSlipPrintData(ctx, slipId);

		expect(slip.slip_number).toBe(slipNumber);
		expect(slip.shipped_at).toBe('2026-01-15');
		expect(slip.customer_name).toBe('Print Test Customer');
		expect(slip.user_name).toBe('Print Test User');
		expect(slip.note).toBe(' printed note ');
	});

	it('devuelve los detalles ordenados por line_no', async () => {
		const { details } = await getShippingSlipPrintData(ctx, slipId);

		expect(details.map((d) => d.line_no)).toEqual([1, 2]);
		expect(details[0]).toMatchObject({
			product_code: expect.any(String),
			product_name: 'Print Test Product',
			quantity: 2,
			unit: 'kg'
		});
	});

	it('lanza error(404) si el remito no existe', async () => {
		await expect(getShippingSlipPrintData(ctx, 'no-existe')).rejects.toMatchObject({
			status: 404
		});
	});
});
