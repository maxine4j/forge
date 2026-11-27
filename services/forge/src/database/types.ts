export type SqlValue = string | number | null;
export interface SqlStatement {
	sql: string;
	parameters?: SqlValue[];
}
