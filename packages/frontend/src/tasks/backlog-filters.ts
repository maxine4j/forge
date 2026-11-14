export interface BacklogFilters {
	showDone: boolean;
	showArchived: boolean;
}

export const backlogFiltersKey = "forge.backlog.filters.v1";

export const readBacklogFilters = (): BacklogFilters => {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(backlogFiltersKey) ?? "null");
		if (
			value
			&& typeof value === "object"
			&& "showDone" in value
			&& "showArchived" in value
			&& typeof value.showDone === "boolean"
			&& typeof value.showArchived === "boolean"
		)
			return { showDone: value.showDone, showArchived: value.showArchived };
	} catch {
		/* Storage can be unavailable. */
	}
	return { showDone: false, showArchived: false };
};
