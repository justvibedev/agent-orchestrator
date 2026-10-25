import { findLocalPaths } from "../../shared/local-path";

type MarkdownNode = {
	type: string;
	value?: string;
	children?: MarkdownNode[];
	data?: { hName: string; hProperties: Record<string, string> };
};

/**
 * remark plugin that marks absolute and `~/` paths in prose as `<span data-local-path>`.
 * Code, fences and existing links are left alone; the span renderer decides what a path may do.
 */
export function remarkLocalPaths() {
	return (tree: MarkdownNode) => visit(tree);
}

function visit(node: MarkdownNode): void {
	if (!node.children || node.type === "code" || node.type === "inlineCode" || node.type === "link" || node.type === "linkReference") return;
	for (let index = 0; index < node.children.length; index += 1) {
		const child = node.children[index]!;
		if (child.type !== "text" || !child.value) {
			visit(child);
			continue;
		}
		const matches = findLocalPaths(child.value);
		if (matches.length === 0) continue;
		const replacement: MarkdownNode[] = [];
		let cursor = 0;
		for (const match of matches) {
			if (match.start > cursor) replacement.push({ type: "text", value: child.value.slice(cursor, match.start) });
			replacement.push({
				type: "localPath",
				data: { hName: "span", hProperties: { dataLocalPath: match.path } },
				children: [{ type: "text", value: match.path }],
			});
			cursor = match.end;
		}
		if (cursor < child.value.length) replacement.push({ type: "text", value: child.value.slice(cursor) });
		node.children.splice(index, 1, ...replacement);
		index += replacement.length - 1;
	}
}
