import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { DesktopApi, McpAuthEvent, McpServer } from "./contract";
import type { Translate } from "./i18n";
import "./mcp.css";

type Props = {
	sessionId?: string;
	servers: McpServer[];
	authEvent?: McpAuthEvent;
	call: DesktopApi["invoke"];
	t: Translate;
};

export function McpPanel({ sessionId, servers, authEvent, call, t }: Props) {
	const [listed, setListed] = useState(servers);
	const [busy, setBusy] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [name, setName] = useState("");
	const [scope, setScope] = useState<"global" | "project">("project");
	const [configJson, setConfigJson] = useState("");
	const [editing, setEditing] = useState<string>();
	const [removeTarget, setRemoveTarget] = useState<string>();
	const [reloadNeeded, setReloadNeeded] = useState(false);

	useEffect(() => setListed(servers), [servers]);
	const refresh = useCallback(async () => {
		if (!sessionId) return;
		const result = await call("mcp.list", { sessionId });
		if (result.ok) setListed(result.data);
		else setNotice(`${result.code}: ${result.message}`);
	}, [call, sessionId]);
	useEffect(() => { void refresh(); }, [refresh]);

	const action = async (key: string, run: () => Promise<{ ok: boolean; data?: unknown; code?: string; message?: string }>) => {
		setBusy(key);
		setNotice(undefined);
		try {
			const result = await run();
			if (!result.ok) {
				setNotice(`${result.code}: ${result.message}`);
				return false;
			}
			if (result.data && typeof result.data === "object" && "reloadRequired" in result.data && result.data.reloadRequired === true) {
				setReloadNeeded(true);
				setNotice(t("Configuration saved. Reload the session to apply it."));
			}
			await refresh();
			return true;
		} finally {
			setBusy(undefined);
		}
	};

	const saveConfig = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!sessionId || !name.trim()) return;
		try {
			const parsed: unknown = JSON.parse(configJson);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error(t("Server configuration must be a JSON object."));
		} catch (error) {
			setNotice(error instanceof Error ? error.message : t("Invalid JSON configuration."));
			return;
		}
		const saved = await action("save", () => editing
			? call("mcp.update", { sessionId, name: editing, configJson })
			: call("mcp.add", { sessionId, name: name.trim(), scope, configJson }));
		if (saved) {
			setEditing(undefined);
			setName("");
			setConfigJson("");
		}
	};

	return <div className="modal-content mcp-content">
		{!sessionId ? <div className="inline-diagnostic">{t("Select a conversation session to manage its MCP servers.")}</div> : <>
			<p className="modal-intro">{t("Connection details and tools update live. Server credentials stay in Pi configuration and are never shown here.")}</p>
			{authEvent?.sessionId === sessionId && <div className="mcp-auth-link"><b>{t("MCP authorization")}: {authEvent.serverName}</b><span>{authEvent.url}</span><small>{t("Complete sign-in in the browser. If the callback fails, paste its full redirect URL into the prompt.")}</small></div>}
			{notice && <div className="inline-diagnostic" role="status">{notice}</div>}
			<div className="mcp-toolbar"><span>{listed.length} {t("servers")}</span><button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => void refresh()}>{t("Refresh")}</button><button type="button" className="outline-button" disabled={Boolean(busy) || !reloadNeeded} onClick={() => void action("reload", async () => {
				const result = await call("mcp.reload", { sessionId });
				if (result.ok) setReloadNeeded(false);
				return result;
			})}>{t("Reload session")}</button></div>
			<div className="mcp-server-list">{listed.length === 0 ? <p className="empty-hint">{t("No MCP servers are configured for this session.")}</p> : listed.map((server) => <article className="mcp-server" key={server.name}>
				<div className="mcp-server-head"><div><b>{server.name}</b><small>{server.scope ?? t("unknown scope")} · {t(server.state)} · {server.toolCount} {t("tools")} · {server.resourceCount} {t("resources")}</small></div><span className={`mcp-state mcp-state-${server.state}`}>{t(server.state)}</span></div>
				<div className="mcp-server-actions"><label>{t("Exposure")}<select value={server.exposure} disabled={Boolean(busy)} onChange={(event) => void action(`${server.name}:exposure`, () => call("mcp.set-exposure", { sessionId, name: server.name, exposure: event.target.value as McpServer["exposure"] }))}><option value="codemode">codemode</option><option value="deferred">deferred</option><option value="direct">direct</option><option value="hidden">hidden</option></select></label><label className="mcp-enabled"><input type="checkbox" checked={server.enabled} disabled={Boolean(busy)} onChange={(event) => void action(`${server.name}:enabled`, () => call("mcp.set-enabled", { sessionId, name: server.name, enabled: event.target.checked }))} />{t("Enabled")}</label>
					<button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void action(`${server.name}:reconnect`, () => call("mcp.reconnect", { sessionId, name: server.name }))}>{t("Reconnect")}</button>
					{server.usesOAuth && <><button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void action(`${server.name}:sign-in`, () => call("mcp.sign-in", { sessionId, name: server.name }))}>{t("Sign in")}</button><button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void action(`${server.name}:sign-out`, () => call("mcp.sign-out", { sessionId, name: server.name }))}>{t("Sign out")}</button></>}
					{server.scope !== "extension" && <><button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => { setEditing(server.name); setName(server.name); setScope(server.scope === "global" ? "global" : "project"); setConfigJson(""); setNotice(t("Paste the full replacement configuration. Existing secrets cannot be displayed.")); }}>{t("Edit config")}</button><button type="button" className="text-button mcp-remove" disabled={Boolean(busy)} onClick={() => setRemoveTarget(server.name)}>{t("Remove")}</button></>}
				</div>
				{removeTarget === server.name && <div className="mcp-remove-confirm"><span>{t("Remove this server from its configuration file?")}</span><button type="button" className="outline-button" onClick={() => setRemoveTarget(undefined)}>{t("Cancel")}</button><button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => void action(`${server.name}:remove`, () => call("mcp.remove", { sessionId, name: server.name })).then((removed) => { if (removed) setRemoveTarget(undefined); })}>{t("Confirm remove")}</button></div>}
			</article>)}</div>
			<form className="mcp-config-form" onSubmit={(event) => void saveConfig(event)}><h3>{t(editing ? "Replace MCP server config" : "Add MCP server")}</h3><div className="mcp-config-fields"><label>{t("Server name")}<input required disabled={Boolean(editing)} value={name} onChange={(event) => setName(event.target.value)} placeholder="docs" /></label><label>{t("Scope")}<select value={scope} disabled={Boolean(editing)} onChange={(event) => setScope(event.target.value as "global" | "project")}><option value="project">{t("Project")}</option><option value="global">{t("User")}</option></select></label></div><label>{t("Server configuration JSON")}<textarea required value={configJson} onChange={(event) => setConfigJson(event.target.value)} rows={5} spellCheck={false} placeholder={'{ "url": "https://example.com/mcp" }'} /></label><small>{t("For local servers, use command and args. For remote servers, use url. Secrets may use Pi environment references.")}</small><div className="modal-footer"><button type="button" className="outline-button" onClick={() => { setEditing(undefined); setName(""); setConfigJson(""); }}>{t("Clear form")}</button><button className="primary-action" disabled={Boolean(busy) || !name.trim() || !configJson.trim()}>{t(editing ? "Replace config" : "Add server")}</button></div></form>
		</>}
	</div>;
}
