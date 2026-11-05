export const FileIcon = ({ name, directory = false }: { name: string; directory?: boolean }) => {
	const extension = name.toLowerCase().split(".").at(-1) ?? "";
	const types: Record<string, [string, string]> = {
		ts: ["typescript", "TS"],
		tsx: ["typescript", "TS"],
		js: ["javascript", "JS"],
		jsx: ["javascript", "JS"],
		mjs: ["javascript", "JS"],
		cjs: ["javascript", "JS"],
		py: ["python", "Py"],
		rs: ["rust", "Rs"],
		go: ["go", "Go"],
		sh: ["shell", ">_"],
		bash: ["shell", ">_"],
		json: ["config", "{}"],
		yaml: ["config", "Y"],
		yml: ["config", "Y"],
		toml: ["config", "T"],
		md: ["markdown", "M↓"],
		markdown: ["markdown", "M↓"],
		txt: ["text", ""],
		css: ["style", "#"],
		scss: ["style", "#"],
		html: ["html", "<>"],
		svg: ["image", "◇"],
		png: ["image", "◇"],
		jpg: ["image", "◇"],
		jpeg: ["image", "◇"],
		webp: ["image", "◇"],
	};
	const [type, label] = directory
		? ["folder", ""]
		: name.toLowerCase() === "dockerfile"
			? ["config", "D"]
			: (types[extension] ?? ["text", ""]);
	return (
		<svg
			className={`file-icon file-icon-${type}`}
			data-file-type={type}
			width='20'
			height='20'
			viewBox='0 0 20 20'
			aria-hidden='true'
		>
			{directory ? (
				<path d='M2 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v9H2Z' fill='currentColor' />
			) : label ? (
				<>
					<rect x='1' y='2' width='18' height='16' rx='3' fill='currentColor' opacity='.16' />
					<text x='10' y='13' textAnchor='middle' fill='currentColor' fontSize='9' fontWeight='700'>
						{label}
					</text>
				</>
			) : (
				<path d='M5 2h6l4 4v12H5Zm6 0v5h4M7 11h6m-6 3h6' fill='none' stroke='currentColor' strokeWidth='1.3' />
			)}
		</svg>
	);
};
