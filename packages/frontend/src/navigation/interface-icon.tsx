const paths = {
	notifications: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
	filters: "M3 4h18l-7 8v7l-4 2v-9z",
	tasks: "M6 5h14M6 12h14M6 19h14M3 5h.01M3 12h.01M3 19h.01",
	repos: "M4 19V5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 1 0-4h14M8 7h8",
	costs: "M12 2v20m5-15H9a2.5 2.5 0 0 0 0 5h6a2.5 2.5 0 0 1 0 5H7",
	settings:
		"M10 3h4l.6 2.5 2 .9 2.2-1.3 2 3.5-1.9 1.7v2.3l1.9 1.7-2 3.5-2.2-1.3-2 .9L14 20h-4l-.6-2.6-2-.9-2.2 1.3-2-3.5 1.9-1.7v-2.3L3.2 8.6l2-3.5 2.2 1.3 2-.9L10 3Z M15 11.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
	board: "M3 4h18v16H3zM9 4v16m6-16v16",
	backlog: "M3 4h18v16H3zM3 9h18M3 14h18M8 9v11",
	code: "m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16",
	agents: "M4 4h16v12H9l-5 4zM8 8h8m-8 4h5",
	pipelines: "M3 3h6v6H3zM15 15h6v6h-6zM6 9v9h9m-3-3 3 3-3 3",
	terminals: "M3 4h18v16H3zM7 8l4 4-4 4m6 0h4",
	play: "M8 5v14l11-7z",
	pause: "M9 5v14m6-14v14",
};

export const InterfaceIcon = ({ name }: { name: keyof typeof paths }) => (
	<svg
		aria-hidden='true'
		width='16'
		height='16'
		viewBox='0 0 24 24'
		fill='none'
		stroke='currentColor'
		strokeWidth='1.8'
		strokeLinecap='round'
		strokeLinejoin='round'
	>
		<path d={paths[name]} />
	</svg>
);
