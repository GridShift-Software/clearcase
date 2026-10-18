export function download(name: string, content: string | Uint8Array, type = 'text/csv;charset=utf-8') {
	const url = URL.createObjectURL(new Blob([typeof content === 'string' ? content : new Uint8Array(content)], { type }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
