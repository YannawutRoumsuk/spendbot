import { EXPENSE_CATEGORIES, FALLBACK_CATEGORY } from '$lib/categories';
import { analyzeBudget } from '$lib/budget';
import { billDueDate } from '$lib/bills';
import { config, describeLlmSetup } from '$lib/server/config';
import { textTransactionFingerprint } from '$lib/server/dedupe';
import { admit, isOwner } from '$lib/server/access';
import { claimPendingAction, listMembers, pendingActionIsLive, setPendingAction } from '$lib/server/db/users';
import {
	FEEDBACK_DAILY_LIMIT,
	FEEDBACK_MAX_LENGTH,
	countFeedbackSince,
	createFeedback
} from '$lib/server/db/feedback';
import { releases } from '$lib/releases';
import { createBill, getUnpaidBillTotal, listBills } from '$lib/server/db/bills';
import { getMonthlyPlan } from '$lib/server/db/plans';
import {
	processEventOnce,
	deleteLatestTransaction,
	getByCategory,
	getPaymentMethodTotal,
	getTotals,
	insertTransaction,
	insertTransactionIfUnique,
	updateLatestTransactionNote,
} from '$lib/server/db/queries';
import type { DbExecutor } from '$lib/server/db/queries';
import {
	claimPendingSlipForSave,
	deleteOwnedPendingSlip,
	deletePendingSlip,
	getPendingSlip,
	replacePendingSlip,
	releasePendingSlipSave,
	updateOwnedPendingSlip
} from '$lib/server/db/slips';
import type { Feedback, NewTransaction, PendingSlip, User } from '$lib/server/db/schema';
import { processPendingSlip } from '$lib/server/ocr/processor';
import { matchCommand, parseEntries, parseMessage } from '$lib/server/parser';
import type { BotCommand, InstallmentPlan, ParseOutcome } from '$lib/server/parser';
import {
	addDays,
	addMonths,
	bangkokDayStart,
	bangkokMonthStart,
	bangkokParts,
	formatThaiMonthYear,
	formatThaiShortDate,
	bangkokMonthKey,
	daysInBangkokMonth
} from '$lib/utils/date';
import { formatNumber, toNumber } from '$lib/utils/money';
import { getDisplayName, pushText, replyQuickReplies, replyText } from './client';
import {
	confirmInstallment,
	confirmNoteUpdated,
	confirmSaved,
	confirmSavedMany,
	duplicateSlipActions,
	duplicateSlipText,
	duplicateTextWarning,
	helpText,
	dashboardLinkText,
	feedbackPromptText,
	feedbackThanksText,
	feedbackTooManyText,
	joinedText,
	membersText,
	newFeedbackText,
	newMemberText,
	noReleaseText,
	releaseNotesText,
	revokedText,
	setupText,
	slipReviewActions,
	slipReviewText,
	summaryText,
	undoText,
	unknownText,
	welcomeText
} from './messages';

export interface LineEvent {
	type: string;
	replyToken?: string;
	webhookEventId?: string;
	timestamp?: number;
	source?: { type: string; userId?: string };
	message?: { id: string; type: string; text?: string; contentProvider?: { type: string } };
	postback?: { data: string };
}

export async function handleEvents(events: LineEvent[]): Promise<void> {
	// Sequential on purpose: entries from one person should land in the order
	// they were typed, and the volume here is a handful of events at most.
	for (const event of events) {
		// Stop on storage failure so later commands cannot overtake this entry.
		await handleEvent(event);
	}
}

async function handleEvent(event: LineEvent): Promise<void> {
	const userId = event.source?.userId ?? '';
	if (!event.replyToken) return;

	if (config.line.allowedUserIds.length === 0) {
		// Nobody owns the bot yet, so hand back the id needed to claim it.
		await replyText(event.replyToken, userId ? setupText(userId) : 'ไม่พบ userId ในข้อความนี้');
		return;
	}

	// Adding the bot is the signup: there is nothing to type and nothing to
	// paste, which is the whole point of doing it here.
	if (event.type === 'follow') {
		await gateOnMembership(event.replyToken, userId, welcomeText());
		return;
	}

	const text = event.type === 'message' ? event.message?.text ?? '' : '';
	// Bootstrap identity without allowing access to the personal ledger.
	if (event.type === 'message' && matchCommand(text) === 'whoami') {
		await replyText(event.replyToken, userId ? `LINE userId ของคุณคือ\n${userId}` : 'ไม่พบ userId ในข้อความนี้');
		return;
	}

	const user = await gateOnMembership(event.replyToken, userId);
	if (!user) return;
	if (event.type === 'postback' && event.postback) {
		await handleSlipPostback(event, user);
		return;
	}
	if (event.type !== 'message' || !event.message) return;
	// Answered outside the ledger transaction: it reads other people's rows, so
	// it has no business inside a per-user write, and it must not be deduped.
	if (matchCommand(text) === 'members') {
		await replyText(event.replyToken, await membersSummary(userId));
		return;
	}
	// Reads settings rather than the ledger, and is owner-only, so it is
	// answered here for the same reason the member list is.
	if (matchCommand(text) === 'status') {
		await replyText(event.replyToken, statusSummary(userId));
		return;
	}
	if (event.message.type === 'image') {
		await handleSlipImage(event, user);
		return;
	}
	if (event.message.type !== 'text') return;

	const eventId = event.webhookEventId ?? event.message.id;
	if (!eventId) throw new Error('LINE message has no event identifier');
	// Parse outside the transaction: an LLM request must not hold a DB connection.
	// Use the original send time so retries across midnight keep the intended day.
	const sentAt = event.timestamp === undefined ? new Date() : new Date(event.timestamp);
	const pending = await getPendingSlip(user.id);
	// Answered before anything is parsed: someone in feedback mode who writes
	// “แอปช้ามาก จ่ายไป 500” means a complaint, not an expense. A slip still in
	// play wins, though — that reply is an answer to a question the bot asked.
	if (!pending && user.pendingAction === 'feedback' && pendingActionIsLive(user, sentAt)) {
		const captured = await processEventOnce(eventId, (executor) => captureFeedback(text, user, executor));
		if (captured === null || captured.reply === null) return;
		if (captured.saved) await announceFeedback(user, captured.saved);
		await sendQuietly(() => replyText(event.replyToken as string, captured.reply as string));
		return;
	}
	const command = matchCommand(text);
	const override = !pending ? duplicateOverride(text) : null;
	const entryText = override?.text ?? text;
	const entryCommand = matchCommand(entryText);
	// A slip conversation is about one payment, so it never splits into a list.
	// Everything else may carry one entry per line.
	let outcomes: ParseOutcome[];
	if (pending && pending.status !== 'failed') {
		// A ready slip already supplies the amount, so the user's description is
		// parsed once with that amount. This avoids spending an LLM fallback call
		// on text such as “ค่าอาหาร” that intentionally contains no number.
		outcomes = [
			pending.status === 'ready' && pending.amount && !command
				? await parseMessage(`${text} ${pending.amount}`, pending.occurredAt ?? sentAt, { userId: user.id })
				: await parseMessage(text, sentAt, { userId: user.id })
		];
	} else {
		outcomes = entryCommand
			? [await parseMessage(entryText, sentAt, { userId: user.id })]
			: await parseEntries(entryText, sentAt, { userId: user.id });
	}
	const response = await processEventOnce(eventId, (executor) =>
		respondTo(outcomes, entryText, user, executor, pending, sentAt, Boolean(override))
	);
	if (response === null) return;
	try {
		await replyResponse(event.replyToken, response);
	} catch (error) {
		// The ledger is committed; a failed confirmation must not repeat mutations.
		console.error('[line] confirmation failed:', error);
	}
}

type LineResponse =
	| string
	| { kind: 'slip'; slip: PendingSlip }
	| { kind: 'duplicate-slip'; slip: PendingSlip }
	| { kind: 'categories'; pendingId: number };

async function replyResponse(replyToken: string, response: LineResponse): Promise<void> {
	if (typeof response === 'string') {
		await replyText(replyToken, response);
		return;
	}
	if (response.kind === 'categories') {
		await replyQuickReplies(replyToken, 'เลือกหมวดหมู่ของรายการนี้', EXPENSE_CATEGORIES.map((category) => ({
			label: `${category.icon} ${category.nameTh}`,
			data: `slip:category:${response.pendingId}:${category.id}`
		})));
		return;
	}
	if (response.kind === 'duplicate-slip') {
		await replyQuickReplies(replyToken, duplicateSlipText(response.slip), duplicateSlipActions(response.slip.id));
		return;
	}
	await replyQuickReplies(replyToken, slipReviewText(response.slip), slipReviewActions(response.slip.id));
}

function duplicateOverride(text: string): { text: string } | null {
	const match = /^บันทึกซ้ำ(?:\s+|\r?\n)([\s\S]+)$/i.exec(text.trim());
	const rest = match?.[1].trim() ?? '';
	return rest ? { text: rest } : null;
}

function pendingExpired(pending: PendingSlip): boolean {
	return Boolean(pending.expiresAt && pending.expiresAt.getTime() <= Date.now());
}

async function handleSlipPostback(event: LineEvent, user: User): Promise<void> {
	if (!event.replyToken) return;
	const data = event.postback?.data ?? '';
	const categoryMatch = /^slip:category:(\d+):([a-z_]{1,32})$/.exec(data);
	const actionMatch = /^slip:(save|force-save|edit-amount|change-category|change-date|cancel):(\d+)$/.exec(data);
	if (!categoryMatch && !actionMatch) return;
	const pendingId = Number(categoryMatch?.[1] ?? actionMatch?.[2]);
	if (!Number.isSafeInteger(pendingId) || pendingId <= 0) return;
	const eventId = event.webhookEventId;
	if (!eventId) throw new Error('LINE postback has no event identifier');

	const response = await processEventOnce(eventId, async (executor): Promise<LineResponse> => {
		const pending = await getPendingSlip(user.id, executor);
		if (!pending || pending.id !== pendingId) return 'รายการนี้ถูกบันทึก ยกเลิก หรือหมดเวลาแล้ว';
		if (pendingExpired(pending)) {
			await deleteOwnedPendingSlip(pending.id, user.id, executor);
			return 'สลิปนี้หมดเวลาแล้ว กรุณาส่งรูปใหม่อีกครั้ง';
		}
		if (pending.status === 'saving') return 'กำลังบันทึกรายการนี้อยู่ รอสักครู่นะ';
		if (pending.status !== 'ready') return 'รายการนี้ยังไม่พร้อมบันทึก';

		if (categoryMatch) {
			const category = EXPENSE_CATEGORIES.find((item) => item.id === categoryMatch[2]);
			if (!category) return 'ไม่พบหมวดหมู่นี้';
			const updated = await updateOwnedPendingSlip(pending.id, user.id, { categoryId: category.id }, executor);
			return updated ? { kind: 'slip', slip: updated } : 'รายการนี้หมดเวลาแล้ว กรุณาส่งรูปใหม่อีกครั้ง';
		}

		switch (actionMatch![1]) {
			case 'edit-amount':
				return 'พิมพ์ยอดใหม่ เช่น “ยอด 350”';
			case 'change-date':
				return 'พิมพ์วันที่ใหม่ เช่น “วันที่ 7/9/2026”';
			case 'change-category':
				return { kind: 'categories', pendingId: pending.id };
			case 'cancel':
				await deleteOwnedPendingSlip(pending.id, user.id, executor);
				return 'ยกเลิกสลิปแล้ว';
			case 'save':
			case 'force-save': {
				if (!pending.amount || toNumber(pending.amount) <= 0) return 'ยังไม่มียอดเงิน กด “แก้ยอด” ก่อนบันทึก';
				const claimed = await claimPendingSlipForSave(pending.id, user.id, executor);
				if (!claimed) return 'รายการนี้ถูกบันทึก ยกเลิก หรือหมดเวลาแล้ว';
				const values: NewTransaction = {
					userId: user.id,
					kind: 'expense',
					amount: claimed.amount!,
					categoryId: claimed.categoryId,
					note: claimed.note,
					occurredAt: claimed.occurredAt ?? new Date(event.timestamp ?? Date.now()),
					paymentMethod: claimed.paymentMethod,
					source: 'line',
					parsedBy: 'ocr',
					rawText: `[OCR]\n${claimed.ocrText}`,
					lineUserId: user.lineUserId
				};
				const saved = actionMatch![1] === 'save' && claimed.fingerprint
					? await insertTransactionIfUnique({ ...values, fingerprint: claimed.fingerprint }, executor)
					: await insertTransaction(values, executor);
				if (!saved) {
					const restored = await releasePendingSlipSave(claimed.id, user.id, executor);
					return restored
						? { kind: 'duplicate-slip', slip: restored }
						: 'รายการนี้ถูกบันทึกหรือยกเลิกไปแล้ว';
				}
				await deleteOwnedPendingSlip(claimed.id, user.id, executor);
				return confirmSaved(saved, saved.categoryId === FALLBACK_CATEGORY.expense);
			}
		}
		return 'ไม่รู้จักคำสั่งนี้';
	});
	if (response !== null) {
		try {
			await replyResponse(event.replyToken, response);
		} catch (error) {
			// Mutations are committed and deduped; failing the webhook here would
			// only make LINE retry an action whose side effect already succeeded.
			console.error('[line] postback response failed:', error);
		}
	}
}

/**
 * Answers a message from someone who may not be a member yet, returning the
 * ledger to use or null when the caller should stop.
 */
async function gateOnMembership(replyToken: string, userId: string, greeting?: string): Promise<User | null> {
	const admission = await admit(userId, () => getDisplayName(userId));
	if (admission.status === 'member') {
		// A returning member who re-adds the bot gets a greeting; mid-conversation
		// there is nothing to say, so the caller carries on with their message.
		if (greeting) await replyText(replyToken, greeting);
		return greeting ? null : admission.user;
	}
	if (admission.status === 'revoked') {
		await replyText(replyToken, revokedText());
		return null;
	}
	// A first message that also opens the account gets the welcome rather than
	// being silently swallowed as an expense.
	await sendQuietly(() => replyText(replyToken, joinedText()));
	await announceNewMember(admission.user);
	return null;
}

/**
 * Anyone who adds the bot gets an account, so the owners' protection is knowing
 * it happened. Telling them is best-effort — a failed push must not undo a
 * signup — and the member list on the dashboard is the durable record.
 */
async function announceNewMember(user: User): Promise<void> {
	for (const owner of config.line.allowedUserIds) {
		if (owner === user.lineUserId) continue;
		await sendQuietly(() => pushText(owner, newMemberText(user.displayName, user.lineUserId, user.createdAt)));
	}
}

/**
 * One unreachable recipient must not abort a loop of messages or fail the
 * webhook — LINE would retry the whole event and repeat the ones that worked.
 */
async function sendQuietly(send: () => Promise<unknown>): Promise<void> {
	try {
		await send();
	} catch (error) {
		console.error('[line] message failed:', error);
	}
}

/**
 * What the bot is actually wired to right now. Exists because both the chat
 * fallback and the monthly analysis go quiet when no provider resolves, and
 * from the outside that looks the same as them being broken — so the owner
 * needs a way to ask without reading a deploy log.
 */
function statusSummary(userId: string): string {
	if (!isOwner(userId)) return 'เฉพาะเจ้าของบอทเท่านั้นที่ดูสถานะระบบได้';
	return [
		'⚙️ สถานะระบบ',
		'',
		describeLlmSetup().replace('[config] ', ''),
		'',
		config.llm.provider === 'none'
			? 'ตัวช่วยอ่านข้อความปิดอยู่ ยังบันทึกด้วยกฎได้ตามปกติ'
			: 'ตัวช่วยอ่านข้อความพร้อมใช้'
	].join('\n');
}

async function membersSummary(userId: string): Promise<string> {
	if (!isOwner(userId)) return 'เฉพาะเจ้าของบอทเท่านั้นที่ดูรายชื่อสมาชิกได้';
	return membersText(await listMembers());
}

async function handleSlipImage(event: LineEvent, user: User): Promise<void> {
	const messageId = event.message?.id;
	if (!messageId || !event.replyToken) return;
	const eventId = event.webhookEventId ?? messageId;
	const claimed = await processEventOnce(eventId, async (executor) => {
		// Sending a slip abandons any half-finished conversation: the reply that
		// follows is about this payment, and feedback mode would otherwise file
		// “ค่าอาหาร” as a complaint and leave the slip unrecorded.
		await setPendingAction(user.id, null, executor);
		return replacePendingSlip({ userId: user.id, lineUserId: user.lineUserId, messageId, status: 'queued' }, executor);
	});
	if (!claimed) return;
	if (config.ocr.mode === 'inline') {
		// Fire and forget, but never unhandled: `processPendingSlip` claims the row
		// before its own try/catch begins, so a dropped connection there would
		// escape the webhook entirely and could take the process with it.
		void processPendingSlip(claimed.slip.id).catch((error) => {
			console.error('[ocr] inline slip read could not start:', error);
		});
	}
	// A second image silently throws away the first read (issue #43). Saying so
	// is what stops the result that still arrives for the old slip from looking
	// like a duplicate answer about the new one.
	const acknowledgement = claimed.replaced
		? '🔄 ยกเลิกสลิปใบก่อนหน้าแล้ว\n\n🧾 รับสลิปใบใหม่แล้ว กำลังอ่านให้นะ'
		: '🧾 รับสลิปแล้ว กำลังอ่านยอดและวันที่ให้นะ\n\nใช้เวลาสักครู่ ไม่ต้องส่งซ้ำ พิมพ์ “ยกเลิก” ได้ถ้าเปลี่ยนใจ';
	try {
		await replyText(event.replyToken, acknowledgement);
	} catch (error) {
		console.error('[line] slip acknowledgement failed:', error);
	}
}

async function respondTo(
	outcomes: ParseOutcome[],
	text: string,
	user: User,
	executor: DbExecutor,
	pending: Awaited<ReturnType<typeof getPendingSlip>> = null,
	sentAt: Date,
	forceDuplicate = false
): Promise<LineResponse> {
	if (pending && pendingExpired(pending)) {
		await deleteOwnedPendingSlip(pending.id, user.id, executor);
		return 'สลิปก่อนหน้าหมดเวลาแล้ว กรุณาส่งรูปใหม่อีกครั้ง';
	}
	if (pending && /^(?:ยกเลิก|cancel)$/i.test(text.trim())) {
		await deletePendingSlip(user.id, executor);
		return 'ยกเลิกสลิปแล้ว';
	}
	if (pending?.status === 'queued' || pending?.status === 'processing') return 'กำลังอ่านสลิปอยู่ รอข้อความผลลัพธ์สักครู่นะ';
	// A failed read invites the person to type the entry by hand, and that entry
	// owes nothing to OCR. Leaving the husk in place would stamp it `parsedBy:
	// 'ocr'` and staple an empty transcript to it.
	if (pending?.status === 'failed') {
		await deletePendingSlip(user.id, executor);
		pending = null;
	}
	if (outcomes.length > 1) return saveBatch(outcomes, text, user, executor, sentAt, forceDuplicate);

	const [outcome] = outcomes;
	if (outcome.type === 'command') {
		// Starting another conversation now would strand the slip: it holds an
		// amount and a date that exist nowhere else once it is replaced.
		if (pending && outcome.command === 'feedback') {
			return 'ยังมีสลิปที่อ่านเสร็จรออยู่ ตอบว่าเป็นค่าอะไรก่อน หรือพิมพ์ “ยกเลิก” แล้วค่อยส่งฟีดแบ็ก';
		}
		return runCommand(outcome.command, user, executor);
	}
	// A plan is money not spent yet, so it becomes upcoming bills rather than
	// entries in the ledger. Answered before the slip branch: a plan typed while
	// a slip waits is still a plan, and the slip keeps waiting.
	if (outcome.type === 'installment') return saveInstallment(outcome.plan, user, executor);
	if (pending?.status === 'ready') {
		if (outcome.type === 'unknown') return 'บอกว่าเป็นค่าอะไร หรือกดปุ่มด้านล่างเพื่อแก้ไขและบันทึก';
		const trimmed = text.trim();
		let values: Parameters<typeof updateOwnedPendingSlip>[2];
		if (/^(?:ยอด|จำนวนเงิน?)\s*/i.test(trimmed)) {
			values = { amount: outcome.tx.amount.toFixed(2) };
		} else if (/^วันที่\s*/i.test(trimmed)) {
			values = { occurredAt: outcome.tx.occurredAt };
		} else {
			values = {
				amount: outcome.tx.amount.toFixed(2),
				categoryId: outcome.tx.categoryId,
				note: outcome.tx.note || pending.note
			};
		}
		const updated = await updateOwnedPendingSlip(pending.id, user.id, values, executor);
		return updated ? { kind: 'slip', slip: updated } : 'สลิปนี้หมดเวลาแล้ว กรุณาส่งรูปใหม่อีกครั้ง';
	}
	if (outcome.type === 'unknown') return unknownText(outcome.text);

	const { tx } = outcome;
	const values: NewTransaction = {
		userId: user.id,
		kind: tx.kind,
		amount: tx.amount.toFixed(2),
		categoryId: tx.categoryId,
		note: tx.note,
		occurredAt: tx.occurredAt,
		paymentMethod: tx.paymentMethod,
		source: 'line',
		parsedBy: tx.parsedBy,
		rawText: text,
		lineUserId: user.lineUserId
	};
	const saved = forceDuplicate
		? await insertTransaction(values, executor)
		: await insertTransactionIfUnique({ ...values, fingerprint: textTransactionFingerprint(tx, sentAt) }, executor);
	if (!saved) return duplicateTextWarning(text);
	return confirmSaved(saved, saved.categoryId === FALLBACK_CATEGORY[saved.kind]);
}

async function runCommand(command: BotCommand, user: User, executor: DbExecutor): Promise<string> {
	// Only the two commands that carry a payload are objects; everything else
	// stays a plain string so the switch below is still checked exhaustively.
	if (typeof command === 'object') {
		if (command.command === 'help') return helpText(command.topic);
		return updateNote(command.text, user, executor);
	}
	switch (command) {
		case 'help':
			return helpText();
		case 'whoami':
			return `LINE userId ของคุณคือ\n${user.lineUserId}`;
		case 'web':
			// The rich menu is a phone-only affordance; on iPad and desktop LINE
			// this is how someone reaches the dashboard at all.
			return dashboardLinkText(config.publicBaseUrl);
		case 'members':
			// Answered in handleEvent: it reads across users, so it must not run
			// inside this user's write transaction.
			throw new Error('members must be handled before the ledger transaction');
		case 'status':
			// Answered in handleEvent for the same reason: it reads settings, not
			// this person's ledger, and it must not be deduped as a mutation.
			throw new Error('status must be handled before the ledger transaction');
		case 'feedback':
			// The message itself comes next: what someone wants to say rarely fits
			// on the line that opens the conversation.
			await setPendingAction(user.id, 'feedback', executor);
			return feedbackPromptText();
		case 'release': {
			const [latest] = releases;
			return latest ? releaseNotesText(latest) : noReleaseText();
		}
		case 'feedback':
			// The message itself comes next: what someone wants to say rarely fits
			// on the line that opens the conversation.
			await setPendingAction(user.id, 'feedback', executor);
			return feedbackPromptText();
		case 'release': {
			const [latest] = releases;
			return latest ? releaseNotesText(latest) : noReleaseText();
		}
		case 'undo':
			return undoText(await deleteLatestTransaction(user.id, executor));
		case 'bills':
			return billsSummary(user.id);
		case 'budget':
			return budgetSummary(user.id, executor);
		case 'today':
			return dailySummary(user.id, executor);
		case 'month':
		case 'summary':
			return monthlySummary(user.id, executor);
	}
}

/**
 * Each month of a plan becomes its own one-off bill, numbered in the order the
 * amounts were typed. Separate bills rather than one recurring bill because the
 * instalments differ in amount and each is paid off on its own.
 */
async function saveInstallment(plan: InstallmentPlan, user: User, executor: DbExecutor): Promise<string> {
	const saved = [];
	for (const bill of plan.bills) {
		saved.push(
			await createBill({
				userId: user.id,
				name: `${plan.name} ${bill.sequence}/${plan.bills.length}`,
				amount: bill.amount.toFixed(2),
				categoryId: plan.categoryId,
				paymentMethod: 'bank',
				recurrence: 'once',
				dueDate: bill.dueDate,
				active: true
			}, executor)
		);
	}
	return confirmInstallment(plan.name, saved);
}

/**
 * Every line of a list lands in the same database transaction, so a message is
 * never half-recorded. `rawText` keeps the line that produced each entry rather
 * than the whole message, which is what makes a later mis-parse diagnosable.
 */
async function saveBatch(
	outcomes: ParseOutcome[],
	text: string,
	user: User,
	executor: DbExecutor,
	sentAt: Date,
	forceDuplicate: boolean
): Promise<string> {
	const saved = [];
	const skipped: string[] = [];
	let duplicates = 0;
	const occurrences = new Map<string, number>();
	for (const outcome of outcomes) {
		if (outcome.type !== 'transaction') {
			skipped.push(outcome.type === 'unknown' ? outcome.text : text);
			continue;
		}
		const { tx } = outcome;
		const baseFingerprint = textTransactionFingerprint(tx, sentAt);
		const occurrenceIndex = occurrences.get(baseFingerprint) ?? 0;
		occurrences.set(baseFingerprint, occurrenceIndex + 1);
		const sourceText = tx.note ? `${tx.note} ${tx.amount}` : text;
		const values: NewTransaction = {
				userId: user.id,
				kind: tx.kind,
				amount: tx.amount.toFixed(2),
				categoryId: tx.categoryId,
				note: tx.note,
				occurredAt: tx.occurredAt,
				paymentMethod: tx.paymentMethod,
				source: 'line',
				parsedBy: tx.parsedBy,
				rawText: sourceText,
				lineUserId: user.lineUserId
			};
		const row = forceDuplicate
			? await insertTransaction(values, executor)
			: await insertTransactionIfUnique({
				...values,
				fingerprint: occurrenceIndex === 0
					? baseFingerprint
					: textTransactionFingerprint(tx, sentAt, occurrenceIndex)
			}, executor);
		if (row) saved.push(row);
		else duplicates += 1;
	}
	return confirmSavedMany(saved, skipped, duplicates);
}

/**
 * Detail attached after the fact. Scoped to the latest entry because chat
 * offers no way to point at an older one and the row id is never shown.
 */
async function updateNote(note: string, user: User, executor: DbExecutor): Promise<string> {
	const updated = await updateLatestTransactionNote(user.id, note.slice(0, 120).trim(), executor);
	if (!updated) return 'ยังไม่มีรายการให้ใส่โน้ต ลองบันทึกรายการก่อน เช่น “ข้าว 60”';
	return confirmNoteUpdated(updated, updated.note);
}

interface CapturedFeedback {
	/** null when there is nothing to say: another delivery already answered. */
	reply: string | null;
	/** null when nothing was stored: a cancellation or a rate-limited send. */
	saved: Feedback | null;
}

/**
 * Consumes the message someone typed after asking to send feedback. The mode is
 * claimed up front, so it ends on every path — a person left stuck in it would
 * find their next expense filed as a complaint — and the claim doubles as the
 * lock that keeps the daily count below from being read by two deliveries at
 * once.
 */
async function captureFeedback(text: string, user: User, executor: DbExecutor): Promise<CapturedFeedback> {
	if (!(await claimPendingAction(user.id, 'feedback', executor))) return { reply: null, saved: null };
	const body = text.trim();
	if (/^(?:ยกเลิก|cancel)$/i.test(body)) return { reply: 'ยกเลิกการส่งฟีดแบ็กแล้ว', saved: null };
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	if ((await countFeedbackSince(user.id, since, executor)) >= FEEDBACK_DAILY_LIMIT) {
		return { reply: feedbackTooManyText(), saved: null };
	}
	const saved = await createFeedback(
		{
			userId: user.id,
			lineUserId: user.lineUserId,
			// Snapshot the name: it is what the owner recognises months later, even
			// if the person renames their LINE account in between.
			displayName: user.displayName,
			message: body.slice(0, FEEDBACK_MAX_LENGTH)
		},
		executor
	);
	return { reply: feedbackThanksText(), saved };
}

/** Best-effort, like every other owner notification: the row is the record. */
async function announceFeedback(user: User, saved: Feedback): Promise<void> {
	for (const owner of config.line.allowedUserIds) {
		await sendQuietly(() => pushText(owner, newFeedbackText(user.displayName, saved.message, saved.createdAt)));
	}
}

async function billsSummary(userId: number): Promise<string> {
	const now = new Date();
	const unpaid = (await listBills(userId, now)).filter((bill) => !bill.paid);
	if (unpaid.length === 0) return '🧾 บิลที่ต้องจ่าย\n\nเดือนนี้ไม่มีบิลค้างแล้ว';
	const lines = ['🧾 บิลที่ต้องจ่าย', ''];
	for (const bill of unpaid.slice(0, 10)) {
		const due = billDueDate(bill, now);
		lines.push(`• ${bill.name} ${formatNumber(bill.amount)} บาท${due ? ` · ${formatThaiShortDate(due)}` : ''}`);
	}
	lines.push('', `รวม ${formatNumber(unpaid.reduce((sum, bill) => sum + bill.amount, 0))} บาท`);
	return lines.join('\n');
}

async function budgetSummary(userId: number, executor: DbExecutor): Promise<string> {
	const now = new Date();
	const month = bangkokMonthKey(now);
	const plan = await getMonthlyPlan(userId, month);
	if (!plan || toNumber(plan.expectedIncome) <= 0) {
		return '📊 ยังไม่ได้ตั้งงบเดือนนี้\n\nเปิดหน้า “แผนเดือน” บนเว็บ แล้วกรอกเงินที่มี ค่าอาหาร และค่าเดินทางก่อน';
	}
	const from = bangkokMonthStart(now);
	const range = { from, to: addMonths(from, 1) };
	const [totals, slices, unpaidBills, creditCardSpent] = await Promise.all([
		getTotals(userId, range, executor), getByCategory(userId, range, 'expense', executor),
		getUnpaidBillTotal(userId, now), getPaymentMethodTotal(userId, range, 'credit_card', executor)
	]);
	const { day } = bangkokParts(now);
	const analysis = analyzeBudget({
		expectedIncome: toNumber(plan.expectedIncome), savingsGoal: toNumber(plan.savingsGoal),
		foodDailyBudget: toNumber(plan.foodDailyBudget), commuteDailyBudget: toNumber(plan.commuteDailyBudget),
		commuteDays: plan.commuteDays, expense: totals.expense,
		foodSpent: slices.find((item) => item.categoryId === 'food')?.total ?? 0,
		commuteSpent: slices.find((item) => item.categoryId === 'transport')?.total ?? 0,
		unpaidBills, currentDay: day, daysInMonth: daysInBangkokMonth(now)
	});
	const advice = analysis.status === 'over' ? '⛔ เกินงบแล้ว ควรหยุดรายจ่ายที่เลื่อนได้' : analysis.status === 'tight' ? '⚠️ งบเริ่มตึง ควรลดรายจ่ายที่ไม่จำเป็น' : '✅ ยังอยู่ในแผน';
	return [
		`📊 งบ${formatThaiMonthYear(now)}`, '', advice,
		`เหลือหลังหักบิล ${formatNumber(analysis.remaining)} บาท`,
		`ใช้ได้เฉลี่ย ${formatNumber(analysis.safeDaily)} บาท/วัน`,
		`ค่าอาหารยังใช้ได้ ${formatNumber(analysis.foodSafeDaily)} บาท/วัน`,
		`ค่าเดินทางยังใช้ได้ ${formatNumber(analysis.commuteSafeDaily)} บาท/วันทำงาน`,
		`ใช้บัตรเครดิตแล้ว ${formatNumber(creditCardSpent)} บาท`
	].join('\n');
}

async function dailySummary(userId: number, executor: DbExecutor): Promise<string> {
	const now = new Date();
	const from = bangkokDayStart(now);
	const range = { from, to: addDays(from, 1) };
	const [totals, slices] = await Promise.all([
		getTotals(userId, range, executor),
		getByCategory(userId, range, 'expense', executor)
	]);
	return summaryText(`📅 สรุปวันที่ ${formatThaiShortDate(now)}`, totals, slices);
}

async function monthlySummary(userId: number, executor: DbExecutor): Promise<string> {
	const now = new Date();
	const from = bangkokMonthStart(now);
	const range = { from, to: addMonths(from, 1) };
	const [totals, slices] = await Promise.all([
		getTotals(userId, range, executor),
		getByCategory(userId, range, 'expense', executor)
	]);
	// Average over days elapsed, not days in the month — mid-month numbers
	// otherwise look artificially low.
	const days = bangkokParts(now).day;
	return summaryText(`🗓 สรุป${formatThaiMonthYear(now)}`, totals, slices, { days });
}
