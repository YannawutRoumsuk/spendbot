const env = process.env;

export type LlmProvider = 'none' | 'anthropic' | 'gemini' | 'openrouter';

/** Which host answers a vision call. Its key is separate from the parser’s. */
export type VisionTransport = 'none' | 'google' | 'openrouter';

/** `auto` reads with Gemini when it is configured and falls back to Tesseract. */
export type OcrProvider = 'gemini' | 'tesseract' | 'auto';

const DEFAULT_MODELS: Record<Exclude<LlmProvider, 'none'>, string> = {
	anthropic: 'claude-haiku-4-5-20251001',
	gemini: 'gemini-2.5-flash-lite',
	// The cheapest model on the gateway that still reads Thai and returns JSON.
	openrouter: 'google/gemini-2.5-flash-lite'
};

function resolveLlm() {
	const declared = (env.LLM_PROVIDER ?? '').trim().toLowerCase();
	const anthropicKey = (env.ANTHROPIC_API_KEY ?? '').trim();
	const geminiKey = (env.GEMINI_API_KEY ?? '').trim();
	const openrouterKey = (env.OPENROUTER_API_KEY ?? '').trim();

	// An explicit LLM_PROVIDER wins; otherwise infer from whichever key is set,
	// so the common case needs one env var instead of two.
	const provider: LlmProvider =
		declared === 'none'
			? 'none'
			: declared === 'anthropic' || declared === 'gemini' || declared === 'openrouter'
			? declared
			: anthropicKey
				? 'anthropic'
				: geminiKey
					? 'gemini'
					: openrouterKey
						? 'openrouter'
						: 'none';

	const keys: Record<LlmProvider, string> = {
		none: '',
		anthropic: anthropicKey,
		gemini: geminiKey,
		openrouter: openrouterKey
	};
	const apiKey = keys[provider];

	if (provider !== 'none' && !apiKey) {
		console.warn(`[config] LLM_PROVIDER=${provider} but its API key is empty — LLM fallback off`);
		return {
			provider: 'none' as const,
			apiKey: '',
			model: '',
			parserDailyLimit: boundedInteger(env.LLM_PARSER_DAILY_LIMIT, 20, 0, 200),
			maxInputChars: boundedInteger(env.LLM_PARSER_MAX_INPUT_CHARS, 500, 50, 2_000),
			maxOutputTokens: boundedInteger(env.LLM_PARSER_MAX_OUTPUT_TOKENS, 150, 50, 400),
			timeoutMs: boundedInteger(env.LLM_TIMEOUT_MS, 8_000, 1_000, 30_000)
		};
	}

	const model =
		(env.LLM_MODEL ?? '').trim() || (provider === 'none' ? '' : DEFAULT_MODELS[provider]);
	if (model) warnOnModelShape('LLM_MODEL', model, provider === 'openrouter');

	return {
		provider,
		apiKey,
		model,
		parserDailyLimit: boundedInteger(env.LLM_PARSER_DAILY_LIMIT, 20, 0, 200),
		maxInputChars: boundedInteger(env.LLM_PARSER_MAX_INPUT_CHARS, 500, 50, 2_000),
		maxOutputTokens: boundedInteger(env.LLM_PARSER_MAX_OUTPUT_TOKENS, 150, 50, 400),
		timeoutMs: boundedInteger(env.LLM_TIMEOUT_MS, 8_000, 1_000, 30_000)
	};
}

function resolveOcrProvider(): OcrProvider {
	const declared = (env.OCR_PROVIDER ?? '').trim().toLowerCase();
	return declared === 'gemini' || declared === 'tesseract' ? declared : 'auto';
}

/**
 * Reading slips and categorising text are separate choices, so they read
 * separate settings. Deriving the vision key from `resolveLlm()` would tie them
 * together: someone running Claude for text and Gemini for slips resolves to
 * `anthropic` there, and the slip reader would then be off with nothing said.
 */
function resolveOcrVision() {
	const declared = (env.OCR_API_PROVIDER ?? '').trim().toLowerCase();
	const googleKey = (env.GEMINI_API_KEY ?? '').trim();
	const gatewayKey = (env.OPENROUTER_API_KEY ?? '').trim();

	if (declared && !['google', 'openrouter', 'none'].includes(declared)) {
		console.warn(`[config] OCR_API_PROVIDER=${declared} is not a transport — slip reading falls back to Tesseract`);
		return { transport: 'none' as const, apiKey: '', model: '' };
	}

	/**
	 * A Google key switches slip reading on by itself; an OpenRouter key does
	 * not. Both routes reach the same model, but the gateway is a second party
	 * that sees the whole image — account numbers and phone numbers the app
	 * never stores — and someone who set `OPENROUTER_API_KEY` to make text
	 * parsing cheaper has not agreed to that. Sending bank slips there has to be
	 * asked for by name.
	 */
	const transport: VisionTransport =
		declared === 'none'
			? 'none'
			: declared === 'google' || declared === 'openrouter'
				? declared
				: googleKey
					? 'google'
					: 'none';

	if (transport === 'none' && !declared && !googleKey && gatewayKey) {
		console.info('[config] OPENROUTER_API_KEY is set but slip reading stays on Tesseract — set OCR_API_PROVIDER=openrouter to send slip images through the gateway');
	}

	const apiKey = transport === 'google' ? googleKey : transport === 'openrouter' ? gatewayKey : '';
	if (transport !== 'none' && !apiKey) {
		console.warn(`[config] OCR_API_PROVIDER=${transport} but its API key is empty — slip reading falls back to Tesseract`);
		return { transport: 'none' as const, apiKey: '', model: '' };
	}

	// Model ids are namespaced on the gateway and bare on Google, so the
	// default has to follow the transport rather than be one string.
	const model =
		(env.OCR_MODEL ?? '').trim() ||
		(transport === 'openrouter' ? 'google/gemini-2.5-flash' : 'gemini-2.5-flash');
	warnOnModelShape('OCR_MODEL', model, transport === 'openrouter');
	return { transport, apiKey, model };
}

/**
 * A namespaced id sent to Google, or a bare one sent to the gateway, is a 404
 * the app treats as "the model is unavailable" and quietly answers without it.
 * That reads as the feature being broken, so the mismatch is named at boot.
 */
function warnOnModelShape(name: string, model: string, namespaced: boolean): void {
	const hasNamespace = model.includes('/');
	if (namespaced && !hasNamespace) {
		console.warn(`[config] ${name}=${model} has no namespace — a gateway wants ids like google/${model}`);
	}
	if (!namespaced && hasNamespace) {
		console.warn(`[config] ${name}=${model} is namespaced — calling a provider directly wants the bare id`);
	}
}

function splitList(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || value.trim() === '') return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export const config = {
	ocr: {
		mode: (env.OCR_MODE ?? 'inline').trim() === 'worker' ? 'worker' as const : 'inline' as const,
		provider: resolveOcrProvider(),
		vision: resolveOcrVision(),
		dailyLimit: boundedInteger(env.OCR_DAILY_LIMIT, 20, 0, 200),
		maxOutputTokens: boundedInteger(env.OCR_MAX_OUTPUT_TOKENS, 600, 100, 1_500),
		timeoutMs: boundedInteger(env.OCR_TIMEOUT_MS, 12_000, 2_000, 30_000)
	},
	reminders: {
		mode: (env.REMINDER_MODE ?? 'timer').trim() === 'cron' ? 'cron' as const : 'timer' as const,
		hour: boundedInteger(env.REMINDER_HOUR, 9, 0, 23),
		daysBefore: boundedInteger(env.REMINDER_DAYS_BEFORE, 3, 0, 31)
	},
	databaseUrl: env.DATABASE_URL ?? '',
	/** The dashboard's public origin, handed out in chat when someone asks for it. */
	publicBaseUrl: (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, ''),
	line: {
		channelSecret: (env.LINE_CHANNEL_SECRET ?? '').trim(),
		accessToken: (env.LINE_CHANNEL_ACCESS_TOKEN ?? '').trim(),
		/**
		 * Comma-separated list of owners. These accounts have access before any
		 * database row exists, and they are the only ones who can see the member
		 * list or revoke someone. Everyone else signs up by adding the bot.
		 */
		allowedUserIds: splitList(env.LINE_ALLOWED_USER_ID),
		/**
		 * The bot's public @id. Shown on the login page so someone who reached
		 * the web first can add the bot — which is the only way to get an
		 * account. The matching QR is generated by `bun run line:qr`.
		 */
		addFriendId: (env.LINE_ADD_FRIEND_ID ?? '').trim()
	},
	dashboard: {
		password: (env.DASHBOARD_PASSWORD ?? '').trim(),
		sessionSecret: (env.SESSION_SECRET ?? '').trim()
	},
	liff: {
		id: (env.LIFF_ID ?? '').trim()
	},
	llm: resolveLlm()
};

/**
 * One line at boot saying what the model settings resolved to.
 *
 * Until now `config` only spoke up when something looked wrong, so a correct
 * setup and a variable that never reached the process produced the same empty
 * log. That is the state worth naming: both the chat fallback and the monthly
 * analysis switch themselves off when there is no provider, and from the
 * outside that is indistinguishable from them being broken.
 *
 * Never prints a key, only whether one arrived.
 */
export function describeLlmSetup(): string {
	const parser =
		config.llm.provider === 'none'
			? 'parser=off (no usable key)'
			: `parser=${config.llm.provider}:${config.llm.model}`;
	// `OCR_PROVIDER=tesseract` wins over any usable transport, so it is checked
	// first: reporting the transport there would claim images leave the machine
	// when they never do, which is the opposite of what this line is for.
	const slips =
		config.ocr.provider === 'tesseract'
			? 'slips=tesseract (local, forced)'
			: config.ocr.vision.transport === 'none'
				? 'slips=tesseract (local, no vision key)'
				: `slips=${config.ocr.vision.transport}:${config.ocr.vision.model}`;
	return `[config] ${parser} ${slips}`;
}

/** The allowlist is the only thing standing between a stranger and the ledger. */
export function isAllowedLineUser(lineUserId: string): boolean {
	return Boolean(lineUserId) && config.line.allowedUserIds.includes(lineUserId);
}

/** Throws on the misconfigurations that would silently break the bot. */
export function assertLineConfigured(): void {
	if (!config.line.channelSecret) throw new Error('LINE_CHANNEL_SECRET is not set');
	if (!config.line.accessToken) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');
}
