import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

export type DB = ReturnType<typeof getDb>;

export type ServiceSettings = {
	notification_email: string;
	low_stock_alert_enabled: boolean;
	alert_email_enabled: boolean | undefined;
	email_locale: 'en' | 'ja';
};

export type ServiceCtx = {
	db: DB;
	env: Env;
	user: NonNullable<App.Locals['user']>;
	request?: Request;
	settings?: Promise<ServiceSettings>;
};

export function makeCtx(platform: App.Platform, locals: App.Locals, request?: Request): ServiceCtx {
	return {
		db: getDb(platform.env.DB),
		env: platform.env,
		user: locals.user!,
		request
	};
}

/**
 * Para `load`: lanza `error(403)` si el usuario no es admin.
 *
 * Reemplaza los checks manuales `if (ctx.user.role !== 'admin') throw error(403, ...)`.
 */
export function requireAdmin(ctx: ServiceCtx): void {
	if (ctx.user?.role !== 'admin') throw error(403, 'Access denied');
}

/**
 * Para actions: devuelve `fail(403, { error: 'Access denied' })` si el usuario no
 * es admin, o `null` si puede continuar.
 *
 * Uso:
 *   const denied = requireAdminAction(ctx);
 *   if (denied) return denied;
 */
export function requireAdminAction(ctx: ServiceCtx) {
	if (ctx.user?.role !== 'admin') return fail(403, { error: 'Access denied' });
	return null;
}
