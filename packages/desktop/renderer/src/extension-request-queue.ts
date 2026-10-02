import type { CommandMap, DesktopEvent, Result } from "./contract.ts";

type ExtensionRequest = Extract<DesktopEvent, { type: "extension.request" }>;
type ExtensionRequestAction =
	| ExtensionRequest
	| Extract<DesktopEvent, { type: "extension.dismiss" }>
	| { type: "extension.response"; requestId: string; result: Result<CommandMap["extension.ui.respond"]["data"]> };

export function extensionRequestQueue(
	requests: readonly ExtensionRequest[],
	action: ExtensionRequestAction,
): readonly ExtensionRequest[] {
	if (action.type === "extension.request") {
		return requests.some((event) => event.request.id === action.request.id) ? requests : [...requests, action];
	}
	if (
		action.type === "extension.response" &&
		!action.result.ok &&
		action.result.code !== "UI_REQUEST_NOT_FOUND" &&
		action.result.code !== "WORKER_NOT_RUNNING"
	) return requests;
	return requests.filter((event) => event.request.id !== action.requestId);
}
