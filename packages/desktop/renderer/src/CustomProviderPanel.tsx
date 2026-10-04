import { useState, type FormEvent } from "react";
import type { Command, CommandMap, DesktopCustomProvider, Provider, Result } from "./contract";
import type { Translate } from "./i18n";
import { buildCustomProvider, customProviderToDraft, emptyCustomModel, emptyCustomProvider, type CustomModelDraft, type CustomProviderDraft } from "./custom-provider-form";
import "./custom-providers.css";

type ProviderCall = <K extends Command>(command: K, payload: CommandMap[K]["payload"]) => Promise<Result<CommandMap[K]["data"]>>;
type Props = { providers: Provider[]; t: Translate; call: ProviderCall; refresh: () => Promise<void> };
const apiOptions: Array<{ value: DesktopCustomProvider["api"]; label: string; hint: string }> = [
	{ value: "anthropic-messages", label: "Anthropic Messages", hint: "For Anthropic-compatible APIs, use the API base URL." },
	{ value: "openai-completions", label: "OpenAI Chat Completions", hint: "Usually ends in /v1; Pi adds /chat/completions." },
	{ value: "openai-responses", label: "OpenAI Responses", hint: "Usually ends in /v1; Pi adds /responses." },
	{ value: "openai-codex-responses", label: "OpenAI Codex Responses", hint: "Uses /codex/responses and requires a Codex access token with an account ID." },
];

export function CustomProviderPanel({ providers, t, call, refresh }: Props) {
	const customProviders = providers.flatMap((provider) => provider.custom ? [provider.custom] : []);
	const [draft, setDraft] = useState<CustomProviderDraft | null>(null);
	const [editingId, setEditingId] = useState<string>();
	const [credential, setCredential] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [removeTarget, setRemoveTarget] = useState<string>();

	const startCreate = () => { setDraft(emptyCustomProvider()); setEditingId(undefined); setCredential(""); setError(""); };
	const startEdit = (provider: DesktopCustomProvider) => { setDraft(customProviderToDraft(provider)); setEditingId(provider.id); setCredential(""); setError(""); };
	const updateModel = (index: number, patch: Partial<CustomModelDraft>) => setDraft((current) => current ? { ...current, models: current.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model) } : current);

	const save = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!draft || busy) return;
		setError("");
		const prepared = buildCustomProvider(draft, editingId);
		if ("error" in prepared) { setError(t(prepared.error)); return; }
		setBusy(true);
		try {
			const result = await call("provider.save", { ...prepared.provider, ...(credential.length > 0 ? { credential } : {}) });
			if (!result.ok) { setError(result.message); return; }
			setCredential("");
			setDraft(null);
			setEditingId(undefined);
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Could not save custom provider."));
		} finally { setBusy(false); }
	};

	const remove = async (providerId: string) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const result = await call("provider.remove", { providerId });
			if (!result.ok) { setError(result.message); return; }
			setRemoveTarget(undefined);
			if (editingId === providerId) { setDraft(null); setEditingId(undefined); setCredential(""); }
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Could not remove custom provider."));
		} finally { setBusy(false); }
	};

	return <div className="custom-provider-panel">
		<div className="custom-provider-heading"><div><h4>{t("Custom providers")}</h4><p>{t("Configure a compatible API and its models for Pi.")}</p></div><button type="button" className="outline-button" disabled={busy} onClick={startCreate}>{t("Add custom provider")}</button></div>
		{error && <div className="inline-diagnostic" role="alert">{error}</div>}
		{customProviders.length === 0 && !draft && <p className="custom-provider-empty">{t("No custom providers configured.")}</p>}
		<div className="custom-provider-list">{customProviders.map((provider) => <article className="custom-provider-card" key={provider.id}>
			<div className="custom-provider-card-head"><div><b>{provider.name}</b><small>{provider.id} · {t(apiOptions.find((option) => option.value === provider.api)?.label ?? provider.api)}</small></div><div className="custom-provider-actions"><button type="button" className="text-button" disabled={busy} onClick={() => startEdit(provider)}>{t("Edit")}</button><button type="button" className="text-button custom-provider-remove" disabled={busy} onClick={() => setRemoveTarget(provider.id)}>{t("Remove")}</button></div></div>
			<div className="custom-provider-card-meta"><span>{provider.baseUrl}</span><span>{provider.models.length} {t("models")}</span></div>
			{removeTarget === provider.id && <div className="custom-provider-confirm"><span>{t("Remove this custom provider?")}</span><button type="button" className="outline-button" disabled={busy} onClick={() => setRemoveTarget(undefined)}>{t("Cancel")}</button><button type="button" className="outline-button custom-provider-remove" disabled={busy} onClick={() => void remove(provider.id)}>{t("Confirm remove")}</button></div>}
		</article>)}</div>
		{draft && <form className="custom-provider-form" onSubmit={(event) => void save(event)}>
			<h4>{t(editingId ? "Edit custom provider" : "New custom provider")}</h4>
		<div className="custom-provider-fields"><label>{t("Provider name")}<input required maxLength={200} value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("My API")}/></label><label>{t("Provider ID")}<input maxLength={128} value={draft.id} disabled={busy || Boolean(editingId)} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder={t("my-provider")} />{editingId && <small>{t("Provider ID cannot be changed after creation.")}</small>}</label></div>
			<div className="custom-provider-fields"><label>{t("API format")}<select value={draft.api} disabled={busy} onChange={(event) => setDraft({ ...draft, api: event.target.value as DesktopCustomProvider["api"] })}>{apiOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}</select></label><label>{t("Base URL")}<input required maxLength={2048} type="url" value={draft.baseUrl} disabled={busy} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /><small>{t(apiOptions.find((option) => option.value === draft.api)?.hint ?? "Enter the API base URL.")}</small></label></div>
			<label className="custom-provider-key">{t("API key")}<input type="password" maxLength={16384} autoComplete="new-password" value={credential} disabled={busy} onChange={(event) => setCredential(event.target.value)} placeholder={t(editingId ? "Leave blank to keep the saved key." : "Optional API key")} /><small>{t(editingId ? "A blank key keeps the current credential. Saved keys are never shown." : "The key is stored in Pi’s local credential store.")}</small></label>
			<div className="custom-provider-models-head"><div><b>{t("Models")}</b><small>{t("Enter the model ID sent to the API and a display name.")}</small></div><button type="button" className="outline-button small-button" disabled={busy || draft.models.length >= 100} onClick={() => setDraft({ ...draft, models: [...draft.models, emptyCustomModel()] })}>{t("Add model")}</button></div>
			{draft.models.map((model, index) => <fieldset className="custom-provider-model" key={index}><legend>{t("Model")} {index + 1}</legend><button type="button" className="text-button custom-provider-model-remove" aria-label={`${t("Remove")} ${model.id || `${t("Model")} ${index + 1}`}`} disabled={busy || draft.models.length <= 1} onClick={() => setDraft({ ...draft, models: draft.models.filter((_, modelIndex) => modelIndex !== index) })}>{t("Remove")}</button><div className="custom-provider-fields"><label>{t("Model ID")}<input required maxLength={256} value={model.id} disabled={busy} onChange={(event) => updateModel(index, { id: event.target.value })} placeholder="model-id" /></label><label>{t("Display name")}<input required maxLength={200} value={model.name} disabled={busy} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder="Model name" /></label></div><div className="custom-provider-fields custom-provider-limits"><label>{t("Context window")}<input required type="number" min="1" max="100000000" step="1" value={model.contextWindow} disabled={busy} onChange={(event) => updateModel(index, { contextWindow: event.target.value })} /></label><label>{t("Max output tokens")}<input required type="number" min="1" max="100000000" step="1" value={model.maxTokens} disabled={busy} onChange={(event) => updateModel(index, { maxTokens: event.target.value })} /></label></div><div className="custom-provider-model-flags"><label><input type="checkbox" checked={model.reasoning} disabled={busy} onChange={(event) => updateModel(index, { reasoning: event.target.checked })} />{t("Reasoning support")}</label><label><input type="checkbox" checked={model.image} disabled={busy} onChange={(event) => updateModel(index, { image: event.target.checked })} />{t("Image input")}</label></div></fieldset>)}
			<div className="custom-provider-footer"><button type="button" className="outline-button" disabled={busy} onClick={() => { setDraft(null); setEditingId(undefined); setCredential(""); setError(""); }}>{t("Cancel")}</button><button className="primary-action" disabled={busy}>{t(busy ? "Saving…" : "Save custom provider")}</button></div>
		</form>}
	</div>;
}
