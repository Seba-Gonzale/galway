/**
 * Tests del batching (TASK-027).
 *
 * Guardan la propiedad que se buscaba: una operación con N líneas hace una
 * cantidad constante de round trips (1 batch por lote), no una query por línea.
 *
 * Medición real contra D1 local (instrumentando el binding, 5 líneas):
 *  - adjustInventory: 5 round trips -> 1
 *  - alta de remito (slip + detalles + inventario): 11 -> 3
 */
import { describe, it, expect } from 'vitest';
import type { BatchItem } from 'drizzle-orm/batch';
import { runBatches, BATCH_CHUNK_SIZE } from './batch';
import { adjustInventory } from './inventory';
import type { DB } from '$lib/services';

function countingDb() {
	const batches: BatchItem<'sqlite'>[][] = [];
	const db = {
		batch: async (statements: BatchItem<'sqlite'>[]) => {
			batches.push(statements);
			return statements.map(() => ({}));
		},
		// builder mínimo para que adjustInventory pueda armar sus statements
		update: () => ({
			set: () => ({ where: () => ({}) as BatchItem<'sqlite'> })
		})
	} as unknown as DB;
	return { db, batches };
}

describe('runBatches', () => {
	it('no ejecuta nada si no hay statements', async () => {
		const { db, batches } = countingDb();

		await runBatches(db, []);

		expect(batches).toHaveLength(0);
	});

	it('manda hasta BATCH_CHUNK_SIZE statements por batch', async () => {
		const { db, batches } = countingDb();
		const statements = Array.from({ length: BATCH_CHUNK_SIZE }, () => ({}) as BatchItem<'sqlite'>);

		await runBatches(db, statements);

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(BATCH_CHUNK_SIZE);
	});

	it('corta en varios lotes cuando se pasa del chunk', async () => {
		const { db, batches } = countingDb();
		const total = BATCH_CHUNK_SIZE * 2 + 7;
		const statements = Array.from({ length: total }, () => ({}) as BatchItem<'sqlite'>);

		await runBatches(db, statements);

		expect(batches.map((b) => b.length)).toEqual([BATCH_CHUNK_SIZE, BATCH_CHUNK_SIZE, 7]);
	});
});

describe('adjustInventory batcheado', () => {
	it('N líneas se resuelven en un solo round trip', async () => {
		const { db, batches } = countingDb();
		const items = Array.from({ length: 12 }, (_, i) => ({
			product_id: `p${i}`,
			quantity: 1
		}));

		await adjustInventory(db, items, '-', new Date().toISOString());

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(12);
	});

	it('sin líneas no ejecuta ninguna query', async () => {
		const { db, batches } = countingDb();

		await adjustInventory(db, [], '-', new Date().toISOString());

		expect(batches).toHaveLength(0);
	});
});
