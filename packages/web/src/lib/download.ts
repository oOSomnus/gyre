/** Save text as a file through a temporary object-URL link. */
export function downloadText(text: string, filename: string, mime = "text/plain"): void {
	const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.style.display = "none";
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoke after the click has been handled; revoking synchronously can cancel the download in some engines.
	setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
