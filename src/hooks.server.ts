import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, verifySessionToken } from '$lib/server/auth';
import { building } from '$app/environment';
import { config, describeLlmSetup } from '$lib/server/config';
import { resolveMember } from '$lib/server/access';
import { startReminderWorker } from '$lib/server/reminders';

const runtime = globalThis as typeof globalThis & {
	__spendbotReminderWorkerStarted?: boolean;
	__spendbotLoggedLlmSetup?: boolean;
};

// Printed once per process so the deploy log answers "did the keys arrive?"
// without anyone having to reproduce a failure in chat to find out.
if (!building && process.env.NODE_ENV !== 'test' && !runtime.__spendbotLoggedLlmSetup) {
	runtime.__spendbotLoggedLlmSetup = true;
	console.info(describeLlmSetup());
}
if (!building && process.env.NODE_ENV !== 'test' && config.reminders.mode === 'timer' && config.databaseUrl && config.line.accessToken && config.line.allowedUserIds.length > 0 && !runtime.__spendbotReminderWorkerStarted) {
	runtime.__spendbotReminderWorkerStarted = true;
	startReminderWorker();
}

/** The webhook authenticates with LINE's signature, not with the dashboard session. */
const PUBLIC_PREFIXES = ['/login', '/api/line', '/api/auth/line'];

export const handle: Handle = async ({ event, resolve }) => {
	const lineUserId = verifySessionToken(event.cookies.get(SESSION_COOKIE));
	// The cookie only proves which LINE account signed in. The ledger row it maps
	// to is what every page filters on, so resolve it here once and never let a
	// route derive an owner from user-supplied input.
	const user = lineUserId ? await resolveMember(lineUserId) : null;
	event.locals.lineUserId = user ? user.lineUserId : null;
	event.locals.userId = user?.id ?? null;
	event.locals.authed = Boolean(user);

	const isPublic = PUBLIC_PREFIXES.some((prefix) => event.url.pathname.startsWith(prefix));
	if (!isPublic && !event.locals.authed) {
		const next = event.url.pathname + event.url.search;
		redirect(303, `/login?next=${encodeURIComponent(next)}`);
	}

	return resolve(event);
};
