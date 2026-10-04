import Type from "typebox";

export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
const MAX_TEXT_CHARS = MAX_ATTACHMENT_BYTES;

export type DesktopAttachment =
	| { type: "image"; name: string; mimeType: string; data: string }
	| { type: "text"; name: string; text: string };

export const DesktopAttachmentSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("image"),
			name: Type.String({ minLength: 1, maxLength: 255 }),
			mimeType: Type.Union([
				Type.Literal("image/png"),
				Type.Literal("image/jpeg"),
				Type.Literal("image/webp"),
				Type.Literal("image/gif"),
			]),
			data: Type.String({ minLength: 1, maxLength: MAX_BASE64_CHARS }),
			// Images are binary base64 sent through the typed desktop bridge.
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("text"),
			name: Type.String({ minLength: 1, maxLength: 255 }),
			text: Type.String({ maxLength: MAX_TEXT_CHARS }),
		},
		{ additionalProperties: false },
	),
]);

function base64ByteLength(data: string): number {
	if (
		data.length === 0 ||
		data.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
	)
		throw new Error("An image attachment has invalid encoded data.");
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

export function validateAttachments(attachments: readonly DesktopAttachment[] | undefined): void {
	if (!attachments) return;
	if (attachments.length > MAX_ATTACHMENT_COUNT)
		throw new Error(`Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`);
	let totalBytes = 0;
	for (const attachment of attachments) {
		if (attachment.name.trim().length === 0 || attachment.name.length > 255)
			throw new Error("Attachment names must be between 1 and 255 characters.");
		if (attachment.type === "image") {
			if (
				!(
					attachment.mimeType === "image/png" ||
					attachment.mimeType === "image/jpeg" ||
					attachment.mimeType === "image/webp" ||
					attachment.mimeType === "image/gif"
				)
			)
				throw new Error(`Unsupported image type for ${attachment.name}.`);
			const bytes = base64ByteLength(attachment.data);
			if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`${attachment.name} exceeds the 8 MiB attachment limit.`);
			totalBytes += bytes;
		} else {
			const bytes = new TextEncoder().encode(attachment.text).byteLength;
			if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`${attachment.name} exceeds the 8 MiB attachment limit.`);
			totalBytes += bytes;
		}
	}
	if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments exceed the 16 MiB total limit.");
}

export class AttachmentBudget {
	private reservedCount = 0;
	private reservedBytes = 0;

	reserve(files: readonly { size: number }[], current: readonly DesktopAttachment[]): () => void {
		if (files.some((file) => file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES))
			throw new Error("Each attachment must be larger than 0 bytes and no larger than 8 MiB.");
		const currentBytes = current.reduce((total, attachment) => total + attachmentByteLength(attachment), 0);
		const batchBytes = files.reduce((total, file) => total + file.size, 0);
		if (current.length + this.reservedCount + files.length > MAX_ATTACHMENT_COUNT)
			throw new Error(`Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`);
		if (currentBytes + this.reservedBytes + batchBytes > MAX_TOTAL_ATTACHMENT_BYTES)
			throw new Error("Attachments exceed the 16 MiB total limit.");
		this.reservedCount += files.length;
		this.reservedBytes += batchBytes;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.reservedCount -= files.length;
			this.reservedBytes -= batchBytes;
		};
	}
}

function attachmentByteLength(attachment: DesktopAttachment): number {
	if (attachment.type === "text") return new TextEncoder().encode(attachment.text).byteLength;
	return base64ByteLength(attachment.data);
}

export function imageContentFromAttachments(attachments: readonly DesktopAttachment[] | undefined) {
	return (attachments ?? []).flatMap((attachment) =>
		attachment.type === "image"
			? [{ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }]
			: [],
	);
}

export function appendTextAttachments(text: string, attachments: readonly DesktopAttachment[] | undefined): string {
	if (!attachments || attachments.length === 0) return text;
	const fileContent = attachments
		.map((file) => {
			const name = file.name
				.replaceAll("&", "&amp;")
				.replaceAll('"', "&quot;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;");
			if (file.type === "image") return `<file name="${name}"></file>`;
			const content = file.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
			return `<file name="${name}">\n${content}\n</file>`;
		})
		.join("\n");
	return text.trim() ? `${text.trim()}\n\n${fileContent}` : fileContent;
}
