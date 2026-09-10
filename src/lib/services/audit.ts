import { desc, count, eq, and, like } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { paginate } from '$lib/services/shared';
import type { ServiceCtx } from '$lib/services';

export type AuditLogFilters = {
	/** action exacto (create / update / delete / import / ...) */
	action?: string;
	/** target_type exacto (product / supplier / receiving_slip / ...) */
	target?: string;
	/** coincide parcial del user_name */
	user?: string;
	page?: number;
	itemsPerPage?: number;
};

export const AUDIT_ITEMS_PER_PAGE = 30;

/**
 * Lectura paginada de audit logs con filtros por action, target_type y user_name.
 *
 * Antes vivía inline en `src/routes/(app)/audit-logs/+page.server.ts`. La query
 * selecciona columnas explícitas (en vez de `select()`), sin perder ninguna de
 * las que la vista usa: id, user_id, user_name, action, target_type, target_id,
 * target_label, detail (JSON string) y created_at.
 */
export async function listAuditLogs(ctx: ServiceCtx, filters: AuditLogFilters = {}) {
	const conditions: SQL[] = [];
	if (filters.action) conditions.push(eq(schema.auditLogs.action, filters.action));
	if (filters.target) conditions.push(eq(schema.auditLogs.target_type, filters.target));
	if (filters.user) conditions.push(like(schema.auditLogs.user_name, `%${filters.user}%`));
	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	const {
		rows: logs,
		totalItems,
		itemsPerPage,
		currentPage
	} = await paginate({
		page: filters.page ?? 1,
		itemsPerPage: filters.itemsPerPage ?? AUDIT_ITEMS_PER_PAGE,
		count: () => ctx.db.select({ count: count() }).from(schema.auditLogs).where(whereClause),
		rows: (limit, offset) =>
			ctx.db
				.select({
					id: schema.auditLogs.id,
					user_id: schema.auditLogs.user_id,
					user_name: schema.auditLogs.user_name,
					action: schema.auditLogs.action,
					target_type: schema.auditLogs.target_type,
					target_id: schema.auditLogs.target_id,
					target_label: schema.auditLogs.target_label,
					detail: schema.auditLogs.detail,
					created_at: schema.auditLogs.created_at
				})
				.from(schema.auditLogs)
				.where(whereClause)
				.orderBy(desc(schema.auditLogs.created_at))
				.limit(limit)
				.offset(offset)
	});

	return {
		logs,
		totalItems,
		itemsPerPage,
		currentPage,
		filterAction: filters.action ?? '',
		filterTarget: filters.target ?? '',
		filterUser: filters.user ?? ''
	};
}
