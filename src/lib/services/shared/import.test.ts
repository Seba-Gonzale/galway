/**
 * Tests del framework de importación CSV (TASK-023).
 *
 * Cubren las partes que estaban duplicadas en los 5 imports
 * (product, supplier, inventory, receiving, shipping):
 *
 *  - parseImportCsv: modo append/replace, "CSV has no data", columnas requeridas
 *    (con mensaje por defecto y custom) y opcionales, nombres alternativos
 *  - requireRecords: "No valid data found"
 *  - mapProductQuantities: descarta códigos inexistentes y cantidades inválidas
 *  - productCodeMap: resuelve "Product Code" -> id contra D1 local
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { parseImportCsv, requireRecords, mapProductQuantities, productCodeMap } from './import';

const PRODUCT_COLUMNS = [
	{ key: 'code', names: ['Product Code'], required: true },
	{ key: 'quantity', names: ['Quantity'], required: true }
];

describe('parseImportCsv', () => {
	it('rechaza un modo que no sea append ni replace', () => {
		const result = parseImportCsv('Product Code,Quantity\nP1,1\n', PRODUCT_COLUMNS, 'merge');

		expect('dataRows' in result).toBe(false);
		if ('dataRows' in result) return;
		expect(result.status).toBe(400);
		expect(result.data).toEqual({ error: 'Invalid import mode' });
	});

	it('acepta append y replace', () => {
		for (const mode of ['append', 'replace']) {
			const result = parseImportCsv('Product Code,Quantity\nP1,1\n', PRODUCT_COLUMNS, mode);
			expect('dataRows' in result).toBe(true);
		}
	});

	it('devuelve fail(400) si el CSV no tiene filas de datos', () => {
		for (const csv of ['', 'Product Code,Quantity']) {
			const result = parseImportCsv(csv, PRODUCT_COLUMNS);

			expect('dataRows' in result).toBe(false);
			if ('dataRows' in result) return;
			expect(result.status).toBe(400);
			expect(result.data).toEqual({
				error: 'CSV has no data (requires a header row plus at least one data row)'
			});
		}
	});

	it('devuelve fail(400) con el mensaje por defecto si falta una columna requerida', () => {
		const result = parseImportCsv('Product Code\nP1\n', PRODUCT_COLUMNS);

		expect('dataRows' in result).toBe(false);
		if ('dataRows' in result) return;
		expect(result.data).toEqual({ error: 'CSV must include a "Quantity" column' });
	});

	it('devuelve fail(400) con el mensaje custom (importInventory acepta Quantity o Stock)', () => {
		const columns = [
			{ key: 'code', names: ['Product Code'], required: true },
			{
				key: 'quantity',
				names: ['Quantity', 'Stock'],
				required: true,
				missingMessage: 'CSV must include a "Quantity" or "Stock" column'
			}
		];
		const result = parseImportCsv('Product Code\nP1\n', columns);

		expect('dataRows' in result).toBe(false);
		if ('dataRows' in result) return;
		expect(result.data).toEqual({ error: 'CSV must include a "Quantity" or "Stock" column' });
	});

	it('resuelve índices, tolera headers con espacios y marca las opcionales como -1', () => {
		const result = parseImportCsv('Quantity, Product Code ,Note\n2,P1,hola\n', [
			{ key: 'code', names: ['Product Code'], required: true },
			{ key: 'quantity', names: ['Quantity'], required: true },
			{ key: 'note', names: ['Note'] },
			{ key: 'missing', names: ['Nope'] }
		]);

		expect('dataRows' in result).toBe(true);
		if (!('dataRows' in result)) return;
		expect(result.index).toEqual({ code: 1, quantity: 0, note: 2, missing: -1 });
		expect(result.dataRows).toHaveLength(1);
	});

	it('acepta nombres alternativos (Stock en lugar de Quantity)', () => {
		const result = parseImportCsv('Product Code,Stock\nP1,4\n', [
			{ key: 'code', names: ['Product Code'], required: true },
			{ key: 'quantity', names: ['Quantity', 'Stock'], required: true }
		]);

		expect('dataRows' in result).toBe(true);
		if (!('dataRows' in result)) return;
		expect(result.index.quantity).toBe(1);
	});

	it('reporta la primera columna requerida que falta, en el orden declarado', () => {
		const result = parseImportCsv('Note\nhola\n', [
			{ key: 'code', names: ['Product Code'], required: true },
			{ key: 'quantity', names: ['Quantity'], required: true }
		]);

		expect('dataRows' in result).toBe(false);
		if ('dataRows' in result) return;
		expect(result.data).toEqual({ error: 'CSV must include a "Product Code" column' });
	});
});

describe('requireRecords', () => {
	it('devuelve fail(400) "No valid data found" si el lote quedó vacío', () => {
		const result = requireRecords([]);

		expect(Array.isArray(result)).toBe(false);
		if (Array.isArray(result)) return;
		expect(result.status).toBe(400);
		expect(result.data).toEqual({ error: 'No valid data found' });
	});

	it('devuelve el mismo array si hay registros', () => {
		const records = [{ product_id: 'p1', quantity: 1 }];
		expect(requireRecords(records)).toBe(records);
	});
});

describe('mapProductQuantities', () => {
	const productMap = new Map([
		['P1', 'id-1'],
		['P2', 'id-2']
	]);

	it('resuelve el código del CSV al id del producto', () => {
		const result = mapProductQuantities(
			[
				['P1', '3'],
				['P2', '1.5']
			],
			{ code: 0, quantity: 1 },
			productMap
		);

		expect(result).toEqual([
			{ product_id: 'id-1', quantity: 3 },
			{ product_id: 'id-2', quantity: 1.5 }
		]);
	});

	it('descarta código vacío, cantidad no numérica, <= 0 y productos inexistentes', () => {
		const result = mapProductQuantities(
			[
				['', '1'],
				['P1', 'abc'],
				['P1', '0'],
				['P1', '-2'],
				['NOPE', '5']
			],
			{ code: 0, quantity: 1 },
			productMap
		);

		expect(result).toEqual([]);
	});

	it('con allowZero acepta cantidad 0 (importInventory) pero no negativas', () => {
		const result = mapProductQuantities(
			[
				['P1', '0'],
				['P1', '-1'],
				['P2', '2']
			],
			{ code: 0, quantity: 1 },
			productMap,
			{ allowZero: true }
		);

		expect(result).toEqual([
			{ product_id: 'id-1', quantity: 0 },
			{ product_id: 'id-2', quantity: 2 }
		]);
	});

	it('ignora columnas inexistentes (índice -1)', () => {
		expect(mapProductQuantities([['P1']], { code: 0, quantity: -1 }, productMap)).toEqual([]);
	});
});

describe('productCodeMap contra D1 local', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let db: ReturnType<typeof getDb>;
	let productId = '';
	const code = `TST-IMP-${Date.now()}`;

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		db = getDb(proxy.env.DB);
		const [product] = await db
			.insert(schema.products)
			.values({ code, name: 'Import Helper Test', unit: 'kg', min_quantity: 0 })
			.returning();
		productId = product.id;
	});

	afterAll(async () => {
		await db.delete(schema.inventory).where(eq(schema.inventory.product_id, productId));
		await db.delete(schema.products).where(eq(schema.products.id, productId));
		await proxy.dispose();
	});

	it('mapea el código del producto a su id', async () => {
		const map = await productCodeMap(db);
		expect(map.get(code)).toBe(productId);
	});

	it('no contiene códigos inexistentes', async () => {
		const map = await productCodeMap(db);
		expect(map.has('NO-EXISTE')).toBe(false);
	});
});
