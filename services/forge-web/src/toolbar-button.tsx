import type { ComponentProps } from "react";

export const ToolbarButton = ({ className = "", type = "button", ...props }: ComponentProps<"button">) => (
	<button {...props} type={type} className={`toolbar-button ${className}`} />
);
