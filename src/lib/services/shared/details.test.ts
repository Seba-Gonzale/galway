/**
 * Tests de los helpers de líneas de detalle (TASK-022).
 *
 * Cubren el código que estaba duplicado en purchasing/receiving/shipping:
 *
 *  - validateLineItems: filtra líneas inválidas y devuelve fail(400) si no queda ninguna
 *  - insertDetails: inserta respetando line_no correlativo (i + 1) y la FK del padre
 *  - tryCleanup: rollback best-effort de la fila padre, sin lanzar
 */
import { describe, it, expect } from 'vitest';
import { validateLineItems, insertDetails, tryCleanup } from './details';
import type { DetailRow } from './details';

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

		await insertDetails(
			[
				{ product_id: 'p1', quantity: 3 },
				{ product_id: 'p2', quantity: 1.5 }
			],
			(row) => {
				inserted.push(row);
				return Promise.resolve();
			}
		);

		expect(inserted).toEqual([
			{ product_id: 'p1', line_no: 1, quantity: 3 },
			{ product_id: 'p2', line_no: 2, quantity: 1.5 }
		]);
	});

	it('deja la FK del padre al call site y lo invoca una vez por línea', async () => {
		const rows: { parent_id: string }[] = [];

		await insertDetails(
			[
				{ product_id: 'p1', quantity: 1 },
				{ product_id: 'p2', quantity: 2 },
				{ product_id: 'p3', quantity: 3 }
			],
			(row) => {
				rows.push({ parent_id: 'parent-1' });
				expect(row.product_id).toMatch(/^p[123]$/);
				return Promise.resolve();
			}
		);

		expect(rows).toEqual([
			{ parent_id: 'parent-1' },
			{ parent_id: 'parent-1' },
			{ parent_id: 'parent-1' }
		]);
	});

	it('no inserta nada si no hay líneas', async () => {
		let calls = 0;
		await insertDetails([], () => {
			calls += 1;
			return Promise.resolve();
		});

		expect(calls).toBe(0);
	});

	it('propaga el error del insert para que el call site haga rollback', async () => {
		await expect(
			insertDetails([{ product_id: 'p1', quantity: 1 }], () => Promise.reject(new Error('boom')))
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
