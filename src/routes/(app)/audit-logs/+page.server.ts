import { error } from '@sveltejs/kit';
import { makeCtx } from '$lib/services';
import { listAuditLogs } from '$lib/services/audit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	if (locals.user?.role !== 'admin') throw error(403, 'Access denied');

	return listAuditLogs(makeCtx(platform!, locals), {
		action: url.searchParams.get('action') || '',
		target: url.searchParams.get('target') || '',
		user: url.searchParams.get('user') || '',
		page: parseInt(url.searchParams.get('page') || '1')
	});
};
