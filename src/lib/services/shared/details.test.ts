/**
 * Tests de los helpers de líneas de detalle (TASK-022).
 *
 * Cubren el código que estaba duplicado en purchasing/receiving/shipping:
 *
 *  - validateLineItems: filtra líneas inválidas y devuelve fail(400) si no queda ninguna
 *  - insertDetails: inserta respetando line_no correlativo (i + 1) y la FK del padre
 *  - tryCleanup: rollback best-effort de la fila padre, sin lanzar
 *
 * Tras TASK-027, `insertDetails` envía los inserts con `db.batch()`: los tests
 * unitarios usan un `db` stub que sólo registra los lotes, y el último describe
 * verifica el camino real contra D1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq, asc } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { validateLineItems, insertDetails, tryCleanup } from './details';
import type { DB } from '$lib/services';
import type { DetailRow } from './details';

/** DB stub: ejecuta "el batch" devolviendo los statements tal cual. */
function stubDb(batches: BatchItem<'sqlite'>[][]): DB {
	return {
		batch: async (statements: BatchItem<'sqlite'>[]) => {
			batches.push(statements);
			return statements.map(() => ({}));
		}
	} as unknown as DB;
}

describe('validateLineItems', () => {
	it('descarta líneas sin product_id o con cantidad <= 0', () => {
		const result = validateLineItems([
			{ product_id: 'p1', quantity: 2 },
			{ product_id: '', quantity: 5 },
			{ product_id: 'p2', quantity: 0 },
			{ product_id: 'p3', quantity: -1 }
		]);

		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([{ product_id: 'p1', quantity: 2 }]);
	});

	it('devuelve fail(400) con el mensaje por defecto cuando no hay líneas válidas', () => {
		const result = validateLineItems([{ product_id: '', quantity: 0 }]);

		expect(Array.isArray(result)).toBe(false);
		if (Array.isArray(result)) return;
		expect(result.status).toBe(400);
		expect(result.data).toEqual({ error: 'At least one valid line item is required' });
	});

	it('devuelve fail(400) con el mensaje del call site (convertToReceivingSlip)', () => {
		const result = validateLineItems([], 'At least one line item with quantity > 0 is required');

		expect(Array.isArray(result)).toBe(false);
		if (Array.isArray(result)) return;
		expect(result.status).toBe(400);
		expect(result.data).toEqual({
			error: 'At least one line item with quantity > 0 is required'
		});
	});

	it('devuelve fail(400) cuando la lista está vacía', () => {
		expect(Array.isArray(validateLineItems([]))).toBe(false);
	});
});

describe('insertDetails', () => {
	it('asigna line_no correlativo empezando en 1 y conserva product_id/quantity', async () => {
		const inserted: DetailRow[] = [];
		const batches: BatchItem<'sqlite'>[][] = [];

		await insertDetails(
			stubDb(batches),
			[
				{ product_id: 'p1', quantity: 3 },
				{ product_id: 'p2', quantity: 1.5 }
			],
			(row) => {
				inserted.push(row);
				return {} as BatchItem<'sqlite'>;
			}
		);

		expect(inserted).toEqual([
			{ product_id: 'p1', line_no: 1, quantity: 3 },
			{ product_id: 'p2', line_no: 2, quantity: 1.5 }
		]);
	});

	it('envía todas las líneas en un solo batch (sin una query por línea)', async () => {
		const batches: BatchItem<'sqlite'>[][] = [];

		await insertDetails(
			stubDb(batches),
			[
				{ product_id: 'p1', quantity: 1 },
				{ product_id: 'p2', quantity: 2 },
				{ product_id: 'p3', quantity: 3 }
			],
			() => ({}) as BatchItem<'sqlite'>
		);

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(3);
	});

	it('no inserta nada si no hay líneas', async () => {
		const batches: BatchItem<'sqlite'>[][] = [];

		await insertDetails(stubDb(batches), [], () => ({}) as BatchItem<'sqlite'>);

		expect(batches).toHaveLength(0);
	});

	it('propaga el error del batch para que el call site haga rollback', async () => {
		const failingDb = {
			batch: async () => {
				throw new Error('boom');
			}
		} as unknown as DB;

		await expect(
			insertDetails(
				failingDb,
				[{ product_id: 'p1', quantity: 1 }],
				() => ({}) as BatchItem<'sqlite'>
			)
		).rejects.toThrow('boom');
	});
});

describe('tryCleanup', () => {
	it('no llama a remove si el id está vacío (la fila padre no se creó)', async () => {
		let calls = 0;
		await tryCleanup('', () => {
			calls += 1;
			return Promise.resolve();
		});

		expect(calls).toBe(0);
	});

	it('no hace nada si el id es null', async () => {
		let calls = 0;
		await tryCleanup(null, () => {
			calls += 1;
			return Promise.resolve();
		});

		expect(calls).toBe(0);
	});

	it('borra la fila padre pasándole el id', async () => {
		let received: string | undefined;
		await tryCleanup('slip-1', (id) => {
			received = id;
			return Promise.resolve();
		});

		expect(received).toBe('slip-1');
	});

	it('no lanza si el borrado falla (no enmascara el error original)', async () => {
		await expect(
			tryCleanup('slip-1', () => Promise.reject(new Error('delete failed')))
		).resolves.toBeUndefined();
	});
});

describe('insertDetails contra D1 local', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let db: ReturnType<typeof getDb>;
	let accountId = '';
	let supplierId = '';
	let productId = '';
	let slipId = '';

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		db = getDb(proxy.env.DB);

		const [account] = await db
			.insert(schema.accounts)
			.values({
				email: `details-batch-${Date.now()}@example.com`,
				password_hash: 'not-a-real-hash',
				name: 'Details Batch Test',
				role: 'general'
			})
			.returning();
		accountId = account.id;

		const [supplier] = await db
			.insert(schema.suppliers)
			.values({ name: 'Details Batch Supplier' })
			.returning();
		supplierId = supplier.id;

		const [product] = await db
			.insert(schema.products)
			.values({ code: `TST-DET-${Date.now()}`, name: 'Details Batch Product', unit: 'kg' })
			.returning();
		productId = product.id;

		const [slip] = await db
			.insert(schema.receivingSlips)
			.values({
				slip_number: `RCV-TST-${Date.now()}`,
				received_at: '2026-01-20',
				supplier_id: supplierId,
				account_id: accountId,
				note: ''
			})
			.returning();
		slipId = slip.id;
	});

	afterAll(async () => {
		await db
			.delete(schema.receivingSlipDetails)
			.where(eq(schema.receivingSlipDetails.slip_id, slipId));
		await db.delete(schema.receivingSlips).where(eq(schema.receivingSlips.id, slipId));
		await db.delete(schema.inventory).where(eq(schema.inventory.product_id, productId));
		await db.delete(schema.products).where(eq(schema.products.id, productId));
		await db.delete(schema.suppliers).where(eq(schema.suppliers.id, supplierId));
		await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
		await proxy.dispose();
	});

	it('inserta las líneas en la base con line_no correlativo', async () => {
		await insertDetails(
			db,
			[
				{ product_id: productId, quantity: 5 },
				{ product_id: productId, quantity: 2 }
			],
			(row) => db.insert(schema.receivingSlipDetails).values({ slip_id: slipId, ...row })
		);

		const rows = await db
			.select({
				line_no: schema.receivingSlipDetails.line_no,
				quantity: schema.receivingSlipDetails.quantity,
				product_id: schema.receivingSlipDetails.product_id
			})
			.from(schema.receivingSlipDetails)
			.where(eq(schema.receivingSlipDetails.slip_id, slipId))
			.orderBy(asc(schema.receivingSlipDetails.line_no));

		expect(rows).toEqual([
			{ line_no: 1, quantity: 5, product_id: productId },
			{ line_no: 2, quantity: 2, product_id: productId }
		]);
	});
});
