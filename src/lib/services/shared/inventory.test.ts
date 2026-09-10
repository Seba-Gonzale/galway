/**
 * Tests de los helpers de ajuste de inventario.
 *
 * Cubren la distinción deliberada entre las dos estrategias que existían
 * duplicadas en receiving/shipping/purchasing antes de TASK-020:
 *
 *  - upsertInventoryDelta: INSERT ... ON CONFLICT DO UPDATE (crea la fila si falta)
 *  - adjustInventory: UPDATE simple (no hace nada si la fila no existe)
 *
 * Usan D1 local real vía getPlatformProxy, igual que el resto de tests de servicios.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { adjustInventory, upsertInventoryDelta } from './inventory';

describe('Inventory helpers', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let db: ReturnType<typeof getDb>;
	const createdProductIds: string[] = [];

	async function makeProduct(initialStock: number | null): Promise<string> {
		const [product] = await db
			.insert(schema.products)
			.values({
				code: `TST-INV-${Date.now()}-${createdProductIds.length}`,
				name: 'Inventory Helper Test',
				unit: 'kg',
				min_quantity: 0
			})
			.returning();
		createdProductIds.push(product.id);

		if (initialStock !== null) {
			await db
				.insert(schema.inventory)
				.values({ product_id: product.id, quantity: initialStock, updated_at: now() });
		}
		return product.id;
	}

	function now(): string {
		return new Date().toISOString();
	}

	async function stockOf(productId: string): Promise<number | undefined> {
		const [row] = await db
			.select({ quantity: schema.inventory.quantity })
			.from(schema.inventory)
			.where(eq(schema.inventory.product_id, productId));
		return row?.quantity;
	}

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		db = getDb(proxy.env.DB);
	});

	afterAll(async () => {
		for (const id of createdProductIds) {
			await db.delete(schema.inventory).where(eq(schema.inventory.product_id, id));
			await db.delete(schema.products).where(eq(schema.products.id, id));
		}
		await proxy.dispose();
	});

	it('upsertInventoryDelta "+" crea la fila cuando el producto no tenía inventario', async () => {
		const productId = await makeProduct(null);
		await upsertInventoryDelta(db, [{ product_id: productId, quantity: 7 }], '+', now());
		expect(await stockOf(productId)).toBe(7);
	});

	it('upsertInventoryDelta "+" suma sobre el stock existente', async () => {
		const productId = await makeProduct(10);
		await upsertInventoryDelta(db, [{ product_id: productId, quantity: 5 }], '+', now());
		expect(await stockOf(productId)).toBe(15);
	});

	it('upsertInventoryDelta "-" parte de una cantidad negativa al crear la fila', async () => {
		const productId = await makeProduct(null);
		await upsertInventoryDelta(db, [{ product_id: productId, quantity: 3 }], '-', now());
		expect(await stockOf(productId)).toBe(-3);
	});

	it('upsertInventoryDelta "-" resta sobre el stock existente', async () => {
		const productId = await makeProduct(10);
		await upsertInventoryDelta(db, [{ product_id: productId, quantity: 4 }], '-', now());
		expect(await stockOf(productId)).toBe(6);
	});

	it('adjustInventory "-" resta sobre el stock existente', async () => {
		const productId = await makeProduct(10);
		await adjustInventory(db, [{ product_id: productId, quantity: 4 }], '-', now());
		expect(await stockOf(productId)).toBe(6);
	});

	it('adjustInventory "+" suma sobre el stock existente', async () => {
		const productId = await makeProduct(10);
		await adjustInventory(db, [{ product_id: productId, quantity: 4 }], '+', now());
		expect(await stockOf(productId)).toBe(14);
	});

	it('adjustInventory no crea la fila si el producto no tenía inventario', async () => {
		const productId = await makeProduct(null);
		await adjustInventory(db, [{ product_id: productId, quantity: 4 }], '-', now());
		expect(await stockOf(productId)).toBeUndefined();
	});

	it('ambos helpers aplican el delta a cada producto de la lista', async () => {
		const a = await makeProduct(100);
		const b = await makeProduct(50);
		await adjustInventory(
			db,
			[
				{ product_id: a, quantity: 10 },
				{ product_id: b, quantity: 20 }
			],
			'-',
			now()
		);
		expect(await stockOf(a)).toBe(90);
		expect(await stockOf(b)).toBe(30);
	});
});
