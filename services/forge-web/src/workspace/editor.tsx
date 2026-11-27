import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";

export const Editor = ({
	content,
	path,
	change,
	readOnly = false,
}: {
	content: string;
	path: string;
	change: (content: string) => void;
	readOnly?: boolean;
}) => {
	const element = useRef<HTMLDivElement>(null);
	const callback = useRef(change);
	const [initialContent] = useState(content);
	useEffect(() => {
		callback.current = change;
	}, [change]);
	useEffect(() => {
		if (!element.current) return;
		const view = new EditorView({
			parent: element.current,
			doc: initialContent,
			extensions: [
				basicSetup,
				EditorView.editable.of(!readOnly),
				syntaxHighlighting(
					HighlightStyle.define([
						{ tag: [tags.keyword, tags.operator], color: "#ff7b72" },
						{ tag: tags.name, color: "#e6edf3" },
						{ tag: [tags.function(tags.variableName), tags.typeName, tags.className], color: "#d2a8ff" },
						{ tag: [tags.string, tags.special(tags.string)], color: "#a5d6ff" },
						{ tag: [tags.number, tags.bool, tags.null], color: "#79c0ff" },
						{ tag: tags.regexp, color: "#7ee787" },
						{ tag: tags.comment, color: "#8b949e" },
					]),
				),
				EditorView.theme(
					{
						"&": { color: "#e6edf3", backgroundColor: "#0d1117" },
						".cm-content": { caretColor: "#e6edf3" },
						".cm-cursor": { borderLeftColor: "#e6edf3" },
						".cm-gutters": {
							backgroundColor: "#161b22",
							color: "#8b949e",
							borderRight: "1px solid #30363d",
						},
						".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#161b22" },
						"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
							backgroundColor: "#264f78",
						},
					},
					{ dark: true },
				),
				...(/\.[cm]?[jt]sx?$/u.test(path)
					? [javascript({ typescript: /\.tsx?$/u.test(path), jsx: /\.[jt]sx$/u.test(path) })]
					: []),
				EditorView.contentAttributes.of({ "aria-label": "File editor" }),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) callback.current(update.state.doc.toString());
				}),
			],
		});
		return () => view.destroy();
	}, [path, initialContent, readOnly]);
	return <div className='code-editor' ref={element} />;
};
