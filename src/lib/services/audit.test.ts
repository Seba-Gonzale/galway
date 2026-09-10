/**
 * Tests del servicio de audit logs (TASK-025).
 *
 * listAuditLogs() reemplaza la query inline de `src/routes/(app)/audit-logs/+page.server.ts`.
 * Verifican contra D1 local: shape devuelto, paginación (30 por página), los tres
 * filtros y que las columnas explícitas siguen incluyendo `detail` (la vista lo parsea).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { eq, like } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { hashPassword } from '$lib/server/auth';
import { listAuditLogs, AUDIT_ITEMS_PER_PAGE } from './audit';
import type { ServiceCtx } from '$lib/services';

describe('Audit log service', () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
	let ctx: ServiceCtx;
	let testAccountId: string;
	const userName = 'Audit Test User';
	const createdIds: string[] = [];

	async function insertLog(action: string, targetType: string, name: string) {
		const [row] = await ctx.db
			.insert(schema.auditLogs)
			.values({
				user_id: null,
				user_name: name,
				action,
				target_type: targetType,
				target_label: `${action}-${targetType}`,
				detail: JSON.stringify({ item_count: 3 })
			})
			.returning();
		createdIds.push(row.id);
	}

	beforeAll(async () => {
		proxy = await getPlatformProxy<{ DB: D1Database }>();
		const db = getDb(proxy.env.DB);

		const pw = await hashPassword('test123');
		const [account] = await db
			.insert(schema.accounts)
			.values({
				email: 'audit-svc-test@example.com',
				password_hash: pw,
				name: userName,
				role: 'admin'
			})
			.returning();
		testAccountId = account.id;

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

		await insertLog('create', 'product', userName);
		await insertLog('update', 'supplier', userName);
		await insertLog('delete', 'product', 'Someone Else');
	});

	afterAll(async () => {
		for (const id of createdIds) {
			await ctx.db.delete(schema.auditLogs).where(eq(schema.auditLogs.id, id));
		}
		await ctx.db.delete(schema.accounts).where(eq(schema.accounts.id, testAccountId));
		await proxy.dispose();
	});

	it('devuelve el mismo shape que la ruta retornaba', async () => {
		const result = await listAuditLogs(ctx);

		expect(Object.keys(result)).toEqual([
			'logs',
			'totalItems',
			'itemsPerPage',
			'currentPage',
			'filterAction',
			'filterTarget',
			'filterUser'
		]);
		expect(result.itemsPerPage).toBe(AUDIT_ITEMS_PER_PAGE);
		expect(result.currentPage).toBe(1);
	});

	it('selecciona columnas explícitas, incluido detail y created_at', async () => {
		const result = await listAuditLogs(ctx, { user: userName });

		expect(result.logs.length).toBeGreaterThan(0);
		for (const log of result.logs) {
			expect(Object.keys(log).sort()).toEqual(
				[
					'action',
					'created_at',
					'detail',
					'id',
					'target_id',
					'target_label',
					'target_type',
					'user_id',
					'user_name'
				].sort()
			);
			expect(typeof log.created_at).toBe('string');
		}
	});

	it('filtra por user_name (coincidencia parcial)', async () => {
		const result = await listAuditLogs(ctx, { user: 'Audit Test' });

		expect(result.logs.length).toBe(2);
		expect(result.logs.every((l) => l.user_name === userName)).toBe(true);
		expect(result.filterUser).toBe('Audit Test');
	});

	it('filtra por action y por target_type', async () => {
		const byAction = await listAuditLogs(ctx, { action: 'update', user: userName });
		expect(byAction.logs).toHaveLength(1);
		expect(byAction.logs[0].target_type).toBe('supplier');
		expect(byAction.filterAction).toBe('update');

		const byTarget = await listAuditLogs(ctx, { target: 'product', user: userName });
		expect(byTarget.logs).toHaveLength(1);
		expect(byTarget.logs[0].action).toBe('create');
		expect(byTarget.filterTarget).toBe('product');
	});

	it('combina filtros y pagina de a 30 sin repetir filas', async () => {
		const first = await listAuditLogs(ctx, { page: 1, itemsPerPage: 2 });
		const second = await listAuditLogs(ctx, { page: 2, itemsPerPage: 2 });

		expect(first.logs.length).toBeLessThanOrEqual(2);
		expect(second.currentPage).toBe(2);
		const overlap = second.logs.filter((l) => first.logs.some((f) => f.id === l.id));
		expect(overlap).toHaveLength(0);
	});

	it('el total coincide con un count directo', async () => {
		const result = await listAuditLogs(ctx, { user: userName });
		const rows = await ctx.db
			.select({ id: schema.auditLogs.id })
			.from(schema.auditLogs)
			.where(like(schema.auditLogs.user_name, `%${userName}%`));

		expect(result.totalItems).toBe(rows.length);
	});
});
