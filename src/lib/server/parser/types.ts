import type { PaymentMethod, TxKind } from '$lib/server/db/schema';
import type { InstallmentPlan } from './installment';

export interface ParsedTransaction {
	kind: TxKind;
	/** Always positive, in baht. */
	amount: number;
	categoryId: string;
	note: string;
	occurredAt: Date;
	parsedBy: 'rule' | 'llm';
	paymentMethod?: PaymentMethod;
}

/** Sub-pages of "ช่วย" (help) — each one is its own short, copy-pasteable guide. */
export type HelpTopic = 'overview' | 'record' | 'slip' | 'web' | 'bills' | 'commands';

/**
 * Every command that has nothing more to say than its own name stays a plain
 * string, exactly as before. Only the two commands that carry a payload — a
 * help sub-topic, the free text of a note — get an object shape instead of
 * exploding into more string literals ('help_record', 'help_slip', ...).
 */
export type BotCommand =
	| 'help'
	| 'today'
	| 'month'
	| 'summary'
	| 'bills'
	| 'budget'
	| 'undo'
	| 'whoami'
	| 'members'
	| 'status'
	| 'web'
	| 'feedback'
	| 'release'
	/** "ช่วย <หัวข้อ>" — bare "help" still means the overview page. */
	| { command: 'help'; topic: HelpTopic }
	/** Overwrites the most recent entry's note with free text. */
	| { command: 'note'; text: string };

export type ParseOutcome =
	| { type: 'command'; command: BotCommand }
	| { type: 'transaction'; tx: ParsedTransaction }
	/** A payment plan: several future bills rather than money already spent. */
	| { type: 'installment'; plan: InstallmentPlan }
	| { type: 'unknown'; text: string };
