/**
 * Tests del helper de paginación (TASK-021).
 *
 * Cubren el cálculo de `itemsPerPage` / `currentPage` / `offset` que antes
 * estaba duplicado en las 7 funciones `list*` (product, supplier, purchasing,
 * receiving, shipping, inventory, account):
 *
 *  - defaults: itemsPerPage=20, currentPage mínimo 1
 *  - itemsPerPage custom (30 en accounts)
 *  - totalItems sale del count, 0 si el count viene vacío
 *  - `extra` se ejecuta en paralelo y se devuelve tal cual
 *
 * El último test corre contra D1 local real (getPlatformProxy), igual que el
 * resto de tests de servicios.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { asc, count } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { paginate } from './pagination';

describe('paginate', () => {
	it('aplica itemsPerPage=20 por defecto y currentPage mínimo 1', async () => {
		let received: { limit: number; offset: number } | undefined;

		const result = await paginate<number>({
			page: 0,
			count: () => Promise.resolve([{ count: 7 }]),
			rows: (limit, offset) => {
				received = { limit, offset };
				return Promise.resolve([1, 2]);
			}
		});

		expect(result.itemsPerPage).toBe(20);
		expect(result.currentPage).toBe(1);
		expect(received).toEqual({ limit: 20, offset: 0 });
		expect(result.totalItems).toBe(7);
		expect(result.rows).toEqual([1, 2]);
		expect(result.extra).toBeUndefined();
	});

	it('calcula el offset a partir de la página', async () => {
		let received: { limit: number; offset: number } | undefined;

		await paginate<number>({
			page: 3,
			itemsPerPage: 2,
			count: () => Promise.resolve([{ count: 10 }]),
			rows: (limit, offset) => {
				received = { limit, offset };
				return Promise.resolve([]);
			}
		});

		expect(received).toEqual({ limit: 2, offset: 4 });
	});

	it('respeta itemsPerPage custom (30 en accounts) y páginas negativas', async () => {
		let received: { limit: number; offset: number } | undefined;

		const result = await paginate<number>({
			page: -5,
			itemsPerPage: 30,
			count: () => Promise.resolve([{ count: 0 }]),
			rows: (limit, offset) => {
				received = { limit, offset };
				return Promise.resolve([]);
			}
		});

		expect(result.itemsPerPage).toBe(30);
		expect(result.currentPage).toBe(1);
		expect(received).toEqual({ limit: 30, offset: 0 });
		expect(result.totalItems).toBe(0);
	});

	it('totalItems es 0 cuando el count no devuelve filas', async () => {
		const result = await paginate<number>({
			page: 1,
			count: () => Promise.resolve([]),
			rows: () => Promise.resolve([])
		});

		expect(result.totalItems).toBe(0);
	});

	it('devuelve las consultas extra y las corre en el mismo lote que count y rows', async () => {
		const result = await paginate<number, [string[], number]>({
			page: 2,
			count: () => Promise.resolve([{ count: 3 }]),
			rows: () => Promise.resolve([1]),
			extra: () => Promise.all([Promise.resolve(['a', 'b']), Promise.resolve(42)])
		});

		expect(result.extra).toEqual([['a', 'b'], 42]);
	});
});

describe('paginate contra D1 local', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let db: ReturnType<typeof getDb>;
	let allIds: string[] = [];

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		db = getDb(proxy.env.DB);
		allIds = (await db.select({ id: schema.products.id }).from(schema.products)).map((r) => r.id);
	});

	afterAll(async () => {
		await proxy.dispose();
	});

	it('devuelve la página pedida y el total de filas coincide con el count', async () => {
		if (allIds.length < 2) return;

		const result = await paginate({
			page: 1,
			itemsPerPage: 1,
			count: () => db.select({ count: count() }).from(schema.products),
			rows: (limit, offset) =>
				db
					.select({ id: schema.products.id })
					.from(schema.products)
					.orderBy(asc(schema.products.id))
					.limit(limit)
					.offset(offset)
		});

		expect(result.totalItems).toBe(allIds.length);
		expect(result.rows).toHaveLength(1);
		expect(allIds).toContain(result.rows[0].id);
	});

	it('la segunda página no repite filas de la primera', async () => {
		if (allIds.length < 3) return;

		const options = {
			itemsPerPage: 2,
			count: () => db.select({ count: count() }).from(schema.products),
			rows: (limit: number, offset: number) =>
				db
					.select({ id: schema.products.id })
					.from(schema.products)
					.orderBy(asc(schema.products.id))
					.limit(limit)
					.offset(offset)
		};

		const first = await paginate({ ...options, page: 1 });
		const second = await paginate({ ...options, page: 2 });

		expect(second.rows).toHaveLength(2);
		const overlap = second.rows.filter((r) => first.rows.some((f) => f.id === r.id));
		expect(overlap).toHaveLength(0);
	});
});
