import { fail } from '@sveltejs/kit';
import * as schema from '$lib/server/db/schema';
import { logAudit } from '$lib/server/audit';
import { settingsSchema } from '$lib/validation';
import { requireAdmin } from '$lib/services';
import type { ServiceCtx, ServiceSettings } from '$lib/services';

type SettingKey =
	'notification_email' | 'low_stock_alert_enabled' | 'alert_email_enabled' | 'email_locale';

async function readSettings(ctx: ServiceCtx): Promise<ServiceSettings> {
	const rows = await ctx.db.select().from(schema.settings);
	const map = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, string>;
	return {
		notification_email: map['notification_email'] ?? '',
		low_stock_alert_enabled: map['low_stock_alert_enabled'] !== 'false',
		alert_email_enabled:
			map['alert_email_enabled'] === undefined ? undefined : map['alert_email_enabled'] === 'true',
		email_locale: (map['email_locale'] === 'ja' ? 'ja' : 'en') as 'en' | 'ja'
	};
}

/** Reads settings once and reuses the result for the lifetime of this request. */
export function getSettings(ctx: ServiceCtx): Promise<ServiceSettings> {
	ctx.settings ??= readSettings(ctx);
	return ctx.settings;
}

export async function loadSettings(ctx: ServiceCtx) {
	requireAdmin(ctx);
	const settings = await getSettings(ctx);
	return {
		settings: {
			...settings,
			alert_email_enabled: settings.alert_email_enabled === true
		}
	};
}

export async function saveSettings(
	ctx: ServiceCtx,
	data: {
		notification_email: string;
		low_stock_alert_enabled: boolean;
		alert_email_enabled: boolean;
		email_locale: string;
	}
) {
	requireAdmin(ctx);
	const parsed = settingsSchema.safeParse(data);
	if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message });
	const { notification_email, low_stock_alert_enabled, alert_email_enabled, email_locale } =
		parsed.data;

	const updates: { key: SettingKey; value: string }[] = [
		{ key: 'notification_email', value: notification_email },
		{ key: 'low_stock_alert_enabled', value: low_stock_alert_enabled ? 'true' : 'false' },
		{ key: 'alert_email_enabled', value: alert_email_enabled ? 'true' : 'false' },
		{ key: 'email_locale', value: email_locale }
	];
	const now = new Date().toISOString();

	try {
		for (const { key, value } of updates) {
			await ctx.db
				.insert(schema.settings)
				.values({ key, value, updated_at: now })
				.onConflictDoUpdate({ target: schema.settings.key, set: { value, updated_at: now } });
		}
		ctx.settings = undefined;
		await logAudit({
			db: ctx.db,
			user_id: ctx.user.id,
			user_name: ctx.user.name,
			action: 'settings_save',
			target_type: 'settings'
		});
		return { success: true };
	} catch (err) {
		console.error('Failed to save settings:', err);
		return fail(500, { error: 'Failed to save settings' });
	}
}
