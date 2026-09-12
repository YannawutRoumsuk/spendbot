import { FALLBACK_CATEGORY, getCategory } from '$lib/categories';
import type { ReleaseNote } from '$lib/releases';
import type { CategorySlice, Totals } from '$lib/server/db/queries';
import type { Bill, Transaction } from '$lib/server/db/schema';
import type { HelpTopic } from '$lib/server/parser/types';
import { formatThaiShortDate, formatThaiTime } from '$lib/utils/date';
import { formatNumber, toNumber } from '$lib/utils/money';

export interface SlipReviewData {
	id: number;
	amount?: number | string | null;
	occurredAt?: Date | null;
	recipient?: string;
	categoryId: string;
	paymentMethod: string;
	amountConfidence?: number | string | null;
	dateConfidence?: number | string | null;
	recipientConfidence?: number | string | null;
}

const paymentMethodLabels: Record<string, string> = {
	bank: 'โอน/บัญชี',
	cash: 'เงินสด',
	credit_card: 'บัตรเครดิต',
	wallet: 'วอลเล็ต'
};

export function slipReviewText(slip: SlipReviewData): string {
	const amount = slip.amount === null || slip.amount === undefined
		? 'ยังอ่านไม่ชัด — กด “แก้ยอด”'
		: `${formatNumber(toNumber(slip.amount))} บาท`;
	const occurredAt = slip.occurredAt
		? `${formatThaiShortDate(slip.occurredAt)} ${formatThaiTime(slip.occurredAt)} น.`
		: 'วันนี้';
	const warnings = [
		confidenceWarning('ยอดเงิน', slip.amountConfidence),
		confidenceWarning('วันที่', slip.dateConfidence),
		confidenceWarning('ผู้รับ', slip.recipientConfidence)
	].filter(Boolean);
	return [
		'🧾 ตรวจสอบรายการจากสลิป',
		'',
		`ยอดเงิน: ${amount}`,
		`วันที่: ${occurredAt}`,
		`ผู้รับ: ${slip.recipient?.trim() || 'ไม่ทราบชื่อ'}`,
		`หมวดหมู่: ${categoryLine(slip.categoryId)}`,
		`จ่ายด้วย: ${paymentMethodLabels[slip.paymentMethod] ?? slip.paymentMethod}`,
		...(warnings.length ? ['', '⚠️ ควรตรวจอีกครั้ง', ...warnings] : []),
		'',
		'เลือกการทำรายการด้านล่าง'
	].join('\n');
}

function confidenceWarning(label: string, value: number | string | null | undefined): string {
	if (value === null || value === undefined) return '';
	const confidence = Number(value);
	return Number.isFinite(confidence) && confidence < 0.7 ? `• ${label}อ่านได้ไม่ชัด` : '';
}

export function slipReviewActions(id: number) {
	return [
		{ label: 'บันทึก', data: `slip:save:${id}` },
		{ label: 'แก้ยอด', data: `slip:edit-amount:${id}` },
		{ label: 'เปลี่ยนหมวดหมู่', data: `slip:change-category:${id}` },
		{ label: 'เปลี่ยนวันที่', data: `slip:change-date:${id}` },
		{ label: 'ยกเลิก', data: `slip:cancel:${id}` }
	];
}

export function duplicateSlipText(slip: SlipReviewData): string {
	return [
		'⚠️ สลิปนี้เคยถูกบันทึกแล้ว',
		'',
		slipReviewText(slip),
		'',
		'ถ้าเป็นคนละรายการจริง กด “บันทึกอีกครั้ง”'
	].join('\n');
}

export function duplicateSlipActions(id: number) {
	return [
		{ label: 'บันทึกอีกครั้ง', data: `slip:force-save:${id}` },
		{ label: 'ยกเลิก', data: `slip:cancel:${id}` }
	];
}

export function duplicateTextWarning(text: string): string {
	const example = text.trim().slice(0, 180);
	return [
		'⚠️ รายการนี้เหมือนรายการที่เพิ่งบันทึก จึงยังไม่เพิ่มซ้ำ',
		'',
		'ถ้าเป็นคนละรายการจริง ให้พิมพ์:',
		`บันทึกซ้ำ ${example}`
	].join('\n');
}

function categoryLine(categoryId: string): string {
	const category = getCategory(categoryId);
	return category ? `${category.icon} ${category.nameTh}` : `📦 ${categoryId}`;
}

/** Tells the user how to attach the detail a bare confirmation cannot show. */
const ADD_NOTE_HINT = 'อยากเพิ่มรายละเอียด พิมพ์ "โน้ต" ตามด้วยข้อความ เช่น "โน้ต กับพี่ตุ้ย"';

export function confirmSaved(tx: Transaction, uncertain: boolean): string {
	const amount = toNumber(tx.amount);
	const sign = tx.kind === 'income' ? '+' : '-';
	const when = `${formatThaiShortDate(tx.occurredAt)} ${formatThaiTime(tx.occurredAt)} น.`;
	const lines = [
		tx.kind === 'income' ? '💚 บันทึกรายรับแล้ว' : '✅ บันทึกแล้ว',
		`${sign}${formatNumber(amount)} บาท`,
		categoryLine(tx.categoryId),
		when
	];
	// The note is shown on its own line — folded into the category line it was
	// too easy to skim past, and that is exactly the detail this reply exists
	// to let someone double-check.
	if (tx.note) lines.push(`📝 ${tx.note}`);
	if (uncertain) lines.push('', 'ℹ️ เดาหมวดหมู่ให้เป็น "อื่นๆ" — พิมพ์ "ลบ" ถ้าไม่ถูก');
	if (!tx.note) lines.push('', ADD_NOTE_HINT);
	return lines.join('\n');
}

/** Confirms a note change on the most recent entry, echoing it back to check at a glance. */
export function confirmNoteUpdated(tx: Transaction, note: string): string {
	const amount = toNumber(tx.amount);
	const sign = tx.kind === 'income' ? '+' : '-';
	return [
		'📝 แก้โน้ตแล้ว',
		`${sign}${formatNumber(amount)} บาท · ${categoryLine(tx.categoryId)}`,
		note ? `"${note}"` : '(ลบโน้ตออกแล้ว)'
	].join('\n');
}

/**
 * One receipt for a message that carried several entries. Every line is echoed
 * back with its own amount: a batch that silently recorded the wrong number is
 * exactly what this feature exists to prevent, so the reply has to be checkable
 * at a glance.
 */
export function confirmSavedMany(saved: Transaction[], skipped: string[], duplicates = 0): string {
	if (saved.length === 0 && duplicates > 0 && skipped.length === 0) {
		return [
			`⚠️ พบ ${duplicates} รายการซ้ำ จึงยังไม่บันทึก`,
			'',
			'ถ้าเป็นคนละรายการจริง ให้เติม “บันทึกซ้ำ” ไว้หน้าข้อความเดิมแล้วส่งอีกครั้ง'
		].join('\n');
	}
	const total = saved.reduce(
		(sum, tx) => sum + (tx.kind === 'income' ? toNumber(tx.amount) : -toNumber(tx.amount)),
		0
	);
	const lines = [`✅ บันทึก ${saved.length} รายการ`, ''];
	for (const tx of saved) {
		const sign = tx.kind === 'income' ? '+' : '-';
		lines.push(`${sign}${formatNumber(toNumber(tx.amount))} · ${categoryLine(tx.categoryId)}${tx.note ? ` · ${tx.note}` : ''}`);
	}
	lines.push('', `รวม ${total >= 0 ? '+' : '-'}${formatNumber(Math.abs(total))} บาท`);

	if (skipped.length > 0) {
		lines.push('', `⚠️ ข้าม ${skipped.length} บรรทัดที่อ่านไม่ออก`);
		for (const line of skipped.slice(0, 3)) lines.push(`  "${line}"`);
	}
	if (duplicates > 0) {
		lines.push('', `⚠️ กันไว้ ${duplicates} รายการที่เหมือนรายการเดิม`);
		lines.push('ถ้าเป็นคนละรายการจริง ให้เติม “บันทึกซ้ำ” ไว้หน้าข้อความเดิม');
	}
	const uncertain = saved.filter((tx) => tx.categoryId === FALLBACK_CATEGORY[tx.kind]).length;
	if (uncertain > 0) lines.push('', `ℹ️ ${uncertain} รายการเดาหมวดเป็น "อื่นๆ" — แก้ได้บนเว็บ`);
	return lines.join('\n');
}

/**
 * A plan is a promise about money not spent yet, so the reply lists every due
 * date: an instalment landing on the wrong month is only obvious here.
 */
export function confirmInstallment(name: string, bills: Bill[]): string {
	const total = bills.reduce((sum, bill) => sum + toNumber(bill.amount), 0);
	const lines = [`🧾 ตั้งบิลล่วงหน้า ${bills.length} งวด`, '', name, ''];
	for (const [index, bill] of bills.entries()) {
		const due = bill.dueDate ? formatThaiShortDate(bill.dueDate) : 'ยังไม่กำหนด';
		lines.push(`งวด ${index + 1} · ${formatNumber(toNumber(bill.amount))} บาท · ครบ ${due}`);
	}
	lines.push('', `รวม ${formatNumber(total)} บาท`, '', 'แก้หรือลบได้ที่หน้า "บิล" บนเว็บ');
	return lines.join('\n');
}

export function summaryText(
	title: string,
	totals: Totals,
	slices: CategorySlice[],
	options: { days?: number } = {}
): string {
	if (totals.count === 0) return `${title}\n\nยังไม่มีรายการในช่วงนี้`;

	const lines = [title, ''];
	if (totals.income > 0) lines.push(`รายรับ  +${formatNumber(totals.income)} บาท`);
	lines.push(`รายจ่าย  -${formatNumber(totals.expense)} บาท`);
	lines.push(`คงเหลือ  ${totals.net >= 0 ? '+' : ''}${formatNumber(totals.net)} บาท`);

	if (options.days && options.days > 1 && totals.expense > 0) {
		const perDay = totals.expense / options.days;
		lines.push(`เฉลี่ย  ${formatNumber(Math.round(perDay))} บาท/วัน`);
	}

	const top = slices.slice(0, 5);
	if (top.length > 0) {
		lines.push('', 'จ่ายมากสุด');
		const max = top[0].total || 1;
		for (const slice of top) {
			const bar = '▰'.repeat(Math.max(1, Math.round((slice.total / max) * 8)));
			lines.push(`${categoryLine(slice.categoryId)}  ${formatNumber(slice.total)}`);
			lines.push(`  ${bar}`);
		}
	}

	return lines.join('\n');
}

export function undoText(tx: Transaction | null): string {
	if (!tx) return 'ไม่มีรายการให้ลบ';
	const sign = tx.kind === 'income' ? '+' : '-';
	return [
		'🗑 ลบรายการล่าสุดแล้ว',
		`${sign}${formatNumber(toNumber(tx.amount))} บาท`,
		`${categoryLine(tx.categoryId)}${tx.note ? ` · ${tx.note}` : ''}`
	].join('\n');
}

// ------------------------------------------------------------------- help --

/** Every page stays comfortably under LINE's ~2000-char truncation limit. */
const HELP_PAGES: Record<HelpTopic, () => string> = {
	overview: helpOverview,
	record: helpRecord,
	slip: helpSlip,
	web: helpWeb,
	bills: helpBills,
	commands: helpCommands
};

export function helpText(topic: HelpTopic = 'overview'): string {
	return HELP_PAGES[topic]();
}

function helpOverview(): string {
	return [
		'📒 Nudget ช่วยจดรายรับ-รายจ่ายให้ไวจากแชท',
		'',
		'ที่คนใช้บ่อยที่สุด',
		'1) บันทึกรายจ่าย — พิมพ์',
		'   ข้าวเที่ยง 60',
		'   บอทตอบ: ✅ บันทึกแล้ว พร้อมยอดและหมวด',
		'2) ส่งสลิปโอนเงิน — แนบรูปสลิป แล้วรอสักครู่',
		'   บอทตอบ: 🧾 รับสลิปแล้ว กำลังอ่านยอดและวันที่ให้นะ',
		'3) เปิดแดชบอร์ด — พิมพ์',
		'   เว็บ',
		'   บอทตอบ: ลิงก์เข้าเว็บ กด "เข้าสู่ระบบด้วย LINE" ครั้งแรก',
		'',
		'ดูเพิ่มเติม พิมพ์',
		'  ช่วย บันทึก · ช่วย สลิป · ช่วย เว็บ · ช่วย บิล · ช่วย คำสั่ง'
	].join('\n');
}

function helpRecord(): string {
	return [
		'📝 วิธีบันทึกรายการ',
		'',
		'รายจ่าย — พิมพ์ของกับราคา',
		'  ข้าวเที่ยง 60',
		'  กาแฟ 85 บาท',
		'  ค่าน้ำมัน 1,200',
		'บอทตอบ: ✅ บันทึกแล้ว พร้อมยอด หมวด และเวลา',
		'',
		'รายรับ — ขึ้นต้นด้วย + หรือ "รับ"',
		'  +เงินเดือน 30000',
		'  รับ ฟรีแลนซ์ 5k',
		'บอทตอบ: 💚 บันทึกรายรับแล้ว',
		'',
		'ย้อนหลัง — ใส่วันไว้ข้างหน้า',
		'  เมื่อวาน ข้าว 50',
		'  1/9 ค่าไฟ 800',
		'',
		'หลายรายการ — พิมพ์บรรทัดละรายการ ส่งทีเดียว',
		'  กาแฟ 60',
		'  น้ำ 30',
		'',
		'เพิ่มโน้ตทีหลัง — แก้โน้ตของรายการล่าสุด',
		'  โน้ต กับพี่ตุ้ย',
		'บอทตอบ: 📝 แก้โน้ตแล้ว'
	].join('\n');
}

function helpSlip(): string {
	return [
		'🧾 ส่งสลิปโอนเงิน',
		'',
		'1) แนบรูปสลิปมาได้เลย',
		'   บอทตอบทันที: 🧾 รับสลิปแล้ว กำลังอ่านยอดและวันที่ให้นะ',
		'2) การอ่านสลิปใช้เวลาไม่กี่วินาที — รอสักครู่ อย่าเพิ่งส่งรูปซ้ำ',
		'3) อ่านเสร็จแล้วบอทจะถามว่าเป็นค่าอะไร พิมพ์ตอบสั้น ๆ ได้เลย',
		'   ค่าอาหาร ข้าวมันไก่ กับพี่ตุ้ย',
		'   บอทจะเก็บ "ข้าวมันไก่ กับพี่ตุ้ย" เป็นโน้ตให้อัตโนมัติ',
		'4) เปลี่ยนใจกลางทาง พิมพ์ "ยกเลิก" ได้ทุกเมื่อ',
		'',
		'ยอดกับวันที่มาจากสลิปอัตโนมัติ ไม่ต้องพิมพ์ซ้ำ'
	].join('\n');
}

function helpWeb(): string {
	return [
		'🖥 ใช้งานผ่านเว็บแดชบอร์ด',
		'',
		'1) พิมพ์ "เว็บ" เพื่อขอลิงก์',
		'2) เปิดลิงก์ที่บอทส่งให้',
		'3) กด "เข้าสู่ระบบด้วย LINE" ครั้งแรก',
		'4) ระบบจำไว้ให้ 30 วัน ไม่ต้องเข้าสู่ระบบซ้ำ',
		'',
		'บนเว็บทำอะไรได้บ้าง',
		'  แก้หมวดหมู่ / แก้ยอด / ลบรายการ',
		'  ตั้งงบรายเดือน',
		'  ดูบิลที่ต้องจ่าย',
		'  ส่งออกข้อมูลเป็น CSV/JSON',
		'  ดูสรุปย้อนหลังรายเดือน'
	].join('\n');
}

function helpBills(): string {
	return [
		'🧾 บิลและการผ่อนจ่าย',
		'',
		'ตั้งบิลล่วงหน้า — บอกจำนวนงวดกับยอดแต่ละงวด',
		'  บิล shoppe 3 เดือน 4050 3800 3800',
		'บอทตอบ: รายการบิลทุกงวดพร้อมวันครบกำหนด',
		'',
		'ดูบิลที่ต้องจ่าย — พิมพ์',
		'  บิล',
		'บอทตอบ: รายการบิลที่ยังไม่จ่ายในเดือนนี้',
		'',
		'แก้ไขหรือลบบิล ทำได้บนเว็บหน้า "บิล" เท่านั้น',
		'พิมพ์ "เว็บ" เพื่อขอลิงก์'
	].join('\n');
}

function helpCommands(): string {
	return [
		'📋 คำสั่งทั้งหมด',
		'',
		'วันนี้ — สรุปวันนี้',
		'เดือนนี้ — สรุปเดือนนี้',
		'งบ — เงินที่ยังใช้ได้ต่อวัน',
		'บิล — รายการที่ยังต้องจ่าย',
		'ลบ — ลบรายการล่าสุด',
		'โน้ต <ข้อความ> — แก้โน้ตของรายการล่าสุด',
		'ไอดี — ดู LINE userId ของคุณ',
		'เว็บ — ขอลิงก์เปิดแดชบอร์ด',
		'สมาชิก — ดูคนที่ใช้บอทนี้ (เจ้าของเท่านั้น)',
		'สถานะ — ดูว่าต่อโมเดลอะไรอยู่ (เจ้าของเท่านั้น)',
		'ฟีดแบ็ก — ส่งข้อความถึงผู้พัฒนา',
		'มีอะไรใหม่ — ดูอัปเดตล่าสุดของบอท',
		'',
		'พิมพ์ "ช่วย" เพื่อย้อนกลับไปหน้าแรก'
	].join('\n');
}

// ---------------------------------------------------------------- welcome --

/** Kept deliberately short: this is the first message after someone adds the bot. */
export function welcomeText(): string {
	return [
		'👋 ยินดีต้อนรับสู่ Nudget',
		'',
		'ลองพิมพ์ 3 อย่างนี้ดูก่อนได้เลย',
		'  ข้าว 60          → บันทึกรายจ่าย',
		'  เว็บ              → ขอลิงก์เปิดแดชบอร์ด',
		'  ช่วย              → ดูวิธีใช้ทั้งหมด',
		'',
		'หรือส่งรูปสลิปมาได้เลย แล้วตอบว่าเป็นค่าอะไร',
		'',
		'บัญชีของคุณเป็นส่วนตัว คนอื่นมองไม่เห็นรายการของคุณ'
	].join('\n');
}

export function joinedText(): string {
	return [
		'🎉 เปิดบัญชีให้แล้ว ยินดีต้อนรับ',
		'',
		'บัญชีนี้เป็นของคุณคนเดียว คนอื่นมองไม่เห็นรายการของคุณ',
		'',
		'ลองพิมพ์ 3 อย่างนี้ดูก่อนได้เลย',
		'  ข้าว 60          → บันทึกรายจ่ายแรก',
		'  เว็บ              → ขอลิงก์เปิดแดชบอร์ด',
		'  ช่วย              → ดูวิธีใช้ทั้งหมด'
	].join('\n');
}

// --------------------------------------------------------------- unknown --

/**
 * Guesses the likely mistake behind a message the parser could not read, so
 * the correction is specific instead of a generic "try again".
 */
function guessMistake(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	// Bare date shape ("1/9", "25-12") with nothing else — no item, no amount.
	if (/^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(trimmed)) {
		return 'ดูเหมือนวันที่ แต่ไม่มีชื่อรายการหรือยอดเงิน ลองพิมพ์ "1/9 ค่าไฟ 800"';
	}

	// Only digits (plus a unit word) — an amount with no item name.
	if (/^[\d,.]+\s*(บาท|฿|k)?$/i.test(trimmed)) {
		return 'มีแต่ตัวเลข ลืมใส่ชื่อรายการหรือเปล่า ลองพิมพ์ "ชื่อของ ตามด้วยราคา" เช่น "ข้าวเที่ยง 60"';
	}

	// Letters only, no digits anywhere — a name with no amount.
	if (/^[a-zA-Zก-๙\s]+$/.test(trimmed) && !/\d/.test(trimmed)) {
		return 'มีชื่อรายการแต่ไม่มียอดเงิน ลองใส่ราคาต่อท้าย เช่น "กาแฟ 85"';
	}

	// Digits mixed in with everything else — probably a malformed date or amount.
	if (/\d/.test(trimmed)) {
		return 'มีตัวเลขอยู่ แต่บอทอ่านไม่ออก ลองตรวจวันที่หรือยอดเงินอีกครั้ง เช่น "ข้าวเที่ยง 60"';
	}

	return null;
}

export function unknownText(text: string): string {
	const hint = guessMistake(text);
	const lines = ['🤔 ไม่เข้าใจข้อความนี้', ''];
	if (hint) lines.push(hint, '');
	lines.push('ลองพิมพ์แบบนี้ดู', '  ข้าวเที่ยง 60', '  +เงินเดือน 30000', '', 'พิมพ์ "ช่วย" เพื่อดูวิธีใช้ทั้งหมด');
	return lines.join('\n');
}

export function dashboardLinkText(baseUrl: string): string {
	if (!baseUrl) return 'ยังไม่ได้ตั้งค่าที่อยู่เว็บ (PUBLIC_BASE_URL)';
	return [
		'🖥 เปิดแดชบอร์ด',
		'',
		baseUrl,
		'',
		'ครั้งแรกให้กด “เข้าสู่ระบบด้วย LINE” แล้วจะจำไว้ 30 วัน'
	].join('\n');
}

export function revokedText(): string {
	return '🚫 บัญชีนี้ถูกปิดการใช้งานโดยเจ้าของบอท';
}

/** What an owner sees the moment a stranger adds the bot. */
export function newMemberText(displayName: string, lineUserId: string, joinedAt: Date): string {
	return [
		'👤 มีคนใหม่เริ่มใช้ Nudget',
		'',
		`ชื่อ LINE: ${displayName.trim() || '(ไม่ทราบชื่อ)'}`,
		`เวลา: ${formatThaiShortDate(joinedAt)} ${formatThaiTime(joinedAt)} น.`,
		`LINE id: ${lineUserId}`,
		'',
		'ดูรายชื่อทั้งหมดหรือปิดสิทธิ์ได้ที่หน้า “สมาชิก” บนเว็บ'
	].join('\n');
}

export interface MemberLine {
	displayName: string;
	lineUserId: string;
	active: boolean;
	joinedAt: Date;
	transactionCount: number;
	lastActivityAt: Date | null;
}

export function membersText(members: MemberLine[]): string {
	if (members.length === 0) return '👥 ยังไม่มีสมาชิก';
	const lines = [`👥 สมาชิก ${members.filter((m) => m.active).length} คนที่ใช้งานอยู่`, ''];
	for (const member of members.slice(0, 20)) {
		const name = member.displayName.trim() || member.lineUserId.slice(0, 10);
		const last = member.lastActivityAt ? formatThaiShortDate(member.lastActivityAt) : 'ยังไม่เคยบันทึก';
		lines.push(
			`${member.active ? '•' : '✕'} ${name}`,
			`   เข้ามา ${formatThaiShortDate(member.joinedAt)} · ${member.transactionCount} รายการ · ล่าสุด ${last}`
		);
	}
	if (members.length > 20) lines.push('', `และอีก ${members.length - 20} คน — ดูทั้งหมดบนเว็บ`);
	return lines.join('\n');
}

export function setupText(userId: string): string {
	return [
		'🔧 บอทยังไม่ได้ตั้งค่าเจ้าของ',
		'',
		'ใส่ id นี้ใน LINE_ALLOWED_USER_ID:',
		userId
	].join('\n');
}

// -------------------------------------------------------------- feedback --

export function feedbackPromptText(): string {
	return [
		'💬 อยากบอกอะไรกับผู้พัฒนา',
		'',
		'พิมพ์ข้อความที่อยากส่งได้เลย ข้อความถัดไปที่คุณส่งจะถูกส่งถึงผู้พัฒนาทันที',
		'พิมพ์ "ยกเลิก" ถ้าเปลี่ยนใจ'
	].join('\n');
}

export function feedbackThanksText(): string {
	return [
		'🙏 ได้รับข้อความแล้ว ขอบคุณมาก',
		'',
		'เจ้าของบอทจะอ่านข้อความนี้เอง',
		'อาจไม่ได้ตอบกลับทุกข้อความ แต่จะเก็บไว้พิจารณาแน่นอน'
	].join('\n');
}

export function feedbackTooManyText(): string {
	return 'ส่งฟีดแบ็กถี่ไปหน่อย ขอเวลาผู้พัฒนาอ่านที่ส่งมาก่อน แล้วค่อยส่งใหม่นะ 🙏';
}

/** What the bot owner receives when someone sends feedback. */
export function newFeedbackText(displayName: string, message: string, at: Date): string {
	return [
		'💬 มีฟีดแบ็กใหม่',
		'',
		`จาก: ${displayName.trim() || '(ไม่ทราบชื่อ)'}`,
		`เวลา: ${formatThaiShortDate(at)} ${formatThaiTime(at)} น.`,
		'',
		message
	].join('\n');
}

// ------------------------------------------------------------ release notes --

export function releaseNotesText(release: ReleaseNote): string {
	const lines = [
		`🚀 มีอะไรใหม่ — v${release.version}`,
		formatThaiShortDate(release.date),
		'',
		release.title,
		''
	];
	for (const highlight of release.highlights) lines.push(`• ${highlight}`);
	return lines.join('\n');
}

export function noReleaseText(): string {
	return 'ยังไม่มีอัปเดตใหม่ให้ดูตอนนี้';
}
