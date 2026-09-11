/**
 * Tests de los datos mínimos para crear un remito de recepción (TASK-029).
 *
 * `getReceivingSlipForNew()` no debe reutilizar `listReceivingSlips()`: la
 * pantalla nueva solo necesita los catálogos de suppliers y products.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { getDb } from '$lib/server/db';
import { getReceivingSlipForNew } from './receiving';
import type { ServiceCtx } from '$lib/services';

describe('getReceivingSlipForNew', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let ctx: ServiceCtx;

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		ctx = {
			db: getDb(proxy.env.DB),
			env: proxy.env as Env,
			user: {
				id: 'test-user',
				name: 'Test User',
				email: 'test@example.com',
				role: 'general',
				created_at: new Date().toISOString()
			}
		};
	});

	afterAll(async () => {
		await proxy.dispose();
	});

	it('devuelve solo los catálogos usados por el formulario nuevo', async () => {
		const result = await getReceivingSlipForNew(ctx);

		expect(Object.keys(result)).toEqual(['suppliers', 'products']);
		expect(Array.isArray(result.suppliers)).toBe(true);
		expect(Array.isArray(result.products)).toBe(true);

		if (result.suppliers[0]) {
			expect(Object.keys(result.suppliers[0])).toEqual(['id', 'name']);
		}
		if (result.products[0]) {
			expect(Object.keys(result.products[0])).toEqual(['id', 'code', 'name', 'unit']);
		}
	});
});
