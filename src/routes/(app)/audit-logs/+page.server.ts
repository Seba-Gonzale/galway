import { makeCtx, requireAdmin } from '$lib/services';
import { listAuditLogs } from '$lib/services/audit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	const ctx = makeCtx(platform!, locals);
	requireAdmin(ctx);

	return listAuditLogs(ctx, {
		action: url.searchParams.get('action') || '',
		target: url.searchParams.get('target') || '',
		user: url.searchParams.get('user') || '',
		page: parseInt(url.searchParams.get('page') || '1')
	});
};
