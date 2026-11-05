import type { Project } from "@forge/contracts";
export interface ProjectRecord extends Project {
	source?: string;
}
