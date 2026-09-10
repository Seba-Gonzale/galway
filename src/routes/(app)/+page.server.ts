import { makeCtx } from '$lib/services';
import { loadDashboard } from '$lib/services/dashboard';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) =>
	loadDashboard(makeCtx(platform!, locals));
