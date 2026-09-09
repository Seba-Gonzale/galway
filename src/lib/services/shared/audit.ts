import { logAudit } from '$lib/server/audit';
import type { AuditAction, AuditTargetType } from '$lib/server/audit';
import type { ServiceCtx } from '$lib/services';

export type AuditOptions = {
	target_id?: string | null;
	target_label?: string | null;
	detail?: Record<string, unknown> | null;
};

/**
 * Envuelve logAudit() infiriendo db/user_id/user_name desde el ServiceCtx.
 *
 * Reemplaza el patrón repetido:
 *   await logAudit({ db: ctx.db, user_id: ctx.user.id, user_name: ctx.user.name, action, target_type, ... });
 */
export function auditLog(
	ctx: ServiceCtx,
	action: AuditAction,
	target_type: AuditTargetType,
	options: AuditOptions = {}
): Promise<void> {
	return logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action,
		target_type,
		target_id: options.target_id ?? null,
		target_label: options.target_label ?? null,
		detail: options.detail ?? null
	});
}
