import { makeCtx } from '$lib/services';
import { getShippingSlipPrintData } from '$lib/services/shipping';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, locals }) =>
	getShippingSlipPrintData(makeCtx(platform!, locals), params.id);
