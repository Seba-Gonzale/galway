import { describe, expect, it } from 'vitest';
import { getSettings } from './settings';
import type { ServiceCtx } from '$lib/services';

describe('getSettings', () => {
	it('consulta settings una sola vez y comparte la promesa por request', async () => {
		let selects = 0;
		const db = {
			select: () => {
				selects += 1;
				return {
					from: async () => [
						{ key: 'email_locale', value: 'ja' },
						{ key: 'notification_email', value: 'admin@example.com' },
						{ key: 'low_stock_alert_enabled', value: 'false' }
					]
				};
			}
		} as unknown as ServiceCtx['db'];
		const ctx = { db } as ServiceCtx;

		const [first, second] = await Promise.all([getSettings(ctx), getSettings(ctx)]);

		expect(selects).toBe(1);
		expect(first).toBe(second);
		expect(first).toMatchObject({
			notification_email: 'admin@example.com',
			low_stock_alert_enabled: false,
			email_locale: 'ja'
		});
		expect(first.alert_email_enabled).toBeUndefined();
	});
});
