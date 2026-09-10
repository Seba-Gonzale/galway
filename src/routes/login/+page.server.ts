import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import {
	SESSION_COOKIE_OPTIONS,
	createSession,
	checkRateLimit,
	recordFailedAttempt,
	resetRateLimit,
	authenticateAccount
} from '$lib/server/auth/index';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(302, '/');
	}
	return {};
};

export const actions = {
	default: async (event) => {
		const { request, cookies, platform } = event;
		const data = await request.formData();
		const email = data.get('email')?.toString();
		const password = data.get('password')?.toString();

		if (!email || !password) {
			return fail(400, { error: 'Email and password are required' });
		}

		const db = getDb(platform!.env.DB);
		const ip = event.getClientAddress();

		const lockedMessage = await checkRateLimit(db, ip);
		if (lockedMessage) return fail(429, { error: lockedMessage });

		const account = await authenticateAccount(db, email, password);

		if (!account) {
			await recordFailedAttempt(db, ip);
			return fail(401, { error: 'Invalid email address or password' });
		}

		await resetRateLimit(db, ip);
		const token = await createSession(db, account.id);
		cookies.set('session', token, SESSION_COOKIE_OPTIONS);

		throw redirect(302, '/');
	}
} satisfies Actions;
