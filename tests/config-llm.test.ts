import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Which host a key reaches is a privacy decision, not a detail: one route sends
 * a whole bank slip to Google, another sends it through a gateway that sees the
 * same image, and the wrong inference makes that choice for someone who never
 * made it. `config.ts` reads `process.env` once at import, so each case loads a
 * fresh copy of the module.
 */
const BASE_ENV = { ...process.env };

async function loadModule(env: Record<string, string | undefined>) {
	for (const key of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'LLM_PROVIDER', 'LLM_MODEL', 'OCR_API_PROVIDER', 'OCR_MODEL', 'OCR_PROVIDER']) {
		delete process.env[key];
	}
	Object.assign(process.env, env);
	vi.resetModules();
	return await import('../src/lib/server/config');
}

async function loadConfig(env: Record<string, string | undefined>) {
	for (const key of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'LLM_PROVIDER', 'LLM_MODEL', 'OCR_API_PROVIDER', 'OCR_MODEL']) {
		delete process.env[key];
	}
	Object.assign(process.env, env);
	vi.resetModules();
	return (await import('../src/lib/server/config')).config;
}

afterEach(() => {
	process.env = { ...BASE_ENV };
	vi.resetModules();
});

describe('choosing a text provider', () => {
	it('picks the gateway when its key is the only one set', async () => {
		const config = await loadConfig({ OPENROUTER_API_KEY: 'sk-or-x' });
		expect(config.llm.provider).toBe('openrouter');
		expect(config.llm.apiKey).toBe('sk-or-x');
		expect(config.llm.model).toBe('google/gemini-2.5-flash-lite');
	});

	it('never hands one provider the key belonging to another', async () => {
		const config = await loadConfig({ LLM_PROVIDER: 'openrouter', GEMINI_API_KEY: 'goog-x' });
		// The declared provider has no key of its own, so the whole fallback is off
		// rather than reaching the gateway with a Google key.
		expect(config.llm.provider).toBe('none');
		expect(config.llm.apiKey).toBe('');
	});

	it('prefers a direct provider over the gateway when both keys exist', async () => {
		const config = await loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENROUTER_API_KEY: 'sk-or-x' });
		expect(config.llm.provider).toBe('anthropic');
		expect(config.llm.apiKey).toBe('sk-ant-x');
	});
});

describe('choosing who reads a bank slip', () => {
	// The finding this test exists for: a key set to make text parsing cheaper
	// must not start uploading slip images to a second company.
	it('leaves slip reading on Tesseract when only the gateway key is set', async () => {
		const config = await loadConfig({ OPENROUTER_API_KEY: 'sk-or-x', LLM_PROVIDER: 'openrouter' });
		expect(config.ocr.vision.transport).toBe('none');
		expect(config.ocr.vision.apiKey).toBe('');
	});

	it('sends slips through the gateway only when asked for by name', async () => {
		const config = await loadConfig({ OPENROUTER_API_KEY: 'sk-or-x', OCR_API_PROVIDER: 'openrouter' });
		expect(config.ocr.vision.transport).toBe('openrouter');
		expect(config.ocr.vision.model).toBe('google/gemini-2.5-flash');
	});

	it('switches on by itself for a direct Google key, which is the same party as before', async () => {
		const config = await loadConfig({ GEMINI_API_KEY: 'goog-x' });
		expect(config.ocr.vision.transport).toBe('google');
		expect(config.ocr.vision.model).toBe('gemini-2.5-flash');
	});

	it('honours an explicit off switch even with a usable key', async () => {
		const config = await loadConfig({ GEMINI_API_KEY: 'goog-x', OCR_API_PROVIDER: 'none' });
		expect(config.ocr.vision.transport).toBe('none');
	});

	it('refuses a transport it does not recognise rather than guessing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const config = await loadConfig({ GEMINI_API_KEY: 'goog-x', OCR_API_PROVIDER: 'gemini' });
		expect(config.ocr.vision.transport).toBe('none');
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('falls back when the named transport has no key', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const config = await loadConfig({ OCR_API_PROVIDER: 'openrouter' });
		expect(config.ocr.vision.transport).toBe('none');
		warn.mockRestore();
	});
});

describe('warning about a model id that cannot work', () => {
	it('names a bare id sent to the gateway', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await loadConfig({ OPENROUTER_API_KEY: 'sk-or-x', LLM_MODEL: 'gemini-2.5-flash-lite' });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no namespace'));
		warn.mockRestore();
	});

	it('names a namespaced id sent straight to a provider', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await loadConfig({ GEMINI_API_KEY: 'goog-x', OCR_MODEL: 'google/gemini-2.5-flash' });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('is namespaced'));
		warn.mockRestore();
	});

	it('stays quiet when the id matches the route', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await loadConfig({ OPENROUTER_API_KEY: 'sk-or-x', OCR_API_PROVIDER: 'openrouter', LLM_MODEL: 'google/gemini-2.5-flash-lite' });
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('saying out loud what resolved', () => {
	// The gap this closes: config only spoke up when something looked wrong, so
	// a working setup and a variable that never arrived left the same empty log.
	it('names the provider and model when a gateway key is present', async () => {
		const { describeLlmSetup } = await loadModule({
			OPENROUTER_API_KEY: 'sk-or-x',
			OCR_API_PROVIDER: 'openrouter'
		});
		expect(describeLlmSetup()).toBe(
			'[config] parser=openrouter:google/gemini-2.5-flash-lite slips=openrouter:google/gemini-2.5-flash'
		);
	});

	it('says why each half is off when nothing is configured', async () => {
		const { describeLlmSetup } = await loadModule({});
		const line = describeLlmSetup();
		expect(line).toContain('parser=off (no usable key)');
		expect(line).toContain('slips=tesseract (local, no vision key)');
	});

	it('distinguishes a forced local reader from a missing key', async () => {
		const { describeLlmSetup } = await loadModule({ OCR_PROVIDER: 'tesseract', GEMINI_API_KEY: 'goog-x' });
		expect(describeLlmSetup()).toContain('slips=tesseract (local, forced)');
	});

	it('never prints the key itself', async () => {
		const { describeLlmSetup } = await loadModule({ OPENROUTER_API_KEY: 'sk-or-secret-value' });
		expect(describeLlmSetup()).not.toContain('sk-or-secret-value');
	});
});
